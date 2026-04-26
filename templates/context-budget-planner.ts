/**
 * context-budget-planner.ts
 *
 * Allocates a model's context window across categories (system, tools,
 * memory, RAG, history, user, output) and enforces caps at runtime. When
 * the planner detects overflow, it sheds categories in a configurable
 * order until the call fits.
 *
 * Use one planner per call site (or one shared per model). Construct it
 * once with a budget and reuse it; the planner is stateless across calls.
 */

/** Categories the planner allocates against. */
export type ContextCategory =
  | "system"
  | "tools"
  | "memory"
  | "rag"
  | "history"
  | "user";

/** Categories that may be shed on overflow. `system` is shed last by default. */
export type SheddableCategory = ContextCategory;

/** Inputs to a budget plan. */
export interface ContextBudgetInputs {
  /** Anthropic model ID — used for the label only. */
  model: string;
  /** Total context window of the model, in tokens. */
  windowTokens: number;
  /** Fraction of the window reserved for output. Default 0.20. */
  outputReserveFraction?: number;
  /** Fraction of the window held back as safety margin. Default 0.05. */
  safetyReserveFraction?: number;
  /** Per-category weights summing to any positive number; planner normalizes. */
  weights: Record<ContextCategory, number>;
  /** Optional hard floors per category — these are never shed below this value. */
  floors?: Partial<Record<ContextCategory, number>>;
  /** Order categories shed when overflow occurs. Earlier = shed first. */
  overflowOrder?: SheddableCategory[];
}

/** A finalized plan computed from inputs. Cap values are in tokens. */
export interface ContextBudget {
  model: string;
  windowTokens: number;
  reserves: { output: number; safety: number };
  /** Per-category cap, in tokens. */
  allocations: Record<ContextCategory, number>;
  /** Per-category floor (defaults to 0). */
  floors: Record<ContextCategory, number>;
  /** Shed order applied by `enforce()` on overflow. */
  overflowOrder: SheddableCategory[];
}

/** Live token usage passed to `enforce()`. */
export type CategoryUsage = Record<ContextCategory, number>;

/** Result of an enforcement pass. */
export interface EnforcementResult {
  /** Capped usage that fits within `windowTokens - output - safety`. */
  capped: CategoryUsage;
  /** Tokens shed per category, by name. */
  shed: Partial<Record<SheddableCategory, number>>;
  /** True if the plan still overflows after shedding to all floors. */
  overBudget: boolean;
  /** Total input tokens after capping (excludes output reserve). */
  totalAfter: number;
  /** Total input tokens before capping. */
  totalBefore: number;
}

const DEFAULT_OVERFLOW_ORDER: SheddableCategory[] = [
  "history",
  "memory",
  "rag",
  "tools",
  "user",
  "system",
];

/**
 * Build a `ContextBudget` from a set of weights. Allocates the input budget
 * (window − output reserve − safety reserve) across categories proportionally
 * to the supplied weights, respecting any floors.
 *
 * @example
 *   const plan = planContextBudget({
 *     model: "claude-sonnet-4-6",
 *     windowTokens: 200_000,
 *     weights: { system: 1, tools: 1, memory: 2, rag: 4, history: 6, user: 1 },
 *     floors:  { system: 1500, rag: 4000 },
 *   });
 */
export function planContextBudget(inputs: ContextBudgetInputs): ContextBudget {
  const {
    model,
    windowTokens,
    outputReserveFraction = 0.2,
    safetyReserveFraction = 0.05,
    weights,
    floors = {},
    overflowOrder = DEFAULT_OVERFLOW_ORDER,
  } = inputs;

  if (windowTokens <= 0) throw new Error("windowTokens must be > 0");
  if (outputReserveFraction + safetyReserveFraction >= 1) {
    throw new Error("output + safety reserves must leave room for input");
  }

  const output = Math.floor(windowTokens * outputReserveFraction);
  const safety = Math.floor(windowTokens * safetyReserveFraction);
  const inputBudget = windowTokens - output - safety;

  const totalWeight = Object.values(weights).reduce((s, w) => s + w, 0);
  if (totalWeight <= 0) throw new Error("at least one category weight must be > 0");

  const allocations: Record<ContextCategory, number> = {
    system: 0,
    tools: 0,
    memory: 0,
    rag: 0,
    history: 0,
    user: 0,
  };
  const fullFloors: Record<ContextCategory, number> = {
    system: floors.system ?? 0,
    tools: floors.tools ?? 0,
    memory: floors.memory ?? 0,
    rag: floors.rag ?? 0,
    history: floors.history ?? 0,
    user: floors.user ?? 0,
  };

  (Object.keys(allocations) as ContextCategory[]).forEach((cat) => {
    const share = Math.floor((weights[cat] / totalWeight) * inputBudget);
    allocations[cat] = Math.max(share, fullFloors[cat]);
  });

  return {
    model,
    windowTokens,
    reserves: { output, safety },
    allocations,
    floors: fullFloors,
    overflowOrder,
  };
}

/**
 * Enforce a budget against live usage. Each category is first capped at its
 * allocation. If the resulting total still exceeds the input budget, the
 * planner sheds tokens from categories in `overflowOrder` (earliest first),
 * never going below their floors.
 *
 * Returns the post-cap usage and a per-category shed map. If shedding to
 * all floors still does not fit, `overBudget` is true — callers must
 * compress further (e.g. summarize history) or fail loudly.
 */
export function enforce(plan: ContextBudget, usage: CategoryUsage): EnforcementResult {
  const capped: CategoryUsage = { ...usage };
  const shed: Partial<Record<SheddableCategory, number>> = {};
  const totalBefore = sum(usage);

  // 1. Cap each category at its allocation.
  (Object.keys(capped) as ContextCategory[]).forEach((cat) => {
    if (capped[cat] > plan.allocations[cat]) {
      const delta = capped[cat] - plan.allocations[cat];
      capped[cat] = plan.allocations[cat];
      shed[cat] = (shed[cat] ?? 0) + delta;
    }
  });

  const inputBudget = plan.windowTokens - plan.reserves.output - plan.reserves.safety;
  let totalAfter = sum(capped);

  // 2. If still over, shed in the configured order down to floors.
  for (const cat of plan.overflowOrder) {
    if (totalAfter <= inputBudget) break;
    const floor = plan.floors[cat];
    if (capped[cat] <= floor) continue;
    const overflow = totalAfter - inputBudget;
    const available = capped[cat] - floor;
    const reduceBy = Math.min(available, overflow);
    capped[cat] -= reduceBy;
    shed[cat] = (shed[cat] ?? 0) + reduceBy;
    totalAfter -= reduceBy;
  }

  return {
    capped,
    shed,
    overBudget: totalAfter > inputBudget,
    totalAfter,
    totalBefore,
  };
}

function sum(u: CategoryUsage): number {
  return u.system + u.tools + u.memory + u.rag + u.history + u.user;
}
