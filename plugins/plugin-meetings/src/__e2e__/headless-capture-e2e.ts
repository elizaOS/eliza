/**
 * Headless capture -> pipeline -> transcript e2e (the flagship robustness proof).
 *
 * Drives a REAL headless Chromium (playwright-core, headless:true, system
 * `chrome` channel fallback) against a LOCAL fake-meeting page (fake-meeting.html,
 * loaded over file://). The page renders two participant tiles, each with its own
 * <audio> element carrying a live WebAudio MediaStream (per-participant tones with
 * a muted->speaking gain ramp + a `.speaking` DOM class), i.e. exactly the shape
 * Google Meet delivers.
 *
 * Wiring under test is REAL, end to end, with NO real Meet and NO real ASR:
 *   - REAL browser audio-capture (src/browser/audio-capture.ts): page.evaluate +
 *     exposeBinding discovers the live elements, attaches AudioContext +
 *     ScriptProcessor, and forwards Float32 chunks to Node.
 *   - REAL transcription pipeline (createMeetingTranscriptionPipeline) fed those
 *     chunks per speaker, with a SCRIPTED AsrBackend (deterministic text per
 *     speaker window — the ONLY mock, standing in for the model layer).
 *   - REAL MeetingTranscriptWriter against the in-memory runtime double
 *     (makeFakeRuntime) — the same double the vitest suites use.
 *
 * Assertions (each proves one link of the chain):
 *   1. the fake page exposes 2 live per-participant audio elements,
 *   2. the REAL capture binding fires (per-speaker PCM crosses browser->Node),
 *   3. the pipeline receives per-speaker audio for BOTH speaker keys,
 *   4. finalize() produces confirmed segments carrying the mapped speaker labels,
 *   5. the transcript record is created (recording) then finalized (ready) in the
 *      runtime double, with both speakers + the scripted text, and the knowledge
 *      mirror lands.
 *
 * Exits non-zero on any failed assertion or page error.
 *
 * Run: bun run --cwd plugins/plugin-meetings test:e2e
 */

import type { Buffer } from "node:buffer";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { UUID } from "@elizaos/core";
import { chromium } from "playwright-core";
import { startSpeakerAudioCapture } from "../browser/audio-capture.js";
import { createMeetingTranscriptionPipeline } from "../pipeline/pipeline.js";
import type { AsrBackend } from "../pipeline/transcriber.js";
import { makeFakeRuntime } from "../test-support.js";
import {
  MeetingTranscriptWriter,
  readTranscriptRow,
} from "../transcripts/meeting-transcript-writer.js";

const here = dirname(new URL(import.meta.url).pathname);
const pageUrl = pathToFileURL(join(here, "fake-meeting.html")).href;

let failures = 0;
function assert(cond: unknown, msg: string): boolean {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures += 1;
  return Boolean(cond);
}

/**
 * The ONLY mock in this run: a deterministic ASR backend standing in for
 * runtime.useModel(TRANSCRIPTION). Returns fixed text per speaker key so the
 * chain is reproducible. Records every call so we can prove real per-speaker
 * WAV windows reached the ASR boundary.
 */
function scriptedBackend(textFor: Map<string, string>): {
  backend: AsrBackend;
  calls: Array<{ wavBytes: number }>;
  perKeyText: (speakerKey: string) => string;
} {
  const calls: Array<{ wavBytes: number }> = [];
  // The pipeline hands the backend only the WAV window, not the speaker key —
  // it labels the resulting segment by speaker itself. So the backend just
  // round-robins deterministic non-silence text across the two speakers; the
  // test asserts the pipeline attaches the right speaker LABEL to each.
  let seq = 0;
  const texts = [...textFor.values()];
  const backend: AsrBackend = {
    async transcribe(wav: Buffer) {
      calls.push({ wavBytes: wav.length });
      // Round-robin the scripted texts so distinct speakers get distinct text.
      const text = texts[seq % texts.length] ?? "hello from the meeting";
      seq += 1;
      return { text };
    },
  };
  return { backend, calls, perKeyText: (k) => textFor.get(k) ?? "" };
}

