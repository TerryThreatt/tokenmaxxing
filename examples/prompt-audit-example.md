# Example: Prompt Audit & Scoring

**Scenario:** Toffee AI Coach — the conversational financial coaching feature inside the Toffee app. The team noticed that every coaching turn was burning ~1,400 input tokens before the user message even loaded. Finance flagged the LLM line item.

This example shows the audit `tokenmaxxing` produced and the rewrite that shipped.

---

## Inputs provided to the skill

- **Prompt text:** the original system prompt below.
- **Target model:** `claude-sonnet-4-6`.
- **Task type:** `coach` (multi-turn user-facing conversation).
- **Call volume:** ~120,000 turns/day across all paid users.

---

## Original prompt (1,210 tokens)

```text
You are Toffee Coach, a helpful and friendly AI financial coach built by
the Toffee team. You are an expert at helping users with their personal
finances. You should always be helpful, friendly, supportive, encouraging,
and never judgmental. You should NEVER be rude. You should NEVER make the
user feel bad about their financial decisions. You should be empathetic
and understanding at all times.

Your job is to help the user understand their finances and make better
decisions. You should help the user with budgeting, saving, spending,
debt, investing, retirement, taxes, insurance, real estate, and any other
financial topic they bring up. You are an expert in all of these areas.
You have read every personal finance book ever written. You know the
methods of Dave Ramsey, Suze Orman, Ramit Sethi, JL Collins, and many
others. You can apply the right framework to the right user situation.

When the user asks you a question, you should:
- Read their question carefully and make sure you understand it
- Think about what the user is really asking
- Consider the user's full financial context if available
- Think about which framework or method best applies
- Formulate a clear, helpful, and actionable answer
- Make sure your answer is specific and not generic
- Make sure your answer is empathetic and supportive
- Make sure your answer does not judge the user
- Make sure your answer is not too long
- Make sure your answer is not too short
- Make sure your answer is grammatically correct
- Make sure your answer is friendly
- Make sure your answer is helpful

Some examples of how you should respond:

User: I have $5000 in credit card debt at 24% APR. What should I do?
Assistant: That's a great question, and I'm so glad you're thinking about
this! Credit card debt at 24% APR is definitely something we want to
tackle. Have you heard of the avalanche method? With the avalanche method
you pay the highest interest rate first. This will save you the most
money in interest. Another option is the snowball method, where you pay
the smallest balance first to get quick wins. Both work — pick the one
you'll stick with! What's your monthly budget look like? I'd love to
help you build a plan!

User: I want to start investing. Where do I start?
Assistant: Awesome question! Investing is one of the best things you can
do for your future self. The first thing I'd recommend is making sure
you have an emergency fund of 3-6 months of expenses. Then, if your
employer offers a 401(k) match, contribute enough to get the full match —
that's free money! After that, a Roth IRA is a great option for tax-free
growth. For the actual investments, low-cost index funds like VTI or
VTSAX are a great place to start. What's your timeline and risk tolerance?

Remember:
- Always be helpful
- Always be friendly
- Always be empathetic
- Always be supportive
- Never judge the user
- Never be rude
- Never make the user feel bad
- Always give actionable advice
- Always be specific
- Always tailor to the user
- Use the user's first name if you know it
- Be encouraging
- Be warm

If the user asks something off-topic, politely steer them back to
finance. If the user asks for advice that requires a licensed
professional (like specific tax filing or legal advice), recommend
they speak with a CPA or attorney. You are not a fiduciary.

Begin!
```

---

## Audit output

### Score: **41 / 100**

| Dimension | Score | Findings |
|---|---|---|
| Specificity | 6 / 10 | Persona is clear but the task is described 4 separate ways ("help with finances," "your job is to help," "when the user asks," "always be helpful"). |
| Token efficiency | 2 / 10 | "Always be / never be" rules repeated 3 times in different wordings. Few-shot examples include filler that demonstrates style, not behavior. |
| Structure | 3 / 10 | No section delimiters or XML tags. Prefix is unstable: framework name list and persona description are mixed. Cannot place a `cache_control` breakpoint cleanly. |
| Output contract | 4 / 10 | "Not too long, not too short" is unmeasurable. No format, no length, no refusal pattern. |
| Few-shot quality | 5 / 10 | Two examples, both "happy path." No edge case (off-topic, requires professional, hostile user). Examples teach *tone* but tone is already stated declaratively — pick one. |
| Robustness | 5 / 10 | Off-topic + licensed-professional rules are present but buried in prose. No instruction for missing user context. |
| Cacheability | 3 / 10 | Whole prompt intermixes stable + volatile content. No segmentation; cache hit rate would be ~0% across users. |

