---
name: tokenmaxxing
description: Optimize LLM token usage in AI-powered applications — reduce cost, improve latency, and enforce engineering discipline around prompt design, memory, routing, caching, validation, and observability.
---

# tokenmaxxing

Helps software engineers building AI-powered applications maximize useful work per token. Audits prompts, generates memory architectures, configures model routing, sets up prompt caching, scaffolds output validation and observability, establishes prompt version control, and plans context window budgets.

## Trigger Conditions

Activate this skill when the user says or implies any of the following:

- "Audit my prompt(s)" / "score my prompt" / "review this system prompt"
- "Reduce my LLM cost" / "my OpenAI/Anthropic bill is too high" / "tokenmaxxing"
- "Optimize tokens" / "cut token usage" / "shrink my context"
- "Set up prompt caching" / "enable cache_control" / "anthropic prompt caching"
- "Pick the right model" / "route between Haiku/Sonnet/Opus" / "model router"
- "Memory architecture" / "session memory" / "long-term memory for my agent"
- "Validate LLM output" / "structured output validation" / "schema enforcement"
- "Observability for prompts" / "log my LLM calls" / "track prompt performance"
- "Version my prompts" / "prompt registry" / "A/B test prompts"
- "Context window budget" / "my context is overflowing" / "context engineering"
- User pastes a system prompt > 500 tokens and asks for review
- User shares LLM call code (OpenAI/Anthropic SDK) and asks for cost/perf review
- User mentions building an agent, RAG pipeline, or chat app and asks about architecture
- User asks "how do I make my AI app cheaper/faster/more reliable"

Do NOT activate for: general programming questions, non-LLM optimization, model training, fine-tuning workflows, embedding-only pipelines without generation.

## Solutions Provided

1. **Prompt Audit & Scoring** — analyze a prompt across 7 dimensions, return score + concrete rewrites.
2. **Memory Architecture Generator** — design layered memory (working / session / long-term) with eviction rules.
3. **Model Router Template** — produce a typed router that picks the cheapest model meeting task requirements.
4. **Prompt Caching Setup** — restructure prompts and SDK calls to maximize cache hits across providers.
5. **Output Validation Layer** — Zod/Pydantic schemas + retry-with-repair around every structured call.
6. **Observability Scaffolding** — wrap calls with token/cost/latency/cache-hit telemetry and a trace ID.
7. **Prompt Version Control Pattern** — file-based registry with semver, hashes, and eval hooks.
8. **Context Window Budget Planner** — allocate tokens across system / memory / RAG / user / output with overflow strategy.

## Execution Instructions

For every invocation: confirm which of the 8 solutions applies, gather the inputs listed below, do the analysis, and return output in the format specified in **Output Formats**. If multiple solutions apply, run them in dependency order: 8 → 1 → 2 → 4 → 3 → 5 → 6 → 7.

### 1. Prompt Audit & Scoring

**Inputs to ask for (only if not provided):**
- The prompt text (system + any few-shot examples).
- Target model (e.g. `claude-sonnet-4-6`, `gpt-4o`).
- Task type (classification, extraction, generation, agentic).
- Approximate call volume (per day) — used to weight cost findings.

**Analyze across these 7 dimensions, scoring each 0–10:**
1. **Specificity** — does the prompt define the task, inputs, outputs unambiguously?
2. **Token efficiency** — count tokens; flag redundancy, filler, repeated instructions.
3. **Structure** — uses sections / XML tags / clear delimiters; cacheable prefix vs volatile suffix.
4. **Output contract** — explicit schema, format, length, refusal behavior.
5. **Few-shot quality** — examples diverse, minimal, ordered hardest-last.
6. **Robustness** — handles edge cases, ambiguous input, adversarial input.
7. **Cacheability** — static prefix ratio; opportunities for `cache_control` breakpoints.

**Output:** see `PromptAuditReport` schema. Always include a rewritten prompt and a token-delta estimate.

### 2. Memory Architecture Generator

**Inputs to ask for:**
- App type (chat, agent, RAG assistant, copilot).
- Session length expectation (turns or minutes).
- Persistence requirement (per-user? cross-session? cross-device?).
- Privacy/compliance constraints (PII, HIPAA, GDPR).
- Existing storage (Postgres, Redis, vector DB, none).

**Design three layers:**
- **Working memory** — current turn + last N turns verbatim. Bounded token budget.
- **Session memory** — rolling summary of the current session, regenerated every K turns.
- **Long-term memory** — facts/preferences extracted and persisted. Retrieval is RAG-style or keyed lookup.

For each layer specify: storage backend, write trigger, read trigger, eviction policy, token budget, PII handling.

**Output:** see `MemoryArchitecture` schema + a TypeScript scaffold derived from `templates/session-state.ts`.

### 3. Model Router Template

**Inputs to ask for:**
- Models available (and their cost/token + capabilities).
- Task taxonomy (list of task types the app dispatches).
- Latency budget per task.
- Quality floor (acceptable failure rate).

