import type { ActionResult, IAgentRuntime, Memory } from "@elizaos/core";
import { currentGmailComposeOrigin } from "../../../../services/device-actions/service.ts";
import { trustedConnectorAccountId } from "../../../advanced-capabilities/actions/connectorActionUtils.ts";
import type { DraftRequest } from "../types.ts";

/** Hand an unsent new email to the requesting phone's own editor. No provider
 * draft exists and no chat confirmation is armed; the phone owns a later Send. */
export async function deviceEmailDraft(
  runtime: IAgentRuntime,
  message: Memory,
  request: Pick<
    DraftRequest,
    "source" | "to" | "subject" | "body" | "threadId" | "worldId" | "channelId"
  >,
  parameters: unknown,
): Promise<ActionResult | undefined> {
  if (request.source !== "gmail") return;
  const messageId = await currentGmailComposeOrigin(runtime, message);
  if (!messageId) return;
  if (
    request.threadId ||
    request.channelId ||
    (request.worldId && request.worldId !== "default")
  )
    return {
      success: false,
      text: "Open Inbox to prepare a reply in that thread.",
      continueChain: false,
    };

  // The compact editor supports a new text email from the selected mailbox.
  // Preserve any richer addressing, attachment, or timing request for Inbox.
  const explicit = (parameters ?? {}) as Record<string, unknown>;
  if (
    trustedConnectorAccountId(message) ||
    [
      "accountId",
      "connectorAccountId",
      "from",
      "cc",
      "bcc",
      "attachments",
      "thread",
      "inReplyToId",
      "sendAt",
      "sendAtMs",
      "at",
    ].some((key) => {
      const value = explicit[key];
      return Array.isArray(value) ? value.length > 0 : Boolean(value);
    })
  )
    return {
      success: false,
      text: "Open Inbox to prepare this email with those details.",
      continueChain: false,
    };

  const text = "Here’s the draft.";
  return {
    success: true,
    text,
    userFacingText: text,
    verifiedUserFacing: true,
    turnComplete: true,
    continueChain: false,
    values: {
      mode: "local-compose",
      targetId: "inbox",
      emailDraft: {
        version: 1,
        requestMessageId: messageId,
        to: request.to.map((recipient) => recipient.identifier),
        subject: request.subject ?? "",
        body: request.body,
      },
    },
    data: { actionName: "MESSAGE" },
  };
}
