/**
 * Participant-count polling error policy for the Google Meet recording loop.
 * Deterministic: the Playwright Page is a hand-rolled fake — no real browser.
 * Guards the fix that a failed `page.evaluate` must read as "unknown" (null),
 * never a fabricated `0` that would trip a premature auto-leave (#12275).
 */

import type { Page } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startSpeakerAudioCapture } from "../../browser/audio-capture.js";
import type { MeetingBotSession } from "../../types.js";
import { countParticipants, startGoogleRecording } from "./recording.js";

vi.mock("../../browser/audio-capture.js", () => ({
  startSpeakerAudioCapture: vi.fn(),
}));

function fakePage(evaluate: Page["evaluate"]): Page {
  return { evaluate } as unknown as Page;
}

describe("countParticipants", () => {
  it("returns the tile count when the DOM query succeeds", async () => {
    const page = fakePage((async () => 3) as Page["evaluate"]);
    expect(await countParticipants(page)).toBe(3);
  });

  it("returns 0 for a real empty-room reading (distinct from failure)", async () => {
    const page = fakePage((async () => 0) as Page["evaluate"]);
    expect(await countParticipants(page)).toBe(0);
  });

  it("returns null (unknown) when the page evaluate throws, not a fabricated 0", async () => {
    const page = fakePage((async () => {
      throw new Error("Execution context was destroyed");
    }) as Page["evaluate"]);
    expect(await countParticipants(page)).toBeNull();
  });
});

describe("startGoogleRecording alone-time", () => {
  let capturedOnChunk:
    | ((streamKey: string, samples: Float32Array) => void)
    | undefined;
  let controller: AbortController;

  beforeEach(() => {
    vi.useFakeTimers();
    capturedOnChunk = undefined;
    controller = new AbortController();
    vi.mocked(startSpeakerAudioCapture).mockImplementation(
      async (_page, opts) => {
        capturedOnChunk = opts.onChunk;
        return { stop: async () => {} };
      },
    );
  });

  afterEach(() => {
    controller.abort();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  function makeSession(): MeetingBotSession {
    return {
      id: "session-1",
      config: {
        platform: "googlemeet",
        meetingUrl: "https://meet.google.com/abc-defg-hij",
        nativeMeetingId: "abc-defg-hij",
        botName: "Notetaker",
        autoLeave: {
          waitingRoomTimeoutMs: 300_000,
          noOneJoinedTimeoutMs: 3_000,
          everyoneLeftTimeoutMs: 2_000,
        },
        retainAudio: false,
      },
      sink: {
        pushSpeakerAudio: vi.fn(),
        setSpeakerName: vi.fn(),
        flushSpeaker: vi.fn(),
        participantJoined: vi.fn(),
        participantLeft: vi.fn(),
      },
      signal: controller.signal,
      reportStatus: vi.fn(),
    } as unknown as MeetingBotSession;
  }

  function emptyRoomPage(): Page {
    return {
      evaluate: async () => 0,
      isClosed: () => false,
    } as unknown as Page;
  }

  it("leaves an empty meeting at the configured no-one-joined timeout even when no audio ever flowed", async () => {
    const session = makeSession();
    let reason: string | undefined;
    const done = startGoogleRecording(emptyRoomPage(), session).then((r) => {
      reason = r;
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(reason).toBe("startup_alone_timeout");
    await done;
  });

  it("still waits out the audio grace after real audio flowed", async () => {
    const session = makeSession();
    let reason: string | undefined;
    const done = startGoogleRecording(emptyRoomPage(), session).then((r) => {
      reason = r;
    });
    await Promise.resolve();
    expect(capturedOnChunk).toBeDefined();
    capturedOnChunk?.("0", new Float32Array([0.5]));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(reason).toBeUndefined();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(reason).toBe("startup_alone_timeout");
    await done;
  });
});
