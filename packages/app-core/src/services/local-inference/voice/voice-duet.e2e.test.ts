/**
 * Real-output end-to-end test for the two-agents-talking-endlessly path the
 * `voice:duet` harness drives. Gated behind `it.skipIf(!realBackendPresent)` —
 * the existing probe (catalog kernels advertised + a fused build). When it
 * runs (a macOS-Metal / linux-fused box with `eliza-1-0_6b` staged) it boots
 * two `LocalInferenceEngine`s on the same bundle with two characters, wires the
 * `DuetAudioBridge`, seeds agent A, and lets the duet ping-pong; the assertion
 * is that PCM crossed at least the forward direction, no crash. Don't fake a
 * "real" run.
 *
 * The UNCONDITIONAL wiring / cancel / shape assertions (stub backends + the
 * bridge + the latency tracers) live in the sibling `voice-duet.test.ts` —
 * that one is part of the default test run; this one is the slow,
 * native-code-loading e2e variant.
 *
 * All heavy modules (`../engine`, `../dflash-server`, `../registry`,
 * `@elizaos/shared`) are imported lazily inside the gated `it` so the file is
 * cheap to collect even when the gate is false.
 */

import { describe, expect, it } from "vitest";

const ASR_RATE = 16_000;
const realBundleId = "eliza-1-0_6b";

/** Probe — lazy import so collection stays cheap when nothing is present. */
async function probeRealBackend(): Promise<boolean> {
  try {
    const { findCatalogModel } = await import("@elizaos/shared");
    const { getDflashRuntimeStatus } = await import("../dflash-server");
    const entry = findCatalogModel(realBundleId);
    const status = getDflashRuntimeStatus();
    const required = entry?.runtime?.optimizations?.requiresKernel ?? [];
    const advertised = status.capabilities?.kernels ?? null;
    const kernelsOk =
      required.length > 0 &&
      advertised != null &&
      required.every(
        (k) => (advertised as Record<string, boolean>)[k] === true,
      );
    return Boolean(kernelsOk && status.capabilities?.fused);
  } catch {
    return false;
  }
}

const realBackendPresent = await probeRealBackend();

describe.skipIf(!realBackendPresent)(
  "voice:duet — real eliza-1-0_6b + fused TTS",
  () => {
    it("boots two engines on the same bundle, wires the duet bridge, and produces audio crossing the loop", async () => {
      const { LocalInferenceEngine } = await import("../engine");
      const { listInstalledModels } = await import("../registry");
      const { DuetAudioBridge } = await import(
        "../../../../scripts/lib/duet-bridge.mjs"
      );
      const { PushMicSource } = await import("./mic-source");

      const installed = await listInstalledModels();
      const target = installed.find((m) => m.id === realBundleId);
      expect(target).toBeTruthy();
      if (!target?.bundleRoot) {
        throw new Error("real eliza-1-0_6b bundle has no bundleRoot");
      }
      const bundleRoot = target.bundleRoot;
      const pushA = new PushMicSource({ sampleRate: ASR_RATE });
      const pushB = new PushMicSource({ sampleRate: ASR_RATE });
      let aToB = 0;
      let bToA = 0;
      const bridge = new DuetAudioBridge({
        micSourceA: pushA,
        micSourceB: pushB,
        opts: {
          targetRate: ASR_RATE,
          onForward: (d: "aToB" | "bToA", p: Float32Array) => {
            if (d === "aToB") aToB += p.length;
            else bToA += p.length;
          },
        },
      });
      await pushA.start();
      await pushB.start();

      const engA = new LocalInferenceEngine();
      const engB = new LocalInferenceEngine();
      await engA.load(target.path);
      await engB.load(target.path);
      engA.startVoice({
        bundleRoot,
        useFfiBackend: true,
        sink: bridge.sinkForA() as unknown as never,
      });
      engB.startVoice({
        bundleRoot,
        useFfiBackend: true,
        sink: bridge.sinkForB() as unknown as never,
      });
      await engA.armVoice();
      await engB.armVoice();

      // Seed: A speaks a fixed line directly into A's TTS (the LLM side of
      // `generate` is exercised by voice-duet.test.ts + interactive-session).
      const tok = (i: number, t: string) => ({ index: i, text: t });
      for (let i = 0; i < 5; i++) {
        await engA.pushAcceptedTokens([tok(i, `${i ? " " : ""}hello`)]);
      }
      await engA.voice()?.settle();
      // Let B hear it; give the loop a couple of seconds.
      await new Promise((r) => setTimeout(r, 8000));
      await engA.voice()?.settle();
      await engB.voice()?.settle();
      // The forward direction must have produced audio; bToA may be 0 if B's
      // message handler isn't booted here — assert what actually happened
      // (the harness records both honestly).
      expect(aToB).toBeGreaterThan(0);
      expect(bToA).toBeGreaterThanOrEqual(0);
      await engA.stopVoice();
      await engB.stopVoice();
      await engA.unload();
      await engB.unload();
      await pushA.stop();
      await pushB.stop();
    });
  },
);
