# tokenmaxxing

> A Claude Skill for engineers building AI-powered apps — audit prompts, design memory, route models, cache aggressively, validate output, and instrument every call.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

LLM apps die from the same eight failure modes: bloated prompts, no memory architecture, single-model usage, zero caching, unchecked output, no telemetry, prompts buried in inline strings, and context windows that silently truncate. `tokenmaxxing` is a Claude Skill that diagnoses these failures and emits production-grade scaffolding for each one. Drop it into your `~/.claude/skills/` directory and Claude will apply the patterns the moment you ask.

## The 8 Solutions

| # | Solution | What it produces |
|---|---|---|
| 1 | **Prompt Audit & Scoring** | A 0–100 score across 7 dimensions plus a rewritten prompt — e.g. "1,210 → 384 tokens, –68%, $214/mo saved at 2M calls." |
| 2 | **Memory Architecture Generator** | A three-layer memory spec (working / session / long-term) with backends and eviction rules — e.g. "Postgres + pgvector, summarize every 8 turns, 4k-token working budget." |
| 3 | **Model Router Template** | A typed router with a decision table — e.g. "extraction → Haiku 4.5; default → Sonnet 4.6; agentic loop → Opus 4.7; fallback on rate-limit." |
| 4 | **Prompt Caching Setup** | Reordered prompt assembly with `cache_control` breakpoints — e.g. "4 breakpoints, projected 78% cache hit rate, –62% input cost." |
| 5 | **Output Validation Layer** | A Zod/Pydantic schema and a `safeCall(prompt, schema)` wrapper with one repair pass — e.g. "discriminated union `{ ok: true; data: T } \| { ok: false; error }`." |
| 6 | **Observability Scaffolding** | An `instrumentedCall()` wrapper that emits canonical span attributes — e.g. "tokens, cost_usd, cache_read_tokens, ttft_ms, prompt_version, route_reason." |
| 7 | **Prompt Version Control Pattern** | A `prompts/` directory with semver, content hashes, and an eval gate — e.g. "`prompts/triage/v2.1.md` with `eval_id: e_8a2f` required before promotion." |
| 8 | **Context Window Budget Planner** | A per-category token allocation with overflow shed order — e.g. "20% output / 5% safety / history sheds first → memory summary → RAG count." |

## Quick Start

### 1. Install the skill

```bash
git clone https://github.com/TerryThreatt/tokenmaxxing.git ~/.claude/skills/tokenmaxxing
```

Or copy the directory into any skill location Claude Code searches (`~/.claude/skills/`, `.claude/skills/` in your repo, or a plugin path).

### 2. Reference it in Claude Code

The skill auto-loads when triggers in `SKILL.md` match your prompt. To force-load it, paste this in any Claude Code session:

```
Use the tokenmaxxing skill.
```

### 3. Invoke a solution

One line per solution. Paste any of these into Claude Code:

```text
# 1. Prompt Audit
Audit this system prompt for token efficiency: <paste prompt>

# 2. Memory Architecture
Design memory for a multi-session coding assistant with Postgres + pgvector.

# 3. Model Router
Build a model router for an app with extraction, chat, and agentic tasks.

# 4. Prompt Caching
Set up Anthropic prompt caching for this prompt assembly: <paste code>

# 5. Output Validation
Add a Zod-validated safeCall wrapper around this extraction call: <paste code>

# 6. Observability
Scaffold OpenTelemetry spans for every LLM call in this file: <paste path>

# 7. Prompt Version Control
Migrate my inline prompts in src/ai/*.ts into a versioned prompt registry.

# 8. Context Budget
Plan a 200k-token context budget for Sonnet with system + RAG (top-5) + history.
```

## Template Reference

Located in [`/templates`](./templates):

| File | Purpose | Language |
|---|---|---|
| `context-budget-planner.ts` | Allocate tokens across system / tools / memory / RAG / history / user with overflow shed order. | TypeScript |
| `session-state.ts` | Three-layer memory scaffold (working / session / long-term) with summarization triggers. | TypeScript |
| `model-router.ts` | Typed router with decision table, fallback chain, and `routing_decision` event emission. | TypeScript |
| `safe-ai-call.ts` | `safeCall(prompt, schema)` wrapper with structured output, parse-and-repair, and typed result. | TypeScript |
| `observability.ts` | `instrumentedCall()` wrapper emitting canonical span attributes (tokens, cost, cache, latency, route). | TypeScript |
| `prompt-registry.ts` | File-based prompt loader with semver, SHA-256 hash, and eval-gate enforcement. | TypeScript |

## Examples

Located in [`/examples`](./examples):

| File | What it shows |
|---|---|
| `prompt-audit-example.md` | Full audit of a 1.2k-token system prompt with rewrite and projected monthly savings. |
| `memory-architecture-example.md` | Three-layer memory for a multi-session coding assistant on Postgres + pgvector. |
| `model-router-example.md` | Haiku/Sonnet/Opus router with classification rules and fallback chain. |
| `output-validation-example.md` | Zod schema + `safeCall` with repair pass for an extraction task. |
| `observability-example.md` | OpenTelemetry spans, PostHog dashboards, and alert definitions. |

## Use Cases

### Building a multi-turn AI chat feature

You're shipping a chat UI on top of Sonnet. Run solutions **8 → 2 → 4 → 6**: plan the context budget, generate a three-layer memory architecture so conversations survive past the window, restructure the prompt so 90%+ of every call hits cache, and instrument every call so you can see token cost per user from day one. You ship with cost-per-conversation as a first-class metric instead of discovering it after the bill.

### Scaling an AI feature from prototype to production

Your prototype calls Opus on every request. Run solutions **3 → 5 → 7**: introduce a router that sends extraction and classification to Haiku, wrap every call in `safeCall` so a malformed JSON response doesn't crash a downstream service, and move prompts into a versioned registry so the eval suite gates promotions. Cost drops 5–10×, and a bad prompt never reaches `current` without an eval run.

### Auditing an existing AI integration for cost reduction

Finance flagged the LLM line item. Run solutions **1 → 4 → 8 → 6**: audit every prompt for token bloat and rewrite, add caching breakpoints to the system + tool segments, replan the context budget to drop history before RAG, and add observability so the savings show up in a dashboard you can hand back to finance. Typical first-pass result: 40–70% reduction with no quality regression.

## Contributing

PRs welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines on adding solutions, templates, and examples.

## License

[MIT](./LICENSE)
