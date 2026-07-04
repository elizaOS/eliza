/**
 * Google Meet recording phase. Starts per-speaker audio capture + vote-and-lock
 * speaker attribution, then monitors participant presence for the auto-leave
 * timeouts. Resolves with a `MeetingEndReason` when the meeting ends naturally
 * (bot left alone past a timeout) or when the session aborts; the shared flow
 * races this against the removal monitor and the abort signal.
 *
 * Alone-detection is cross-validated against recent audio activity: DOM tile
 * counts can transiently drop during screen-share / layout changes, so if audio
 * flowed within the last 120s the tick refuses to accrue alone-time (false
 * LEFT_ALONE guard, ported from Vexa recording.ts, Apache-2.0).
 */

import { logger } from "@elizaos/core";
import type { MeetingEndReason } from "@elizaos/shared";
import type { Page } from "playwright-core";
import { startSpeakerAudioCapture } from "../../browser/audio-capture.js";
import type { MeetingBotSession } from "../../types.js";
import { googleParticipantSelectors } from "./selectors.js";
import { GoogleSpeakerIdentity } from "./speaker-identity.js";

const TICK_MS = 1_000;
const AUDIO_GRACE_MS = 120_000;

/** Count non-bot participant tiles present in the meeting DOM. */
async function countParticipants(page: Page): Promise<number> {
  try {
    return await page.evaluate(
      (selectors: string[]) => {
        const ids = new Set<string>();
        for (const sel of selectors) {
          for (const el of Array.from(document.querySelectorAll(sel))) {
            const id =
              el.getAttribute("data-participant-id") ??
              el.getAttribute("data-self-name") ??
              el.outerHTML.slice(0, 64);
            ids.add(id);
          }
        }
        return ids.size;
      },
      [...googleParticipantSelectors],
    );
  } catch {
    return 0;
  }
}

export async function startGoogleRecording(
  page: Page,
  session: MeetingBotSession,
): Promise<MeetingEndReason> {
  const identity = new GoogleSpeakerIdentity(
    page,
    session.sink,
    session.config.botName,
  );
  identity.start();

  let lastAudioMs = Date.now();
  const capture = await startSpeakerAudioCapture(page, {
    onChunk: (streamKey, samples) => {
      lastAudioMs = Date.now();
      session.sink.pushSpeakerAudio(streamKey, samples);
      void identity.observeAudio(streamKey);
    },
  });

  const { noOneJoinedTimeoutMs, everyoneLeftTimeoutMs } =
    session.config.autoLeave;

  return new Promise<MeetingEndReason>((resolve) => {
    let settled = false;
    let aloneMs = 0;
    let speakersSeen = false;

    const finish = (reason: MeetingEndReason) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      identity.stop();
      void capture.stop();
      resolve(reason);
    };

    const timer = setInterval(async () => {
      if (session.signal.aborted || page.isClosed()) {
        finish("normal_completion");
        return;
      }
      const others = await countParticipants(page);
      if (others > 0) speakersSeen = true;

      if (others > 0) {
        aloneMs = 0;
        return;
      }
      // Cross-validate: recent audio means the meeting is live despite tile drop.
      if (Date.now() - lastAudioMs < AUDIO_GRACE_MS) {
        aloneMs = 0;
        return;
      }
      aloneMs += TICK_MS;
      const limit = speakersSeen ? everyoneLeftTimeoutMs : noOneJoinedTimeoutMs;
      if (aloneMs >= limit) {
        const reason: MeetingEndReason = speakersSeen
          ? "left_alone_timeout"
          : "startup_alone_timeout";
        logger.info(
          `[GoogleMeetRecording] ${reason} after ${Math.round(aloneMs / 1000)}s alone`,
        );
        finish(reason);
      }
    }, TICK_MS);

    session.signal.addEventListener(
      "abort",
      () => finish("normal_completion"),
      { once: true },
    );
  });
}
