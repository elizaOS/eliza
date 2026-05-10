/**
 * Runtime integration for conversation-compactor strategies.
 *
 * The compactors in conversation-compactor.ts operate on structured
 * CompactorTranscript objects (role-tagged messages). The Eliza runtime
 * pipeline at this layer only sees a flat prompt string assembled by the
 * core providers (`# Conversation Messages` block + system prefix
 * + `# Received Message` suffix).
 *
 * This module bridges the two by:
 *   1. Best-effort parsing the prompt string into a CompactorTranscript
 *      (Shape A in the integration design — string-level).
 *   2. Invoking the chosen Compactor strategy.
 *   3. Serializing the compacted transcript back into the prompt, replacing
 *      only the `# Conversation Messages` region and preserving the prefix
 *      and suffix verbatim.
 *
 * Opt-in via `ELIZA_CONVERSATION_COMPACTOR=<strategy>`. When unset, no
 * conversation-level compaction runs and the existing presentation-layer
 * compaction + tail truncation pipeline in prompt-optimization.ts is the
 * only path.
 *
 * TODO(message-level): the cleanest integration is a message-level hook
 * upstream in @elizaos/core that hands the compactor a real transcript
 * before string assembly. Until that exists, the parse/serialize step
 * here is best-effort and intentionally conservative.
 */

import type { AgentRuntime } from "@elizaos/core";
import {
  compactors,
  naiveSummaryCompactor,
} from "./conversation-compactor.ts";
import {
  approxCountTokens,
  type CompactorMessage,
  type CompactorModelCall,
  type CompactorTranscript,
} from "./conversation-compactor.types.ts";

export const STRATEGY_NAMES = [
  "naive-summary",
  "structured-state",
  "hierarchical-summary",
  "hybrid-ledger",
] as const;

export type StrategyName = (typeof STRATEGY_NAMES)[number];

const CONVERSATION_HEADER = "# Conversation Messages";
const RECEIVED_HEADER_RE = /\n#{1,3}\s*Received Message\b/i;

