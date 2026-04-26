/**
 * model-router.ts
 *
 * Maps task types to the cheapest Claude model that meets quality + latency
 * requirements. Use selectModel(task) at the call site; never hardcode a
 * model ID anywhere else in the application.
 *
 * Pricing reflects Anthropic public list prices and should be revalidated
 * periodically against https://www.anthropic.com/pricing. Costs are USD
 * per 1,000 tokens (i.e. per 1k tokens, not per 1M).
 */

/** Canonical task taxonomy. Add new types here, not in callers. */
export enum TaskType {
  /** Single-label / multi-label classification of short input. */
  Classify = "classify",
  /** Structured field extraction from documents or messages. */
  Extract = "extract",
  /** Compress long input into a shorter abstractive summary. */
  Summarize = "summarize",
  /** Conversational coaching, tutoring, or guided UX. */
  Coach = "coach",
  /** Multi-step analysis over moderate context. */
  Analyze = "analyze",
  /** Hard reasoning, agentic loops, long context, code synthesis. */
  DeepReason = "deep_reason",
}

/** Anthropic model identifiers. Pinned to the latest 4.x family. */
export type ClaudeModel =
  | "claude-haiku-4-5-20251001"
  | "claude-sonnet-4-6"
  | "claude-opus-4-7";

/**
 * Per-route configuration. The router treats `model`, `maxTokens`, and the
 * cost fields as authoritative; downstream metering should read costs from
 * here rather than maintaining its own table.
 */
export interface ModelRoute {
  /** Anthropic model ID. */
  model: ClaudeModel;
  /** Hard cap on completion tokens for this task. */
  maxTokens: number;
  /** USD per 1,000 input tokens. */
  inputCostPer1k: number;
  /** USD per 1,000 output tokens. */
  outputCostPer1k: number;
  /** Free-form rationale surfaced in observability traces. */
  reason: string;
}

/**
 * Authoritative routing table. To change a route, edit this object — do not
 * branch on TaskType in calling code.
 */
export const MODEL_ROUTES: Readonly<Record<TaskType, ModelRoute>> = Object.freeze({
  [TaskType.Classify]: {
    model: "claude-haiku-4-5-20251001",
    maxTokens: 256,
    inputCostPer1k: 0.001,
    outputCostPer1k: 0.005,
    reason: "Trivial labeling — Haiku is sufficient and ~10x cheaper than Sonnet.",
  },
  [TaskType.Extract]: {
    model: "claude-haiku-4-5-20251001",
    maxTokens: 1024,
    inputCostPer1k: 0.001,
    outputCostPer1k: 0.005,
    reason: "Schema-bound extraction — Haiku with structured output is reliable and cheap.",
  },
  [TaskType.Summarize]: {
    model: "claude-sonnet-4-6",
    maxTokens: 1024,
    inputCostPer1k: 0.003,
    outputCostPer1k: 0.015,
    reason: "Abstractive summaries need Sonnet-level fluency; Haiku tends to clip nuance.",
  },
  [TaskType.Coach]: {
    model: "claude-sonnet-4-6",
    maxTokens: 2048,
    inputCostPer1k: 0.003,
    outputCostPer1k: 0.015,
    reason: "User-facing conversation — Sonnet hits the price/quality sweet spot.",
  },
  [TaskType.Analyze]: {
    model: "claude-sonnet-4-6",
    maxTokens: 4096,
    inputCostPer1k: 0.003,
    outputCostPer1k: 0.015,
    reason: "Multi-step analysis with moderate context fits Sonnet's reasoning budget.",
  },
  [TaskType.DeepReason]: {
    model: "claude-opus-4-7",
    maxTokens: 8192,
    inputCostPer1k: 0.015,
    outputCostPer1k: 0.075,
    reason: "Hard reasoning, agentic loops, and long context — Opus is worth the cost.",
  },
});

/**
 * Select a model route for a given task type.
 *
 * @param task - the canonical task type
 * @returns a frozen ModelRoute including model ID, token cap, and pricing
 * @throws if `task` is not a valid TaskType
 *
 * @example
 *   const route = selectModel(TaskType.Extract);
 *   const response = await anthropic.messages.create({
 *     model: route.model,
 *     max_tokens: route.maxTokens,
 *     ...
 *   });
 */
export function selectModel(task: TaskType): ModelRoute {
  const route = MODEL_ROUTES[task];
  if (!route) {
    throw new Error(`No route configured for task type: ${String(task)}`);
  }
  return route;
}

/**
 * Estimate USD cost for a call given an input/output token count and route.
 * Use after a call lands to populate observability events.
 */
export function estimateCostUsd(
  route: ModelRoute,
  inputTokens: number,
  outputTokens: number,
): number {
  return (
    (inputTokens / 1000) * route.inputCostPer1k +
    (outputTokens / 1000) * route.outputCostPer1k
  );
}