**Build a router that:**
- Classifies the task (rule-based first; LLM-classifier only if rules insufficient).
- Selects the cheapest model meeting capability + latency + quality floor.
- Falls back on rate-limit / 5xx / safety-block to next tier.
- Emits a `routing_decision` event for observability.

**Default tiering** (override per user input): trivial/extraction → Haiku 4.5; default reasoning → Sonnet 4.6; hard reasoning, long context, agentic loops → Opus 4.7.

**Output:** typed router based on `templates/model-router.ts`. Include a decision table the user can edit.

### 4. Prompt Caching Setup

**Inputs to ask for:**
- Provider (Anthropic, OpenAI, Bedrock, Vertex).
- Current prompt structure.
- QPS and reuse pattern (same system prompt across users? per-user customization?).

**Restructure to maximize cache hits:**
- Order content **most stable → most volatile**: tool defs → system prompt → long context → few-shots → conversation → current user turn.
- Place `cache_control: { type: "ephemeral" }` on the last block of each stable segment (Anthropic). Up to 4 breakpoints; place them at segment boundaries, not inside paragraphs.
- Verify minimum cacheable size per provider (Anthropic: 1024 tokens for most models, 2048 for Haiku).
- For OpenAI: ensure prefix stability (no timestamps, user IDs, or random ordering in the first ~1024 tokens).

**Output:** see `CachingPlan` schema with before/after diff and projected hit-rate + cost delta.

### 5. Output Validation Layer

**Inputs to ask for:**
- Language (TS/Python).
- Desired output shape (Zod schema, Pydantic model, JSON schema, or plain description).
- Failure tolerance (strict / repair-once / repair-loop).

**Generate:**
- A schema definition (Zod or Pydantic).
- A `safeCall(prompt, schema)` wrapper that:
  1. Calls the model with structured output mode if supported.
  2. Parses the response against the schema.
  3. On parse failure, invokes a repair pass with the parse error included.
  4. Caps repair attempts (default 1) and emits a validation failure event.
- A typed result: `{ ok: true; data: T } | { ok: false; error: ValidationError; raw: string }`.

**Output:** code based on `templates/safe-ai-call.ts`. Never return unvalidated model output to downstream code.

### 6. Observability Scaffolding

**Inputs to ask for:**
- Existing telemetry stack (OpenTelemetry, Datadog, PostHog, Langfuse, none).
- Whether they want PII redaction in logs.

