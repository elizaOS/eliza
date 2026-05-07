/**
 * PLAY_EMOTE action — plays an emote animation on the VRM companion avatar.
 *
 * Lives in @elizaos/app-companion so emote catalog and behavior stay with the
 * companion app. Session gating is applied at the plugin level
 * (`gatePluginSessionForHostedApp`).
 */

import { hasRoleAccess } from "@elizaos/agent/security/access";
import type {
  Action,
  HandlerOptions,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { AGENT_EMOTE_BY_ID, AGENT_EMOTE_CATALOG } from "../emotes/catalog.js";

/** API port for posting emote requests (matches dashboard static server default). */
const API_PORT = process.env.API_PORT || process.env.SERVER_PORT || "2138";
const EMOTE_REQUEST_TIMEOUT_MS = 2_500;

export const emoteAction: Action = {
  name: "PLAY_EMOTE",
  contexts: ["media", "general"],
  contextGate: { anyOf: ["media", "general"] },

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
  descriptionCompressed:
    "Play one-shot VRM avatar emote animation. Silent visual side-action.",

  validate: async (runtime: IAgentRuntime, message: Memory, _state) => {
    if (runtime.character?.settings?.DISABLE_EMOTES) return false;
    if (!(await hasRoleAccess(runtime, message, "USER"))) return false;
    const source = (message?.content as Record<string, unknown>)?.source;
    return source === "client_chat";
  },

  handler: async (_runtime, _message, _state, options) => {
    const params = (options as HandlerOptions | undefined)?.parameters as
      | { emote?: string }
      | undefined;
    const emoteId = params?.emote?.trim();

    if (!emoteId) return { text: "", success: false };

    const emote = AGENT_EMOTE_BY_ID.get(emoteId);
    if (!emote) return { text: "", success: false };

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      EMOTE_REQUEST_TIMEOUT_MS,
    );
    try {
      const response = await fetch(`http://localhost:${API_PORT}/api/emote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emoteId: emote.id }),
        signal: controller.signal,
      });

      if (!response.ok) {
        return { text: "", success: false };
      }
    } catch {
      return { text: "", success: false };
    } finally {
      clearTimeout(timeout);
    }

    return {
      text: "",
      success: true,
      data: { emoteId: emote.id },
    };
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
