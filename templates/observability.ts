/**
 * observability.ts
 *
 * Provider-agnostic telemetry layer for LLM calls. Every call site should
 * end with `trackAICall(event)` so that token, cost, latency, and cache
 * statistics flow into a single canonical event stream.
 *
 * Two backends ship out of the box:
 *   - PostHog (via posthog-node) when configured
 *   - Console (always available, no dependency)
 *
 * Add custom backends by passing your own `Tracker` to `setTracker()`.
 *
 * Also exposes `TokenBudgetMonitor` — a per-feature accounting class that
 * fires a callback when a feature exceeds a token-or-cost ceiling.
 */

/** Canonical event emitted for every LLM call. */
export interface AICallEvent {
  /** Anthropic model ID (or other provider). */
  model: string;
  /** TaskType from the model router (string for provider neutrality). */
  taskType: string;
  /** Input token count reported by the provider. */
  inputTokens: number;
  /** Output token count reported by the provider. */
  outputTokens: number;
  /** Tokens served from prompt cache. 0 when no cache hit. */
  cachedTokens: number;
  /** Wall-clock latency in milliseconds. */
  latencyMs: number;
  /** Did the call succeed end-to-end (including validation)? */
  success: boolean;
  /** Number of repair attempts (0 = first try succeeded). */
  retryCount: number;
  /** USD cost computed from route pricing. */
  estimatedCostUsd: number;
  /** Prompt id + version from the prompt registry. */
  promptVersion: string;
  /** Optional feature key — used by TokenBudgetMonitor. */
  featureKey?: string;
  /** Optional trace id for distributed tracing correlation. */
  traceId?: string;
}

/** Minimal tracker interface. Implement this to add a backend. */
export interface Tracker {
  capture(event: AICallEvent): void | Promise<void>;
  shutdown?(): void | Promise<void>;
}

/** Console fallback. Pretty-prints in dev, JSON-lines in prod. */
export class ConsoleTracker implements Tracker {
  constructor(private readonly mode: "pretty" | "json" = process.env.NODE_ENV === "production" ? "json" : "pretty") {}

  capture(event: AICallEvent): void {
    if (this.mode === "json") {
      console.log(JSON.stringify({ event: "ai_call", ...event }));
      return;
    }
    const cost = event.estimatedCostUsd.toFixed(6);
    console.log(
      `[ai_call] ${event.model} task=${event.taskType} ` +
        `in=${event.inputTokens} out=${event.outputTokens} cached=${event.cachedTokens} ` +
        `latency=${event.latencyMs}ms retries=${event.retryCount} ok=${event.success} ` +
        `cost=$${cost} prompt=${event.promptVersion}` +
        (event.featureKey ? ` feature=${event.featureKey}` : "") +
        (event.traceId ? ` trace=${event.traceId}` : ""),
    );
  }
}

/**
 * Minimal PostHog tracker. Avoids a hard dependency on posthog-node by taking
 * the client at construction time. Pass any object with `capture()`.
 */
export interface PostHogClient {
  capture(args: { distinctId: string; event: string; properties?: Record<string, unknown> }): void;
  shutdown?(): Promise<void> | void;
}

export class PostHogTracker implements Tracker {
  constructor(
    private readonly client: PostHogClient,
    private readonly distinctId: string = "system",
    private readonly eventName: string = "ai_call",
  ) {}

  capture(event: AICallEvent): void {
    this.client.capture({
      distinctId: this.distinctId,
      event: this.eventName,
      properties: { ...event },
    });
  }

  async shutdown(): Promise<void> {
    if (this.client.shutdown) await this.client.shutdown();
  }
}

let activeTracker: Tracker = new ConsoleTracker();

/** Replace the active tracker (e.g. swap in PostHog at startup). */
export function setTracker(tracker: Tracker): void {
  activeTracker = tracker;
}

/** Read the active tracker (mostly for tests). */
export function getTracker(): Tracker {
  return activeTracker;
}

/**
 * Emit an `AICallEvent`. Also routes the event through any registered
 * `TokenBudgetMonitor` instances so they can fire alerts.
 */
export async function trackAICall(event: AICallEvent): Promise<void> {
  for (const monitor of monitors) monitor.record(event);
  await activeTracker.capture(event);
}

/* ---------------------------------------------------------------------- */
/* Token budget monitor                                                    */
/* ---------------------------------------------------------------------- */

