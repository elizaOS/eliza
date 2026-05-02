import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import {
  classifyPlaybackTransportIntent,
  type PlaybackTransportKind,
} from "../utils/playbackTransportIntent.js";

const INTENT_ACTION: Record<PlaybackTransportKind, string> = {
  pause: "PAUSE_MUSIC",
  resume: "RESUME_MUSIC",
  skip: "SKIP_TRACK",
  stop: "STOP_MUSIC",
};

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
 * "pause" — rewrite those to PAUSE_MUSIC / etc. before processActions runs.
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
      const intent = classifyPlaybackTransportIntent(text);
      if (intent && Array.isArray(responses)) {
        const replacement = INTENT_ACTION[intent];
        for (const res of responses as Array<{
          content?: { actions?: string[] };
        }>) {
          const c = res?.content;
          if (!c || !Array.isArray(c.actions)) continue;
          if (
            !c.actions.some((a) => String(a).toUpperCase() === "PLAY_AUDIO")
          ) {
            continue;
          }
          const next = c.actions.map((a) =>
            String(a).toUpperCase() === "PLAY_AUDIO" ? replacement : a,
          );
          res.content = { ...c, actions: next };
          logger.info(
            `[music-player] Rewrote PLAY_AUDIO -> ${replacement} (transport intent: ${intent})`,
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