const CONVERSATION_LINE_RE =
  /^(\d{1,2}:\d{2})\s*\(([^)]*)\)\s*(?:\[([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\])?\s*([^:]+):\s*(.*)$/i;

const INTERNAL_THOUGHT_RE = /\([^)]*'s internal thought:[^)]*\)/i;
const ACTIONS_LINE_RE = /\([^)]*'s actions:[^)]*\)/i;

// ---------------------------------------------------------------------------
// Env config
// ---------------------------------------------------------------------------

/**
 * Reads `ELIZA_CONVERSATION_COMPACTOR` from the environment.
 * Returns `null` when unset (compaction is opt-in).
 * Throws when set to a value that is not a known strategy name.
 */
export function selectStrategyFromEnv(): StrategyName | null {
  const raw = process.env.ELIZA_CONVERSATION_COMPACTOR;
  if (raw === undefined || raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if ((STRATEGY_NAMES as readonly string[]).includes(trimmed)) {
    return trimmed as StrategyName;
  }
  throw new Error(
    `ELIZA_CONVERSATION_COMPACTOR=${trimmed} is invalid. ` +
      `Expected one of: ${STRATEGY_NAMES.join(", ")}`,
  );
}

// ---------------------------------------------------------------------------
// Parse: prompt string -> CompactorTranscript
// ---------------------------------------------------------------------------

type ConversationRegion = {
  /** Verbatim text before `# Conversation Messages`. Empty string when missing. */
  prefix: string;
  /** Verbatim text starting at `# Conversation Messages`, ending at the
   *  start of `# Received Message` (or end of prompt). Includes the header. */
  region: string;
  /** Verbatim text from `# Received Message` to end of prompt, or empty. */
  suffix: string;
};

function locateConversationRegion(prompt: string): ConversationRegion | null {
  const start = prompt.indexOf(CONVERSATION_HEADER);
  if (start === -1) return null;
  const tailSearch = prompt.slice(start);
  const tailMatch = tailSearch.match(RECEIVED_HEADER_RE);
  const endOffset =
    tailMatch && typeof tailMatch.index === "number"
      ? start + tailMatch.index
      : prompt.length;
  return {
    prefix: prompt.slice(0, start),
    region: prompt.slice(start, endOffset),
    suffix: prompt.slice(endOffset),
  };
}

type ParsedMessageLine = {
  /** Inferred role: "assistant" if the message has an attached internal
   *  thought / actions list (those only appear on agent turns), else "user". */
  role: "user" | "assistant";
  /** The full multi-line block for this message, verbatim minus trailing newline. */
  raw: string;
  /** The speaker name extracted from the header line ("Eliza", "User", etc.). */
  name: string;
  /** Just the spoken text, no thought / action annotations. */
  text: string;
  /** The original timestamp string ("12:53"). */
  time?: string;
};

function parseConversationBody(body: string): ParsedMessageLine[] {
  const lines = body.split("\n");
  const blocks: string[][] = [];
  let current: string[] | null = null;

  for (const line of lines) {
    if (CONVERSATION_LINE_RE.test(line.trim())) {
      if (current) blocks.push(current);
      current = [line];
    } else if (current) {
      current.push(line);
    }
    // Lines before any header line are dropped — they belong to the section
    // header itself, not to any message.
  }
  if (current) blocks.push(current);

  const messages: ParsedMessageLine[] = [];
  for (const block of blocks) {
    const headerLine = block[0].trim();
    const match = headerLine.match(CONVERSATION_LINE_RE);
    if (!match) continue;
    const [, time, , , name, text] = match;
    const blockText = block.join("\n");
    const role: "user" | "assistant" =
      INTERNAL_THOUGHT_RE.test(blockText) || ACTIONS_LINE_RE.test(blockText)
        ? "assistant"
        : "user";
    messages.push({
      role,
      raw: blockText,
      name: name.trim(),
      text: text.trim(),
      time,
    });
  }
  return messages;
}

/**
 * Best-effort split of an Eliza-assembled prompt into a CompactorTranscript.
 *
 * Strategy:
 *   - Everything before `# Conversation Messages` becomes a single
 *     system-role message (so the compactor preserves it verbatim — system
 *     prefix is index 0 and is never summarized).
 *   - Each turn inside the conversation block becomes one CompactorMessage,
 *     role = "assistant" if the block has an internal-thought / actions
 *     annotation (those only appear on agent turns) else "user".
 *   - Everything from `# Received Message` to end-of-prompt is appended as
 *     a final user message (so the active turn stays in the preserved tail).
 *
 * Failure modes:
 *   - If `# Conversation Messages` is absent, returns a single user-message
 *     transcript containing the whole prompt. Downstream compaction will
 *     then no-op safely (no region to summarize).
 */
export function parsePromptToTranscript(prompt: string): CompactorTranscript {
  const region = locateConversationRegion(prompt);
  if (!region) {
    return {
      messages: [{ role: "user", content: prompt }],
      metadata: { parseFallback: true },
    };
  }

  // The conversation region always starts with the literal header. Strip
  // the header line so the body parser doesn't have to special-case it.
  const headerStripped = region.region.slice(CONVERSATION_HEADER.length);
  const parsed = parseConversationBody(headerStripped);

  const messages: CompactorMessage[] = [];
  if (region.prefix.trim().length > 0) {
    messages.push({
      role: "system",
      content: region.prefix.replace(/\n+$/, ""),
    });
  }
  for (const m of parsed) {
    messages.push({
      role: m.role,
      content: m.raw,
    });
  }
  if (region.suffix.trim().length > 0) {
    messages.push({
      role: "user",
      content: region.suffix.replace(/^\n+/, ""),
    });
  }

  return {
    messages,
    metadata: {
      parseFallback: false,
      prefixChars: region.prefix.length,
      regionChars: region.region.length,
      suffixChars: region.suffix.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Serialize: CompactorTranscript -> prompt string
// ---------------------------------------------------------------------------

function renderCompactedMessage(m: CompactorMessage): string {
  // Replacement messages emitted by the compactor do not have the
  // `HH:MM (...) [uuid] Name: text` header format; render them with a
  // role-prefixed marker instead. The downstream model sees these as
  // synthesized summaries and has no risk of confusing them with real
  // conversation turns.
  const tag = m.tags && m.tags.length > 0 ? ` [${m.tags.join(",")}]` : "";
  switch (m.role) {
    case "system":
      return `[system summary${tag}] ${m.content}`;
    case "assistant":
      return `[Agent${tag}] ${m.content}`;
    case "tool":
      return `[Tool${m.toolName ? `:${m.toolName}` : ""}${tag}] ${m.content}`;
    default:
      return m.content;
  }
}

/**
 * Replaces the `# Conversation Messages` region in `original` with a
 * compacted version derived from `compacted`. Preserves the prefix and
 * suffix (`# Received Message`...) verbatim.
 *
 * Messages whose `content` matches the original raw block format
 * (i.e. preserved-tail entries we passed through unchanged) are emitted
 * exactly as they appeared. Synthesized replacement messages are
 * rendered with `renderCompactedMessage` to keep them visually distinct.
 *
 * If `original` does not contain a `# Conversation Messages` section,
 * the original prompt is returned unchanged.
 */
export function serializeTranscriptToPrompt(
  original: string,
  compacted: CompactorTranscript,
): string {
  const region = locateConversationRegion(original);
  if (!region) return original;

  const parts: string[] = [];
  for (const m of compacted.messages) {
    if (m.role === "system") {
      // System-role messages were pulled from the prefix or were synthesized
      // by the compactor. Either way they belong in the system prefix area,
      // not in the conversation region — but we don't have a clean home for
      // them here, so we render them as a summary marker inline.
      const looksLikePrefix =
        m.content.includes(CONVERSATION_HEADER) ||
        (region.prefix.length > 0 && region.prefix.includes(m.content));
      if (looksLikePrefix) continue; // will be re-emitted via region.prefix
      parts.push(renderCompactedMessage(m));
      continue;
    }
    if (m.role === "user" && region.suffix.length > 0) {
      // Last message that matches the suffix verbatim is the active turn —
      // it gets re-emitted via region.suffix below, skip it here.
      const stripped = m.content.replace(/^\n+/, "");
      const suffixStripped = region.suffix.replace(/^\n+/, "");
      if (stripped === suffixStripped) continue;
    }
    // Preserved-tail entries arrive with their original raw header line —
    // they already include `HH:MM (...) [uuid] Name:` so emit verbatim.
    if (CONVERSATION_LINE_RE.test(m.content.split("\n")[0]?.trim() ?? "")) {
      parts.push(m.content);
    } else {
      parts.push(renderCompactedMessage(m));
    }
  }

  const newRegion = `${CONVERSATION_HEADER}\n${parts.join("\n")}`;
  return `${region.prefix}${newRegion}${
    region.suffix.startsWith("\n") ? "" : "\n"
  }${region.suffix}`;
}

// ---------------------------------------------------------------------------
// Apply: invoke a strategy if the prompt is over budget
// ---------------------------------------------------------------------------

export type ApplyConversationCompactionArgs = {
  prompt: string;
  strategy: StrategyName;
  /** Current prompt token count (already estimated by the caller). */
  currentTokens: number;
  /** Token budget the prompt must fit into. */
  targetTokens: number;
  /** Wraps `runtime.useModel(TEXT_LARGE, ...)`; required for summarizers. */
  callModel: CompactorModelCall;
  /** Optional — used only for telemetry / logger hookup. */
  runtime?: AgentRuntime;
  /** Optional — message-count to preserve verbatim at the tail. */
  preserveTailMessages?: number;
};

export type ApplyConversationCompactionResult = {
  prompt: string;
  didCompact: boolean;
  originalTokens: number;
  compactedTokens: number;
  latencyMs: number;
  strategy: StrategyName | null;
};

/**
 * Main entry point for runtime conversation-level compaction.
 *
 * No-ops when `currentTokens <= targetTokens`. Otherwise parses the prompt,
 * runs the selected strategy, serializes back, and returns the result.
 * Always returns; never throws on a parse-failure path (falls back to
 * the original prompt with `didCompact: false`).
 */
export async function applyConversationCompaction(
  args: ApplyConversationCompactionArgs,
): Promise<ApplyConversationCompactionResult> {
  const startedAt = Date.now();
  const originalTokens = args.currentTokens;

  if (args.currentTokens <= args.targetTokens) {
    return {
      prompt: args.prompt,
      didCompact: false,
      originalTokens,
      compactedTokens: originalTokens,
      latencyMs: 0,
      strategy: args.strategy,
    };
  }

  const strategyImpl = compactors[args.strategy] ?? naiveSummaryCompactor;
  const transcript = parsePromptToTranscript(args.prompt);

  // Bail when the parser had no conversation region to bite into — running
  // a summarizer on a single user-message blob is wasted spend.
  if (transcript.metadata?.parseFallback === true) {
    return {
      prompt: args.prompt,
      didCompact: false,
      originalTokens,
      compactedTokens: originalTokens,
      latencyMs: Date.now() - startedAt,
      strategy: args.strategy,
    };
  }

  const artifact = await strategyImpl.compact(transcript, {
    targetTokens: args.targetTokens,
    callModel: args.callModel,
    countTokens: approxCountTokens,
    ...(args.preserveTailMessages !== undefined
      ? { preserveTailMessages: args.preserveTailMessages }
      : {}),
  });

  // Reconstruct a transcript = systemPrefix + replacement + preservedTail.
  // The compactor returned only the replacement; we need to combine with
  // the boundary it computed. Easiest: re-split the original transcript
  // and rebuild here.
  const systemOffset =
    transcript.messages[0]?.role === "system" ? 1 : 0;
  // The compactor uses findSafeCompactionBoundary internally; mirror its
  // default tail size unless the caller overrode it.
  const preserveTail = args.preserveTailMessages ?? 6;
  const total = transcript.messages.length;
  const naiveBoundary = Math.max(systemOffset, total - preserveTail);
  const systemPrefix =
    systemOffset === 1 ? [transcript.messages[0]] : [];
  const preservedTail = transcript.messages.slice(naiveBoundary);
  const compactedTranscript: CompactorTranscript = {
    messages: [
      ...systemPrefix,
      ...artifact.replacementMessages,
      ...preservedTail,
    ],
    metadata: transcript.metadata,
  };

  const compactedPrompt = serializeTranscriptToPrompt(
    args.prompt,
    compactedTranscript,
  );
  const compactedTokens = Math.ceil(compactedPrompt.length / 4);

  return {
    prompt: compactedPrompt,
    didCompact: compactedPrompt !== args.prompt,
    originalTokens,
    compactedTokens,
    latencyMs: Date.now() - startedAt,
    strategy: args.strategy,
  };
}
