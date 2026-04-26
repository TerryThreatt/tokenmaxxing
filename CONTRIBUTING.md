# Contributing to tokenmaxxing

Thanks for considering a contribution. This project exists to make LLM applications cheaper, faster, and more reliable through repeatable engineering patterns. Contributions should move at least one of those needles measurably.

## Philosophy

A good contribution does one of these things, with evidence:

1. **Improves token efficiency measurably.** A new pattern that cuts tokens, raises cache hit rate, or reduces retries — backed by before/after numbers, not vibes.
2. **Adds a template or example** that an engineer can drop in and use within an hour.
3. **Improves `SKILL.md` clarity.** Better trigger conditions, sharper execution steps, more precise output schemas.

A contribution should not:

- Introduce a new dependency without justifying why an existing one (Anthropic SDK, Zod) won't do.
- Add a feature flag, abstraction, or "future-proof" hook for a use case that doesn't exist yet.
- Restate guidance that is already in `SKILL.md` or another template.

If you're not sure whether your idea fits, open an issue first.

## How to contribute

1. **Fork** the repository to your own GitHub account.
2. **Branch** from `main` using a descriptive name: `feat/python-router`, `docs/clarify-caching-trigger`, `fix/zod-extract-edge-case`.
3. **Commit** in small, reviewable steps. One concern per commit.
4. **Open a PR** against `main` with a description that includes:
   - What changed and why.
   - Measurements if the change is performance-related (token count, cost delta, cache hit rate).
   - A link to the issue this closes, if any.
5. **Respond to review.** PRs are merged once one maintainer approves and CI is green.

## What to contribute

### New templates

- **Python versions of existing TypeScript templates.** `model_router.py`, `session_state.py`, `safe_ai_call.py`, `observability.py`, `prompt_registry.py`. Match the public surface as closely as the language allows: same function names in `snake_case`, same return shapes, Pydantic in place of Zod, dataclasses or `TypedDict` in place of TS interfaces.
- **Other languages** (Go, Rust, Ruby) are welcome but require an example demonstrating the template in a real call site.
- Place TypeScript templates in `templates/` and language ports in `templates/<lang>/`.

### New examples

We want examples from industries beyond fintech. Strong candidates:

- Healthcare scribe / clinical documentation (HIPAA constraints, validation pressure).
- Customer support copilot (memory + handoff to human).
- Coding assistant / agentic loop (long context, tool use, deep reasoning routing).
- E-commerce product Q&A (RAG + cache invalidation patterns).
- Legal document review (extraction + structured output validation).

Each example must be concrete: a real prompt, real numbers, the failure mode the pattern fixed, and what was measured before and after. Generic "you could use this for X" prose is not an example.

### `SKILL.md` improvements

- Sharper trigger phrases (especially additions for ambiguous user intents).
- Clearer execution instructions for any of the 8 solutions.
- Tightened output schemas (fields you'd actually consume, not aspirational ones).
- Better integration notes between solutions.

### New solutions (beyond the current 8)

A new solution must:

- Address a recurring failure mode in production LLM apps that the existing 8 do not cover.
- Have a name and one-line description that fit the existing pattern.
- Include execution instructions, an output schema, integration notes, a template, and an example — same shape as every other solution.
- Be discussed in an issue first; we'd rather refine the existing 8 than grow the surface area carelessly.

## PR requirements

- **A new template must ship with an example.** A template without an example is not a contribution; it's an unfinished sketch.
- **Update `CHANGELOG.md`.** Add your change under `[Unreleased]` in the appropriate section (Added / Changed / Fixed / Removed).
- **Do not break existing golden output tests.** If a behavior change requires a golden update, regenerate it in the same commit and explain the diff in the PR body.
- **No drive-by reformatting.** Keep diffs scoped to the change.
- **No emoji in committed files** (READMEs, examples, code) unless the file already uses them.

## Code style

- **TypeScript strict mode.** `"strict": true` and `"noUncheckedIndexedAccess": true` are non-negotiable.
- **JSDoc on every exported symbol.** Type, public function, class, constant. JSDoc is what users read first; treat it as documentation, not decoration.
- **Zod for all runtime validation.** Use Zod schemas for any boundary between model output and application code. Do not hand-roll validators.
- **No default exports.** Named exports only — they grep cleanly and refactor safely.
- **No `any`.** Use `unknown` and narrow. If you genuinely need `any`, leave a comment explaining why.
- **Errors are typed.** Subclass `Error` and set `name`. Discriminate via a `reason` field where the caller will branch.
- **Pure where possible.** Templates should not maintain hidden global state. The one exception is `observability.ts` — global tracker registration is intentional.

For Python ports: `mypy --strict`, `ruff` clean, Google-style docstrings on every public symbol, Pydantic v2.

## Issue templates

Bug reports, feature requests, and "new solution" proposals each have an issue template under `.github/ISSUE_TEMPLATE/`. Use the matching template — it asks for the information maintainers need to triage quickly. PRs without a matching issue are fine for small fixes; larger work should reference an issue.

## Maintainers

Questions, design discussions, or anything that doesn't fit a template: open a Discussion or an issue with the `question` label. We try to respond within a week.
