/**
 * safe-ai-call.ts
 *
 * Validated wrapper around the Anthropic Messages API. Every structured call
 * in the application should go through `safeAICall<T>()`:
 *
 *   1. Calls the model with the user-supplied prompt.
 *   2. Extracts the first JSON block from the response.
 *   3. Validates it against the supplied Zod schema.
 *   4. On parse/validation failure, generates a corrective prompt and retries
 *      up to `maxRetries` times.
 *   5. Throws a typed `AICallError` on terminal failure.
 *
 * Never return unvalidated model output to downstream code.
 */

import Anthropic from "@anthropic-ai/sdk";
import { z, ZodError, ZodSchema } from "zod";
import { ClaudeModel } from "./model-router.js";

/** Reasons a `safeAICall` can terminally fail. */
export type AICallErrorReason =
  | "validation_failed"   // schema rejected the model output after all retries
  | "no_text_response"    // model returned no text content blocks
  | "transport_error"     // SDK / network error not recovered by retries
  | "max_retries_exceeded"; // generic terminal-after-retries

/** Typed error thrown by `safeAICall` on terminal failure. */
export class AICallError extends Error {
  constructor(
    message: string,
    public readonly reason: AICallErrorReason,
    public readonly attempts: number,
    public readonly lastRawOutput?: string,
    public readonly lastValidationError?: ZodError,
  ) {
    super(message);
    this.name = "AICallError";
  }
}

/** Arguments to `safeAICall`. */
export interface SafeAICallArgs<T> {
  /** Prompt sent as the user message on the first attempt. */
  prompt: string;
  /** Zod schema the response must validate against. */
  schema: ZodSchema<T>;
  /** Anthropic model ID. Use the value from `selectModel()`. */
  model: ClaudeModel;
  /** Max completion tokens. */
  maxTokens?: number;
  /** Optional system prompt; cacheable prefix should live here. */
  system?: string;
  /** Repair retries after a validation failure. Default 1. */
  maxRetries?: number;
  /** Anthropic SDK client. Inject for tests; defaults to a fresh client. */
  client?: Anthropic;
}

/** Successful result. */
export interface SafeAICallResult<T> {
  data: T;
  /** Number of model calls made (1 + repair attempts). */
  attempts: number;
  /** Raw text of the final, validated response. */
  rawOutput: string;
}

/**
 * Make a validated call to Anthropic. Returns parsed, type-safe data or throws.
 *
 * @example
 *   const Profile = z.object({ name: z.string(), age: z.number() });
 *   const { data } = await safeAICall({
 *     prompt: "Extract profile from: ...",
 *     schema: Profile,
 *     model: "claude-haiku-4-5-20251001",
 *   });
 */
export async function safeAICall<T>(args: SafeAICallArgs<T>): Promise<SafeAICallResult<T>> {
  const {
    prompt,
    schema,
    model,
    maxTokens = 1024,
    system,
    maxRetries = 1,
    client = new Anthropic(),
  } = args;

  let attempts = 0;
  let lastRaw = "";
  let lastValidationError: ZodError | undefined;
  let currentPrompt = prompt;
  const totalBudget = 1 + maxRetries;

  while (attempts < totalBudget) {
    attempts++;
    let rawText: string;

    try {
      const response = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: currentPrompt }],
      });

      const textBlock = response.content.find((b) => b.type === "text");
      if (!textBlock || textBlock.type !== "text") {
        throw new AICallError(
          "Model returned no text content blocks.",
          "no_text_response",
          attempts,
        );
      }
      rawText = textBlock.text;
      lastRaw = rawText;
    } catch (err) {
      if (err instanceof AICallError) throw err;
      // Transport / SDK error — do not consume a repair attempt; rethrow typed.
      throw new AICallError(
        `Anthropic transport error: ${err instanceof Error ? err.message : String(err)}`,
        "transport_error",
        attempts,
      );
    }

    const candidate = extractJson(rawText);
    const parsed = schema.safeParse(candidate);

    if (parsed.success) {
      return { data: parsed.data, attempts, rawOutput: rawText };
    }

    lastValidationError = parsed.error;

    if (attempts >= totalBudget) break;

    currentPrompt = buildRepairPrompt(prompt, rawText, parsed.error);
  }

  throw new AICallError(
    `safeAICall: schema validation failed after ${attempts} attempt(s).`,
    "validation_failed",
    attempts,
    lastRaw,
    lastValidationError,
  );
}

/**
 * Extract a JSON value from raw model text. Handles three cases:
 *   1. The whole response is JSON.
 *   2. JSON is wrapped in ```json ... ``` fences.
 *   3. JSON is embedded in prose (best-effort: first balanced { ... } or [ ... ]).
 */
export function extractJson(raw: string): unknown {
  const trimmed = raw.trim();

  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }

  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fence && fence[1]) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      /* fall through */
    }
  }

  const balanced = findBalancedJson(trimmed);
  if (balanced) {
    try {
      return JSON.parse(balanced);
    } catch {
      /* fall through */
    }
  }

  return undefined;
}

/** Best-effort extraction of the first balanced `{...}` or `[...]` substring. */
function findBalancedJson(s: string): string | null {
  const start = s.search(/[{[]/);
  if (start === -1) return null;
  const open = s[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/** Compose the corrective prompt sent on a repair attempt. */
function buildRepairPrompt(
  originalPrompt: string,
  badOutput: string,
  err: ZodError,
): string {
  const issues = err.issues
    .map((i) => `- ${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("\n");

  return [
    "Your previous response failed schema validation. Fix it and respond again.",
    "",
    "<original_request>",
    originalPrompt,
    "</original_request>",
    "",
    "<previous_response>",
    badOutput,
    "</previous_response>",
    "",
    "<validation_errors>",
    issues,
    "</validation_errors>",
    "",
    "Respond with ONLY a valid JSON value matching the schema. No prose, no fences.",
  ].join("\n");
}

/** Re-export Zod for convenience so callers don't need a separate import. */
export { z };
