// src/testParticipant.ts

import 'dotenv/config';
import { Client } from '../client';
import { SpaceParticipant } from './core/SpaceParticipant';
import { SttTtsPlugin } from './plugins/SttTtsPlugin';
import { logger } from '@elizaos/core';

/**
 * Main test entry point for the "participant" flow:
 * - Joins an existing Space in listener mode
 * - Requests speaker role
 * - Waits for host approval (with a timeout)
 * - Optionally sends periodic beep frames if we become speaker
 * - Adds a graceful SIGINT handler for cleanup
 */
/**
 * Asynchronous function that serves as the main entry point for the program.
 * It performs the following steps:
 * 1) Logs that the test participant is starting.
 * 2) Logs in to Twitter via Client.
 * 3) Creates a SpaceParticipant instance using the provided AudioSpace ID and sets up TTS/STT plugins.
 * 4) Joins the Space as a listener and retrieves the HLS URL.
 * 5) Requests the speaker role, waits for host acceptance with a maximum wait time, and handles approval or timeout scenarios.
 * 6) Performs mute/unmute test for the participant.
 * 7) Generates a sine wave beep and sends PCM frames if the participant is a speaker.
 * 8) Sets up a beep interval to send the beep every 10 seconds.
 * 9) Initiates a graceful shutdown process after 60 seconds or catches SIGINT for manual stop.
 */
async function main() {
  logger.debug('[TestParticipant] Starting...');

  // 1) Twitter login via Client
  const client = new Client();
  await client.login(process.env.TWITTER_USERNAME!, process.env.TWITTER_PASSWORD!);

  // 2) Create the participant
  // Replace with your target AudioSpace ID
  const audioSpaceId = '1eaKbaNYanvxX';
  const participant = new SpaceParticipant(client, {
    spaceId: audioSpaceId,
    debug: false,
  });

  // Create our TTS/STT plugin instance, just for demonstration
  const sttTtsPlugin = new SttTtsPlugin();
  participant.use(sttTtsPlugin, {
    openAiApiKey: process.env.OPENAI_API_KEY,
    elevenLabsApiKey: process.env.ELEVENLABS_API_KEY || process.env.ELEVENLABS_XI_API_KEY,
    voiceId: 'D38z5RcWu1voky8WS1ja', // example voice
    // systemPrompt: "You are a calm and friendly AI assistant."
  });

  // 3) Join the Space in listener mode
  await participant.joinAsListener();
  logger.debug('[TestParticipant] HLS URL =>', participant.getHlsUrl());

  // 4) Request the speaker role => returns { sessionUUID }
  const { sessionUUID } = await participant.requestSpeaker();
  logger.debug('[TestParticipant] Requested speaker =>', sessionUUID);

  // 5) Wait for host acceptance with a maximum wait time (e.g., 15 seconds).
  try {
    await waitForApproval(participant, sessionUUID, 15000);
    logger.debug('[TestParticipant] Speaker approval sequence completed (ok or timed out).');
  } catch (err) {
    console.error('[TestParticipant] Approval error or timeout =>', err);
    // Optionally cancel the request if we timed out or got an error
    try {
      await participant.cancelSpeakerRequest();
      logger.debug('[TestParticipant] Speaker request canceled after timeout or error.');
    } catch (cancelErr) {
      console.error('[TestParticipant] Could not cancel the request =>', cancelErr);
    }
  }

  // (Optional) Mute/unmute test
  await participant.muteSelf();
  logger.debug('[TestParticipant] Muted.');
  await new Promise((resolve) => setTimeout(resolve, 3000));
  await participant.unmuteSelf();
  logger.debug('[TestParticipant] Unmuted.');

  // ---------------------------------------------------------
  // Example beep generation (sends PCM frames if we're speaker)
  // ---------------------------------------------------------
  const beepDurationMs = 500;
  const sampleRate = 16000;
  const totalSamples = (sampleRate * beepDurationMs) / 1000; // 8000
  const beepFull = new Int16Array(totalSamples);

  // Sine wave at 440Hz, amplitude ~12000
  const freq = 440;
  const amplitude = 12000;
  for (let i = 0; i < beepFull.length; i++) {
    const t = i / sampleRate;
    beepFull[i] = amplitude * Math.sin(2 * Math.PI * freq * t);
  }

  const FRAME_SIZE = 160;
  async function sendBeep() {
    logger.debug('[TestParticipant] Starting beep...');
    for (let offset = 0; offset < beepFull.length; offset += FRAME_SIZE) {
      const portion = beepFull.subarray(offset, offset + FRAME_SIZE);
      const frame = new Int16Array(FRAME_SIZE);
      frame.set(portion);
      participant.pushAudio(frame, sampleRate);
      await new Promise((r) => setTimeout(r, 10));
    }
    logger.debug('[TestParticipant] Finished beep.');
  }

  // Example: send beep every 10s
  const beepInterval = setInterval(() => {
    sendBeep().catch((err) => console.error('[TestParticipant] beep error =>', err));
  }, 10000);

  // Graceful shutdown after 60s
  const shutdownTimer = setTimeout(async () => {
    await participant.leaveSpace();
    logger.debug('[TestParticipant] Left space. Bye!');
    process.exit(0);
  }, 60000);

  // Catch SIGINT for manual stop
  process.on('SIGINT', async () => {
    logger.debug('\n[TestParticipant] Caught interrupt signal, stopping...');
    clearInterval(beepInterval);
    clearTimeout(shutdownTimer);
    await participant.leaveSpace();
    logger.debug('[TestParticipant] Space left. Bye!');
    process.exit(0);
  });
}

/**
 * waitForApproval waits until "newSpeakerAccepted" matches our sessionUUID,
 * then calls becomeSpeaker() or rejects after a given timeout.
 */
function waitForApproval(
  participant: SpaceParticipant,
  sessionUUID: string,
  timeoutMs = 10000
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let resolved = false;

    const handler = async (evt: { sessionUUID: string }) => {
      if (evt.sessionUUID === sessionUUID) {
        resolved = true;
        participant.off('newSpeakerAccepted', handler);
        try {
          await participant.becomeSpeaker();
          logger.debug('[TestParticipant] Successfully became speaker!');
          resolve();
        } catch (err) {
          reject(err);
        }
      }
    };

    // Listen to "newSpeakerAccepted" from participant
    participant.on('newSpeakerAccepted', handler);

    // Timeout to reject if not approved in time
    setTimeout(() => {
      if (!resolved) {
        participant.off('newSpeakerAccepted', handler);
        reject(
          new Error(
            `[TestParticipant] Timed out waiting for speaker approval after ${timeoutMs}ms.`
          )
        );
      }
    }, timeoutMs);
  });
}

main().catch((err) => {
  console.error('[TestParticipant] Unhandled error =>', err);
  process.exit(1);
});
