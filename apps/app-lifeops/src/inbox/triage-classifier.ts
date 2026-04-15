import type { IAgentRuntime } from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import type {
  InboundMessage,
  InboxTriageConfig,
  InboxTriageRules,
  TriageClassification,
  TriageExample,
  TriageResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// Rule-based pre-classification
// ---------------------------------------------------------------------------

/**
 * Check if a message matches any rule-based override before hitting the LLM.
 * Returns a classification if matched, null if the LLM should decide.
 */
export function applyTriageRules(
  message: InboundMessage,
  rules: InboxTriageRules | undefined,
  _config: InboxTriageConfig | undefined,
): TriageClassification | null {
  if (!rules) return null;

  const text = message.text.toLowerCase();
  const senderId = message.entityId ?? "";
  const channelName = message.channelName.toLowerCase();
  const source = message.source.toLowerCase();

  for (const pattern of rules.alwaysUrgent ?? []) {
    if (matchesRule(pattern, text, senderId, channelName, source)) {
      return "urgent";
    }
  }
  for (const pattern of rules.alwaysIgnore ?? []) {
    if (matchesRule(pattern, text, senderId, channelName, source)) {
      return "ignore";
    }
  }
  for (const pattern of rules.alwaysNotify ?? []) {
    if (matchesRule(pattern, text, senderId, channelName, source)) {
      return "notify";
    }
  }

  return null;
}

function matchesRule(
  pattern: string,
  text: string,
  senderId: string,
  channelName: string,
  source: string,
): boolean {
  const [prefix, value] = pattern.split(":", 2);
  if (!value) return false;
  const lowerValue = value.toLowerCase();

  switch (prefix.toLowerCase()) {
    case "keyword":
      return text.includes(lowerValue);
    case "sender":
      return senderId.toLowerCase() === lowerValue;
    case "channel":
      return channelName.includes(lowerValue);
    case "source":
      return source === lowerValue;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// LLM-based classification
// ---------------------------------------------------------------------------

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
    // Fall back: classify everything as "notify" with low confidence
    return messages.map(() => ({
      classification: "notify" as const,
      urgency: "low" as const,
      confidence: 0.3,
      reasoning: "LLM classification unavailable; defaulting to notify",
    }));
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
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const gmailHints: string[] = [];
    if (msg.gmailIsImportant) gmailHints.push("Gmail-marked-important");
    if (msg.gmailLikelyReplyNeeded)
      gmailHints.push("Gmail-likely-reply-needed");
    const hintsStr = gmailHints.length > 0 ? ` [${gmailHints.join(", ")}]` : "";

    sections.push(
      `### Message ${i + 1}`,
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
    "Return ONLY the JSON array, no other text.",
  );

  return sections.join("\n");
}

function parseTriageResults(
  raw: string,
  expectedCount: number,
): TriageResult[] {
  // Try to extract JSON array from the response
  const jsonMatch = raw.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    logger.warn(
      "[inbox-classifier] Could not extract JSON array from LLM response",
    );
    return fallbackResults(expectedCount);
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as unknown[];
    if (!Array.isArray(parsed)) {
      return fallbackResults(expectedCount);
    }

    const results: TriageResult[] = [];
    for (let i = 0; i < expectedCount; i++) {
      const item = parsed[i] as Record<string, unknown> | undefined;
      if (!item || typeof item !== "object") {
        results.push(fallbackResult());
        continue;
      }
      results.push({
        classification: validClassification(item.classification) ?? "notify",
        urgency: validUrgency(item.urgency) ?? "low",
        confidence: validConfidence(item.confidence) ?? 0.5,
        reasoning: typeof item.reasoning === "string" ? item.reasoning : "",
        suggestedResponse:
          typeof item.suggestedResponse === "string"
            ? item.suggestedResponse
            : undefined,
      });
    }
    return results;
  } catch {
    logger.warn("[inbox-classifier] Failed to parse LLM JSON response");
    return fallbackResults(expectedCount);
  }
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

function fallbackResult(): TriageResult {
  return {
    classification: "notify",
    urgency: "low",
    confidence: 0.3,
    reasoning: "Could not parse LLM classification",
  };
}

function fallbackResults(count: number): TriageResult[] {
  return Array.from({ length: count }, () => fallbackResult());
}
