/**
 * 16 kHz PCM frame-pump wire-contract e2e (sol-voice-pwa-e2e).
 * Runs in the default `chromium` project (no mic/audio/DOM needed — it exercises
 * the pump in the Playwright Node runner, not the page).
 *
 * The AudioFramePump (packages/ui/src/voice/audio-frame-pump.ts) is the seam the
 * FUTURE Deepgram-Flux streaming STT path pumps 16 kHz mono PCM through:
 *   native audioFrame events -> batch -> POST /api/voice/audio-frames.
 * The pump's batching/flush LOGIC has unit coverage (audio-frame-pump.test.ts);
 * this spec pins the on-the-wire POST CONTRACT the streaming path depends on so
 * it cannot silently drift when Flux is wired in: batched (not per-frame) POSTs,
 * a size-cap mid-flush at the 49-frame boundary, a terminal `flush:true` batch
 * on stop, and every frame carrying the 16 kHz / 320-sample (20 ms) shape.
 *
 * Imports the REAL AudioFramePump from @elizaos/ui SOURCE via a relative path —
 * the exact cross-package source-import pattern used by tts-stt-e2e.spec.ts
 * (which imports `../../../ui/src/voice/voice-provider-defaults`). Importing the
 * source module rather than the `@elizaos/ui/voice` subpath keeps this decoupled
 * from the dist build state in the Playwright (Node) runner, which has no
 * tsconfig-path resolution. A regression in the pump fails this spec with it.
 *
 * We drive the pump with a fake TalkMode plugin that emits synthetic frames and
 * capture its batched POSTs by stubbing `globalThis.fetch` for the duration of
 * the test (the pump posts via plain `fetch`, so this intercepts the real wire
 * body). No browser bundle / `@elizaos/ui/voice` runtime resolution is involved,
 * so the spec can never silently `test.skip` on a bundler change.
 *
 *   bun run --cwd packages/app test:e2e test/ui-smoke/voice-pwa-framepump.spec.ts
 */
import { expect, test } from "@playwright/test";
import type {
  TalkModeAudioFrameEvent,
  TalkModePluginLike,
} from "../../../ui/src/bridge/native-plugins";
// REAL pump, imported from @elizaos/ui source (matches the cross-package
// source-import pattern in tts-stt-e2e.spec.ts / live-agent-chat.spec.ts).
import { AudioFramePump } from "../../../ui/src/voice/audio-frame-pump";

interface PostedBatch {
  frames: Array<{ sampleRate: number; samples: number; frameIndex: number }>;
  flush: boolean;
}

/**
 * A minimal TalkMode plugin that lets the test drive `audioFrame` delivery by
 * hand. Only the members AudioFramePump touches are implemented; the cast keeps
 * us honest about which surface the pump actually depends on.
 */
function makeFakeTalkMode(): {
  plugin: TalkModePluginLike;
  emit: (event: TalkModeAudioFrameEvent) => void;
} {
  let listener: ((event: TalkModeAudioFrameEvent) => void) | null = null;
  const plugin = {
    addListener: async (
      _name: "audioFrame",
      fn: (event: TalkModeAudioFrameEvent) => void,
    ) => {
      listener = fn;
      return {
        remove: async () => {
          listener = null;
        },
      };
    },
    startAudioFrames: async () => ({
      started: true as const,
      sampleRate: 16_000,
      frameSamples: 320,
      suspendedStt: true,
    }),
    stopAudioFrames: async () => {},
  } as unknown as TalkModePluginLike;
  return {
    plugin,
    emit: (event) => listener?.(event),
  };
}

test.describe("AudioFramePump wire contract", () => {
  test("POSTs 16 kHz / 20 ms batched PCM to /api/voice/audio-frames with a size-cap mid-flush and a terminal flush", async () => {
    const batches: PostedBatch[] = [];
    const originalFetch = globalThis.fetch;
    // Capture the pump's real POST bodies. The pump only ever POSTs the frames
    // endpoint; assert that and return the agent-ack shape it expects.
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string" ? input : input.toString();
      expect(url).toContain("/api/voice/audio-frames");
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body ?? "{}")) as PostedBatch;
      batches.push(body);
      return new Response(
        JSON.stringify({
          ok: true,
          framesReceived: body.frames?.length ?? 0,
          turnsObserved: 0,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof globalThis.fetch;

    try {
      const { plugin, emit } = makeFakeTalkMode();
      const pump = new AudioFramePump(plugin, {
        agentBaseUrl: "http://127.0.0.1:0",
        sampleRate: 16_000,
        frameMs: 20,
      });

      const started = await pump.start();
      expect(started.started).toBe(true);

      // Emit 60 frames (> the 49-frame size cap => forces at least one mid-flush
      // before stop, proving batching is size-bounded, not one-POST-per-frame).
      for (let i = 0; i < 60; i += 1) {
        emit({
          pcm16: "AA==",
          sampleRate: 16_000,
          channels: 1,
          samples: 320, // 20 ms @ 16 kHz
          rms: 0.01,
          timestamp: i * 20,
          frameIndex: i,
        });
      }

      await pump.stop(); // sends the terminal flush:true batch

      // At least two batches: the size-cap flush at 49 frames + the terminal one.
      expect(batches.length).toBeGreaterThanOrEqual(2);
      // A mid-flush (before stop) means a non-final batch was posted at the cap.
      const nonFinalBefore = batches.filter((b) => b.flush !== true);
      expect(nonFinalBefore.length).toBeGreaterThanOrEqual(1);
      expect(nonFinalBefore[0]?.frames?.length).toBe(49);
      // Exactly the 60 emitted frames reach the wire, in order, once each.
      const allFrames = batches.flatMap((b) => b.frames ?? []);
      expect(allFrames.length).toBe(60);
      expect(allFrames.map((f) => f.frameIndex)).toEqual(
        Array.from({ length: 60 }, (_, i) => i),
      );
      // A terminal flush:true batch must close the session.
      expect(batches.at(-1)?.flush).toBe(true);
      expect(batches.some((b) => b.flush === true)).toBe(true);
      // Every frame carries the 16 kHz / 320-sample (20 ms) shape.
      for (const f of allFrames) {
        expect(f.sampleRate).toBe(16_000);
        expect(f.samples).toBe(320);
      }
      // The pump's own accounting matches the wire.
      expect(pump.framesSent).toBe(60);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
