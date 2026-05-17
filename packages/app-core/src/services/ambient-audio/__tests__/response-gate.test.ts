import { describe, expect, it } from "vitest";
import { decideResponse } from "../response-gate.ts";
import type { ResponseGateSignals } from "../types.ts";

function signals(
  overrides: Partial<ResponseGateSignals> = {},
): ResponseGateSignals {
  return {
    vadActive: true,
    directAddress: false,
    wakeIntent: 0,
    contextExpectsReply: false,
    ownerConfidence: 0,
    ...overrides,
  };
}

describe("decideResponse", () => {
  it("silent when vad is inactive regardless of other signals", () => {
    expect(
      decideResponse(
        signals({
          vadActive: false,
          directAddress: true,
          wakeIntent: 1,
          ownerConfidence: 1,
        }),
      ),
    ).toBe("silent");
  });

  it("responds on direct address with sufficient owner confidence", () => {
    expect(
      decideResponse(signals({ directAddress: true, ownerConfidence: 0.6 })),
    ).toBe("respond");
  });

  it("observes on direct address with insufficient owner confidence", () => {
    expect(
      decideResponse(signals({ directAddress: true, ownerConfidence: 0.4 })),
    ).toBe("observe");
  });

  it("responds on high wake intent without direct address", () => {
    expect(decideResponse(signals({ wakeIntent: 0.85 }))).toBe("respond");
  });

  it("observes when wake intent is below threshold", () => {
    expect(decideResponse(signals({ wakeIntent: 0.84 }))).toBe("observe");
  });

  it("responds when context expects reply with floor owner confidence", () => {
    expect(
      decideResponse(
        signals({ contextExpectsReply: true, ownerConfidence: 0.5 }),
      ),
    ).toBe("respond");
  });

  it("observes when context expects reply but owner confidence too low", () => {
    expect(
      decideResponse(
        signals({ contextExpectsReply: true, ownerConfidence: 0.49 }),
      ),
    ).toBe("observe");
  });

  it("respects a custom direct-address threshold", () => {
    expect(
      decideResponse(
        signals({ directAddress: true, ownerConfidence: 0.7 }),
        0.8,
      ),
    ).toBe("observe");
    expect(
      decideResponse(
        signals({ directAddress: true, ownerConfidence: 0.85 }),
        0.8,
      ),
    ).toBe("respond");
  });
});
