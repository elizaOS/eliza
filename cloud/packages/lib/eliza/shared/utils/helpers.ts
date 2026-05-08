/**
 * Common helper functions for workflow handlers.
 */

import {
  type AgentContext,
  type ActionResult as CoreActionResult,
  createUniqueUuid,
  executePlannedToolCall,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  ModelType,
  parseKeyValueXml,
  type State,
  type UUID,
} from "@elizaos/core";
import { v4 } from "uuid";
import type { ParsedPlan, ParsedResponse } from "./parsers";

/**
 * Default Eliza agent ID - used to detect creator mode
 */
export const DEFAULT_ELIZA_ID = "b850bc30-45f8-0041-a00a-83df46d8555d";

/**
 * Check if runtime is in creator mode (chatting with default Eliza to create a new character)
 * vs editing an existing character.
 */
export function isCreatorMode(runtime: IAgentRuntime): boolean {
  const characterId = runtime.character.id;
  return !characterId || characterId === DEFAULT_ELIZA_ID;
}

export const MAX_RESPONSE_RETRIES = 3;
export const EVALUATOR_TIMEOUT_MS = 30000;

// =============================================================================
// Response Post-Processing Utilities
// =============================================================================

/**
 * Patterns that indicate AI-speak that should be avoided
 */
const AI_SPEAK_PATTERNS = [
  /\bAs an AI\b/gi,
  /\bI'm an AI\b/gi,
  /\bI am an AI\b/gi,
  /\bAs a language model\b/gi,
  /\bAs an artificial intelligence\b/gi,
  /\bI don't have feelings\b/gi,
  /\bI cannot feel\b/gi,
  /\bI'm just a program\b/gi,
  /\bI'm programmed to\b/gi,
  /\bMy programming\b/gi,
  /\bI was trained\b/gi,
  /\bMy training data\b/gi,
];

/**
 * Repetitive greeting patterns to detect
 */
const REPETITIVE_GREETINGS = [
  /^Hey!?\s*$/i,
  /^Hello!?\s*$/i,
  /^Hi!?\s*$/i,
  /^Hi there!?\s*$/i,
  /^Hey there!?\s*$/i,
  /^Hello there!?\s*$/i,
  /^Greetings!?\s*$/i,
];

/**
 * Check if response contains AI-speak patterns
 */
export function containsAISpeak(text: string): boolean {
  return AI_SPEAK_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Remove AI-speak patterns from response
 * Returns cleaned text
 */
export function removeAISpeak(text: string): string {
  let cleaned = text;

  // Remove sentences containing AI-speak
  AI_SPEAK_PATTERNS.forEach((pattern) => {
    // Find and remove sentences containing the pattern
    const sentencePattern = new RegExp(`[^.!?]*${pattern.source}[^.!?]*[.!?]?\\s*`, pattern.flags);
    cleaned = cleaned.replace(sentencePattern, "");
  });

  return cleaned.trim();
}

/**
 * Check if the opening is a repetitive/generic greeting
 */
export function isRepetitiveGreeting(text: string): boolean {
  const firstLine = text.split("\n")[0].trim();
  const firstSentence = text.split(/[.!?]/)[0].trim();

  return REPETITIVE_GREETINGS.some(
    (pattern) => pattern.test(firstLine) || pattern.test(firstSentence),
  );
}

/**
 * Simple LRU cache implementation.
 * When a key is accessed, it's moved to the end (most recently used).
 * When capacity is exceeded, the oldest (least recently used) entry is evicted.
 */
class LRUCache<K, V> {
  private cache = new Map<K, V>();
  private readonly maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  get(key: K): V | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    // Delete first to ensure it goes to end
    this.cache.delete(key);
    this.cache.set(key, value);

    // Evict oldest (first entry) if over capacity
    if (this.cache.size > this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) this.cache.delete(oldestKey);
    }
  }

  delete(key: K): boolean {
    return this.cache.delete(key);
  }

  get size(): number {
    return this.cache.size;
  }
}

const recentOpenings = new LRUCache<string, string[]>(1000);
const MAX_TRACKED_OPENINGS = 5;

