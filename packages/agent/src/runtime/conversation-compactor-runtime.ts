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
  findSafeCompactionBoundary,
  naiveSummaryCompactor,
} from "./conversation-compactor.ts";
import {
  approxCountTokens,
  type CompactionStats,
  type CompactorMessage,
  type CompactorModelCall,
  type CompactorTranscript,
  countTranscriptTokens,
} from "./conversation-compactor.types.ts";

export const STRATEGY_NAMES = [
  "naive-summary",
  "structured-state",
  "hierarchical-summary",
  "hybrid-ledger",
] as const;

export type StrategyName = (typeof STRATEGY_NAMES)[number];

const CONVERSATION_HEADER = "# Conversation Messages";
const CONVERSATION_HEADER_RE = /^#{1,3}\s*Conversation Messages\b/gim;
const RECEIVED_HEADER_RE = /\n#{1,3}\s*Received Message\b/gi;

// Match any of:
//   "12:53 (17 minutes ago) [uuid] Eliza: text"  ← canonical Eliza recorder
//   "12:53 (17 minutes ago) Eliza: text"          ← without uuid
//   "12:53 Eliza: text"                            ← minimal (dev/tests)
// All four capture groups (time, relative, uuid, name, text) are returned, but
// only `time` and the trailing `name: text` are required.
const CONVERSATION_LINE_RE =
  /^(\d{1,2}:\d{2})(?:\s*\(([^)]*)\))?(?:\s*\[([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\])?\s*([^:]+?):\s*(.*)$/i;

const INTERNAL_THOUGHT_RE = /\([^)]*'s internal thought:[^)]*\)/i;
const ACTIONS_LINE_RE = /\([^)]*'s actions:[^)]*\)/i;
const USER_SPEAKER_RE = /^(?:user|operator|human|client|customer|system)$/i;
const ASSISTANT_SPEAKER_RE =
  /^(?:eliza|eliza|agent|assistant|bot|ai)(?:\s*\([^)]*\))?$/i;
const SYNTHETIC_MARKER_LINE_RE =
  /^\[(system summary|Agent|Tool(?::([^\]\s]+))?)(?:\s+\[([^\]]*)\])?\]\s*(.*)$/i;
const REPLACEMENT_OVERHEAD_TOKENS = 32;

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
  const receivedMatches = [...prompt.matchAll(RECEIVED_HEADER_RE)];
  const lastReceived = receivedMatches.at(-1);
  const receivedStart =
    lastReceived && typeof lastReceived.index === "number"
      ? lastReceived.index
      : prompt.length;
  const conversationMatches = [...prompt.matchAll(CONVERSATION_HEADER_RE)];
  const startMatch = conversationMatches
    .filter(
      (match) => typeof match.index === "number" && match.index < receivedStart,
    )
    .at(-1);
  if (!startMatch || typeof startMatch.index !== "number") return null;
  const start = startMatch.index;
  const endOffset = receivedStart > start ? receivedStart : prompt.length;
  return {
    prefix: prompt.slice(0, start),
    region: prompt.slice(start, endOffset),
    suffix: prompt.slice(endOffset),
  };
}

type ParsedMessageLine = {
  /** Inferred role: "assistant" if the message has an attached internal
   *  thought / actions list (those only appear on agent turns), else "user". */
  role: CompactorMessage["role"];
  /** The full multi-line block for this message, verbatim minus trailing newline. */
  raw: string;
  /** The speaker name extracted from the header line ("Eliza", "User", etc.). */
  name: string;
  /** Just the spoken text, no thought / action annotations. */
  text: string;
  /** The original timestamp string ("12:53"). */
  time?: string;
  /** Tags from a runtime-emitted synthetic marker. */
  tags?: string[];
  /** Tool name from a runtime-emitted synthetic tool marker. */
  toolName?: string;
};

