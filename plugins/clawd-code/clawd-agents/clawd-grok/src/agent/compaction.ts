import { generateText, type ModelMessage } from "ai";
import { resolveModelRuntime, type XaiProvider } from "../grok/client";
import { containsEncryptedReasoning } from "./reasoning";

export interface CompactionSettings {
  reserveTokens: number;
  keepRecentTokens: number;
}

export interface CutPointResult {
  firstKeptIndex: number;
  turnStartIndex: number;
  isSplitTurn: boolean;
}

export interface PreparedCompaction {
  previousSummary?: string;
  messagesToSummarize: ModelMessage[];
  turnPrefixMessages: ModelMessage[];
  keptMessages: ModelMessage[];
  firstKeptIndex: number;
  isSplitTurn: boolean;
  tokensBefore: number;
  settings: CompactionSettings;
}

const TOOL_RESULT_MAX_CHARS = 2000;
const MIN_KEPT_TOKENS_ON_RETRY = 4000;

export const DEFAULT_RESERVE_TOKENS = 16_384;
export const DEFAULT_KEEP_RECENT_TOKENS = 20_000;
export const COMPACTION_SUMMARY_HEADER = "[Context checkpoint summary]";

const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant.

Do not continue the conversation. Do not answer any questions from the conversation.
Only output a structured checkpoint summary that another coding agent can use to continue the work.`;

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this exact format:

## Goal
[What the user is trying to accomplish]

## Constraints & Preferences
- [Requirements, preferences, or constraints]
- [(none) if none were mentioned]

## Progress
### Done
- [x] [Completed work]

### In Progress
- [ ] [Current work]

### Blocked
- [Any active blockers]

## Key Decisions
- **[Decision]**: [Rationale]

## Next Steps
1. [The next action to take]

## Critical Context
- [Important details needed to continue]
- [(none) if not applicable]

Keep it concise, but preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are new conversation messages to incorporate into the existing summary provided below.

Update the existing structured summary with new information. Rules:
- Preserve still-relevant information from the previous summary
- Add new progress, decisions, and critical context
- Move completed items from "In Progress" to "Done" when appropriate
- Update "Next Steps" based on the current state
- Preserve exact file paths, function names, and error messages

Use the exact same section structure as the existing summary format.`;

const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the early prefix of a single turn that was too large to keep in full. The recent suffix is still available.

Summarize only what is needed so another coding agent can understand the retained suffix.

Use this exact format:

## Original Request
[What the user asked for in this turn]

## Early Progress
- [Key work done before the kept suffix]

## Context For Suffix
- [Information needed to understand the kept recent messages]`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getTextParts(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];

  const parts: string[] = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    if (part.type === "text" && typeof part.text === "string") {
      parts.push(part.text);
      continue;
    }
    if (part.type === "reasoning" && typeof part.text === "string") {
      if (!containsEncryptedReasoning(part.text)) {
        parts.push(part.text);
      }
      continue;
    }
    if (part.type === "reasoning" && typeof part.reasoning === "string") {
      if (!containsEncryptedReasoning(part.reasoning)) {
        parts.push(part.reasoning);
      }
    }
  }
  return parts;
}

function stringifyForSummary(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function truncateForSummary(text: string, maxChars = TOOL_RESULT_MAX_CHARS): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[... ${text.length - maxChars} more characters truncated]`;
}

function extractUserContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    if (part.type === "text" && typeof part.text === "string") {
      parts.push(part.text);
      continue;
    }
    if (part.type === "image") {
      parts.push("[Image]");
      continue;
    }
    if (part.type === "file") {
      const filename = typeof part.filename === "string" ? part.filename : null;
      parts.push(filename ? `[File: ${filename}]` : "[File]");
    }
  }
  return parts.join("\n");
}

function extractAssistantText(content: unknown): string {
  return getTextParts(content).join("\n");
}

function extractToolCallText(content: unknown): string[] {
  if (!Array.isArray(content)) return [];

  const toolCalls: string[] = [];
  for (const part of content) {
    if (!isRecord(part) || part.type !== "tool-call") continue;
    const toolName = typeof part.toolName === "string" ? part.toolName : "tool";
    const input = isRecord(part.input) ? part.input : {};
    const args = Object.entries(input)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join(", ");
    toolCalls.push(`${toolName}(${args})`);
  }
  return toolCalls;
}

