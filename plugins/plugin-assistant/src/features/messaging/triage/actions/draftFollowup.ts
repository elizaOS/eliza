/**
 * Triage action that composes a follow-up / check-in draft to one or more
 * contacts on a chosen message source. Registered under the shared `MESSAGE`
 * action name; parameters are parsed and validated by `parseDraftFollowupParams`
 * before the handler delegates to the default TriageService's `draftFollowup`,
 * which only produces a preview draft — it never sends. Sending is a separate,
 * confirmed step. ADMIN-gated.
 */

import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import { getDefaultTriageService } from "../triage-service.ts";
import { ALL_MESSAGE_SOURCES } from "../types.ts";
import {
  bodyParameter,
  parseDraftFollowupParams,
  SUPPORTED_MESSAGE_SOURCES_TEXT,
  validateMessageAction,
} from "./_shared.ts";
import { deviceEmailDraft } from "./device-email-draft.ts";

export const draftFollowupAction: Action = {
  name: "MESSAGE",
  contexts: ["messaging", "email", "contacts", "tasks"],
  roleGate: { minRole: "ADMIN" },
  description:
    "Compose a new outbound draft or recreate a previous unsent draft from this chat. No inbox message is needed. On a phone with a Gmail composer, hand the draft to the local editor. Otherwise return a preview. This action never sends.",
  similes: ["COMPOSE_FOLLOWUP", "FOLLOWUP_DRAFT", "CHECK_IN_DRAFT"],
  parameters: [
    {
      name: "source",
      description: `Message source to draft for. One of: ${SUPPORTED_MESSAGE_SOURCES_TEXT}.`,
      required: true,
      schema: { type: "string" as const, enum: [...ALL_MESSAGE_SOURCES] },
    },
    {
      name: "to",
      description: "Recipient identifiers or recipient objects.",
      required: true,
      schema: {
        type: "array" as const,
        items: { type: "string" as const },
      },
    },
    bodyParameter,
    {
      name: "subject",
      description: "Optional subject for email-like sources.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "threadId",
      description: "Optional existing thread identifier.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "channelId",
      description:
        "Optional platform channel to draft into, for channel-based sources.",
      required: false,
      schema: { type: "string" as const },
    },
  ],
  examples: [
    [
      {
        name: "User",
        content: { text: "Draft a follow-up to Alice on Telegram" },
      },
      {
        name: "Agent",
        content: {
          text: "Drafting a follow-up — here's the preview.",
          action: "MESSAGE",
        },
      },
    ],
  ] as ActionExample[][],

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
    state?: State,
  ): Promise<boolean> => validateMessageAction(message, state),

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const parsed = parseDraftFollowupParams(options);
    if ("error" in parsed) {
      logger.warn(`[DraftFollowup] ${parsed.error}`);
      return {
        success: false,
        text: parsed.error,
        error: parsed.error,
      };
    }

    const local = await deviceEmailDraft(
      runtime,
      _message,
      parsed,
      options?.parameters,
    );
    if (local) {
      if (callback && local.text)
        await callback({ text: local.text, action: "MESSAGE" });
      return local;
    }

    const service = getDefaultTriageService();
    const record = await service.draftFollowup(runtime, {
      requester: _message,
      source: parsed.source,
      to: parsed.to,
      subject: parsed.subject,
      body: parsed.body,
      threadId: parsed.threadId,
      worldId: parsed.worldId,
      channelId: parsed.channelId,
    });

    const text = `Drafted follow-up on ${record.source}. Preview: ${record.preview}`;
    logger.info(
      `[DraftFollowup] draftId=${record.draftId} source=${record.source}`,
    );
    if (callback) {
      await callback({ text, action: "MESSAGE" });
    }

    return {
      success: true,
      text,
      data: {
        draftId: record.draftId,
        source: record.source,
        preview: record.preview,
        to: record.to.map((t) => t.identifier),
      },
    };
  },
};
