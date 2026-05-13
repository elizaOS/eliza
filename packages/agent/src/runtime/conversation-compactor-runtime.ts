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
 * Enabled by default with the hybrid-ledger strategy. Set
 * `ELIZA_CONVERSATION_COMPACTOR=off|none|false|0|disabled` to disable, or set
 * it to a named strategy to override.
 *
 * The preferred path is the message-history hook installed at runtime,
 * which compacts structured RECENT_MESSAGES state before prompt rendering.
 * The string parse/serialize path remains as a conservative fallback for
 * direct prompt calls that do not pass through message-state composition.
 */

import type {
  AgentRuntime,
  JsonValue,
  Memory,
  MessageHistoryCompactionHookResult,
  MessageHistoryCompactionTelemetry,
  Metadata,
  MetadataValue,
  State,
  UUID,
} from "@elizaos/core";
import { registerMessageHistoryCompactionHook } from "@elizaos/core";
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

export const DEFAULT_CONVERSATION_COMPACTOR_STRATEGY: StrategyName =
  "hybrid-ledger";

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
const DISABLED_COMPACTOR_VALUES = new Set([
  "0",
  "false",
  "off",
  "none",
  "disabled",
  "no",
]);
const ROOM_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECRET_VALUE_RE =
  /\b(?:sk|csk|pk|ghp|gho|ghu|ghs|github_pat)-[A-Za-z0-9_-]{16,}\b/g;
const SECRET_ASSIGNMENT_RE =
  /\b((?:api[_\s-]?key|secret|password|access[_\s-]?token|refresh[_\s-]?token|private[_\s-]?key)\s*[:=]\s*)([^\s,;]+)/gi;

function isProtectedPrefixRole(role: CompactorMessage["role"]): boolean {
  return role === "system" || role === "developer";
}

function protectedPrefixLength(messages: readonly CompactorMessage[]): number {
  let index = 0;
  while (
    index < messages.length &&
    isProtectedPrefixRole(messages[index].role)
  ) {
    index++;
  }
  return index;
}

type ConversationCompactionMetadata = Metadata & {
  priorLedger?: string;
  strategy?: string;
  updatedAt?: string;
  updatedAtMs?: number;
  source?: string;
  compactionCount?: number;
};

const runtimePriorLedgers = new WeakMap<AgentRuntime, Map<string, string>>();

function redactSecretsInLedger(text: string): string {
  return text
    .replace(SECRET_VALUE_RE, (match) => {
      const prefix = match.split("-", 1)[0] || "secret";
      return `${prefix}-[REDACTED]`;
    })
    .replace(SECRET_ASSIGNMENT_RE, "$1[REDACTED]");
}

// ---------------------------------------------------------------------------
// Env config
// ---------------------------------------------------------------------------

/**
 * Reads `ELIZA_CONVERSATION_COMPACTOR` from the environment.
 * Returns the default strategy when unset.
 * Returns `null` when explicitly disabled.
 * Throws when set to a value that is not a known strategy name.
 */