function extractToolResultText(content: unknown): string[] {
  if (!Array.isArray(content)) return [];

  const toolResults: string[] = [];
  for (const part of content) {
    if (!isRecord(part) || part.type !== "tool-result") continue;
    toolResults.push(truncateForSummary(stringifyForSummary(part.output)));
  }
  return toolResults;
}

export function createCompactionSummaryMessage(summary: string): ModelMessage {
  return {
    role: "system",
    content: `${COMPACTION_SUMMARY_HEADER}\n${summary.trim()}`,
  };
}

export function isCompactionSummaryMessage(message: ModelMessage | undefined): boolean {
  return message?.role === "system" && typeof message.content === "string"
    ? message.content.startsWith(COMPACTION_SUMMARY_HEADER)
    : false;
}

export function getCompactionSummaryText(message: ModelMessage | undefined): string | null {
  if (!isCompactionSummaryMessage(message) || typeof message?.content !== "string") {
    return null;
  }
  return message.content.slice(COMPACTION_SUMMARY_HEADER.length).trim();
}

export function estimateMessageTokens(message: ModelMessage): number {
  let chars = 0;

  switch (message.role) {
    case "user":
      chars += extractUserContent(message.content).length;
      break;
    case "assistant":
      chars += extractAssistantText(message.content).length;
      chars += extractToolCallText(message.content).join("; ").length;
      break;
    case "tool":
      chars += extractToolResultText(message.content).join("\n").length;
      break;
    case "system":
      chars +=
        typeof message.content === "string" ? message.content.length : getTextParts(message.content).join("\n").length;
      break;
    default:
      chars += stringifyForSummary((message as { content?: unknown }).content).length;
      break;
  }

  return Math.ceil(chars / 4);
}

