# Example: Observability for an AI Feature

**Scenario:** Toffee AI Coach is in production. Finance wants daily cost broken down by feature, engineering wants a single-pane view of cache hit rate and validation failures, and the on-call wants to be paged when any feature blows past its monthly token budget. This example shows the full setup.

---

## Stack

- **App:** TypeScript / Node 20 backend.
- **Tracker:** PostHog (via `posthog-node`).
- **Dashboard:** PostHog Insights.
- **Alerting:** PagerDuty webhook, fired by `TokenBudgetMonitor.onAlert`.

---

## `trackAICall()` wired to PostHog

```ts
// src/ai/telemetry.ts
import { PostHog } from "posthog-node";
import {
  PostHogTracker,
  setTracker,
  TokenBudgetMonitor,
} from "../../templates/observability";

const posthog = new PostHog(process.env.POSTHOG_KEY!, {
  host: process.env.POSTHOG_HOST ?? "https://us.i.posthog.com",
  flushAt: 20,
  flushInterval: 5_000,
});

// PostHogTracker matches the minimal PostHogClient interface; no shim needed.
setTracker(new PostHogTracker(posthog, "system", "ai_call"));

// Per-feature monthly budgets. Window = 30 days. Warn at 80%, breach at 100%.
new TokenBudgetMonitor({
  featureKey: "coach_turn",
  maxCostUsd: 18_000,
  windowMs: 30 * 24 * 60 * 60 * 1000,
  warnAt: 0.8,
  onAlert: pageOnCall,
});

new TokenBudgetMonitor({
  featureKey: "goal_plan_weekly",
  maxCostUsd: 9_000,
  windowMs: 30 * 24 * 60 * 60 * 1000,
  warnAt: 0.8,
  onAlert: pageOnCall,
});

new TokenBudgetMonitor({
  featureKey: "transaction_categorizer",
  maxTokens: 5_000_000_000,   // 5B tokens / month — Haiku, cheap but high volume
  windowMs: 30 * 24 * 60 * 60 * 1000,
  warnAt: 0.8,
  onAlert: pageOnCall,
});

async function pageOnCall(alert: import("../../templates/observability").TokenBudgetAlert) {
  await fetch(process.env.PAGERDUTY_WEBHOOK!, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      routing_key: process.env.PAGERDUTY_ROUTING_KEY,
      event_action: "trigger",
      payload: {
        summary:
          `[${alert.level.toUpperCase()}] AI feature ${alert.featureKey} ` +
          `at ${Math.round((alert.current / alert.limit) * 100)}% of ` +
          `${alert.metric} budget (${alert.current.toFixed(2)} / ${alert.limit}).`,
        severity: alert.level === "breach" ? "critical" : "warning",
        source: "tokenmaxxing.budget_monitor",
        custom_details: alert,
      },
    }),
  });
}
```

Every feature ends its call site with `await trackAICall({...})`. The router writes `route_reason`, the prompt registry writes `promptVersion`, and the `safeAICall` wrapper writes `retryCount` and `success`. There is one canonical event shape — no per-feature schemas.

---

## Real event payload

A single coach turn that hit a partial cache:

```json
{
  "event": "ai_call",
  "distinct_id": "user_8f4c1a",
  "timestamp": "2026-04-26T14:31:08.412Z",
  "properties": {
    "model": "claude-sonnet-4-6",
    "taskType": "coach",
    "inputTokens": 3412,
    "outputTokens": 287,
    "cachedTokens": 2890,
    "latencyMs": 1840,
    "success": true,
    "retryCount": 0,
    "estimatedCostUsd": 0.005871,
    "promptVersion": "coach@2.0.0",
    "featureKey": "coach_turn",
    "traceId": "01JS6F8K3W2H9XQ5N4VC7BAREP",
    "routeReason": "Sonnet hits the price/quality sweet spot for user-facing conversation."
  }
}
```

Three things to notice:

1. `cachedTokens: 2890` of `inputTokens: 3412` → **84.7% cache hit rate** on this call. Matches the projection from the audit.
2. `estimatedCostUsd: 0.005871` is computed via `estimateCostUsd(route, in, out)` and stored alongside raw tokens — finance dashboards never recompute prices, they sum this column.
3. `traceId` is propagated from the upstream HTTP request so this event joins to API logs, RUM, and any downstream services in the same trace.