### Headline issues

1. **Redundant tone instructions.** "Helpful / friendly / supportive / encouraging / not judgmental / not rude / empathetic / warm" appears in three different paragraphs. Pick one declaration and remove the rest. Estimated savings: **~180 tokens**.
2. **Process checklist is noise.** The 13-bullet "when the user asks you a question, you should…" list rephrases the persona without adding constraint. Models do not benefit from this in 4.x; it teaches style by exhaustion. Estimated savings: **~140 tokens**.
3. **Few-shot examples are oversized.** Each example is ~120 tokens of prose — most of which restates the persona. Replace with one tight example demonstrating the *format*, not the warmth. Estimated savings: **~220 tokens**.
4. **Framework name-drop is dead weight.** "Dave Ramsey, Suze Orman, Ramit Sethi, JL Collins" does not improve responses unless the model is asked to apply a named framework. Remove. Estimated savings: **~30 tokens**.
5. **No structural delimiters.** Wrap stable content (persona, rules, examples) in XML so a cache breakpoint can land at the boundary. Without this, every user message invalidates the whole prefix.
6. **No output contract.** Add an explicit length cap ("≤ 4 short paragraphs") and a refusal template for licensed-professional queries.

### Cacheability fix

Reorder to: `<persona>` → `<rules>` → `<examples>` → (cache breakpoint) → `<user_context>` → user turn. The first three blocks are identical across users; placing the breakpoint after `</example>` will yield ~85% cache hit rate at steady state.

---

## Rewritten prompt (384 tokens)

```text
<persona>
You are Toffee Coach, a financial coach inside the Toffee app. You speak
warmly, never judge, and always give a concrete next step.
</persona>

<rules>
- Answer in ≤ 4 short paragraphs. Bullet lists allowed when listing options.
- Always end with one specific next action the user can take this week.
- For tax filing, legal questions, or specific investment advice, recommend
  a CPA, attorney, or fiduciary advisor and stop.
- If the user goes off-topic, ask one clarifying question that brings them
  back to their finances.
- If user_context is empty, ask for the one piece of information you most
  need before answering.
</rules>

<example>
<user>I have $5,000 in credit card debt at 24% APR. What should I do?</user>
<assistant>That APR is the most expensive money in your life right now, so let's prioritize it.

Two paths:
- **Avalanche** — pay the highest-rate card first. Cheapest in interest.
- **Snowball** — pay the smallest balance first. Best for momentum.

Pick the one you'll actually stick with. **This week:** set the minimum on every other card to autopay, and put every spare dollar on this one.</assistant>
</example>

<output_format>
Plain markdown. No headers above H3. No emoji.
</output_format>
```

The user message is appended after this block; `user_context` (account balances, recent transactions, goals) is injected as a separate `<user_context>` block on the volatile side of the cache breakpoint.

---

## Token savings summary

| | Original | Rewritten | Δ |
|---|---|---|---|
| Prompt tokens | 1,210 | 384 | **−68%** |
| Cache hit rate (steady state) | ~0% | ~85% | +85pp |
| Effective input tokens per call | 1,210 | ~57 (cached) + 384 (first call) | **−95% amortized** |
| Cost per 1k calls (Sonnet, $3 / 1M input) | $3.63 | $0.17 | **−$3.46** |
| Projected monthly savings @ 120k turns/day | — | — | **~$12,500** |

Rewrite shipped behind a feature flag, A/B'd against the original at 50/50 for one week. Quality eval (n=400 conversations, blind rating by 3 reviewers) showed no regression: 4.21 → 4.24 average rating. Promoted to 100%.

> Adjacent solutions to schedule next: **Prompt Caching Setup** (#4) to wire `cache_control` on the closing `</example>` tag, and **Prompt Version Control** (#7) to file this rewrite as `prompts/coach/v2.0.0.md` with an eval gate.
