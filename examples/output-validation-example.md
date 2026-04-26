# Example: Output Validation Layer

**Scenario:** Toffee's receipt extractor. Users snap a photo of a paper receipt; OCR runs in the mobile client; the OCR text is sent to the server, which calls Claude Haiku to extract structured fields. Those fields go straight into the user's transactions table — so a malformed JSON response is a user-visible bug.

This example shows the Zod schema, the `safeAICall` wrapper in use, and how a real malformed response is repaired in one retry.

---

## Inputs provided to the skill

- **Language:** TypeScript.
- **Output shape:** merchant, total in USD, ISO date, line items with qty + unit price.
- **Failure tolerance:** repair-once. If the second call still fails, fall back to a "needs review" UI state — never write garbage into the transactions table.

---

## Generated Zod schema

```ts
// src/ai/schemas/receipt.ts
import { z } from "zod";

export const ReceiptLineItem = z.object({
  description: z.string().min(1),
  quantity: z.number().positive(),
  unitPriceUsd: z.number().nonnegative(),
});

export const Receipt = z.object({
  merchant: z.string().min(1),
  totalUsd: z.number().positive(),
  /** ISO 8601 date, no time component. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  lineItems: z.array(ReceiptLineItem).min(1),
  /** Tax is optional — many receipts roll it into items. */
  taxUsd: z.number().nonnegative().optional(),
});

export type Receipt = z.infer<typeof Receipt>;
```

---

## `safeAICall` wired up

```ts
// src/ai/extractors/receipt.ts
import { selectModel, TaskType, estimateCostUsd } from "../../templates/model-router";
import { safeAICall, AICallError } from "../../templates/safe-ai-call";
import { trackAICall } from "../../templates/observability";
import { Receipt } from "../schemas/receipt";

const SYSTEM = `<persona>
You extract structured data from OCR'd receipt text.
</persona>

<rules>
- Return ONLY a JSON object matching the schema. No prose, no fences.
- If a field is unreadable or absent, omit it (do not guess).
- Money values are USD numbers, no symbols.
- The date is the receipt's purchase date, ISO format YYYY-MM-DD.
</rules>`;

export interface ExtractResult {
  receipt: Receipt | null;
  needsReview: boolean;
  reason?: string;
}

export async function extractReceipt(
  ocrText: string,
  traceId: string,
): Promise<ExtractResult> {
  const route = selectModel(TaskType.Extract);
  const t0 = Date.now();

  try {
    const { data, attempts, rawOutput } = await safeAICall({
      prompt: `<ocr>\n${ocrText}\n</ocr>`,
      schema: Receipt,
      model: route.model,
      maxTokens: route.maxTokens,
      system: SYSTEM,
      maxRetries: 1,
    });

    await trackAICall({
      model: route.model,
      taskType: TaskType.Extract,
      inputTokens: estimateInputTokens(ocrText),
      outputTokens: estimateOutputTokens(rawOutput),
      cachedTokens: 0,
      latencyMs: Date.now() - t0,
      success: true,
      retryCount: attempts - 1,
      estimatedCostUsd: estimateCostUsd(route, /* in */ 600, /* out */ 350),
      promptVersion: "receipt_extractor@1.1.0",
      featureKey: "receipt_extractor",
      traceId,
    });

    return { receipt: data, needsReview: false };
  } catch (err) {
    if (err instanceof AICallError) {
      await trackAICall({
        model: route.model,
        taskType: TaskType.Extract,
        inputTokens: estimateInputTokens(ocrText),
        outputTokens: 0,
        cachedTokens: 0,
        latencyMs: Date.now() - t0,
        success: false,
        retryCount: err.attempts - 1,
        estimatedCostUsd: 0,
        promptVersion: "receipt_extractor@1.1.0",
        featureKey: "receipt_extractor",
        traceId,
      });

      return { receipt: null, needsReview: true, reason: err.reason };
    }
    throw err;
  }
}
```

The route into the transactions table only fires when `needsReview === false`; otherwise the receipt is held in a `pending_review` queue surfaced in the user's mobile app as "We couldn't read this — tap to fix."

---

## Real malformed response → repair

A receipt photo for a Whole Foods purchase. OCR text:

```
WHOLE FOODS MARKET
SOMA - SAN FRANCISCO
04/22/2026 14:31
ORG BANANAS    1 LB    $0.89
365 OAT MILK   2 EA    $7.98
SOURDOUGH      1 EA    $5.99
SUBTOTAL              $14.86
TAX                    $0.00
TOTAL                 $14.86
```

### Attempt 1 — Haiku response (invalid)

```json
{
  "merchant": "Whole Foods Market",
  "totalUsd": "14.86",
  "date": "04/22/2026",
  "lineItems": [
    { "description": "ORG BANANAS", "quantity": 1, "unitPriceUsd": 0.89 },
    { "description": "365 OAT MILK", "quantity": 2, "unitPriceUsd": 7.98 },
    { "description": "SOURDOUGH", "quantity": 1, "unitPriceUsd": 5.99 }
  ]
}
```

Two validation errors:

```
- totalUsd: Expected number, received string
- date: String must match pattern /^\d{4}-\d{2}-\d{2}$/
```

(The 365 Oat Milk line is `2 EA $7.98` — that's the line total, so unit price should be 3.99. The schema can't catch that semantic error; downstream reconciliation against the user's bank transaction surfaces the discrepancy.)

### Repair prompt (auto-generated by `safeAICall`)

```
Your previous response failed schema validation. Fix it and respond again.

<original_request>
<ocr>
WHOLE FOODS MARKET
...
</ocr>
</original_request>

<previous_response>
{ "merchant": "Whole Foods Market", "totalUsd": "14.86", ... }
</previous_response>

<validation_errors>
- totalUsd: Expected number, received string
- date: String must match pattern /^\d{4}-\d{2}-\d{2}$/
</validation_errors>

Respond with ONLY a valid JSON value matching the schema. No prose, no fences.
```

### Attempt 2 — Haiku response (valid)

```json
{
  "merchant": "Whole Foods Market",
  "totalUsd": 14.86,
  "date": "2026-04-22",
  "lineItems": [
    { "description": "ORG BANANAS", "quantity": 1, "unitPriceUsd": 0.89 },
    { "description": "365 OAT MILK", "quantity": 2, "unitPriceUsd": 7.98 },
    { "description": "SOURDOUGH", "quantity": 1, "unitPriceUsd": 5.99 }
  ],
  "taxUsd": 0
}
```

`Receipt.parse(...)` succeeds. `extractReceipt()` returns `{ receipt, needsReview: false }`. The transaction lands in the user's ledger.

---

## Production stats (last 30 days)

| Metric | Value |
|---|---:|
| Receipts processed | 847,113 |
| Validated on first try | 99.1% |
| Validated on repair retry | 0.8% |
| Sent to manual review | 0.1% |
| Cost per 1k receipts (Haiku, ~600 in / 350 out) | $2.36 |
| Repair retries cost overhead | +$0.02 / 1k (negligible) |

The 0.1% manual-review rate is the actual ceiling; pushing harder via additional retries hurt cost more than it helped accuracy. The same number on Sonnet was 0.07% — not worth 4× cost for 0.03 percentage points.

> Adjacent solutions to schedule next: **Observability** (#6) is already wired above; the next step is to alert when `terminal_failure_rate` on the `receipt_extractor` feature exceeds 0.5% in any 24-hour window — that's the signal a prompt regression has shipped.