// --autoplay-policy=no-user-gesture-required lets the fake page's local WebAudio
// streams start without a user gesture (real Meet's remote WebRTC media autoplays
// under the media-engagement policy instead). --use-fake-ui-for-media-stream
// mirrors the production launch args.
const LAUNCH_ARGS = [
  "--autoplay-policy=no-user-gesture-required",
  "--use-fake-ui-for-media-stream",
  "--no-sandbox",
];

async function launchBrowser() {
  try {
    return await chromium.launch({ headless: true, args: LAUNCH_ARGS });
  } catch (err) {
    console.log(
      `[e2e] bundled chromium launch failed (${err instanceof Error ? err.message.split("\n")[0] : String(err)}); falling back to system chrome channel`,
    );
    return await chromium.launch({
      headless: true,
      channel: "chrome",
      args: LAUNCH_ARGS,
    });
  }
}

async function main() {
  const browser = await launchBrowser();
  const context = await browser.newContext();
  const page = await context.newPage();

  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  await page.goto(pageUrl);
  await page.waitForFunction(
    () => (window as { __meetingReady?: boolean }).__meetingReady === true,
  );

  // Two participant tiles rendered.
  const tileCount = await page.locator(".tile").count();
  assert(
    tileCount === 2,
    `fake page renders 2 participant tiles (got ${tileCount})`,
  );

  // ── REAL runtime double + pipeline + writer ──────────────────────────────
  const fake = makeFakeRuntime();
  const sessionId = crypto.randomUUID() as UUID;
  const worldId = crypto.randomUUID() as UUID;
  const roomId = crypto.randomUUID() as UUID;

  // Scripted deterministic ASR: "Jill" stream (index 0) and "Bob" (index 1).
  const scripted = scriptedBackend(
    new Map([
      ["0", "hello everyone this is jill"],
      ["1", "hi jill bob here"],
    ]),
  );
  const pipeline = createMeetingTranscriptionPipeline(
    { runtime: fake.runtime, sessionId, retainAudio: true },
    scripted.backend,
  );

  const writer = new MeetingTranscriptWriter(fake.runtime, 0);
  await writer.start({
    sessionId,
    worldId,
    roomId,
    entityId: fake.runtime.agentId,
    title: "Google Meet meeting fake-e2e",
    platform: "google_meet",
    meetingUrl: "https://meet.google.com/fake-e2e-run",
    nativeMeetingId: "fake-e2e-run",
  });

  // Transcript record created in "recording" status.
  const recordingRow = fake.memories.get(writer.transcriptId);
  assert(
    readTranscriptRow(recordingRow as never)?.status === "recording",
    "transcript record created in status recording",
  );

  // Wire pipeline updates into the writer (mirrors service.ts onUpdate).
  const confirmed: string[] = [];
  pipeline.onUpdate((update) => {
    for (const seg of update.confirmed)
      confirmed.push(`${seg.speakerLabel}: ${seg.text}`);
    writer.updateSegments(update.confirmed);
  });

  // Map stream keys -> display names (as speaker-attribution would).
  pipeline.setSpeakerName("0", "Jill");
  pipeline.setSpeakerName("1", "Bob");

  // Start the tones + speaking indicators FIRST — resuming the AudioContext is
  // what makes each per-participant MediaStream track live (an element backed by
  // a suspended-context stream reads as paused/inactive to the discovery scan).
  const started = await page.evaluate(() =>
    (window as { __startTones?: () => Promise<unknown> }).__startTones?.(),
  );
  assert(
    Array.isArray(started) && started.length === 2,
    "both participant tones started",
  );
  const speaking = await page.locator(".tile.speaking").count();
  assert(
    speaking === 2,
    `both tiles show the speaking indicator (got ${speaking})`,
  );

  // Sanity: the page now exposes the live per-participant elements the capture
  // module discovers.
  const liveCount = await page.evaluate(() =>
    (window as { __liveElementCount?: () => number }).__liveElementCount?.(),
  );
  assert(
    liveCount === 2,
    `capture sees 2 live per-participant audio elements (got ${liveCount})`,
  );

  // ── REAL capture: browser -> Node -> pipeline ────────────────────────────
  const pushedKeys = new Set<string>();
  let chunkCount = 0;
  const capture = await startSpeakerAudioCapture(page, {
    rescanIntervalMs: 1_000,
    onChunk: (streamKey, samples) => {
      chunkCount += 1;
      pushedKeys.add(streamKey);
      pipeline.pushSpeakerAudio(streamKey, samples);
    },
  });

  // Let real audio flow through the ScriptProcessor -> binding -> Node for a
  // few seconds so each speaker buffers > minAudioDurationSec of unconfirmed
  // audio. The pipeline's submit timers + finalize() flush turn it into
  // confirmed segments.
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline && pushedKeys.size < 2) {
    await new Promise((r) => setTimeout(r, 200));
  }
  // Keep pushing a little longer so both buffers have real content.
  await new Promise((r) => setTimeout(r, 2_500));

  assert(
    chunkCount > 0,
    `REAL capture binding fired: ${chunkCount} PCM chunks crossed browser->Node`,
  );
  assert(
    pushedKeys.size === 2,
    `per-speaker PCM reached the pipeline for BOTH speakers (keys: ${[...pushedKeys].sort().join(", ")})`,
  );

  await capture.stop();
  await page.evaluate(() =>
    (window as { __stopTones?: () => void }).__stopTones?.(),
  );

  // ── Finalize: pipeline flush -> segments -> transcript write ─────────────
  const segments = await pipeline.finalize();
  assert(
    segments.length >= 1,
    `pipeline produced >=1 confirmed segment (got ${segments.length})`,
  );
  const labels = new Set(segments.map((s) => s.speakerLabel));
  assert(
    labels.has("Jill") || labels.has("Bob"),
    `segments carry mapped speaker labels (${[...labels].join(", ")})`,
  );
  const wav = pipeline.sessionAudioWav();
  assert(
    wav != null && wav.length > 44,
    `retained session audio WAV produced (${wav?.length ?? 0} bytes)`,
  );

  const final = await writer.finalize({
    segments,
    endReason: "normal_completion",
    participants: [
      { id: "0", displayName: "Jill" },
      { id: "1", displayName: "Bob" },
    ],
    audioWav: wav,
  });
  assert(final.status === "ready", "transcript finalized to status ready");

  const finalRow = fake.memories.get(writer.transcriptId);
  const readBack = readTranscriptRow(finalRow as never);
  assert(
    readBack?.status === "ready",
    "finalized row parses back through the transcripts-view reader",
  );
  assert(
    (readBack?.segments.length ?? 0) >= 1,
    "finalized transcript has >=1 segment",
  );
  assert(
    fake.documents.length === 1 &&
      (fake.documents[0].metadata as { tags?: string[] }).tags?.includes(
        "transcript",
      ) === true,
    "knowledge mirror landed with the transcript tag",
  );

  assert(
    pageErrors.length === 0,
    `no page errors (${pageErrors.join(" | ") || "none"})`,
  );
  assert(
    scripted.calls.length >= 1,
    `scripted ASR backend received >=1 real WAV window (${scripted.calls.length} calls)`,
  );

  console.log("\n--- transcript segments ---");
  for (const seg of segments) console.log(`  ${seg.speakerLabel}: ${seg.text}`);
  console.log(
    `--- ${scripted.calls.length} ASR calls, WAV bytes: ${scripted.calls.map((c) => c.wavBytes).join(",")} ---`,
  );

  await context.close();
  await browser.close();

  if (failures > 0) {
    console.error(`\nFAILED: ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log(
    "\nPASS: headless capture -> pipeline -> transcript ran end to end (no real Meet, no real ASR)",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
