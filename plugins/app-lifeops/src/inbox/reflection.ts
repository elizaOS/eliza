import type { IAgentRuntime } from "@elizaos/core";
import {
  logger,
  ModelType,
  runWithTrajectoryContext,
} from "@elizaos/core";
import { parseJsonModelRecord } from "../utils/json-model-output.js";

function parseReflectionObject(raw: string): Record<string, unknown> | null {
  const parsedJson = parseJsonModelRecord<Record<string, unknown>>(raw);
  if (parsedJson && typeof parsedJson === "object") {
    return parsedJson;
  }
  return null;
}

function promptLine(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : "(empty)";
}

function readBoolean(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  return typeof value === "string" && value.trim().toLowerCase() === "true";
}

function readReasoning(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : "No reasoning provided";
}

// ---------------------------------------------------------------------------
// Send confirmation reflection
// ---------------------------------------------------------------------------

/**
 * Before sending a drafted response, run a reflection LLM call to verify
 * the owner actually confirmed the send. This catches ambiguous messages
 * like "sure" (which could be a response to something else) or "wait"
 * that might be misinterpreted as confirmation.
 *
 * Returns true if the reflection confirms the owner intended to send.
 */
export async function reflectOnSendConfirmation(
  runtime: IAgentRuntime,
  opts: {
    /** The owner's most recent message. */
    userMessage: string;
    /** The drafted response text that would be sent. */
    draftText: string;
    /** Where it would be sent. */
    channelName: string;
    /** Who it would be sent to. */
    recipientName: string;
  },
): Promise<{ confirmed: boolean; reasoning: string }> {
  const prompt = [
    "You are a safety check for an inbox response system. Your job is to determine",
    "whether the user has clearly confirmed they want to send a drafted message.",
    "",
    "Pending draft TOON:",
    `draftText: ${promptLine(opts.draftText)}`,
    `recipientName: ${promptLine(opts.recipientName)}`,
    `channelName: ${promptLine(opts.channelName)}`,
    "",
    "Owner message TOON:",
    `userMessage: ${promptLine(opts.userMessage)}`,
    "",
    "Determine if the user CLEARLY confirmed they want this message sent.",
    "Confirmation signals: 'yes', 'send it', 'go ahead', 'looks good, send it', 'confirm'",
    "Rejection signals: 'no', 'wait', 'hold on', 'change it', 'actually...', 'not yet'",
    "Ambiguous (treat as NOT confirmed): single words that could mean anything, unrelated responses",
    "",
    "Return TOON only with exactly these fields:",
    "confirmed: true or false",
    "reasoning: brief explanation",
  ].join("\n");

  try {
    const result = await runWithTrajectoryContext(
      { purpose: "lifeops-inbox-reflect-autoreply" },
      () => runtime.useModel(ModelType.TEXT_SMALL, { prompt }),
    );
    const raw = typeof result === "string" ? result : "";
    const parsed = parseReflectionObject(raw);
    if (parsed) {
      return {
        confirmed: readBoolean(parsed.confirmed),
        reasoning: readReasoning(parsed.reasoning),
      };
    }
    return {
      confirmed: false,
      reasoning: `Could not parse reflection: ${raw.slice(0, 100)}`,
    };
  } catch (error) {
    logger.warn(
      {
        src: "inbox-reflection",
        error: error instanceof Error ? error.message : String(error),
      },
      "[InboxReflection] send confirmation reflection failed",
    );
    // On error, default to NOT confirmed (safer)
    return {
      confirmed: false,
      reasoning:
        "Reflection check failed; defaulting to not confirmed for safety",
    };
  }
}

// ---------------------------------------------------------------------------
// Auto-reply safety reflection
// ---------------------------------------------------------------------------

/**
 * Before auto-sending a reply without explicit owner confirmation, run a
 * reflection check to verify the response is appropriate and safe.
 */
export async function reflectOnAutoReply(
  runtime: IAgentRuntime,
  opts: {
    /** The original inbound message. */
    inboundText: string;
    /** The proposed auto-reply. */
    replyText: string;
    /** Source channel. */
    source: string;
    /** Sender name. */
    senderName: string;
  },
): Promise<{ approved: boolean; reasoning: string }> {
  const prompt = [
    "You are a safety check for an auto-reply system. The system wants to automatically",
    "send a reply WITHOUT explicit owner confirmation. Your job is to determine if this",
    "auto-reply is appropriate and safe to send.",
    "",
    "Inbound message TOON:",
    `senderName: ${promptLine(opts.senderName)}`,
    `source: ${promptLine(opts.source)}`,
    `inboundText: ${promptLine(opts.inboundText)}`,
    "",
    "Proposed reply TOON:",
    `replyText: ${promptLine(opts.replyText)}`,
    "",
    "Approve the auto-reply ONLY if ALL of these are true:",
    "1. The reply is factually neutral and unlikely to cause harm",
    "2. The reply doesn't make promises, commitments, or share sensitive info",
    "3. The reply is appropriate for the tone and context of the conversation",
    "4. The reply doesn't reveal private information about the owner",
    "5. The message is routine (acknowledgement, simple greeting, basic info)",
    "",
    "Reject if ANY of these are true:",
    "- The reply contains opinions, decisions, or commitments",
    "- The conversation topic is sensitive (financial, legal, personal)",
    "- The reply could be embarrassing or inappropriate",
    "- The sender seems upset or the conversation is heated",
    "",
    "Return TOON only with exactly these fields:",
    "approved: true or false",
    "reasoning: brief explanation",
  ].join("\n");

  try {
    const result = await runWithTrajectoryContext(
      { purpose: "lifeops-inbox-reflect-send" },
      () => runtime.useModel(ModelType.TEXT_SMALL, { prompt }),
    );
    const raw = typeof result === "string" ? result : "";
    const parsed = parseReflectionObject(raw);
    if (parsed) {
      return {
        approved: readBoolean(parsed.approved),
        reasoning: readReasoning(parsed.reasoning),
      };
    }

    return {
      approved: false,
      reasoning: `Could not parse reflection: ${raw.slice(0, 100)}`,
    };
  } catch (error) {
    logger.warn(
      {
        src: "inbox-reflection",
        error: error instanceof Error ? error.message : String(error),
      },
      "[InboxReflection] auto-reply reflection failed",
    );
    return {
      approved: false,
      reasoning: "Reflection check failed; blocking auto-reply for safety",
    };
  }
}
