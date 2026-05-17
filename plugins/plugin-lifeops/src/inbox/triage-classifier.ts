import type { IAgentRuntime } from "@elizaos/core";
import { logger, ModelType, runWithTrajectoryContext } from "@elizaos/core";
import { parseJsonModelRecord } from "../utils/json-model-output.js";
import type {
  InboundMessage,
  InboxTriageConfig,
  TriageClassification,
  TriageExample,
  TriageResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// LLM-based classification
// ---------------------------------------------------------------------------

export class InboxTriageClassificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InboxTriageClassificationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function formatPromptScalar(value: unknown, maxLength = 600): string {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value).replace(/\s+/g, " ").trim().slice(0, maxLength);
}

/**
 * Classify a batch of messages using the LLM. Returns one TriageResult per
 * input message, in the same order.
 */
export async function classifyMessages(
  runtime: IAgentRuntime,
  messages: InboundMessage[],
  opts: {
    config?: InboxTriageConfig;
    examples?: TriageExample[];
    ownerContext?: string;
  },
): Promise<TriageResult[]> {
  if (messages.length === 0) return [];

  const results: TriageResult[] = [];

  // Process in batches of 10 to avoid prompt length issues
  const batchSize = 10;
  for (let i = 0; i < messages.length; i += batchSize) {
    const batch = messages.slice(i, i + batchSize);
    const batchResults = await classifyBatch(runtime, batch, opts);
    results.push(...batchResults);
  }

  return results;
}

async function classifyBatch(
  runtime: IAgentRuntime,
  messages: InboundMessage[],
  opts: {
    config?: InboxTriageConfig;
    examples?: TriageExample[];
    ownerContext?: string;
  },
): Promise<TriageResult[]> {
  const prompt = buildTriagePrompt(messages, opts);

  let rawResponse = "";
  try {
    const result = await runWithTrajectoryContext(
      { purpose: "lifeops-inbox-triage" },
      () => runtime.useModel(ModelType.TEXT_SMALL, { prompt }),
    );
    rawResponse = typeof result === "string" ? result : "";
  } catch (error) {
    logger.warn(
      {
        src: "inbox-classifier",
        error: error instanceof Error ? error.message : String(error),
      },
      "[InboxTriageClassifier] LLM classification failed",
    );
    throw new InboxTriageClassificationError(
      "Inbox classification model call failed.",
    );
  }

  return parseTriageResults(rawResponse, messages.length);
}

