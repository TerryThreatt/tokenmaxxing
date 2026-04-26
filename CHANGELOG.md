# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- _Reserved for upcoming changes._

### Changed
- _Reserved for upcoming changes._

### Fixed
- _Reserved for upcoming changes._

### Removed
- _Reserved for upcoming changes._

## [1.0.0] — 2026-04-26

Initial public release of `tokenmaxxing` as a Claude Skill for engineers building AI-powered applications.

### Added

#### Skill definition
- `SKILL.md` — full skill specification including trigger conditions, execution instructions, output schemas, and integration notes.

#### Solutions (8)
- **Prompt Audit & Scoring** — 7-dimension scorecard with a rewritten prompt and projected savings.
- **Memory Architecture Generator** — three-layer memory design (working / session / long-term) with eviction rules and PII handling.
- **Model Router Template** — typed router that selects the cheapest qualified model per task type, with fallback chain.
- **Prompt Caching Setup** — provider-aware prompt restructuring with `cache_control` breakpoint placement and projected hit-rate gains.
- **Output Validation Layer** — Zod/Pydantic schema plus a `safeCall` wrapper with structured output, parse-and-repair, and typed result.
- **Observability Scaffolding** — canonical `AICallEvent` shape, an `instrumentedCall()` wrapper, dashboard specs, and alert definitions.
- **Prompt Version Control Pattern** — file-based registry with semver, content hashes, and an eval-gate before promotion.
- **Context Window Budget Planner** — per-category token allocation across system / tools / memory / RAG / history / user, with overflow shed order.

#### Templates (6)
- `templates/model-router.ts` — `TaskType` enum, frozen `MODEL_ROUTES` config, `selectModel()`, and `estimateCostUsd()` for Haiku 4.5 / Sonnet 4.6 / Opus 4.7.
- `templates/session-state.ts` — generic `AISession<T>` interface, `createSession()`, `appendTurn()`, `compressSession()` (Haiku-backed default summarizer), and `buildContextPayload()`.
- `templates/safe-ai-call.ts` — `safeAICall<T>()` wrapper with Anthropic SDK, JSON extraction (raw / fenced / balanced), Zod validation, repair-prompt retry loop, and typed `AICallError`.
- `templates/observability.ts` — `AICallEvent` interface, pluggable `Tracker` (with `ConsoleTracker` and `PostHogTracker`), `setTracker()` / `trackAICall()`, and a `TokenBudgetMonitor` class with rolling-window alerts.
- `templates/prompt-registry.ts` — `PromptEntry` type and `PromptRegistry` class with `register()`, `getActive()`, `getVersion()`, `setActive()`, `getABVariant()`, plus optional JSON file persistence.
- `templates/context-budget-planner.ts` — `planContextBudget()` and `enforce()` for proportional category allocation across `system / tools / memory / rag / history / user` with shed-on-overflow.

#### Examples (5)
- `examples/prompt-audit-example.md` — full audit and rewrite of a 1,210-token coaching prompt down to 384 tokens with projected $12.5k/month savings.
- `examples/memory-architecture-example.md` — three-layer memory design for a multi-session financial coaching app on Postgres + pgvector, including the rolling-summary and entity-extraction prompts.
- `examples/model-router-example.md` — five-task routing scenario across Haiku / Sonnet / Opus with a real cost comparison and the ~$125k/year hard savings from removing trivial-task overpayment.
- `examples/output-validation-example.md` — Zod schema and `safeAICall` wrapper for receipt extraction, with a real malformed Haiku response and the auto-generated repair prompt.
- `examples/observability-example.md` — full PostHog wiring of `trackAICall()`, three live `TokenBudgetMonitor` instances paging via PagerDuty, a real event payload, and four HogQL dashboard queries.

#### Project files
- `README.md` — hero section, 8-solution table, quick start, template and example tables, three real-world use cases.
- `CONTRIBUTING.md` — contribution philosophy, PR process, code style, and issue template references.
- `LICENSE` — MIT.

[Unreleased]: https://github.com/your-org/tokenmaxxing/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/your-org/tokenmaxxing/releases/tag/v1.0.0
