# Example: Memory Architecture for a Financial Coaching App

**Scenario:** Toffee AI Coach. Users return to the app daily; coaching conversations span weeks. The model needs to remember the user's goals, debts, accounts, and prior commitments without re-loading the entire conversation history every turn.

This example shows the three-layer memory architecture `tokenmaxxing` produced.

---

## Feature description (input to the skill)

> "We're building a multi-turn financial coaching feature. Users have linked bank accounts via Plaid (so we have transactions), set 1–3 financial goals at onboarding, and chat with the coach 3–5 times per week. Conversations are 6–12 turns. We need the coach to remember:
> - Goals (e.g. 'save $10k for a wedding by Oct 2026')
> - Stated constraints (e.g. 'I only get paid biweekly', 'I'm helping my mom with rent')
> - Commitments the coach has made (e.g. 'we agreed you'd cancel DoorDash for 30 days')
> - Sensitive context the user shared (e.g. 'going through a divorce') — handled with extra care
>
> Stack: Postgres + pgvector. Per-user, cross-session, single-device for now. PII-sensitive (financial data). No HIPAA but treat like it."

---

## Generated architecture

### Layer 1 — Working memory (in-memory, per request)

- **Backend:** none — lives in the request handler.
- **Contents:** the **last 5 turns** of the current conversation, verbatim.
- **Token budget:** 2,000 tokens hard cap (≈ 5 turns × 400 tokens).
- **Eviction:** FIFO; turn 6 displaces turn 1, which is handed to Layer 2 for compression.

### Layer 2 — Session memory (Postgres row per session)

- **Backend:** Postgres table `coach_sessions`, column `summary text`.
- **Contents:** rolling natural-language abstract of older turns in the *current* session.
- **Token budget:** 800 tokens. Trimmed by the summarizer if it overshoots.
- **Write trigger:** every time `appendTurn()` evicts a turn from working memory, the evicted turn is folded into `summary` via Haiku.
- **Read trigger:** every coaching call, included in the system block.
- **PII handling:** stored encrypted at rest (column-level via pgcrypto). Summary is allowed to reference accounts by *nickname* only, never by account number.

### Layer 3 — Long-term entity memory (Postgres + pgvector)

- **Backend:** Postgres table `coach_entities` (structured) + `coach_notes` (vector-indexed free text).
- **Contents (structured):** `goals`, `constraints`, `commitments`, `sensitive_flags`.
- **Contents (vector):** longer free-text notes ("user mentioned they're saving for a Subaru Outback after their lease ends in March"). Top-3 retrieval per turn.
- **Write trigger:** after each assistant turn, an extraction pass (Haiku) decides whether the turn introduced a new goal/constraint/commitment.
- **Read trigger:** every coaching call. Structured rows are loaded by `user_id`; vector retrieval is keyed on the current user message.
- **Eviction:** structured rows never expire; vector notes age out after 12 months unless re-confirmed.
- **PII handling:** `sensitive_flags` is encrypted; access is logged. Notes flagged sensitive are never included in the model context unless the user references the topic in the current turn.

---

## TypeScript session state

```ts
import type { AISession } from "../templates/session-state";

/** Toffee-specific entity memory carried in `AISession<T>`. */
export interface CoachEntityMemory {
  goals: Array<{
    id: string;
    label: string;          // "Wedding fund"
    targetUsd: number;      // 10000
    targetDate: string;     // ISO date
    progressUsd: number;    // updated by the transactions pipeline
  }>;
  constraints: Array<{
    id: string;
    statement: string;      // "Paid biweekly on Fridays"
    addedAt: number;
  }>;
  commitments: Array<{
    id: string;
    statement: string;      // "Cancel DoorDash for 30 days"
    dueDate?: string;
    status: "open" | "kept" | "broken" | "abandoned";
  }>;
  sensitiveFlags: Array<{
    id: string;
    topic: string;          // "divorce", "job_loss", "medical"
    addedAt: number;
    /** If true, only surface in context when user references it first. */
    quietByDefault: boolean;
  }>;
  recentAccountSnapshot: {
    checkingUsd: number;
    savingsUsd: number;
    creditCardDebtUsd: number;
    asOf: number;
  } | null;
}

/** The session type used everywhere in the coach feature. */
export type CoachSession = AISession<CoachEntityMemory>;
```

---

## Rolling-summary prompt (Layer 2)

Used by `defaultSummarizer` in `templates/session-state.ts`. Calls Haiku.

```text
Update the running summary of this coaching session by folding in the new
turns. Output a tight bulleted summary, ≤ 200 words.

Rules:
- Capture decisions, commitments the coach made, and any new fact the user
  shared (income change, new debt, life event).
- Do NOT include greetings, small talk, or the coach's encouragement.
- Reference accounts by nickname only. Never include account numbers.
- If the user mentioned a sensitive topic (job loss, divorce, illness),
  note it as "sensitive: <topic>" without details.
- Preserve commitments verbatim — the coach will reference them later.

<previous_summary>
{{previousSummary}}
</previous_summary>

<new_turns>
{{turnsToFold}}
</new_turns>

Return only the updated summary.
```

---

## Entity-extraction prompt (Layer 3)

Run after every assistant turn. Output validated by Zod via `safeAICall`.

```text
You are extracting structured memory from a coaching conversation turn.
Return ONLY a JSON object matching the schema below. Use empty arrays if
nothing applies.

Schema:
{
  "newGoals":       Array<{ label: string; targetUsd: number; targetDate: string }>,
  "newConstraints": Array<{ statement: string }>,
  "newCommitments": Array<{ statement: string; dueDate?: string }>,
  "sensitiveFlags": Array<{ topic: string; quietByDefault: boolean }>
}

Rules:
- Only extract things the user *stated*, not things the coach proposed.
- A commitment is a behavior the user agreed to ("I'll cancel DoorDash") or
  the coach committed to on the user's behalf with explicit user buy-in.
- Sensitive topics: divorce, job loss, medical, family death, addiction.
  Default `quietByDefault: true` for these.

<turn>
USER: {{userTurn}}
ASSISTANT: {{assistantTurn}}
</turn>
```

---

## What gets compressed vs. kept raw

| Content | Where it lives | Compressed? |
|---|---|---|
| Current turn (user + assistant) | Working memory | Raw |
| Last 4 prior turns | Working memory | Raw |
| Turns 6+ in current session | Session summary | **Compressed** (Haiku, every eviction) |
| Goals (label, target, progress) | Long-term entities | Raw structured rows |
| Constraints | Long-term entities | Raw structured rows |
| Commitments | Long-term entities | Raw structured rows |
| Free-text notes | Long-term vector | Raw, retrieved top-3 by similarity |
| Account snapshot | Long-term entities | Refreshed nightly from Plaid |
| Sensitive flags | Long-term entities (encrypted) | Surfaced only when user references the topic |

### Context payload at turn 9 of a session

For a single Sonnet call:

```
system:
  <persona>...</persona>                            ← cached, ~120 tok
  <rules>...</rules>                                ← cached, ~140 tok
  <example>...</example>                            ← cached, ~120 tok
  <session_summary>...</session_summary>            ← volatile, ~600 tok
  <entity_memory>{ goals, constraints, ... }</…>    ← volatile, ~400 tok
  <retrieved_notes>...</retrieved_notes>            ← volatile, ~300 tok

messages:
  turn 5 (user)
  turn 5 (assistant)
  turn 6 (user)
  turn 6 (assistant)
  turn 7 (user)
  turn 7 (assistant)
  turn 8 (user)
  turn 8 (assistant)
  turn 9 (user)                                     ← current
```

Total: ~3,400 input tokens — flat regardless of session length, instead of growing linearly past the context window.

> Adjacent solutions to schedule next: **Output Validation Layer** (#5) on the entity extraction prompt — a single bad JSON parse would corrupt long-term memory, and **Observability** (#6) to track summarizer cost per active user.
