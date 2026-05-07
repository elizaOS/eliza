/**
 * Publish a Nostr text note (kind:1) to relays.
 */

import {
  type Action,
  type ActionResult,
  composePromptFromState,
  type IAgentRuntime,
  logger,
  type Memory,
  ModelType,
  parseJSONObjectFromText,
  type State,
} from "@elizaos/core";
import type { NostrService } from "../service.js";
import { NOSTR_SERVICE_NAME } from "../types.js";

const PUBLISH_NOTE_TEMPLATE = `# Task: Extract a Nostr note (kind:1) from the conversation

Recent conversation:
{{recentMessages}}

Extract the text content of the note to publish. Respond with JSON only, no prose or fences:

{
  "text": "the note content here"
}
`;

interface PublishNoteParams {
  text: string;
}

const MAX_NOSTR_NOTE_CHARS = 4_000;
const MAX_NOSTR_RESULT_RELAYS = 10;
const NOSTR_ACTION_TIMEOUT_MS = 30_000;

function readDirectText(_options: Record<string, unknown> | undefined): string | null {
  if (!_options) return null;
  const direct = _options.text;
  if (typeof direct === "string" && direct.trim()) {
    return direct.trim().slice(0, MAX_NOSTR_NOTE_CHARS);
  }
  const params = (_options as { parameters?: Record<string, unknown> }).parameters;
  if (params && typeof params.text === "string" && params.text.trim()) {
    return params.text.trim().slice(0, MAX_NOSTR_NOTE_CHARS);
  }
  return null;
}

export const publishNote: Action = {
  name: "NOSTR_PUBLISH_NOTE",
  similes: ["NOSTR_NOTE", "POST_NOSTR_NOTE", "NOSTR_KIND_1", "PUBLISH_NOSTR"],
  description:
    "Publish a Nostr text note (kind:1) to the configured relays. Use for short broadcast posts; private messages should be sent via SEND_MESSAGE (which routes through the Nostr DM connector).",
  descriptionCompressed: "Publish Nostr note (kind:1) to relays.",
  contexts: ["social_posting", "connectors"],
  contextGate: { anyOf: ["social_posting", "connectors"] },
  roleGate: { minRole: "USER" },
  parameters: [
    {
      name: "text",
      description: "Note content to publish.",
      required: true,
      schema: { type: "string" },
    },
  ],

  validate: async (_runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    return message.content.source === "nostr";
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: Record<string, unknown>,
    callback?: (response: { text: string; source?: string }) => void
  ): Promise<ActionResult> => {
    const nostrService = runtime.getService<NostrService>(NOSTR_SERVICE_NAME);
    if (!nostrService?.isConnected()) {
      if (callback) {
        callback({ text: "Nostr service is not available.", source: "nostr" });
      }
      return { success: false, error: "Nostr service not available" };
    }

    let noteText = readDirectText(options);

    if (!noteText) {
      const currentState = state ?? (await runtime.composeState(message));
      const prompt = await composePromptFromState({
        template: PUBLISH_NOTE_TEMPLATE,
        state: currentState,
      });

      let params: PublishNoteParams | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        const response = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
        const parsed = parseJSONObjectFromText(String(response)) as Record<string, unknown> | null;
        const candidateText = parsed?.text;
        if (typeof candidateText === "string" && candidateText.trim()) {
          params = { text: candidateText.trim().slice(0, MAX_NOSTR_NOTE_CHARS) };
          break;
        }
      }

      if (!params) {
        if (callback) {
          callback({
            text: "I couldn't understand the note content. Please try again.",
            source: "nostr",
          });
        }
        return { success: false, error: "Could not extract note content" };
      }
      noteText = params.text;
    }

    logger.info(
      { src: "plugin:nostr", op: "NOSTR_PUBLISH_NOTE", textLength: noteText.length },
      "Publishing Nostr note"
    );
    const timeoutMs = NOSTR_ACTION_TIMEOUT_MS;
    const result = await nostrService.publishNote(noteText);

    if (!result.success) {
      if (callback) {
        callback({
          text: `Failed to publish note: ${result.error}`,
          source: "nostr",
        });
      }
      return { success: false, error: result.error };
    }

    if (callback) {
      callback({
        text: "Note published successfully.",
        source: message.content.source as string,
      });
    }

    return {
      success: true,
      data: {
        eventId: result.eventId,
        relays: result.relays?.slice(0, MAX_NOSTR_RESULT_RELAYS),
        text: noteText,
        timeoutMs,
      },
    };
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Post a note: gm nostr" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Publishing that note to Nostr.",
          actions: ["NOSTR_PUBLISH_NOTE"],
        },
      },
    ],
  ],
};
