import { describe, expect, it } from "vitest";
import { localSignal, signalScore } from "../src/signal-score.ts";

const MINT = "So11111111111111111111111111111111111111112";

describe("Brain signal score", () => {
  it("uses the API score when the worker answers", async () => {
    const result = await signalScore(
      MINT,
      { url: "https://brain.example", key: "secret-key" },
      async () =>
        new Response(
          JSON.stringify({ score: 64, flags: ["liquidity"], disclaimer: "Not financial advice." }),
          {
            status: 200,
          }
        )
    );
    expect(result.source).toBe("api");
    expect(result.score).toBe(64);
    expect(result.flags).toContain("liquidity");
  });

  it("falls back locally when the API is missing or down", async () => {
    const missing = await signalScore(MINT, {});
    expect(missing.source).toBe("local");
    expect(missing.disclaimer).toContain("Not financial advice");
    const down = await signalScore(
      MINT,
      { url: "https://brain.example", key: "secret-key" },
      async () => {
        throw new Error("offline");
      }
    );
    expect(down.source).toBe("local");
    expect(down.flags).toContain("api did not answer");
    expect(localSignal("short").score).toBe(20);
  });
});
