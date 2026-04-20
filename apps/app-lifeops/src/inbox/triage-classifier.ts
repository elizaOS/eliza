import type { IAgentRuntime } from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
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
    const result = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
    rawResponse = typeof result === "string" ? result : "";
  } catch (error) {
    logger.warn("[inbox-classifier] LLM classification failed:", String(error));
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
    sections.push("", "## Owner Context", opts.ownerContext);
  }

  // Priority senders/channels
  const config = opts.config;
  if (config?.prioritySenders?.length) {
    sections.push(
      "",
      `## Priority Senders (treat as higher urgency): ${config.prioritySenders.join(", ")}`,
    );
  }
  if (config?.priorityChannels?.length) {
    sections.push(
      "",
      `## Priority Channels: ${config.priorityChannels.join(", ")}`,
    );
  }

  // Few-shot examples
  if (opts.examples && opts.examples.length > 0) {
    sections.push("", "## Examples from past triage decisions:");
    for (const ex of opts.examples.slice(0, 5)) {
      sections.push(
        `- Source: ${ex.source} | Snippet: "${ex.snippet.slice(0, 80)}" | Classified: ${ex.classification}` +
          (ex.ownerClassification
            ? ` (owner corrected to: ${ex.ownerClassification})`
            : ""),
      );
    }
  }

  // Messages to classify
  sections.push("", "## Messages to classify:", "");
  for (const [index, msg] of messages.entries()) {
    const gmailHints: string[] = [];
    if (msg.gmailIsImportant) gmailHints.push("Gmail-marked-important");
    if (msg.gmailLikelyReplyNeeded)
      gmailHints.push("Gmail-likely-reply-needed");
    const hintsStr = gmailHints.length > 0 ? ` [${gmailHints.join(", ")}]` : "";

    sections.push(
      `### Message ${index + 1}`,
      `Source: ${msg.source} | Channel: ${msg.channelName} (${msg.channelType}) | From: ${msg.senderName}${hintsStr}`,
      `Text: ${msg.text.slice(0, 500)}`,
    );
    if (msg.threadMessages && msg.threadMessages.length > 0) {
      sections.push(`Recent context: ${msg.threadMessages.join(" | ")}`);
    }
    sections.push("");
  }

  sections.push(
    "Respond with a JSON array of objects, one per message, in order. Each object must have:",
    '{ "classification": "...", "urgency": "...", "confidence": 0.0-1.0, "reasoning": "...", "suggestedResponse": "..." }',
    "",
    "Return ONLY a bare JSON array — no prose, no markdown, no code fences, no <think>.",
    "The response must start with [ and end with ].",
  );

  return sections.join("\n");
}

// Strip a surrounding markdown code fence from the model output, e.g.
// ```json\n[...]\n``` or ```\n[...]\n```. This is purely about tolerating
// common model formatting — it is NOT a semantic regex over user input.
const TRIAGE_CODE_FENCE_PATTERN =
  /^\s*```(?:json|json5)?\s*\r?\n?([\s\S]*?)\r?\n?```\s*$/i;

// Parse a JSON array returned by the classifier. We ask the model for a bare
// array ("starts with [, ends with ]"). We tolerate code fences and leading
// <think> blocks, but we do NOT regex-slice an array out of arbitrary prose —
// that approach silently accepts malformed output and hides real failures.
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
      "Failed to parse LLM classification JSON",
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

function parseTriageResults(
  raw: string,
  expectedCount: number,
): TriageResult[] {
  const parsed = parseTriageJsonArray(raw);

  const results: TriageResult[] = [];
  for (let i = 0; i < expectedCount; i++) {
    const item = parsed[i] as Record<string, unknown> | undefined;
    if (!item || typeof item !== "object") {
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
      reasoning: typeof item.reasoning === "string" ? item.reasoning : "",
      suggestedResponse:
        typeof item.suggestedResponse === "string"
          ? item.suggestedResponse
          : undefined,
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
  if (
    typeof v === "string" &&
    VALID_CLASSIFICATIONS.has(v as TriageClassification)
  ) {
    return v as TriageClassification;
  }
  return null;
}

function validUrgency(v: unknown): "low" | "medium" | "high" | null {
  if (typeof v === "string" && VALID_URGENCIES.has(v)) {
    return v as "low" | "medium" | "high";
  }
  return null;
}

function validConfidence(v: unknown): number | null {
  if (typeof v === "number" && v >= 0 && v <= 1) return v;
  return null;
}