function parseSyntheticMarkerLine(line: string): {
  role: CompactorMessage["role"];
  text: string;
  name: string;
  tags?: string[];
  toolName?: string;
} | null {
  const match = line.trim().match(SYNTHETIC_MARKER_LINE_RE);
  if (!match) return null;
  const marker = match[1]?.toLowerCase() ?? "";
  const tagText = match[3]?.trim() ?? "";
  const tags = tagText
    ? tagText
        .split(",")
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0)
    : undefined;
  if (marker.startsWith("system summary")) {
    return {
      role: "system",
      name: "system summary",
      text: match[4]?.trim() ?? "",
      ...(tags ? { tags } : {}),
    };
  }
  if (marker.startsWith("tool")) {
    const toolName = match[2]?.trim();
    return {
      role: "tool",
      name: toolName ? `Tool:${toolName}` : "Tool",
      text: match[4]?.trim() ?? "",
      ...(tags ? { tags } : {}),
      ...(toolName ? { toolName } : {}),
    };
  }
  return {
    role: "assistant",
    name: "Agent",
    text: match[4]?.trim() ?? "",
    ...(tags ? { tags } : {}),
  };
}

function parseConversationBody(body: string): ParsedMessageLine[] {
  const lines = body.split("\n");
  const blocks: string[][] = [];
  let current: string[] | null = null;

  for (const line of lines) {
    const match = line.trim().match(CONVERSATION_LINE_RE);
    const synthetic = parseSyntheticMarkerLine(line);
    const speaker = match?.[4]?.trim() ?? "";
    const canonicalTurn = Boolean(match?.[2] || match?.[3]);
    const knownSpeaker =
      USER_SPEAKER_RE.test(speaker) || ASSISTANT_SPEAKER_RE.test(speaker);
    if (
      synthetic ||
      (match && (current === null || canonicalTurn || knownSpeaker))
    ) {
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
    const synthetic = parseSyntheticMarkerLine(headerLine);
    if (synthetic) {
      const contentLines = [synthetic.text, ...block.slice(1)].filter(
        (line, index) => index > 0 || line.length > 0,
      );
      const raw = contentLines.join("\n");
      messages.push({
        role: synthetic.role,
        raw,
        name: synthetic.name,
        text: synthetic.text,
        ...(synthetic.tags ? { tags: synthetic.tags } : {}),
        ...(synthetic.toolName ? { toolName: synthetic.toolName } : {}),
      });
      continue;
    }
    const match = headerLine.match(CONVERSATION_LINE_RE);
    if (!match) continue;
    const [, time, , , name, text] = match;
    const blockText = block.join("\n");
    const normalizedName = name.trim();
    const isUserSpeaker = USER_SPEAKER_RE.test(normalizedName);
    const isAssistantSpeaker = ASSISTANT_SPEAKER_RE.test(normalizedName);
    const role: "user" | "assistant" =
      !isUserSpeaker &&
      (isAssistantSpeaker ||
        INTERNAL_THOUGHT_RE.test(blockText) ||
        ACTIONS_LINE_RE.test(blockText))
        ? "assistant"
        : "user";
    messages.push({
      role,
      raw: blockText,
      name: normalizedName,
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

  // Strip the section header line so the body parser doesn't have to
  // special-case it.
  const headerStripped = region.region.replace(
    /^#{1,3}\s*Conversation Messages\b[^\n]*(?:\n)?/i,
    "",
  );
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
      ...(m.tags ? { tags: m.tags } : {}),
      ...(m.toolName ? { toolName: m.toolName } : {}),
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
  targetTokens: number;
  replacementTargetTokens: number;
  artifact?: {
    replacementMessageCount: number;
    stats: CompactionArtifactStats;
  };
  skipReason?: string;
};

export type ApplyConversationMessageCompactionArgs = {
  messages: CompactorMessage[];
  strategy: StrategyName;
  /** Current message token count (already estimated by caller when known). */
  currentTokens: number;
  /** Token budget the message list must fit into. */
  targetTokens: number;
  /** Wraps `runtime.useModel(TEXT_LARGE, ...)`; required for summarizers. */
  callModel: CompactorModelCall;
  /** Optional — message-count to preserve verbatim at the tail. */
  preserveTailMessages?: number;
};

export type ApplyConversationMessageCompactionResult = Omit<
  ApplyConversationCompactionResult,
  "prompt"
> & {
  messages: CompactorMessage[];
};

type CompactionArtifactStats = {
  originalMessageCount: CompactionStats["originalMessageCount"];
  compactedMessageCount: CompactionStats["compactedMessageCount"];
  originalTokens: CompactionStats["originalTokens"];
  compactedTokens: CompactionStats["compactedTokens"];
  summarizationModel?: CompactionStats["summarizationModel"];
  latencyMs: CompactionStats["latencyMs"];
  extra?: CompactionStats["extra"];
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
      targetTokens: args.targetTokens,
      replacementTargetTokens: args.targetTokens,
      skipReason: "not-over-budget",
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
      targetTokens: args.targetTokens,
      replacementTargetTokens: args.targetTokens,
      skipReason: "parse-fallback",
    };
  }

  const systemOffset = transcript.messages[0]?.role === "system" ? 1 : 0;
  const hasActiveSuffix = Boolean(
    locateConversationRegion(args.prompt)?.suffix.trim().length,
  );
  const preserveTail = Math.max(
    args.preserveTailMessages ?? 6,
    hasActiveSuffix ? 1 : 0,
  );
  const boundary = findSafeCompactionBoundary(
    transcript.messages,
    preserveTail,
  );
  const systemPrefix = systemOffset === 1 ? [transcript.messages[0]] : [];
  const preservedTail = transcript.messages.slice(boundary);
  const nonCompactableTokens = approxCountTokens(
    [...systemPrefix, ...preservedTail].map((m) => m.content).join("\n"),
  );
  const viableReplacementTokens =
    args.targetTokens - nonCompactableTokens - REPLACEMENT_OVERHEAD_TOKENS;
  const minimumReplacementBudget = Math.min(64, args.targetTokens);
  if (viableReplacementTokens < minimumReplacementBudget) {
    return {
      prompt: args.prompt,
      didCompact: false,
      originalTokens,
      compactedTokens: originalTokens,
      latencyMs: Date.now() - startedAt,
      strategy: args.strategy,
      targetTokens: args.targetTokens,
      replacementTargetTokens: Math.max(0, viableReplacementTokens),
      skipReason: "noncompactable-over-budget",
    };
  }
  const replacementTargetTokens = Math.max(
    minimumReplacementBudget,
    Math.min(args.targetTokens, viableReplacementTokens),
  );

  const artifact = await strategyImpl.compact(transcript, {
    targetTokens: replacementTargetTokens,
    callModel: args.callModel,
    countTokens: approxCountTokens,
    preserveTailMessages: preserveTail,
  });

  // Reconstruct a transcript = systemPrefix + replacement + preservedTail.
  // The compactor returned only the replacement; we need to combine with
  // the boundary it computed. Easiest: re-split the original transcript
  // and rebuild here.
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

  if (compactedTokens >= originalTokens) {
    return {
      prompt: args.prompt,
      didCompact: false,
      originalTokens,
      compactedTokens: originalTokens,
      latencyMs: Date.now() - startedAt,
      strategy: args.strategy,
      targetTokens: args.targetTokens,
      replacementTargetTokens,
      artifact: {
        replacementMessageCount: artifact.replacementMessages.length,
        stats: artifact.stats,
      },
      skipReason: "expanded",
    };
  }

  return {
    prompt: compactedPrompt,
    didCompact: compactedPrompt !== args.prompt,
    originalTokens,
    compactedTokens,
    latencyMs: Date.now() - startedAt,
    strategy: args.strategy,
    targetTokens: args.targetTokens,
    replacementTargetTokens,
    artifact: {
      replacementMessageCount: artifact.replacementMessages.length,
      stats: artifact.stats,
    },
  };
}

/**
 * Message-level companion to `applyConversationCompaction`.
 *
 * v5 runtime model calls often pass OpenAI-style `messages` directly instead
 * of a flattened prompt string. This path avoids lossy prompt parsing and
 * lets the conversation compactor operate on the role-tagged transcript.
 */
export async function applyConversationMessageCompaction(
  args: ApplyConversationMessageCompactionArgs,
): Promise<ApplyConversationMessageCompactionResult> {
  const startedAt = Date.now();
  const originalTokens = args.currentTokens;

  if (args.currentTokens <= args.targetTokens) {
    return {
      messages: args.messages,
      didCompact: false,
      originalTokens,
      compactedTokens: originalTokens,
      latencyMs: 0,
      strategy: args.strategy,
      targetTokens: args.targetTokens,
      replacementTargetTokens: args.targetTokens,
      skipReason: "not-over-budget",
    };
  }

  const strategyImpl = compactors[args.strategy] ?? naiveSummaryCompactor;
  const transcript: CompactorTranscript = { messages: args.messages };
  const systemOffset = args.messages[0]?.role === "system" ? 1 : 0;
  const preserveTail = args.preserveTailMessages ?? 6;
  const boundary = findSafeCompactionBoundary(args.messages, preserveTail);
  const systemPrefix = systemOffset === 1 ? [args.messages[0]] : [];
  const preservedTail = args.messages.slice(boundary);
  const nonCompactableTokens = approxCountTokens(
    [...systemPrefix, ...preservedTail].map((m) => m.content).join("\n"),
  );
  const viableReplacementTokens =
    args.targetTokens - nonCompactableTokens - REPLACEMENT_OVERHEAD_TOKENS;
  const minimumReplacementBudget = Math.min(64, args.targetTokens);
  if (viableReplacementTokens < minimumReplacementBudget) {
    return {
      messages: args.messages,
      didCompact: false,
      originalTokens,
      compactedTokens: originalTokens,
      latencyMs: Date.now() - startedAt,
      strategy: args.strategy,
      targetTokens: args.targetTokens,
      replacementTargetTokens: Math.max(0, viableReplacementTokens),
      skipReason: "noncompactable-over-budget",
    };
  }
  const replacementTargetTokens = Math.max(
    minimumReplacementBudget,
    Math.min(args.targetTokens, viableReplacementTokens),
  );

  const artifact = await strategyImpl.compact(transcript, {
    targetTokens: replacementTargetTokens,
    callModel: args.callModel,
    countTokens: approxCountTokens,
    preserveTailMessages: preserveTail,
  });

  if (artifact.replacementMessages.length === 0) {
    return {
      messages: args.messages,
      didCompact: false,
      originalTokens,
      compactedTokens: originalTokens,
      latencyMs: Date.now() - startedAt,
      strategy: args.strategy,
      targetTokens: args.targetTokens,
      replacementTargetTokens,
      artifact: {
        replacementMessageCount: 0,
        stats: artifact.stats,
      },
      skipReason: "empty-replacement",
    };
  }

  const compactedMessages = [
    ...systemPrefix,
    ...artifact.replacementMessages,
    ...preservedTail,
  ];
  const compactedTokens = countTranscriptTokens(
    { messages: compactedMessages },
    approxCountTokens,
  );

  if (compactedTokens >= originalTokens) {
    return {
      messages: args.messages,
      didCompact: false,
      originalTokens,
      compactedTokens: originalTokens,
      latencyMs: Date.now() - startedAt,
      strategy: args.strategy,
      targetTokens: args.targetTokens,
      replacementTargetTokens,
      artifact: {
        replacementMessageCount: artifact.replacementMessages.length,
        stats: artifact.stats,
      },
      skipReason: "expanded",
    };
  }

  return {
    messages: compactedMessages,
    didCompact: true,
    originalTokens,
    compactedTokens,
    latencyMs: Date.now() - startedAt,
    strategy: args.strategy,
    targetTokens: args.targetTokens,
    replacementTargetTokens,
    artifact: {
      replacementMessageCount: artifact.replacementMessages.length,
      stats: artifact.stats,
    },
  };
}
