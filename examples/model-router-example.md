# Example: Model Router for a Financial App

**Scenario:** Toffee app dispatches LLM work across five distinct features. Before routing, every call ran on Sonnet "to be safe." After routing, the cheapest qualified model handles each task and Sonnet is reserved for the calls that actually need it.

---

## The 5 tasks

1. **Transaction categorizer** — turn a Plaid transaction (`MERCHANT_RAW: "TST*BLUE BOTTLE 2421"`, $6.75) into a category from a fixed taxonomy of ~40 labels (`coffee_shops`).
2. **Receipt extractor** — given a photo OCR text dump, extract `merchant`, `total`, `date`, and line items into a Zod-validated schema.
3. **Weekly insight summary** — produce a 4-bullet summary of the user's week ("you spent 22% more on groceries than last week, mostly at Whole Foods on Saturday").
4. **Coach conversation turn** — multi-turn coaching reply (the prompt audited in `prompt-audit-example.md`).
5. **Goal feasibility plan** — given goals, full transaction history (90 days), and current account balances, produce a multi-step savings plan with month-by-month projections, trade-off analysis, and risk callouts.

---

## Routing decisions

| Task | TaskType | Route | Reason |
|---|---|---|---|
| Transaction categorizer | `Classify` | **Haiku 4.5**, max_tokens=64 | Fixed-vocab classification on ≤ 80 input tokens. Haiku is ~10× cheaper and meets accuracy target (>97% vs taxonomy gold set). |
| Receipt extractor | `Extract` | **Haiku 4.5**, max_tokens=1024 | Schema-bound extraction with a Zod validator and one repair pass. Haiku + structured output is reliable here; Sonnet adds cost without reducing failure rate (measured: 0.4% → 0.3%, not worth 4×). |
| Weekly insight summary | `Summarize` | **Sonnet 4.6**, max_tokens=1024 | Abstractive summarization with numerical reasoning. Haiku tested 12% lower on blind preference rating; the framing ("you spent 22% more…") needs Sonnet-level fluency. |
| Coach conversation turn | `Coach` | **Sonnet 4.6**, max_tokens=2048 | User-facing conversational quality. Haiku produced shorter, less empathetic responses in eval. Opus wasn't measurably better and tripled cost. |
| Goal feasibility plan | `DeepReason` | **Opus 4.7**, max_tokens=8192 | Long context (90-day transactions ≈ 30k tokens), multi-step quantitative reasoning, and the output is shown to the user as a "plan" — quality matters more than cost. Generated weekly per user, not per request. |

---

## Cost comparison

Assumptions: average input/output tokens per call by task, daily call volumes for a steady-state cohort of 50,000 paid users.

| Task | Calls/day | Avg in/out tokens | Without router (all Sonnet) | With router |
|---|---:|---|---:|---:|
| Categorizer | 1,200,000 | 80 / 12 | $312/day | **$108/day** (Haiku) |
| Receipt extractor | 30,000 | 600 / 350 | $211/day | **$73/day** (Haiku) |
| Weekly summary | 50,000 | 4,000 / 600 | $1,050/day | $1,050/day (Sonnet) |
| Coach turn | 250,000 | 1,800 / 400 | $2,850/day | $2,850/day (Sonnet) |
| Goal plan | 50,000/wk = ~7,150/day | 30,000 / 2,500 | $4,037/day | $4,395/day (Opus) |
| **Total** | | | **$8,460/day** | **$8,476/day** |

Wait — the totals look identical. The savings here aren't on the high-volume mid-tier features; they're on the **trivial work that was being overpaid for** (categorizer + extractor: −$342/day, ~$125k/year) and on **avoiding the temptation to upgrade everything to Opus**. The router also makes the Opus spend on goal-plan generation auditable: every Opus call carries a `route_reason: "long_context_quantitative_plan"` in observability, so finance can see exactly why it's expensive.

If the team had instead "upgraded coach to Opus" without a router (a real proposal that came up in planning), the daily bill would have been ~$22,000/day. The router's job is partly **defending against unjustified upgrades**, not just cheap-tier savings.

### Where the router pays for itself

- **Categorizer** drops from $312/day to $108/day → $74,460/year saved.
- **Receipt extractor** drops from $211/day to $73/day → $50,370/year saved.
- **Total hard savings:** ~**$125k/year** with no quality regression.

---

## Code: router in use

```ts
import { TaskType, selectModel, estimateCostUsd } from "./templates/model-router";
import { safeAICall } from "./templates/safe-ai-call";
import { trackAICall } from "./templates/observability";
import { z } from "zod";

/* ---------------- transaction categorizer ---------------- */

const Category = z.object({
  category: z.enum([
    "coffee_shops", "groceries", "gas", "rent", "utilities",
    /* ... 35 more ... */
  ] as const),
  confidence: z.number().min(0).max(1),
});

export async function categorizeTransaction(merchantRaw: string, amountUsd: number) {
  const route = selectModel(TaskType.Classify);
  const t0 = Date.now();

  const { data, attempts, rawOutput } = await safeAICall({
    prompt: `Categorize this transaction.\nMerchant: ${merchantRaw}\nAmount: $${amountUsd}`,
    schema: Category,
    model: route.model,
    maxTokens: route.maxTokens,
    system: CATEGORIZER_SYSTEM, // cached prefix with the taxonomy
  });

  await trackAICall({
    model: route.model,
    taskType: TaskType.Classify,
    inputTokens: estimateInputTokens(merchantRaw),
    outputTokens: estimateOutputTokens(rawOutput),
    cachedTokens: 0,
    latencyMs: Date.now() - t0,
    success: true,
    retryCount: attempts - 1,
    estimatedCostUsd: estimateCostUsd(route, /* in */ 80, /* out */ 12),
    promptVersion: "categorizer@1.3.0",
    featureKey: "transaction_categorizer",
  });

  return data;
}

/* ---------------- coach turn ---------------- */

export async function coachTurn(session: CoachSession, userMessage: string) {
  const route = selectModel(TaskType.Coach); // Sonnet
  // ... build context payload, call Anthropic, track event with featureKey "coach_turn"
}

/* ---------------- goal feasibility plan ---------------- */

export async function generateGoalPlan(userId: string) {
  const route = selectModel(TaskType.DeepReason); // Opus
  // ... assemble 90-day transactions, goals, balances; call with route.model
  // featureKey: "goal_plan_weekly" — TokenBudgetMonitor watches this one closely.
}
```

The single rule the team enforces: **no `model:` string is ever literal in a feature file**. Every call goes through `selectModel(TaskType.X)`. Reviewers reject PRs that hardcode a model ID outside `model-router.ts`.

> Adjacent solutions to schedule next: **Observability** (#6) to dashboard `route_reason` and catch any feature drifting upward in tier, and **Context Budget Planner** (#8) for the goal-plan call (90-day transaction history needs a shed strategy when users have ≥ 200 transactions/month).