function getResponseOpening(text: string): string {
  const firstSentence = text.split(/[.!?]/)[0].trim();
  return firstSentence.substring(0, 50).toLowerCase();
}

export function isRepeatedOpening(roomId: string, text: string): boolean {
  const opening = getResponseOpening(text);
  const recent = recentOpenings.get(roomId) || [];
  return recent.includes(opening);
}

export function trackOpening(roomId: string, text: string): void {
  const opening = getResponseOpening(text);
  const recent = recentOpenings.get(roomId) || [];

  recent.push(opening);
  if (recent.length > MAX_TRACKED_OPENINGS) recent.shift();
  recentOpenings.set(roomId, recent);
}

export interface ProcessedResponse {
  text: string;
  wasModified: boolean;
  hadAISpeak: boolean;
  isRepetitive: boolean;
  warnings: string[];
}

export function postProcessResponse(text: string, roomId?: string): ProcessedResponse {
  const warnings: string[] = [];
  let processed = text;
  let wasModified = false;

  // Check for AI-speak
  const hadAISpeak = containsAISpeak(text);
  if (hadAISpeak) {
    processed = removeAISpeak(processed);
    wasModified = true;
    warnings.push("Removed AI-speak patterns");
    logger.warn("[Response Post-Process] Removed AI-speak from response");
  }

  // Check for repetitive greeting
  const isRepetitive =
    isRepetitiveGreeting(processed) || (roomId ? isRepeatedOpening(roomId, processed) : false);

  if (isRepetitive) {
    warnings.push("Response starts with repetitive greeting");
    logger.warn("[Response Post-Process] Detected repetitive opening");
  }

  // Track this opening if room provided
  if (roomId && processed.trim()) {
    trackOpening(roomId, processed);
  }

  return {
    text: processed,
    wasModified,
    hadAISpeak,
    isRepetitive,
    warnings,
  };
}

/**
 * Cached attachment from action results.
 */
export interface CachedAttachment {
  url?: string;
  id?: string;
  title?: string;
  contentType?: string;
}

const actionAttachmentCache = new LRUCache<string, CachedAttachment[]>(500);
const actionResponseSentCache = new LRUCache<string, boolean>(500);

export function hasActionSentResponse(roomId: string): boolean {
  return actionResponseSentCache.get(roomId) === true;
}

export function clearActionResponseFlag(roomId: string): void {
  actionResponseSentCache.delete(roomId);
}

function isBase64DataUrl(url: string): boolean {
  return url.startsWith("data:");
}

export function getAndClearCachedAttachments(roomId: string): CachedAttachment[] {
  const attachments = actionAttachmentCache.get(roomId) || [];
  actionAttachmentCache.delete(roomId);
  return attachments;
}

export function cleanPrompt(prompt: string): string {
  return prompt
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n");
}

interface Attachment {
  url?: string;
  id?: string;
  title?: string;
  contentType?: string;
  [key: string]: unknown;
}

interface AttachmentActionResult {
  data?: { attachments?: Attachment[] };
}

export function extractAttachments(actionResults: AttachmentActionResult[]): Attachment[] {
  return actionResults
    .flatMap((result) => result.data?.attachments ?? [])
    .filter((att): att is Attachment => {
      if (!att?.url) return false;
      if (isBase64DataUrl(att.url)) return false;
      if (att.url.startsWith("[") || att.url === "" || !att.url.startsWith("http")) return false;
      return true;
    });
}

export async function executeProviders(
  runtime: IAgentRuntime,
  message: Memory,
  plannedProviders: string[],
  currentState: State,
): Promise<State> {
  if (plannedProviders.length === 0) return currentState;

  const providerState = await runtime.composeState(message, [...plannedProviders, "CHARACTER"]);
  return { ...currentState, ...providerState };
}