export function estimateConversationTokens(systemPrompt: string, messages: ModelMessage[], inFlightText = ""): number {
  const systemTokens = Math.ceil((systemPrompt.length + inFlightText.length) / 4);
  return systemTokens + messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

export function shouldCompactContext(
  contextTokens: number,
  contextWindow: number,
  settings: CompactionSettings,
): boolean {
  return contextTokens > contextWindow - settings.reserveTokens;
}

function isValidCutPoint(message: ModelMessage): boolean {
  return message.role !== "tool";
}

function findTurnStartIndex(messages: ModelMessage[], entryIndex: number, startIndex: number): number {
  for (let i = entryIndex; i >= startIndex; i--) {
    if (messages[i]?.role === "user") {
      return i;
    }
  }
  return -1;
}

export function findCutPoint(messages: ModelMessage[], startIndex: number, keepRecentTokens: number): CutPointResult {
  const cutPoints: number[] = [];
  for (let i = startIndex; i < messages.length; i++) {
    if (isValidCutPoint(messages[i])) {
      cutPoints.push(i);
    }
  }

  if (cutPoints.length === 0) {
    return { firstKeptIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
  }

  let accumulatedTokens = 0;
  let cutIndex = cutPoints[0];

  for (let i = messages.length - 1; i >= startIndex; i--) {
    accumulatedTokens += estimateMessageTokens(messages[i]);
    if (accumulatedTokens >= keepRecentTokens) {
      cutIndex = cutPoints.find((index) => index >= i) ?? cutPoints[cutPoints.length - 1];
      break;
    }
  }

  const cutMessage = messages[cutIndex];
  const isUserMessage = cutMessage?.role === "user";
  const turnStartIndex = isUserMessage ? -1 : findTurnStartIndex(messages, cutIndex, startIndex);

  return {
    firstKeptIndex: cutIndex,
    turnStartIndex,
    isSplitTurn: !isUserMessage && turnStartIndex !== -1,
  };
}

export function prepareCompaction(
  messages: ModelMessage[],
  systemPrompt: string,
  settings: CompactionSettings,
): PreparedCompaction | null {
  const previousSummary = getCompactionSummaryText(messages[0]) ?? undefined;
  const boundaryStart = previousSummary ? 1 : 0;
  if (boundaryStart >= messages.length) {
    return null;
  }

  const cutPoint = findCutPoint(messages, boundaryStart, settings.keepRecentTokens);
  const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptIndex;
  const messagesToSummarize = messages.slice(boundaryStart, Math.max(boundaryStart, historyEnd));
  const turnPrefixMessages = cutPoint.isSplitTurn
    ? messages.slice(cutPoint.turnStartIndex, cutPoint.firstKeptIndex)
    : [];
  const keptMessages = messages.slice(cutPoint.firstKeptIndex);
  const tokensBefore = estimateConversationTokens(systemPrompt, messages);

  if (keptMessages.length === 0) {
    return null;
  }

  if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0) {
    return null;
  }

  return {
    previousSummary,
    messagesToSummarize,
    turnPrefixMessages,
    keptMessages,
    firstKeptIndex: cutPoint.firstKeptIndex,
    isSplitTurn: cutPoint.isSplitTurn,
    tokensBefore,
    settings,
  };
}

export function relaxCompactionSettings(settings: CompactionSettings): CompactionSettings {
  return {
    ...settings,
    keepRecentTokens: Math.max(MIN_KEPT_TOKENS_ON_RETRY, Math.floor(settings.keepRecentTokens / 2)),
  };
}

export function serializeConversation(messages: ModelMessage[]): string {
  const parts: string[] = [];

  for (const message of messages) {
    if (isCompactionSummaryMessage(message)) {
      const summary = getCompactionSummaryText(message);
      if (summary) {
        parts.push(`[Previous summary]: ${summary}`);
      }
      continue;
    }

    if (message.role === "user") {
      const content = extractUserContent(message.content).trim();
      if (content) parts.push(`[User]: ${content}`);
      continue;
    }

    if (message.role === "assistant") {
      const text = extractAssistantText(message.content).trim();
      const toolCalls = extractToolCallText(message.content);
      if (text) parts.push(`[Assistant]: ${text}`);
      if (toolCalls.length > 0) parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
      continue;
    }

    if (message.role === "tool") {
      const results = extractToolResultText(message.content);
      for (const result of results) {
        if (result.trim()) parts.push(`[Tool result]: ${result}`);
      }
      continue;
    }

    if (message.role === "system") {
      const content =
        typeof message.content === "string" ? message.content.trim() : getTextParts(message.content).join("\n").trim();
      if (content) parts.push(`[System]: ${content}`);
    }
  }

  return parts.join("\n\n");
}

async function summarizeConversation(
  provider: XaiProvider,
  modelId: string,
  messages: ModelMessage[],
  reserveTokens: number,
  customInstructions?: string,
  previousSummary?: string,
  promptOverride?: string,
  signal?: AbortSignal,
): Promise<string> {
  const serialized = serializeConversation(messages);
  const promptParts = [serialized];

  if (previousSummary) {
    promptParts.push(`Existing summary:\n${previousSummary}`);
  }

  const basePrompt = promptOverride ?? (previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT);
  promptParts.push(basePrompt);

  if (customInstructions?.trim()) {
    promptParts.push(`Additional focus: ${customInstructions.trim()}`);
  }

  const runtime = resolveModelRuntime(provider, modelId);
  const { text } = await generateText({
    model: runtime.model,
    system: SUMMARIZATION_SYSTEM_PROMPT,
    prompt: promptParts.filter(Boolean).join("\n\n"),
    abortSignal: signal,
    maxRetries: 0,
    temperature: 0.2,
    ...(runtime.modelInfo?.supportsMaxOutputTokens === false
      ? {}
      : { maxOutputTokens: Math.max(512, Math.floor(reserveTokens * 0.8)) }),
    ...(runtime.providerOptions ? { providerOptions: runtime.providerOptions } : {}),
  });

  return text.trim();
}

export async function generateCompactionSummary(
  provider: XaiProvider,
  modelId: string,
  preparation: PreparedCompaction,
  customInstructions?: string,
  signal?: AbortSignal,
): Promise<string> {
  const { messagesToSummarize, turnPrefixMessages, isSplitTurn, previousSummary, settings } = preparation;

  if (isSplitTurn && turnPrefixMessages.length > 0) {
    const [historySummary, prefixSummary] = await Promise.all([
      messagesToSummarize.length > 0
        ? summarizeConversation(
            provider,
            modelId,
            messagesToSummarize,
            settings.reserveTokens,
            customInstructions,
            previousSummary,
            undefined,
            signal,
          )
        : Promise.resolve(previousSummary?.trim() || ""),
      summarizeConversation(
        provider,
        modelId,
        turnPrefixMessages,
        settings.reserveTokens,
        undefined,
        undefined,
        TURN_PREFIX_SUMMARIZATION_PROMPT,
        signal,
      ),
    ]);

    if (historySummary && prefixSummary) {
      return `${historySummary}\n\n---\n\n${prefixSummary}`;
    }
    return (historySummary || prefixSummary).trim();
  }

  return summarizeConversation(
    provider,
    modelId,
    messagesToSummarize,
    settings.reserveTokens,
    customInstructions,
    previousSummary,
    undefined,
    signal,
  );
}
