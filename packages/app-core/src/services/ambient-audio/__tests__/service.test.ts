import { describe, expect, it } from "vitest";
import { MockAmbientAudioService } from "../service.ts";
import type { TranscribedSegment } from "../types.ts";

function seg(
  id: string,
  startMs: number,
  endMs: number,
  text = "hello",
): TranscribedSegment {
  return { id, startMs, endMs, text, confidence: 0.9 };
}

describe("MockAmbientAudioService", () => {
  it("transitions through start, pause, resume, stop", async () => {
    const svc = new MockAmbientAudioService();
    expect(svc.mode()).toBe("off");
    await svc.start("household");
    expect(svc.mode()).toBe("capturing");
    await svc.pause();
    expect(svc.mode()).toBe("paused");
    await svc.resume();
    expect(svc.mode()).toBe("capturing");
    await svc.stop();
    expect(svc.mode()).toBe("off");
  });

  it("recentTranscript honors window", () => {
    const svc = new MockAmbientAudioService({
      syntheticTranscripts: [
        seg("a", 0, 100),
        seg("b", 5_000, 5_100),
        seg("c", 9_000, 9_100),
      ],
    });
    const out = svc.recentTranscript(5);
    expect(out.map((s) => s.id)).toEqual(["b", "c"]);
  });

  it("silentTrace honors window", () => {
    const svc = new MockAmbientAudioService({
      syntheticSilentTrace: [seg("s1", 0, 100), seg("s2", 10_000, 10_100)],
    });
    const out = svc.silentTrace(5);
    expect(out.map((s) => s.id)).toEqual(["s2"]);
  });

  it("evaluateGate delegates to provided gate", () => {
    const svc = new MockAmbientAudioService({ gate: () => "respond" });
    expect(
      svc.evaluateGate({
        vadActive: false,
        directAddress: false,
        wakeIntent: 0,
        contextExpectsReply: false,
        ownerConfidence: 0,
      }),
    ).toBe("respond");
  });

  it("evaluateGate uses default gate when none provided", () => {
    const svc = new MockAmbientAudioService();
    expect(
      svc.evaluateGate({
        vadActive: true,
        directAddress: true,
        wakeIntent: 0,
        contextExpectsReply: false,
        ownerConfidence: 0.7,
      }),
    ).toBe("respond");
  });
});