export function selectStrategyFromEnv(): StrategyName | null {
  const raw = process.env.ELIZA_CONVERSATION_COMPACTOR;
  if (raw === undefined || raw === null) {
    return DEFAULT_CONVERSATION_COMPACTOR_STRATEGY;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const normalized = trimmed.toLowerCase();
  if (DISABLED_COMPACTOR_VALUES.has(normalized)) return null;
  if ((STRATEGY_NAMES as readonly string[]).includes(normalized)) {
    return normalized as StrategyName;
  }
  throw new Error(
    `ELIZA_CONVERSATION_COMPACTOR=${trimmed} is invalid. ` +
      `Expected one of: ${STRATEGY_NAMES.join(", ")}, off, none, false, 0`,
  );
}

function ledgerMapFor(runtime: AgentRuntime): Map<string, string> {
  const existing = runtimePriorLedgers.get(runtime);
  if (existing) return existing;
  const next = new Map<string, string>();
  runtimePriorLedgers.set(runtime, next);
  return next;
}

function getRoomCompactionMetadata(
  roomMetadata: unknown,
): ConversationCompactionMetadata | null {
  if (!roomMetadata || typeof roomMetadata !== "object") return null;
  const value = (roomMetadata as Record<string, unknown>)
    .conversationCompaction;
  if (!value || typeof value !== "object") return null;
  return value as ConversationCompactionMetadata;
}

function getRoomMetadataRecord(roomMetadata: unknown): Metadata {
  return roomMetadata && typeof roomMetadata === "object"
    ? (roomMetadata as Metadata)
    : {};
}

async function loadRoomLedger(
  runtime: AgentRuntime,
  conversationKey: string,
): Promise<string | null> {
  if (!ROOM_ID_RE.test(conversationKey)) return null;
  try {
    const room = await runtime.getRoom(conversationKey as UUID);
    const metadata = getRoomCompactionMetadata(room?.metadata);
    const priorLedger = metadata?.priorLedger;
    return typeof priorLedger === "string" && priorLedger.trim().length > 0
      ? priorLedger
      : null;
  } catch {
    return null;
  }
}

export async function getConversationCompactionLedger(
  runtime: AgentRuntime,
  conversationKey: string | undefined,
): Promise<string | null> {
  const key = conversationKey?.trim();
  if (!key) return null;
  const inMemory = ledgerMapFor(runtime).get(key);
  if (inMemory && inMemory.trim().length > 0) return inMemory;
  const persisted = await loadRoomLedger(runtime, key);
  if (persisted) {
    ledgerMapFor(runtime).set(key, persisted);
  }
  return persisted;
}

export async function setConversationCompactionLedger(
  runtime: AgentRuntime,
  conversationKey: string | undefined,
  ledger: string,
  options?: {
    strategy?: StrategyName | null;
    source?: string;
    lastCompactionAt?: number;
    historyEntry?: Record<string, JsonValue>;
  },
): Promise<void> {
  const key = conversationKey?.trim();
  const trimmedLedger = redactSecretsInLedger(ledger).trim();
  if (!key || !trimmedLedger) return;
  ledgerMapFor(runtime).set(key, trimmedLedger);

  if (!ROOM_ID_RE.test(key)) return;
  try {
    const room = await runtime.getRoom(key as UUID);
    if (!room) return;
    const previous = getRoomCompactionMetadata(room.metadata);
    const baseMetadata = getRoomMetadataRecord(room.metadata);
    const existingHistory: MetadataValue[] = Array.isArray(
      baseMetadata.compactionHistory,
    )
      ? baseMetadata.compactionHistory
      : [];
    const compactionHistory: MetadataValue[] = options?.historyEntry
      ? [...existingHistory, options.historyEntry].slice(-20)
      : existingHistory;
    const nextMetadata: Metadata = {
      ...baseMetadata,
      ...(typeof options?.lastCompactionAt === "number"
        ? { lastCompactionAt: options.lastCompactionAt }
        : {}),
      ...(compactionHistory.length > 0 ? { compactionHistory } : {}),
      conversationCompaction: {
        ...(previous ?? {}),
        priorLedger: trimmedLedger,
        strategy: options?.strategy ?? previous?.strategy,
        source: options?.source ?? previous?.source ?? "runtime",
        updatedAt: new Date().toISOString(),
        updatedAtMs: Date.now(),
        compactionCount: (previous?.compactionCount ?? 0) + 1,
      },
    };
    await runtime.updateRoom({ ...room, metadata: nextMetadata });
  } catch {
    // Persistence is a quality-of-service path; model calls must not fail if
    // room metadata cannot be written.
  }
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
    case "developer":
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
    if (isProtectedPrefixRole(m.role)) {
      // System/developer-role messages were pulled from the prefix or were synthesized
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
  /** Optional metadata forwarded to the compactor (for prior ledgers, ids). */
  metadata?: Record<string, unknown>;
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
  /** Optional metadata forwarded to the compactor (for prior ledgers, ids). */
  metadata?: Record<string, unknown>;
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
  const parsedTranscript = parsePromptToTranscript(args.prompt);
  const transcript: CompactorTranscript = {
    ...parsedTranscript,
    metadata: {
      ...(parsedTranscript.metadata ?? {}),
      ...(args.metadata ?? {}),
    },
  };

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

  const systemOffset = protectedPrefixLength(transcript.messages);
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
  const systemPrefix = transcript.messages.slice(0, systemOffset);
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
  const transcript: CompactorTranscript = {
    messages: args.messages,
    ...(args.metadata ? { metadata: args.metadata } : {}),
  };
  const systemOffset = protectedPrefixLength(args.messages);
  const preserveTail = args.preserveTailMessages ?? 6;
  const boundary = findSafeCompactionBoundary(args.messages, preserveTail);
  const systemPrefix = args.messages.slice(0, systemOffset);
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

// ---------------------------------------------------------------------------
// Message-history hook: structured `RECENT_MESSAGES` state -> compacted state
// ---------------------------------------------------------------------------

const DEFAULT_MESSAGE_HISTORY_THRESHOLD_TOKENS = 12_000;
const DEFAULT_MESSAGE_HISTORY_TARGET_TOKENS = 4_000;
const DEFAULT_MESSAGE_HISTORY_TAIL = 10;
const MEMORY_TAG_PREFIX = "memory-id:";
const installedMessageHistoryHooks = new WeakSet<object>();

type RuntimeWithSettings = AgentRuntime & {
  getSetting?: (key: string) => unknown;
};

type RecentMessagesProviderRecord = {
  text?: string;
  values?: Record<string, State["values"][string]>;
  data?: Record<string, State["data"][string]>;
  providerName?: string;
};

function runtimeSettingText(
  runtime: RuntimeWithSettings,
  key: string,
): string | undefined {
  const value = runtime.getSetting?.(key);
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function positiveIntegerFromConfig(
  runtime: RuntimeWithSettings,
  envKey: string,
  settingKey: string,
  fallback: number,
): number {
  const raw = process.env[envKey] ?? runtimeSettingText(runtime, settingKey);
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return fallback;
}

function safeMemoryText(memory: Memory): string {
  return typeof memory.content?.text === "string"
    ? memory.content.text.trim()
    : "";
}

function memoryDisplayName(runtime: AgentRuntime, memory: Memory): string {
  if (memory.entityId === runtime.agentId) {
    return runtime.character?.name ?? "Agent";
  }
  const metadata = memory.metadata;
  if (metadata && typeof metadata === "object") {
    const named = (metadata as Record<string, unknown>).entityName;
    if (typeof named === "string" && named.trim().length > 0) {
      return named.trim();
    }
  }
  return "User";
}

function memoryTimestamp(memory: Memory): string {
  const date = new Date(memory.createdAt || Date.now());
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  return `${hours}:${minutes}`;
}

function memoryToCompactorMessage(
  runtime: AgentRuntime,
  memory: Memory,
): CompactorMessage | null {
  const text = safeMemoryText(memory);
  if (!text) return null;
  const role: CompactorMessage["role"] =
    memory.entityId === runtime.agentId ? "assistant" : "user";
  const speaker = memoryDisplayName(runtime, memory);
  const content = `${memoryTimestamp(memory)} [${memory.entityId}] ${speaker}: ${text}`;
  return {
    role,
    content,
    timestamp: memory.createdAt,
    tags: memory.id ? [`${MEMORY_TAG_PREFIX}${memory.id}`] : undefined,
  };
}

function memoryIdFromCompactorMessage(
  message: CompactorMessage,
): string | null {
  for (const tag of message.tags ?? []) {
    if (tag.startsWith(MEMORY_TAG_PREFIX)) {
      return tag.slice(MEMORY_TAG_PREFIX.length);
    }
  }
  return null;
}

function syntheticMemoryId(createdAt: number): UUID {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") {
    return cryptoApi.randomUUID() as UUID;
  }
  const suffix = String(Math.abs(createdAt % 1_000_000_000_000)).padStart(
    12,
    "0",
  );
  return `00000000-0000-4000-8000-${suffix}` as UUID;
}

function syntheticCompactionMemory(args: {
  runtime: AgentRuntime;
  roomId: UUID;
  text: string;
  createdAt: number;
  strategy: StrategyName;
  source: string;
  telemetry: MessageHistoryCompactionTelemetry;
}): Memory {
  return {
    id: syntheticMemoryId(args.createdAt),
    entityId: args.runtime.agentId,
    agentId: args.runtime.agentId,
    roomId: args.roomId,
    createdAt: args.createdAt,
    content: {
      text: args.text,
      source: "conversation-compaction",
    },
    metadata: {
      source: "conversation-compaction",
      tags: ["compaction", "conversation-summary"],
      strategy: args.strategy,
      hookSource: args.source,
      telemetry: args.telemetry as unknown as JsonValue,
    },
  };
}

function renderMemoryForProvider(
  runtime: AgentRuntime,
  memory: Memory,
): string {
  const text = safeMemoryText(memory);
  if (!text) return "";
  const speaker = memoryDisplayName(runtime, memory);
  const entityId = memory.entityId ?? "unknown";
  const thought =
    typeof memory.content?.thought === "string" &&
    memory.content.thought.trim().length > 0
      ? `\n(${speaker}'s internal thought: ${memory.content.thought.trim()})`
      : "";
  const actions = Array.isArray(memory.content?.actions)
    ? memory.content.actions
        .map((action) => String(action).trim())
        .filter(Boolean)
    : [];
  const actionLine =
    actions.length > 0 ? `\n(${speaker}'s actions: ${actions.join(", ")})` : "";
  return `${memoryTimestamp(memory)} [${entityId}] ${speaker}: ${text}${thought}${actionLine}`;
}

function renderCompactedRecentMessagesProvider(args: {
  runtime: AgentRuntime;
  message: Memory;
  memories: Memory[];
  priorLedger?: string | null;
}): string {
  const currentId = args.message.id;
  const historyLines = args.memories
    .filter((memory) => !(currentId && memory.id === currentId))
    .map((memory) => renderMemoryForProvider(args.runtime, memory))
    .filter(Boolean);
  const sections: string[] = [];
  if (args.priorLedger && args.priorLedger.trim().length > 0) {
    sections.push(`# Conversation Compact Ledger\n${args.priorLedger.trim()}`);
  }
  if (historyLines.length > 0) {
    sections.push(`# Conversation Messages\n${historyLines.join("\n")}`);
  }
  const receivedText = safeMemoryText(args.message);
  if (receivedText) {
    sections.push(
      `# Received Message\n${memoryDisplayName(args.runtime, args.message)}: ${receivedText}`,
    );
    sections.push(
      `# Focus your response\nYou are replying to the above message from **${memoryDisplayName(
        args.runtime,
        args.message,
      )}**. Keep your answer relevant to that message, but include as context any previous messages in the thread from after your last reply.`,
    );
  }
  return sections.join("\n\n");
}

function getRecentMessagesProvider(
  state: State,
): RecentMessagesProviderRecord | null {
  const providers = state.data?.providers;
  if (!providers || typeof providers !== "object") return null;
  const provider = (providers as Record<string, unknown>).RECENT_MESSAGES;
  if (!provider || typeof provider !== "object" || Array.isArray(provider)) {
    return null;
  }
  return provider as RecentMessagesProviderRecord;
}

function readRecentMessageMemories(state: State): Memory[] {
  const provider = getRecentMessagesProvider(state);
  const recentMessages = provider?.data?.recentMessages;
  if (!Array.isArray(recentMessages)) return [];
  return recentMessages.filter(
    (memory): memory is Memory =>
      Boolean(memory) &&
      typeof memory === "object" &&
      !Array.isArray(memory) &&
      "content" in memory &&
      "roomId" in memory,
  );
}

function rewriteStateRecentMessages(args: {
  runtime: AgentRuntime;
  message: Memory;
  state: State;
  memories: Memory[];
  telemetry: MessageHistoryCompactionTelemetry;
  priorLedger?: string | null;
}): State {
  const provider = getRecentMessagesProvider(args.state);
  if (!provider) return args.state;
  const rendered = renderCompactedRecentMessagesProvider({
    runtime: args.runtime,
    message: args.message,
    memories: args.memories,
    priorLedger: args.priorLedger,
  });
  const nextProvider: RecentMessagesProviderRecord = {
    ...provider,
    text: rendered,
    data: {
      ...(provider.data ?? {}),
      recentMessages: args.memories,
    },
    values: {
      ...(provider.values ?? {}),
      recentMessages: rendered,
      recentPosts: rendered,
      recentMessage: args.memories.at(-1)
        ? renderMemoryForProvider(args.runtime, args.memories.at(-1) as Memory)
        : "",
      messageHistoryCompaction: args.telemetry,
    },
  };
  const providers = {
    ...(args.state.data?.providers ?? {}),
    RECENT_MESSAGES: nextProvider,
  };
  const nextValues = {
    ...(args.state.values ?? {}),
    recentMessages: rendered,
    recentPosts: rendered,
    messageHistoryCompaction: args.telemetry as unknown as JsonValue,
  };
  const previousText = typeof provider.text === "string" ? provider.text : "";
  const nextText =
    previousText && typeof args.state.text === "string"
      ? args.state.text.replace(previousText, rendered)
      : args.state.text;
  return {
    ...args.state,
    values: nextValues,
    data: {
      ...args.state.data,
      providers,
      messageHistoryCompaction: args.telemetry as unknown as JsonValue,
    },
    text: nextText,
  };
}

function buildCompactorModelCallFromRuntime(
  runtime: AgentRuntime,
  originalUseModel: AgentRuntime["useModel"] | null,
): CompactorModelCall {
  const useModel = (originalUseModel ?? runtime.useModel.bind(runtime)) as (
    modelType: string,
    payload: unknown,
  ) => Promise<unknown>;
  return async ({ systemPrompt, messages, maxOutputTokens }) => {
    const result = await useModel("TEXT_LARGE", {
      system: systemPrompt,
      prompt: messages.map((message) => message.content).join("\n"),
      ...(maxOutputTokens !== undefined ? { maxTokens: maxOutputTokens } : {}),
      providerOptions: {
        eliza: {
          purpose: "conversation-message-history-compaction",
          skipConversationCompaction: true,
        },
      },
    });
    if (typeof result === "string") return result;
    if (result == null) return "";
    try {
      return JSON.stringify(result);
    } catch {
      return String(result);
    }
  };
}

export async function applyMessageHistoryCompactionToState(args: {
  runtime: AgentRuntime;
  message: Memory;
  state: State;
  source?:
    | "compose-response-state"
    | "provider-grounded-state"
    | "continuation-state";
  callModel: CompactorModelCall;
}): Promise<MessageHistoryCompactionHookResult> {
  const source = args.source ?? "compose-response-state";
  const startedAt = Date.now();
  let strategy: StrategyName | null;
  try {
    strategy = selectStrategyFromEnv();
  } catch (error) {
    args.runtime.logger?.warn?.(String((error as Error).message));
    strategy = null;
  }

  const thresholdTokens = positiveIntegerFromConfig(
    args.runtime as RuntimeWithSettings,
    "ELIZA_CONVERSATION_MESSAGE_COMPACTION_THRESHOLD_TOKENS",
    "CONVERSATION_MESSAGE_COMPACTION_THRESHOLD_TOKENS",
    DEFAULT_MESSAGE_HISTORY_THRESHOLD_TOKENS,
  );
  const targetTokens = positiveIntegerFromConfig(
    args.runtime as RuntimeWithSettings,
    "ELIZA_CONVERSATION_MESSAGE_COMPACTION_TARGET_TOKENS",
    "CONVERSATION_MESSAGE_COMPACTION_TARGET_TOKENS",
    Math.min(DEFAULT_MESSAGE_HISTORY_TARGET_TOKENS, thresholdTokens),
  );
  const preserveTailMessages = positiveIntegerFromConfig(
    args.runtime as RuntimeWithSettings,
    "ELIZA_CONVERSATION_MESSAGE_COMPACTION_TAIL_MESSAGES",
    "CONVERSATION_MESSAGE_COMPACTION_TAIL_MESSAGES",
    DEFAULT_MESSAGE_HISTORY_TAIL,
  );
  const originalMemories = readRecentMessageMemories(args.state).sort(
    (a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0),
  );
  const compactorPairs = originalMemories.flatMap((memory) => {
    const compactorMessage = memoryToCompactorMessage(args.runtime, memory);
    return compactorMessage ? [{ memory, compactorMessage }] : [];
  });
  const compactorMessages = compactorPairs.map((pair) => pair.compactorMessage);
  const originalTokens = countTranscriptTokens(
    { messages: compactorMessages },
    approxCountTokens,
  );
  const baseTelemetry: Omit<
    MessageHistoryCompactionTelemetry,
    "didCompact" | "compactedTokens" | "compactedMessageCount" | "latencyMs"
  > = {
    source: "message-history",
    strategy,
    thresholdTokens,
    targetTokens,
    originalTokens,
    originalMessageCount: originalMemories.length,
    preserveTailMessages,
    conversationKey: args.message.roomId,
  };

  const finish = (
    telemetry: Pick<
      MessageHistoryCompactionTelemetry,
      "didCompact" | "compactedTokens" | "compactedMessageCount"
    > &
      Partial<MessageHistoryCompactionTelemetry>,
    state = args.state,
  ): MessageHistoryCompactionHookResult => ({
    state,
    telemetry: {
      ...baseTelemetry,
      ...telemetry,
      latencyMs: Date.now() - startedAt,
    },
  });

  if (!strategy) {
    return finish({
      didCompact: false,
      compactedTokens: originalTokens,
      compactedMessageCount: originalMemories.length,
      skipReason: "disabled",
    });
  }
  if (originalMemories.length <= preserveTailMessages + 1) {
    return finish({
      didCompact: false,
      compactedTokens: originalTokens,
      compactedMessageCount: originalMemories.length,
      skipReason: "not-enough-history",
    });
  }
  if (originalTokens <= thresholdTokens) {
    return finish({
      didCompact: false,
      compactedTokens: originalTokens,
      compactedMessageCount: originalMemories.length,
      skipReason: "below-threshold",
    });
  }

  const priorLedger = await getConversationCompactionLedger(
    args.runtime,
    args.message.roomId,
  );
  const compactionBoundary = findSafeCompactionBoundary(
    compactorMessages,
    preserveTailMessages,
  );
  const compactedThroughMemory =
    compactionBoundary > protectedPrefixLength(compactorMessages)
      ? compactorPairs[compactionBoundary - 1]?.memory
      : undefined;
  const result = await applyConversationMessageCompaction({
    messages: compactorMessages,
    strategy,
    currentTokens: originalTokens,
    targetTokens,
    callModel: args.callModel,
    preserveTailMessages,
    metadata: {
      conversationKey: args.message.roomId,
      source,
      ...(priorLedger ? { priorLedger } : {}),
    },
  });

  if (!result.didCompact) {
    return finish({
      didCompact: false,
      compactedTokens: result.compactedTokens,
      compactedMessageCount: originalMemories.length,
      skipReason: result.skipReason ?? "not-compacted",
      replacementMessageCount: result.artifact?.replacementMessageCount,
    });
  }

  const memoryById = new Map(
    originalMemories
      .filter((memory) => memory.id)
      .map((memory) => [String(memory.id), memory] as const),
  );
  const compactedMemories: Memory[] = [];
  let syntheticCount = 0;
  for (const message of result.messages) {
    const memoryId = memoryIdFromCompactorMessage(message);
    const originalMemory = memoryId ? memoryById.get(memoryId) : undefined;
    if (originalMemory) {
      compactedMemories.push(originalMemory);
      continue;
    }
    const telemetry: MessageHistoryCompactionTelemetry = {
      ...baseTelemetry,
      didCompact: true,
      compactedTokens: result.compactedTokens,
      compactedMessageCount: result.messages.length,
      latencyMs: result.latencyMs,
      replacementMessageCount: result.artifact?.replacementMessageCount,
    };
    compactedMemories.push(
      syntheticCompactionMemory({
        runtime: args.runtime,
        roomId: args.message.roomId,
        text: message.content,
        createdAt: Date.now() + syntheticCount++,
        strategy,
        source,
        telemetry,
      }),
    );
  }

  const renderedLedger = result.artifact?.stats.extra?.renderedLedger;
  const ledgerToPersist =
    typeof renderedLedger === "string" && renderedLedger.trim().length > 0
      ? renderedLedger
      : result.messages
          .filter((message) => !memoryIdFromCompactorMessage(message))
          .map((message) => message.content)
          .join("\n\n");
  if (ledgerToPersist.trim().length > 0) {
    await setConversationCompactionLedger(
      args.runtime,
      args.message.roomId,
      ledgerToPersist,
      {
        strategy,
        source: "message-history",
        lastCompactionAt:
          typeof compactedThroughMemory?.createdAt === "number"
            ? compactedThroughMemory.createdAt + 1
            : Date.now(),
        historyEntry: {
          source,
          strategy,
          originalTokens,
          compactedTokens: result.compactedTokens,
          originalMessageCount: originalMemories.length,
          compactedMessageCount: compactedMemories.length,
        },
      },
    );
  }

  const telemetry: MessageHistoryCompactionTelemetry = {
    ...baseTelemetry,
    didCompact: true,
    compactedTokens: result.compactedTokens,
    compactedMessageCount: compactedMemories.length,
    latencyMs: Date.now() - startedAt,
    replacementMessageCount: result.artifact?.replacementMessageCount,
  };
  const nextState = rewriteStateRecentMessages({
    runtime: args.runtime,
    message: args.message,
    state: args.state,
    memories: compactedMemories,
    telemetry,
    priorLedger: ledgerToPersist || priorLedger,
  });

  args.runtime.logger?.info?.(
    `[eliza] message-history-compaction strategy=${strategy} originalTokens=${telemetry.originalTokens} compactedTokens=${telemetry.compactedTokens} messages=${telemetry.originalMessageCount}->${telemetry.compactedMessageCount} latencyMs=${telemetry.latencyMs}`,
  );
  return { state: nextState, telemetry };
}

export function installMessageHistoryCompactionHook(
  runtime: AgentRuntime,
  options?: {
    originalUseModel?: AgentRuntime["useModel"] | null;
  },
): void {
  if (installedMessageHistoryHooks.has(runtime as object)) return;
  installedMessageHistoryHooks.add(runtime as object);
  const callModel = buildCompactorModelCallFromRuntime(
    runtime,
    options?.originalUseModel ?? null,
  );
  registerMessageHistoryCompactionHook(runtime, async (args) =>
    applyMessageHistoryCompactionToState({
      runtime,
      message: args.message,
      state: args.state,
      source: args.source,
      callModel,
    }),
  );
}