**Wrap every model call with a span that records:**
- `prompt_id`, `prompt_version`, `model`, `task_type`, `route_reason`.
- `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `cost_usd`.
- `ttft_ms`, `total_latency_ms`.
- `validation_ok`, `repair_attempts`, `finish_reason`.
- `trace_id` propagated from upstream request.

Provide a single `instrumentedCall(args)` that wraps the SDK; the router and validator both call through it.

**Output:** code based on `templates/observability.ts` plus a dashboard spec listing the metrics to chart (cost/day per prompt_id, cache hit rate, p50/p95 latency, validation failure rate).

### 7. Prompt Version Control Pattern

**Inputs to ask for:**
- Where prompts live today (inline strings, env vars, DB, files).
- Whether they have an eval harness.

**Establish:**
- A `prompts/` directory with one file per prompt: `prompts/<name>/v<MAJOR>.<MINOR>.md` plus a `current` symlink/pointer.
- Frontmatter on each file: `id`, `version`, `model`, `created_at`, `hash`, `eval_id`.
- A `loadPrompt(id, version?)` function that returns `{ text, hash, version }` and is cached.
- Bump rules: MAJOR for behavior change, MINOR for wording. Hash is content SHA-256, surfaced in observability.
- An eval hook: every new version must reference an eval run before becoming `current`.

**Output:** scaffold based on `templates/prompt-registry.ts` plus the directory layout.

### 8. Context Window Budget Planner

**Inputs to ask for:**
- Target model + its context window.
- Categories present in calls (system, tools, memory, RAG, history, user, expected output).
- Hard requirements per category (e.g. "RAG must include top-5 docs").

**Allocate tokens across categories with these defaults (override on input):**
- Reserve **20%** for output.
- Reserve **5%** safety margin.
- Allocate the remaining 75% across system / tools / memory / RAG / history / user proportionally to need.
- Emit per-category caps **and** an overflow strategy: which category sheds first (typically history → memory summary → RAG count → tool descriptions).

**Output:** see `ContextBudget` schema + code based on `templates/context-budget-planner.ts` that enforces caps at runtime.

## Output Formats

All schemas are TypeScript-style; render the equivalent in the user's language.

### `PromptAuditReport`
```ts
{
  overallScore: number;            // 0–100
  dimensions: Array<{
    name: "specificity" | "tokenEfficiency" | "structure" | "outputContract" | "fewShotQuality" | "robustness" | "cacheability";
    score: number;                 // 0–10
    findings: string[];            // concrete, citing line ranges
    fixes: string[];               // imperative rewrites
  }>;
  tokenCounts: { current: number; rewritten: number; deltaPct: number };
  rewrittenPrompt: string;
  estimatedMonthlySavingsUsd?: number;
}
```

### `MemoryArchitecture`
```ts
{
  layers: {
    working:   { backend: string; budgetTokens: number; writeTrigger: string; readTrigger: string; eviction: string; piiHandling: string };
    session:   { backend: string; budgetTokens: number; summarizeEveryNTurns: number; writeTrigger: string; readTrigger: string; eviction: string; piiHandling: string };
    longTerm:  { backend: string; retrieval: "rag" | "keyed" | "hybrid"; topK?: number; writeTrigger: string; readTrigger: string; eviction: string; piiHandling: string };
  };
  scaffoldFile: string;            // path or inline code
  diagram: string;                 // ASCII data flow
}
```

### `ModelRouterDecisionTable`
```ts
Array<{
  taskType: string;
  primary:   { model: string; maxTokens: number; reason: string };
  fallback:  { model: string; trigger: "rate_limit" | "5xx" | "safety_block" | "low_confidence" };
  latencyBudgetMs: number;
  qualityFloor: number;            // 0–1
}>
```

### `CachingPlan`
```ts
{
  provider: "anthropic" | "openai" | "bedrock" | "vertex";
  before: { structure: string[]; estCacheHitRate: number; costPer1kCallsUsd: number };
  after:  { structure: string[]; estCacheHitRate: number; costPer1kCallsUsd: number; breakpoints: number };
  diff: string;                    // unified diff of prompt assembly code
  notes: string[];                 // gotchas (e.g. "user_id breaks prefix at line 12")
}
```

### `OutputValidationLayer`
```ts
{
  language: "ts" | "py";
  schema: string;                  // Zod or Pydantic source
  wrapper: string;                 // safeCall source
  resultType: string;              // discriminated union
  failurePolicy: { repairAttempts: number; onFinalFailure: "throw" | "return_error" | "fallback_value" };
}
```

### `ObservabilitySpec`
```ts
{
  stack: string;
  spanAttributes: string[];        // canonical names listed above
  wrapper: string;                 // instrumentedCall source
  dashboards: Array<{ name: string; metrics: string[]; groupBy: string[] }>;
  alerts: Array<{ name: string; condition: string; severity: "info" | "warn" | "page" }>;
}
```

### `PromptRegistryLayout`
```ts
{
  directory: string;               // e.g. "prompts/"
  fileConvention: string;          // "<name>/v<MAJOR>.<MINOR>.md"
  frontmatterFields: string[];     // ["id","version","model","created_at","hash","eval_id"]
  loader: string;                  // loadPrompt source
  bumpRules: { major: string; minor: string };
  evalGate: string;                // policy text
}
```

### `ContextBudget`
```ts
{
  model: string;
  windowTokens: number;
  reserves: { output: number; safety: number };
  allocations: Record<"system" | "tools" | "memory" | "rag" | "history" | "user", number>;
  overflowOrder: Array<"history" | "memory" | "rag" | "tools" | "system">;
  enforcerFile: string;
}
```

## Integration Notes

The 8 outputs compose. Wire them as follows:

- **Context Budget (8)** is computed first — its allocations drive Memory (2) layer sizes, Caching (4) breakpoint placement, and Router (3) per-model windows.
- **Prompt Audit (1)** rewrites feed the **Prompt Registry (7)**; bumping a version triggers a new eval before promotion to `current`.
- **Caching (4)** dictates prompt assembly order. Memory (2) and RAG retrieval must be appended *after* the cacheable prefix, never inserted into it.
- **Model Router (3)** wraps every call; the router itself calls **Output Validation (5)** which calls **Observability (6)**. Concretely: `userCode → router.dispatch() → validator.safeCall() → observability.instrumentedCall() → SDK`.
- **Observability (6)** reads `prompt_id` and `prompt_version` from the **Prompt Registry (7)** and `route_reason` from the **Router (3)**. Without these IDs, dashboards cannot group by prompt or model.
- **Output Validation (5)** failure events are a primary signal in the Observability (6) dashboard and a trigger for a Prompt Registry (7) version bump.

When a user requests one solution, mention the adjacent integrations explicitly and offer to scaffold them.

## Examples

Reference implementations live in `examples/`:

- `examples/prompt-audit-example.md` — full audit of a 1.2k-token system prompt with rewrite and savings estimate.
- `examples/memory-architecture-example.md` — three-layer memory for a multi-session coding assistant on Postgres + pgvector.
- `examples/model-router-example.md` — Haiku/Sonnet/Opus router with classification rules and fallback chain.
- `examples/output-validation-example.md` — Zod schema + `safeCall` with repair pass for an extraction task.
- `examples/observability-example.md` — OpenTelemetry spans, PostHog dashboards, and alert definitions.

Templates the executions reference:

- `templates/context-budget-planner.ts`
- `templates/session-state.ts`
- `templates/model-router.ts`
- `templates/safe-ai-call.ts`
- `templates/observability.ts`
- `templates/prompt-registry.ts`

When generating output, copy from the template, adapt to the user's stack and inputs, and cite the template path in the response so the user can diff future versions.