export async function executeActions(
  runtime: IAgentRuntime,
  message: Memory,
  plannedActions: string[],
  plan: ParsedPlan | null,
  currentState: State,
  callback?: HandlerCallback,
  onStreamChunk?: (chunk: string, messageId?: UUID) => Promise<void>,
): Promise<State> {
  if (plannedActions.length === 0) return currentState;

  const actionResponse: Memory = {
    id: createUniqueUuid(runtime, v4() as UUID),
    entityId: runtime.agentId,
    agentId: runtime.agentId,
    roomId: message.roomId,
    worldId: message.worldId,
    content: {
      text: plan?.thought || "Executing actions",
      actions: plannedActions,
      source: "agent",
    },
  };

  actionAttachmentCache.set(message.roomId as string, []);
  actionResponseSentCache.set(message.roomId as string, false);

  const wrappedCallback: HandlerCallback = async (content) => {
    if (content.text?.trim()) {
      actionResponseSentCache.set(message.roomId as string, true);
    }

    if (content.attachments?.length) {
      const existing = actionAttachmentCache.get(message.roomId as string) || [];
      for (const att of content.attachments) {
        const a = att as Attachment;
        if (a.url?.startsWith("http")) {
          existing.push({
            id: a.id,
            url: a.url,
            title: a.title,
            contentType: a.contentType,
          });
        }
      }
      actionAttachmentCache.set(message.roomId as string, existing);
    }

    return callback ? callback(content) : [];
  };

  const previousResults: CoreActionResult[] = [];
  const activeContexts = resolveActiveContexts(currentState);
  for (const actionName of plannedActions) {
    const result = await executePlannedToolCall(
      runtime,
      {
        message,
        state: currentState,
        activeContexts,
        previousResults,
        callback: wrappedCallback,
        responses: [actionResponse],
      },
      { name: actionName },
      onStreamChunk ? { onStreamChunk } : undefined,
    );
    previousResults.push(result);
  }
  const actionState = await runtime.composeState(message, ["CURRENT_RUN_CONTEXT"]);
  return { ...currentState, ...actionState };
}

function resolveActiveContexts(state: State): AgentContext[] {
  const values = [
    state.data?.selectedContexts,
    state.data?.activeContexts,
    state.data?.contexts,
    state.values?.selectedContexts,
    state.values?.activeContexts,
    state.values?.contexts,
  ];
  const contexts = new Set<AgentContext>(["general"]);
  for (const value of values) {
    if (Array.isArray(value)) {
      for (const context of value) {
        if (typeof context === "string" && context.trim()) {
          contexts.add(context.trim().toLowerCase() as AgentContext);
        }
      }
    } else if (typeof value === "string" && value.trim()) {
      for (const context of value.split(/[\n,;]/)) {
        if (context.trim()) {
          contexts.add(context.trim().toLowerCase() as AgentContext);
        }
      }
    }
  }
  return [...contexts];
}

/**
 * Options for generateResponseWithRetry
 */
interface GenerateResponseOptions {
  /** Callback for streaming text chunks in real-time */
  onStreamChunk?: (chunk: string, messageId?: UUID) => Promise<void>;
  /** Callback for streaming thought/reasoning chunks from response */
  onReasoningChunk?: (
    chunk: string,
    phase: "planning" | "actions" | "response",
    messageId?: UUID,
  ) => Promise<void>;
  /** Message ID for streaming coordination */
  messageId?: UUID;
}

/**
 * Options for streaming planning generation
 */
interface StreamingPlanOptions {
  /** Callback for streaming reasoning/thought chunks in real-time */
  onReasoningChunk?: (
    chunk: string,
    phase: "planning" | "actions" | "response",
    messageId?: UUID,
  ) => Promise<void>;
  /** Message ID for streaming coordination */
  messageId?: UUID;
}