function buildTriagePrompt(
  messages: InboundMessage[],
  opts: {
    config?: InboxTriageConfig;
    examples?: TriageExample[];
    ownerContext?: string;
  },
): string {
  const sections: string[] = [];

  sections.push(
    "You are an inbox triage assistant. Classify each message into one of these categories:",
    "",
    "- ignore: spam, irrelevant, automated notifications, bot messages, or general chat that needs no attention",
    "- info: informational updates the owner might want to see but doesn't need to act on",
    "- notify: important information the owner should see, but no response is needed",
    "- needs_reply: someone is asking a question or expects a response from the owner",
    "- urgent: time-sensitive, critical, or from a priority contact — needs immediate attention",
    "",
    "For each message, also provide:",
    "- urgency: low / medium / high",
    "- confidence: 0.0 to 1.0 (how sure you are about this classification)",
    "- reasoning: brief explanation",
    "- suggestedResponse: (optional) a brief draft response if classification is needs_reply or urgent",
  );

  // Owner context
  if (opts.ownerContext) {
    sections.push("", "Owner context:", opts.ownerContext);
  }

  // Priority senders/channels
  const config = opts.config;
  if (config?.prioritySenders?.length) {
    sections.push("", "Priority senders (treat as higher urgency):");
    for (const [index, sender] of config.prioritySenders.entries()) {
      sections.push(`prioritySenders[${index}]: ${formatPromptScalar(sender)}`);
    }
  }
  if (config?.priorityChannels?.length) {
    sections.push("", "Priority channels:");
    for (const [index, channel] of config.priorityChannels.entries()) {
      sections.push(
        `priorityChannels[${index}]: ${formatPromptScalar(channel)}`,
      );
    }
  }

  // Few-shot examples
  if (opts.examples && opts.examples.length > 0) {
    sections.push("", "Examples from past triage decisions:");
    for (const [index, ex] of opts.examples.slice(0, 5).entries()) {
      sections.push(
        `examples[${index}]:`,
        `  source: ${formatPromptScalar(ex.source, 120)}`,
        `  snippet: ${formatPromptScalar(ex.snippet, 160)}`,
        `  classification: ${ex.classification}`,
        `  ownerClassification: ${ex.ownerClassification ?? ""}`,
      );
    }
  }

  // Messages to classify
  sections.push("", "Messages to classify:", "");
  for (const [index, msg] of messages.entries()) {
    const gmailHints: string[] = [];
    if (msg.gmailIsImportant) gmailHints.push("Gmail-marked-important");
    if (msg.gmailLikelyReplyNeeded)
      gmailHints.push("Gmail-likely-reply-needed");

    sections.push(
      `messages[${index}]:`,
      `  source: ${formatPromptScalar(msg.source, 120)}`,
      `  channelName: ${formatPromptScalar(msg.channelName, 160)}`,
      `  channelType: ${msg.channelType}`,
      `  senderName: ${formatPromptScalar(msg.senderName, 160)}`,
    );
    for (const [hintIndex, hint] of gmailHints.entries()) {
      sections.push(`  hints[${hintIndex}]: ${hint}`);
    }
    sections.push(`  text: ${formatPromptScalar(msg.text, 500)}`);
    if (msg.threadMessages && msg.threadMessages.length > 0) {
      for (const [threadIndex, threadMessage] of msg.threadMessages
        .slice(-5)
        .entries()) {
        sections.push(
          `  threadMessages[${threadIndex}]: ${formatPromptScalar(threadMessage, 240)}`,
        );
      }
    }
    sections.push("");
  }

  sections.push(
    "Return JSON only as a single object with one results array entry per message in the same order.",
    "Use this exact shape:",
    '{"results":[{"classification":"ignore|info|notify|needs_reply|urgent","urgency":"low|medium|high","confidence":0.0,"reasoning":"brief explanation","suggestedResponse":null}]}',
    "suggestedResponse may be a brief draft response when useful, otherwise null.",
    "",
    "No prose, markdown, code fences, or <think>.",
  );

  return sections.join("\n");
}

// Legacy JSON fallback: strip a surrounding markdown code fence from older
// model output, e.g. ```json\n[...]\n``` or ```\n[...]\n```.
const TRIAGE_CODE_FENCE_PATTERN =
  /^\s*```(?:json|json5)?\s*\r?\n?([\s\S]*?)\r?\n?```\s*$/i;