---

## A real `TokenBudgetMonitor` alert firing

Goal-plan generation runs weekly per user. In April 2026, an engineer shipped a prompt change that doubled the input context window for the plan (forgot to trim the transactions list). The monitor caught it within four hours.

PagerDuty incident, redacted from the actual event:

```text
[BREACH] AI feature goal_plan_weekly at 100% of cost budget (9012.44 / 9000).
Window: 30 days
Current: $9,012.44
Limit:   $9,000.00
First crossed warn (80%) at 2026-04-23T11:08Z
First crossed breach (100%) at 2026-04-26T03:14Z
```

Click-through to the linked PostHog query showed `inputTokens` p95 had jumped from 28,400 → 51,200 on `goal_plan_weekly` starting 2026-04-21. Engineer rolled back, monitor reset on next eviction window, finance was unaffected because the breach was caught at $12 over budget instead of at end-of-month reconciliation.

---

## PostHog dashboard

Four insights pinned in the `AI / Cost & Performance` dashboard:

### 1. Daily cost per feature

PostHog HogQL:

```sql
SELECT
  toDate(timestamp) AS day,
  properties.featureKey AS feature,
  sum(toFloat(properties.estimatedCostUsd)) AS cost_usd,
  count() AS calls
FROM events
WHERE event = 'ai_call'
  AND timestamp > now() - INTERVAL 30 DAY
GROUP BY day, feature
ORDER BY day DESC, cost_usd DESC
```

Stacked area chart, one band per feature. Anomaly on a band shows up as a visible step.

### 2. Cache hit rate per prompt version

```sql
SELECT
  properties.promptVersion AS prompt,
  sum(toFloat(properties.cachedTokens)) / sum(toFloat(properties.inputTokens)) AS cache_hit_rate,
  count() AS calls
FROM events
WHERE event = 'ai_call'
  AND timestamp > now() - INTERVAL 7 DAY
  AND toFloat(properties.inputTokens) > 0
GROUP BY prompt
ORDER BY calls DESC
```

Tracks regressions: a new prompt version with a hit rate below the previous version's baseline gets blocked at the eval gate before promotion.

### 3. Validation failure rate per feature

```sql
SELECT
  properties.featureKey AS feature,
  countIf(toInt(properties.retryCount) > 0) / count() AS repair_rate,
  countIf(properties.success = 'false') / count() AS terminal_failure_rate
FROM events
WHERE event = 'ai_call'
  AND timestamp > now() - INTERVAL 7 DAY
GROUP BY feature
ORDER BY terminal_failure_rate DESC
```

Alert threshold: terminal_failure_rate > 0.5% on any feature pages on-call. Repair rate > 5% opens a ticket but does not page.

### 4. Latency p50 / p95 per task type

```sql
SELECT
  properties.taskType AS task,
  quantile(0.5)(toFloat(properties.latencyMs)) AS p50,
  quantile(0.95)(toFloat(properties.latencyMs)) AS p95,
  count() AS calls
FROM events
WHERE event = 'ai_call'
  AND timestamp > now() - INTERVAL 1 DAY
GROUP BY task
ORDER BY p95 DESC
```

Coach is the user-facing task with a TTFB SLO; this query plus an alert on p95 > 3,500 ms covers it.

---

## What this gives the team

- **Finance:** one query → one number per feature per day, summed from `estimatedCostUsd` rather than reconstructed from invoices weeks later.
- **Engineering:** prompt version IDs + cache hit rate make every prompt change measurable. A bad prompt is visible in 24 hours, not 30 days.
- **On-call:** PagerDuty fires from a single `onAlert` callback. No bespoke threshold logic per feature.
- **Product:** can answer "how much is feature X costing per active user" by joining `ai_call.distinct_id` to user dimensions in PostHog, no separate ETL.

> Adjacent solutions to schedule next: **Prompt Version Control** (#7) — `promptVersion` is only useful if it changes deliberately; the registry's eval gate prevents accidental version drift.