function createPlanningStreamFilter(
  onThoughtChunk: (
    chunk: string,
    phase: "planning" | "actions" | "response",
    messageId?: UUID,
  ) => Promise<void>,
  phase: "planning" | "actions" | "response",
  messageId?: UUID,
) {
  let insideThought = false;
  let buffer = "";

  return {
    processChunk: async (chunk: string) => {
      buffer += chunk;

      while (buffer.length > 0) {
        if (!insideThought) {
          const tagStart = buffer.indexOf("<thought>");
          if (tagStart === -1) {
            if (buffer.length > 8) buffer = buffer.slice(-8);
            break;
          }
          buffer = buffer.slice(tagStart + 9);
          insideThought = true;
        }

        if (insideThought) {
          const tagEnd = buffer.indexOf("</thought>");
          if (tagEnd === -1) {
            if (buffer.length > 10) {
              await onThoughtChunk(buffer.slice(0, -10), phase, messageId);
              buffer = buffer.slice(-10);
            }
            break;
          }
          const content = buffer.slice(0, tagEnd);
          if (content) await onThoughtChunk(content, phase, messageId);
          buffer = buffer.slice(tagEnd + 10);
          insideThought = false;
        }
      }
    },
    flush: async () => {
      if (insideThought && buffer) {
        await onThoughtChunk(buffer, phase, messageId);
        buffer = "";
      }
    },
  };
}

export async function generatePlanningWithStreaming(
  runtime: IAgentRuntime,
  prompt: string,
  options?: StreamingPlanOptions,
): Promise<string> {
  const { onReasoningChunk, messageId } = options || {};
  let streamFilter: ReturnType<typeof createPlanningStreamFilter> | null = null;

  if (onReasoningChunk) {
    streamFilter = createPlanningStreamFilter(onReasoningChunk, "planning", messageId);
  }

  const response = await runtime.useModel(ModelType.TEXT_LARGE, {
    prompt,
    ...(onReasoningChunk &&
      streamFilter && {
        stream: true,
        onStreamChunk: async (chunk: string) => {
          await streamFilter!.processChunk(chunk);
        },
      }),
  });

  if (streamFilter) {
    await streamFilter.flush();
  }

  return typeof response === "string" ? response : JSON.stringify(response);
}

/**
 * Creates a streaming XML filter that extracts content from <text> and <thought> tags.
 * Each tag has its own independent state machine to handle interleaved content.
 */
function createStreamingXmlFilter(
  onFilteredChunk: (chunk: string, messageId?: UUID) => Promise<void>,
  messageId?: UUID,
  onThoughtChunk?: (
    chunk: string,
    phase: "planning" | "actions" | "response",
    messageId?: UUID,
  ) => Promise<void>,
) {
  // Separate state machines for each tag type to prevent interference
  const textState = { buffer: "", inside: false };
  const thoughtState = { buffer: "", inside: false };

  /**
   * Process a single tag type from a buffer.
   * Returns remaining unprocessed content.
   */
  const processTag = async (
    input: string,
    startTag: string,
    endTag: string,
    onContent: (content: string) => Promise<void>,
    state: { buffer: string; inside: boolean },
  ): Promise<string> => {
    state.buffer += input;

    while (state.buffer.length > 0) {
      if (!state.inside) {
        const tagStart = state.buffer.indexOf(startTag);
        if (tagStart === -1) {
          // Keep minimum buffer for partial tag detection
          if (state.buffer.length > startTag.length) {
            state.buffer = state.buffer.slice(-(startTag.length - 1));
          }
          break;
        }
        // Found start tag, enter content mode
        state.buffer = state.buffer.slice(tagStart + startTag.length);
        state.inside = true;
      }

      if (state.inside) {
        const tagEnd = state.buffer.indexOf(endTag);
        if (tagEnd === -1) {
          // No end tag yet - stream what we can safely emit
          if (state.buffer.length > endTag.length) {
            const safeContent = state.buffer.slice(0, -(endTag.length - 1));
            if (safeContent) await onContent(safeContent);
            state.buffer = state.buffer.slice(-(endTag.length - 1));
          }
          break;
        }
        // Found end tag - emit content and exit content mode
        const content = state.buffer.slice(0, tagEnd);
        if (content) await onContent(content);
        state.buffer = state.buffer.slice(tagEnd + endTag.length);
        state.inside = false;
      }
    }

    return state.buffer;
  };

  return {
    processChunk: async (chunk: string) => {
      // Process text tag with its own state
      await processTag(
        chunk,
        "<text>",
        "</text>",
        async (content) => onFilteredChunk(content, messageId),
        textState,
      );

      // Process thought tag with its own state (if callback provided)
      if (onThoughtChunk) {
        await processTag(
          chunk,
          "<thought>",
          "</thought>",
          async (content) => onThoughtChunk(content, "response", messageId),
          thoughtState,
        );
      }
    },
    flush: async () => {
      // Emit any remaining buffered content
      if (textState.inside && textState.buffer) {
        await onFilteredChunk(textState.buffer, messageId);
        textState.buffer = "";
      }
      if (thoughtState.inside && thoughtState.buffer && onThoughtChunk) {
        await onThoughtChunk(thoughtState.buffer, "response", messageId);
        thoughtState.buffer = "";
      }
    },
  };
}