// Parse a legacy JSON array returned by older classifier prompts. We tolerate
// code fences and leading <think> blocks, but we do NOT regex-slice an array
// out of arbitrary prose because that silently accepts malformed output.
function parseTriageJsonArray(raw: string): unknown[] {
  let candidate = raw.trim();
  if (candidate.length === 0) {
    throw new InboxTriageClassificationError(
      "Inbox classification returned an empty response.",
    );
  }
  // Strip a leading <think>...</think> block (some reasoning models emit one).
  const thinkEnd = candidate.indexOf("</think>");
  if (candidate.startsWith("<think>") && thinkEnd !== -1) {
    candidate = candidate.slice(thinkEnd + "</think>".length).trim();
  }
  const fenced = candidate.match(TRIAGE_CODE_FENCE_PATTERN);
  if (fenced) {
    candidate = (fenced[1] ?? "").trim();
  }
  if (!candidate.startsWith("[")) {
    throw new InboxTriageClassificationError(
      "Inbox classification did not return a JSON array.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate) as unknown;
  } catch (error) {
    logger.warn(
      { src: "inbox-classifier", error: String(error) },
      "[InboxTriageClassifier] failed to parse LLM classification JSON",
    );
    throw new InboxTriageClassificationError(
      "Inbox classification JSON parsing failed.",
    );
  }
  if (!Array.isArray(parsed)) {
    throw new InboxTriageClassificationError(
      "Inbox classification did not return a JSON array.",
    );
  }
  return parsed;
}

function asStructuredArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function parseTriageJsonObjectArray(raw: string): unknown[] | null {
  const parsed = parseJsonModelRecord<Record<string, unknown>>(raw);
  if (!parsed) {
    return null;
  }

  const directArray =
    asStructuredArray(parsed.results) ??
    asStructuredArray(parsed.messages) ??
    asStructuredArray(parsed.items) ??
    asStructuredArray(parsed.classifications);
  if (directArray) {
    return directArray;
  }

  const classifications = asStructuredArray(parsed.classification);
  if (!classifications) {
    return null;
  }

  const urgencies = asStructuredArray(parsed.urgency) ?? [];
  const confidences = asStructuredArray(parsed.confidence) ?? [];
  const reasonings = asStructuredArray(parsed.reasoning) ?? [];
  const suggestedResponses =
    asStructuredArray(parsed.suggestedResponse) ??
    asStructuredArray(parsed.suggested_response) ??
    [];

  return classifications.map((classification, index) => ({
    classification,
    urgency: urgencies[index],
    confidence: confidences[index],
    reasoning: reasonings[index],
    suggestedResponse: suggestedResponses[index],
  }));
}

function parseTriageStructuredArray(raw: string): unknown[] {
  const jsonParsed = parseTriageJsonObjectArray(raw);
  if (jsonParsed) {
    return jsonParsed;
  }
  return parseTriageJsonArray(raw);
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === "null") {
    return undefined;
  }
  return trimmed;
}

function parseTriageResults(
  raw: string,
  expectedCount: number,
): TriageResult[] {
  const parsed = parseTriageStructuredArray(raw);

  const results: TriageResult[] = [];
  for (let i = 0; i < expectedCount; i++) {
    const item = parsed[i];
    if (!isRecord(item)) {
      throw new InboxTriageClassificationError(
        "Inbox classification omitted one or more messages.",
      );
    }
    const classification = validClassification(item.classification);
    const urgency = validUrgency(item.urgency);
    const confidence = validConfidence(item.confidence);
    if (!classification || !urgency || confidence === null) {
      throw new InboxTriageClassificationError(
        "Inbox classification returned invalid structured fields.",
      );
    }
    results.push({
      classification,
      urgency,
      confidence,
      reasoning: normalizeOptionalString(item.reasoning) ?? "",
      suggestedResponse: normalizeOptionalString(
        item.suggestedResponse ?? item.suggested_response,
      ),
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const VALID_CLASSIFICATIONS = new Set<TriageClassification>([
  "ignore",
  "info",
  "notify",
  "needs_reply",
  "urgent",
]);

const VALID_URGENCIES = new Set(["low", "medium", "high"]);

function validClassification(v: unknown): TriageClassification | null {
  if (typeof v === "string") {
    const normalized = v.trim().toLowerCase();
    if (VALID_CLASSIFICATIONS.has(normalized as TriageClassification)) {
      return normalized as TriageClassification;
    }
  }
  return null;
}

function validUrgency(v: unknown): "low" | "medium" | "high" | null {
  if (typeof v === "string") {
    const normalized = v.trim().toLowerCase();
    if (VALID_URGENCIES.has(normalized)) {
      return normalized as "low" | "medium" | "high";
    }
  }
  return null;
}

function validConfidence(v: unknown): number | null {
  const numeric =
    typeof v === "string" && v.trim().length > 0 ? Number(v.trim()) : v;
  if (
    typeof numeric === "number" &&
    Number.isFinite(numeric) &&
    numeric >= 0 &&
    numeric <= 1
  ) {
    return numeric;
  }
  return null;
}
