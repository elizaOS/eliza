import { describe, expect, it } from "vitest";
import { AmbientAudioConsentState } from "../consent.ts";
import { ReplayBuffer } from "../replay-buffer.ts";
import { decideResponse } from "../response-gate.ts";
import { InMemoryAmbientAudioService } from "../service.ts";
import type { AudioFrame, ResponseGateSignals } from "../types.ts";

function frame(samples: number[], capturedAt = 1): AudioFrame {
  return {
    samples: Int16Array.from(samples),
    sampleRate: 16000,
    channels: 1,
    capturedAt,
  };
}

function signals(overrides: Partial<ResponseGateSignals>): ResponseGateSignals {
  return {
    vadActive: false,
    wakeIntent: 0,
    directAddress: false,
    ownerConfidence: 0,
    contextExpectsReply: false,
    ...overrides,
  };
}

describe("AmbientAudioConsentState", () => {
  it("requires active consent before capture", () => {
    const consent = new AmbientAudioConsentState();

    expect(() => consent.require("owner")).toThrow(/consent is required/);

    consent.grant({
      ownerId: "owner",
      grantedAt: 1,
      source: "test",
      expiresAt: 10,
    });

    expect(consent.require("owner", 2).ownerId).toBe("owner");
    expect(() => consent.require("owner", 10)).toThrow(/consent is required/);
  });
});

describe("ReplayBuffer", () => {
  it("keeps the newest samples within maxSeconds", () => {
    const buffer = new ReplayBuffer(0.001);
    buffer.push(frame([1, 2, 3, 4, 5, 6, 7, 8]));
    buffer.push(frame([9, 10, 11, 12, 13, 14, 15, 16, 17, 18]));

    expect(Array.from(buffer.readTail())).toEqual([
      3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
    ]);
    expect(Array.from(buffer.readTail(0.00025))).toEqual([15, 16, 17, 18]);
  });

  it("rejects non-16khz mono frames", () => {
    const buffer = new ReplayBuffer();
    expect(() =>
      buffer.push({ ...frame([1]), sampleRate: 8000 as 16000 }),
    ).toThrow(/16 kHz mono/);
  });
});

describe("decideResponse", () => {
  it("responds to direct address with modest owner confidence", () => {
    expect(
      decideResponse(
        signals({ directAddress: true, ownerConfidence: 0.3, vadActive: true }),
      ),
    ).toMatchObject({ shouldRespond: true, reason: "direct-address" });
  });

  it("responds to wake intent only with owner confidence", () => {
    expect(
      decideResponse(signals({ wakeIntent: 0.8, ownerConfidence: 0.2 }))
        .shouldRespond,
    ).toBe(false);
    expect(
      decideResponse(signals({ wakeIntent: 0.8, ownerConfidence: 0.4 })),
    ).toMatchObject({ shouldRespond: true, reason: "wake-intent" });
  });

  it("waits for speech to finish before expected-reply responses", () => {
    expect(
      decideResponse(
        signals({
          contextExpectsReply: true,
          ownerConfidence: 0.8,
          vadActive: true,
        }),
      ).shouldRespond,
    ).toBe(false);
    expect(
      decideResponse(
        signals({ contextExpectsReply: true, ownerConfidence: 0.8 }),
      ),
    ).toMatchObject({ shouldRespond: true, reason: "expected-reply" });
  });
});

describe("InMemoryAmbientAudioService", () => {
  it("enforces consent and clears retained audio on stop", async () => {
    const consent = new AmbientAudioConsentState();
    const service = new InMemoryAmbientAudioService({ consent });

    await expect(service.start("owner")).rejects.toThrow(/consent is required/);

    consent.grant({ ownerId: "owner", grantedAt: 1, source: "test" });
    await service.start("owner");
    await service.pushFrame(frame([1, 2, 3]));

    expect(service.mode()).toBe("listening");
    expect(Array.from(service.recentAudio())).toEqual([1, 2, 3]);

    await service.pause();
    await expect(service.pushFrame(frame([4]))).rejects.toThrow(
      /not listening/,
    );

    await service.resume();
    await service.pushFrame(frame([4]));
    expect(Array.from(service.recentAudio())).toEqual([1, 2, 3, 4]);

    await service.stop();
    expect(service.mode()).toBe("stopped");
    expect(Array.from(service.recentAudio())).toEqual([]);
  });
});