/**
 * Generate a response with retry logic and optional real-time streaming.
 *
 * When onStreamChunk is provided, the response is streamed in real-time
 * as it's generated by the model. The XML structure is parsed incrementally
 * so only the actual response text (inside <text>...</text>) is streamed to
 * the user - no XML tags appear in the stream.
 */
export async function generateResponseWithRetry(
  runtime: IAgentRuntime,
  prompt: string,
  options?: GenerateResponseOptions,
): Promise<{ text: string; thought: string }> {
  let lastRawResponse = "";
  let lastError: Error | null = null;
  const { onStreamChunk, onReasoningChunk, messageId } = options || {};

  for (let i = 0; i < MAX_RESPONSE_RETRIES; i++) {
    try {
      // When streaming callback is provided, enable streaming mode with XML filtering
      // The filter extracts content from <text>...</text> AND <thought>...</thought> tags
      // Text goes to main response, thought goes to reasoning display
      let streamFilter: ReturnType<typeof createStreamingXmlFilter> | null = null;

      if (onStreamChunk) {
        streamFilter = createStreamingXmlFilter(onStreamChunk, messageId, onReasoningChunk);
      }

      const response = await runtime.useModel(ModelType.TEXT_LARGE, {
        prompt,
        ...(onStreamChunk &&
          streamFilter && {
            stream: true,
            onStreamChunk: async (chunk: string) => {
              await streamFilter!.processChunk(chunk);
            },
          }),
      });

      // Flush any remaining buffered content
      if (streamFilter) {
        await streamFilter.flush();
      }

      if (!response || (typeof response === "string" && response.trim() === "")) {
        logger.warn(`[generateResponseWithRetry] Attempt ${i + 1}: Empty response from model`);
        continue;
      }

      lastRawResponse = typeof response === "string" ? response : JSON.stringify(response);
      const parsed = parseKeyValueXml(response) as ParsedResponse | null;

      if (parsed?.text) {
        return { text: parsed.text, thought: parsed.thought || "" };
      }

      logger.warn(
        `[generateResponseWithRetry] Attempt ${i + 1}: Failed to parse XML, raw: "${lastRawResponse.substring(0, 100)}..."`,
      );
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      logger.error(`[generateResponseWithRetry] Attempt ${i + 1} failed:`, lastError.message);
    }
  }

  if (lastRawResponse && lastRawResponse.length > 10) {
    const cleanedResponse = lastRawResponse
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();

    if (cleanedResponse.length > 20) {
      logger.info(`[generateResponseWithRetry] Using cleaned raw response as fallback`);
      return { text: cleanedResponse, thought: "" };
    }
  }

  logger.error(
    `[generateResponseWithRetry] All ${MAX_RESPONSE_RETRIES} attempts failed. Last error: ${lastError?.message || "Unknown"}`,
  );
  return { text: "", thought: "" };
}

export async function runEvaluatorsWithTimeout(
  runtime: IAgentRuntime,
  message: Memory,
  state: State,
  responseMemory: Memory,
  callback: HandlerCallback,
): Promise<void> {
  if (typeof runtime.evaluate !== "function") return;

  await Promise.race([
    runtime.evaluate(
      message,
      { ...state },
      true,
      async (content) => {
        const result = await callback?.(content);
        return result ?? [];
      },
      [responseMemory],
    ),
    new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error("Evaluators timeout")), EVALUATOR_TIMEOUT_MS),
    ),
  ]);
}
