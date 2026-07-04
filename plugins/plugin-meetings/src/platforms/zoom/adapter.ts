/**
 * Zoom Web Client meeting bot adapter. Joins as an anonymous guest via
 * https://app.zoom.us/wc/<id>/join?pwd=… (canonicalized by parseMeetingUrl),
 * captures the mixed meeting audio (in-browser element capture first,
 * PulseAudio parecord fallback on Linux hosts), and attributes speakers via
 * DOM active-speaker polling with vote-and-lock. No native Zoom SDK.
 */

import { logger } from "@elizaos/core";
import type { MeetingEndReason, MeetingPlatform } from "@elizaos/shared";
import type { MeetingBotSession, MeetingPlatformAdapter } from "../../types.js";
import { launchMeetingBrowser } from "../shared/launch.js";
import { runMeetingFlow } from "../shared/meeting-flow.js";
import {
  createNullSink,
  type NullSink,
  pulseAudioAvailable,
  unloadNullSink,
} from "./pulse-capture.js";
import { createZoomStrategies } from "./strategies.js";

const TAG = "[ZoomAdapter]";

export class ZoomAdapter implements MeetingPlatformAdapter {
  readonly platform: MeetingPlatform = "zoom";

  async run(session: MeetingBotSession): Promise<MeetingEndReason> {
    // On hosts with PulseAudio (Linux / containers), create a per-bot null
    // sink and launch the browser into it. This must happen BEFORE launch:
    // parecord's fallback can only hear audio the browser rendered into the
    // sink. On macOS/Windows there is no PulseAudio — element capture only.
    let sink: NullSink | null = null;
    if (await pulseAudioAvailable()) {
      try {
        sink = await createNullSink(session.id);
      } catch (err) {
        logger.warn(
          { error: err instanceof Error ? err.message : String(err) },
          `${TAG} PulseAudio present but null-sink creation failed — element capture only`,
        );
      }
    } else {
      logger.info(
        `${TAG} no PulseAudio on this host — in-browser element capture only`,
      );
    }

    try {
      const browser = await launchMeetingBrowser({
        channel: "chrome",
        ...(sink ? { env: { PULSE_SINK: sink.sinkName } } : {}),
      });
      try {
        return await runMeetingFlow({
          page: browser.page,
          session,
          strategies: createZoomStrategies({ pulseSinkName: sink?.sinkName }),
          waitingRoomTimeoutMs: session.config.autoLeave.waitingRoomTimeoutMs,
        });
      } finally {
        await browser.close();
      }
    } finally {
      if (sink) await unloadNullSink(sink);
    }
  }
}
