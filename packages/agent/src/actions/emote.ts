/**
 * PLAY_EMOTE action — plays an emote animation on the avatar.
 *
 * When triggered the action:
 *   1. Extracts the emote ID from required structured parameters
 *   2. Looks up the emote in the catalog
 *   3. POSTs to the local API server to trigger the animation
 *   4. Returns success without posting chat text
 *
 * @module actions/emote
 */

import type { Action, HandlerOptions } from "@elizaos/core";
import { AGENT_EMOTE_BY_ID, AGENT_EMOTE_CATALOG } from "../emotes/catalog";

/** API port for posting emote requests. */
const API_PORT = process.env.API_PORT || process.env.SERVER_PORT || "2138";

export const emoteAction: Action = {
  name: "PLAY_EMOTE",

  similes: [
    "EMOTE",
    "ANIMATE",
    "GESTURE",
    "DANCE",
    "WAVE",
    "PLAY_ANIMATION",
    "DO_EMOTE",
    "PERFORM",
  ],

  description:
    "Play a one-shot emote animation on your 3D VRM avatar, then return to idle. " +
    "Use whenever a visible gesture, reaction, or trick helps convey emotion. " +
    "This is a silent non-blocking visual side action that does not create " +
    "chat text on its own. Only call it when you set the required emote " +
    "parameter to a valid emote ID. If you also want speech, chain it " +
    "before, after, or alongside other actions in the same turn " +
    "(for example with REPLY, SEND_MESSAGE, or stream actions).",

  validate: async (_runtime, _message, _state) => {
    // Always valid — the handler will check if the emote exists.
    return true;
  },

  handler: async (_runtime, _message, _state, options) => {
    try {
      type EmoteParams = { emote?: string };
      const params = (options as HandlerOptions | undefined)?.parameters as
        | EmoteParams
        | undefined;
      const emoteId =
        typeof params?.emote === "string" ? params.emote.trim() : "";

      if (!emoteId) {
        return { text: "", success: false };
      }

      // Look up the emote in the catalog.
      const emote = AGENT_EMOTE_BY_ID.get(emoteId);
      if (!emote) {
        return {
          text: "",
          success: false,
        };
      }

      // POST to the local API server to trigger the emote.
      const response = await fetch(`http://localhost:${API_PORT}/api/emote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emoteId: emote.id }),
      });

      if (!response.ok) {
        return {
          text: "",
          success: false,
        };
      }

      return {
        text: "",
        success: true,
        data: { emoteId: emote.id },
      };
    } catch {
      return {
        text: "",
        success: false,
      };
    }
  },

  parameters: [
    {
      name: "emote",
      description:
        "Required emote ID to play once silently before returning to idle. " +
        "Common mappings: dance/vibe → dance-happy, wave/greet → wave, " +
        "flip/backflip → flip, cry/sad → crying, fight/punch → punching, fish → fishing",
      required: true,
      schema: {
        type: "string" as const,
        enum: AGENT_EMOTE_CATALOG.map((e) => e.id),
      },
    },
  ],
};
