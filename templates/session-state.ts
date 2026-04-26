/**
 * session-state.ts
 *
 * A typed, three-layer session container:
 *   - recentTurns       : last N turns verbatim (working memory)
 *   - sessionSummary    : rolling abstract of older turns (session memory)
 *   - entityMemory<T>   : structured, app-specific facts (long-term memory)
 *
 * Callers never send raw history to the model. Build a payload with
 * `buildContextPayload()`; compress periodically with `compressSession()`.
 */

import Anthropic from "@anthropic-ai/sdk";

/** Maximum recent turns kept verbatim. Older turns are folded into the summary. */
export const RECENT_TURNS_LIMIT = 5;

/** Threshold at which `compressSession()` will fold older turns into the summary. */
export const COMPRESSION_THRESHOLD = RECENT_TURNS_LIMIT;

/** A single conversational turn. Keep this minimal — store metadata on entityMemory. */
export interface Turn {
  role: "user" | "assistant";
  content: string;
  /** Unix ms — useful for age-based retention. */
  timestamp: number;
}

/**
 * Generic session state. The `entityMemory` slot is generic so each app can
 * carry its own typed facts (e.g. extracted profile fields, RAG cursors).
 */
export interface AISession<T> {
  userId: string;
  sessionId: string;
  /** Unix ms. */
  createdAt: number;
  /** Unix ms. Update on every mutation. */
  lastUpdatedAt: number;
  /** Total turns observed across the session, including compressed ones. */
  turnCount: number;
  /** Rolling abstract of older turns. Empty until first compression. */
  sessionSummary: string;
  /** The most recent turns kept verbatim. Length <= RECENT_TURNS_LIMIT. */
  recentTurns: Turn[];
  /** App-specific structured memory (preferences, profile, cursors, etc.). */
  entityMemory: T;
}

/** Construct an empty session for a new user/session pair. */
export function createSession<T>(
  userId: string,
  sessionId: string,
  initialEntityMemory: T,
): AISession<T> {
  const now = Date.now();
  return {
    userId,
    sessionId,
    createdAt: now,
    lastUpdatedAt: now,
    turnCount: 0,
    sessionSummary: "",
    recentTurns: [],
    entityMemory: initialEntityMemory,
  };
}

/**
 * Append a turn to the session. Returns a new session object — does not mutate
 * the input. Trims `recentTurns` to RECENT_TURNS_LIMIT; older turns will be
 * folded into the summary on the next `compressSession()` call.
 */
export function appendTurn<T>(session: AISession<T>, turn: Turn): AISession<T> {
  const recentTurns = [...session.recentTurns, turn].slice(-RECENT_TURNS_LIMIT);
  return {
    ...session,
    turnCount: session.turnCount + 1,
    lastUpdatedAt: Date.now(),
    recentTurns,
  };
}

/**
 * Summarizer signature. Defaults to an Anthropic Haiku call but can be
 * replaced with any function (deterministic stub in tests, a different
 * provider, etc.).
 */
export type Summarizer = (input: {
  previousSummary: string;
  turnsToFold: Turn[];
}) => Promise<string>;

/**
 * Default summarizer using Anthropic Haiku. Cheap and good enough for
 * compressing small batches of conversational turns into a paragraph.
 */
export const defaultSummarizer: Summarizer = async ({
  previousSummary,
  turnsToFold,
}) => {
  const client = new Anthropic();
  const transcript = turnsToFold
    .map((t) => `${t.role.toUpperCase()}: ${t.content}`)
    .join("\n");

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 512,
    messages: [
      {
        role: "user",
        content:
          `Update the running session summary by folding in the new turns. ` +
          `Keep it under 200 words and prefer bullet points for stable facts.\n\n` +
          `<previous_summary>\n${previousSummary || "(empty)"}\n</previous_summary>\n\n` +
          `<new_turns>\n${transcript}\n</new_turns>\n\n` +
          `Return only the updated summary.`,
      },
    ],
  });

  const block = response.content[0];
  return block && block.type === "text" ? block.text.trim() : previousSummary;
};

/**
 * Compress a session: if `turnCount` exceeds the threshold and there are
 * older turns sitting outside `recentTurns`, fold them into `sessionSummary`.
 *
 * Because `appendTurn()` already trims to RECENT_TURNS_LIMIT, this function
 * primarily updates the summary using the *currently visible* turns when the
 * caller has been buffering turns elsewhere. To support that pattern, callers
 * may pass `pendingOldTurns` — turns popped from the head of the buffer.
 *
 * @param session         current session
 * @param pendingOldTurns optional turns to fold (usually the ones evicted
 *                        from `recentTurns` by `appendTurn`)
 * @param summarize       summarizer override (defaults to Haiku)
 * @returns a new session with an updated `sessionSummary`
 */
export async function compressSession<T>(
  session: AISession<T>,
  pendingOldTurns: Turn[] = [],
  summarize: Summarizer = defaultSummarizer,
): Promise<AISession<T>> {
  if (session.turnCount <= COMPRESSION_THRESHOLD && pendingOldTurns.length === 0) {
    return session;
  }
  if (pendingOldTurns.length === 0) {
    return session;
  }

  const updatedSummary = await summarize({
    previousSummary: session.sessionSummary,
    turnsToFold: pendingOldTurns,
  });

  return {
    ...session,
    sessionSummary: updatedSummary,
    lastUpdatedAt: Date.now(),
  };
}

/** Shape sent to the model — never expose raw `recentTurns` directly outside this module. */
export interface ContextPayload {
  systemContext: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}

/**
 * Build the minimal payload to send to the model. Composes:
 *   - `sessionSummary` and `entityMemory` into a single system block
 *   - `recentTurns` as the message array (verbatim)
 *
 * The model never sees the full history — the summary is the model's view
 * of older context.
 */
export function buildContextPayload<T>(
  session: AISession<T>,
  systemPrompt: string,
): ContextPayload {
  const memoryBlock =
    session.sessionSummary || hasFields(session.entityMemory)
      ? [
          session.sessionSummary
            ? `<session_summary>\n${session.sessionSummary}\n</session_summary>`
            : "",
          hasFields(session.entityMemory)
            ? `<entity_memory>\n${JSON.stringify(session.entityMemory, null, 2)}\n</entity_memory>`
            : "",
        ]
          .filter(Boolean)
          .join("\n\n")
      : "";

  const systemContext = memoryBlock
    ? `${systemPrompt}\n\n${memoryBlock}`
    : systemPrompt;

  return {
    systemContext,
    messages: session.recentTurns.map((t) => ({ role: t.role, content: t.content })),
  };
}

function hasFields(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value !== "object") return false;
  return Object.keys(value as Record<string, unknown>).length > 0;
}
