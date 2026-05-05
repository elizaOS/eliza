import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import {
  classifyPlaybackTransportIntent,
  type PlaybackTransportKind,
} from "../utils/playbackTransportIntent.js";

const PLAYBACK_OP_ACTION = "PLAYBACK_OP";

type RuntimeWithPatch = IAgentRuntime & {
  __elizaMusicTransportPatch?: boolean;
  processActions?: (
    message: unknown,
    responses: unknown,
    state: unknown,
    callback: unknown,
    opts?: unknown,
  ) => Promise<void>;
};

/**
 * elizaOS runs action handlers without calling validate() first; validate only
 * filters the ACTIONS provider text. The model can still emit PLAY_AUDIO for
 * "pause" — rewrite those to PLAYBACK_OP with op=pause/resume/skip/stop before
 * processActions runs.
 */
export function installProcessActionsTransportPatch(
  runtime: IAgentRuntime,
): void {
  const r = runtime as RuntimeWithPatch;
  if (r.__elizaMusicTransportPatch) return;
  if (typeof r.processActions !== "function") return;

  r.__elizaMusicTransportPatch = true;
  const original = r.processActions.bind(r);

  r.processActions = async (message, responses, state, callback, opts) => {
    try {
      const msg = message as {
        content?: { text?: string };
      } | null;
      const text =
        typeof msg?.content?.text === "string" ? msg.content.text : "";
      const intent: PlaybackTransportKind | null =
        classifyPlaybackTransportIntent(text);
      if (intent && Array.isArray(responses)) {
        for (const res of responses as Array<{
          content?: {
            actions?: string[];
            params?: Record<string, Record<string, unknown>>;
          };
        }>) {
          const c = res?.content;
          if (!c || !Array.isArray(c.actions)) continue;
          if (
            !c.actions.some((a) => String(a).toUpperCase() === "PLAY_AUDIO")
          ) {
            continue;
          }
          const next = c.actions.map((a) =>
            String(a).toUpperCase() === "PLAY_AUDIO" ? PLAYBACK_OP_ACTION : a,
          );
          const params =
            c.params && typeof c.params === "object" ? c.params : {};
          const existing = params[PLAYBACK_OP_ACTION] ?? {};
          const playbackParams = {
            ...existing,
            op: intent,
          };
          res.content = {
            ...c,
            actions: next,
            params: { ...params, [PLAYBACK_OP_ACTION]: playbackParams },
          };
          logger.info(
            `[music-player] Rewrote PLAY_AUDIO -> ${PLAYBACK_OP_ACTION} op=${intent} (transport intent)`,
          );
        }
      }
    } catch (err) {
      logger.warn(
        `[music-player] processActions transport patch failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return original(message, responses, state, callback, opts);
  };
}