/** Configuration for a per-feature budget. */
export interface TokenBudgetConfig {
  /** Logical feature name — must match `AICallEvent.featureKey`. */
  featureKey: string;
  /** Hard ceiling on tokens (input + output) over the rolling window. */
  maxTokens?: number;
  /** Hard ceiling on USD cost over the rolling window. */
  maxCostUsd?: number;
  /** Window size in milliseconds. Default: 1 hour. */
  windowMs?: number;
  /** Alert threshold as a fraction of the cap (default 0.8 → warn at 80%). */
  warnAt?: number;
  /** Called when warn or breach thresholds cross. */
  onAlert: (alert: TokenBudgetAlert) => void;
}

/** Alert payload delivered to `onAlert`. */
export interface TokenBudgetAlert {
  featureKey: string;
  level: "warn" | "breach";
  metric: "tokens" | "cost";
  current: number;
  limit: number;
  windowMs: number;
}

const monitors: TokenBudgetMonitor[] = [];

/**
 * Tracks rolling token + cost usage per feature and fires alerts when
 * thresholds are crossed. Construct one per feature at startup; it
 * auto-registers itself with the global event stream.
 */
export class TokenBudgetMonitor {
  private readonly windowMs: number;
  private readonly warnAt: number;
  private events: Array<{ ts: number; tokens: number; costUsd: number }> = [];
  private warnedTokens = false;
  private warnedCost = false;
  private breachedTokens = false;
  private breachedCost = false;

  constructor(private readonly config: TokenBudgetConfig) {
    this.windowMs = config.windowMs ?? 60 * 60 * 1000;
    this.warnAt = config.warnAt ?? 0.8;
    monitors.push(this);
  }

  /** Drop this monitor from the global registry (for tests / teardown). */
  dispose(): void {
    const idx = monitors.indexOf(this);
    if (idx >= 0) monitors.splice(idx, 1);
  }

  /** Called by `trackAICall`. Public for testing. */
  record(event: AICallEvent): void {
    if (event.featureKey !== this.config.featureKey) return;

    const now = Date.now();
    this.events.push({
      ts: now,
      tokens: event.inputTokens + event.outputTokens,
      costUsd: event.estimatedCostUsd,
    });
    this.evict(now);

    const totals = this.totals();

    if (this.config.maxTokens != null) {
      this.evaluate("tokens", totals.tokens, this.config.maxTokens);
    }
    if (this.config.maxCostUsd != null) {
      this.evaluate("cost", totals.costUsd, this.config.maxCostUsd);
    }
  }

  /** Current usage in the rolling window. */
  totals(): { tokens: number; costUsd: number } {
    this.evict(Date.now());
    return this.events.reduce(
      (acc, e) => ({ tokens: acc.tokens + e.tokens, costUsd: acc.costUsd + e.costUsd }),
      { tokens: 0, costUsd: 0 },
    );
  }

  private evict(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.events.length > 0 && this.events[0]!.ts < cutoff) {
      this.events.shift();
    }
    // Reset latched flags when the window goes back below the warn line.
    const totals = this.events.reduce(
      (acc, e) => ({ tokens: acc.tokens + e.tokens, costUsd: acc.costUsd + e.costUsd }),
      { tokens: 0, costUsd: 0 },
    );
    if (this.config.maxTokens && totals.tokens < this.warnAt * this.config.maxTokens) {
      this.warnedTokens = false;
      this.breachedTokens = false;
    }
    if (this.config.maxCostUsd && totals.costUsd < this.warnAt * this.config.maxCostUsd) {
      this.warnedCost = false;
      this.breachedCost = false;
    }
  }

  private evaluate(metric: "tokens" | "cost", current: number, limit: number): void {
    const breach = current >= limit;
    const warn = current >= limit * this.warnAt;

    const latch =
      metric === "tokens"
        ? { warnFlag: () => this.warnedTokens, setWarn: () => (this.warnedTokens = true), breachFlag: () => this.breachedTokens, setBreach: () => (this.breachedTokens = true) }
        : { warnFlag: () => this.warnedCost, setWarn: () => (this.warnedCost = true), breachFlag: () => this.breachedCost, setBreach: () => (this.breachedCost = true) };

    if (breach && !latch.breachFlag()) {
      latch.setBreach();
      this.config.onAlert({
        featureKey: this.config.featureKey,
        level: "breach",
        metric,
        current,
        limit,
        windowMs: this.windowMs,
      });
      return;
    }

    if (warn && !latch.warnFlag()) {
      latch.setWarn();
      this.config.onAlert({
        featureKey: this.config.featureKey,
        level: "warn",
        metric,
        current,
        limit,
        windowMs: this.windowMs,
      });
    }
  }
}
