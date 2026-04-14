import type { IAgentRuntime } from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";

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
  if (looksLikeInboxConfirmation(opts.userMessage)) {
    return {
      confirmed: true,
      reasoning:
        "Explicit confirmation phrase matched deterministic safety pre-check.",
    };
  }

  if (REJECTION_PATTERN.test(opts.userMessage.trim().toLowerCase())) {
    return {
      confirmed: false,
      reasoning:
        "Explicit rejection phrase matched deterministic safety pre-check.",
    };
  }

  const prompt = [
    "You are a safety check for an inbox response system. Your job is to determine",
    "whether the user has clearly confirmed they want to send a drafted message.",
    "",
    `The pending draft message is: "${opts.draftText}"`,
    `It would be sent to: ${opts.recipientName} on ${opts.channelName}`,
    "",
    `The user's most recent message is: "${opts.userMessage}"`,
    "",
    "Determine if the user CLEARLY confirmed they want this message sent.",
    "Confirmation signals: 'yes', 'send it', 'go ahead', 'looks good, send it', 'confirm'",
    "Rejection signals: 'no', 'wait', 'hold on', 'change it', 'actually...', 'not yet'",
    "Ambiguous (treat as NOT confirmed): single words that could mean anything, unrelated responses",
    "",
    'Respond with exactly one JSON object: { "confirmed": true/false, "reasoning": "brief explanation" }',
  ].join("\n");

  try {
    const result = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
    const raw = typeof result === "string" ? result : "";

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
      return {
        confirmed: parsed.confirmed === true,
        reasoning:
          typeof parsed.reasoning === "string"
            ? parsed.reasoning
            : "No reasoning provided",
      };
    }

    // Fallback: check for YES/NO in the raw text
    const lower = raw.toLowerCase().trim();
    if (lower.startsWith("yes") || lower.includes('"confirmed": true')) {
      return { confirmed: true, reasoning: raw.slice(0, 200) };
    }
    return {
      confirmed: false,
      reasoning: `Could not parse reflection: ${raw.slice(0, 100)}`,
    };
  } catch (error) {
    logger.warn(
      "[inbox-reflection] Reflection LLM call failed:",
      String(error),
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
  const combinedText = `${opts.inboundText}\n${opts.replyText}`.toLowerCase();
  const safeReply =
    /^(?:thanks!?|thank you!?|you'?re welcome!?|got it!?|sounds good!?|hi!?|hello!?|hey!?|ok(?:ay)?!?|noted\.?)$/i.test(
      opts.replyText.trim(),
    );
  const sensitiveReplyContext =
    /\b(invest|wire|money|\$\d|legal|lawsuit|lawyer|diagnos|medical|bank|password|ssn|social security|seed phrase|private key|wallet)\b/i.test(
      combinedText,
    );
  const heatedContext =
    /\b(angry|upset|furious|frustrated|complaint|hate|wtf)\b/i.test(
      combinedText,
    );

  if (safeReply && !sensitiveReplyContext && !heatedContext) {
    return {
      approved: true,
      reasoning:
        "Simple acknowledgement matched deterministic safe auto-reply pre-check.",
    };
  }

  const prompt = [
    "You are a safety check for an auto-reply system. The system wants to automatically",
    "send a reply WITHOUT explicit owner confirmation. Your job is to determine if this",
    "auto-reply is appropriate and safe to send.",
    "",
    `Inbound message from ${opts.senderName} on ${opts.source}: "${opts.inboundText}"`,
    `Proposed auto-reply: "${opts.replyText}"`,
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
    'Respond with exactly one JSON object: { "approved": true/false, "reasoning": "brief explanation" }',
  ].join("\n");

  try {
    const result = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
    const raw = typeof result === "string" ? result : "";

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
      return {
        approved: parsed.approved === true,
        reasoning:
          typeof parsed.reasoning === "string"
            ? parsed.reasoning
            : "No reasoning provided",
      };
    }

    return {
      approved: false,
      reasoning: `Could not parse reflection: ${raw.slice(0, 100)}`,
    };
  } catch (error) {
    logger.warn(
      "[inbox-reflection] Auto-reply reflection failed:",
      String(error),
    );
    return {
      approved: false,
      reasoning: "Reflection check failed; blocking auto-reply for safety",
    };
  }
}

// ---------------------------------------------------------------------------
// Natural language confirmation detection
// ---------------------------------------------------------------------------

const REJECTION_PATTERN =
  /\b(no|nope|nah|don't|do not|wait|hold on|change|edit|update|instead|actually|not yet|stop|cancel)\b/;

const CONFIRMATION_PATTERN =
  /^(?:yes|yeah|yep|yup|ok|okay|sure|confirm|confirmed|go ahead|do it|send it|send that|please send|please do|sounds good|looks good|lgtm)\b/;

/**
 * Detect whether a user message looks like a confirmation to send a draft.
 * Used as a fast pre-check before the reflection LLM call.
 */
export function looksLikeInboxConfirmation(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;
  if (REJECTION_PATTERN.test(normalized)) return false;
  return CONFIRMATION_PATTERN.test(normalized);
}
