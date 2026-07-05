/**
 * Concurrency test for per-turn usage attribution. Drives the real
 * AsyncLocalStorage-backed UsageCapture with two genuinely-overlapping turns
 * (interleaved awaits) that emit MODEL_USED events through the exact listener
 * the bench server registers, and asserts each turn's buffer collects only its
 * own calls — the property the former process-global buffer violated (#13777).
 * No mock stands in for the buffer under test; only the model call and the
 * event bus are simulated, and they use the same current()/push wiring as
 * server.ts.
 */
import { describe, expect, it } from "vitest";
import type { BenchmarkLlmCallUsage } from "./server-utils";
import { summarizeBenchmarkTurnUsage } from "./server-utils";
import { UsageCapture } from "./usage-capture";

/** MODEL_USED listener wiring copied verbatim from server.ts's registration. */
function makeModelUsedListener(usageCapture: UsageCapture) {
  return (usage: BenchmarkLlmCallUsage): void => {
    const buffer = usageCapture.current();
    if (!buffer) return;
    buffer.push(usage);
  };
}

const usageFor = (provider: string, tokens: number): BenchmarkLlmCallUsage => ({
  modelType: "TEXT_LARGE",
  provider,
  promptTokens: tokens,
  completionTokens: tokens,
  totalTokens: tokens * 2,
});

/**
 * Yield to the microtask/timer queue so two concurrently-awaited turns actually
 * interleave rather than running to completion one after another.
 */
const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("UsageCapture", () => {
  it("attributes overlapping turns on different sessions to their own buffers", async () => {
    const usageCapture = new UsageCapture();
    const onModelUsed = makeModelUsedListener(usageCapture);

    // Each turn: bind its buffer, then emit two MODEL_USED events spaced by an
    // await so the two turns' emits interleave in wall-clock order. The staggered
    // delays force turn B's first emit to land between turn A's two emits.
    const runTurn = async (
      buffer: BenchmarkLlmCallUsage[],
      provider: string,
      tokens: number,
      firstDelay: number,
      secondDelay: number,
    ): Promise<void> => {
      await usageCapture.run(buffer, async () => {
        await tick(firstDelay);
        onModelUsed(usageFor(provider, tokens)); // simulated MODEL_USED
        await tick(secondDelay);
        onModelUsed(usageFor(provider, tokens));
      });
    };

    const bufferA: BenchmarkLlmCallUsage[] = [];
    const bufferB: BenchmarkLlmCallUsage[] = [];

    await Promise.all([
      // A: emits at t=0 and t=20
      runTurn(bufferA, "provider-a", 100, 0, 20),
      // B: emits at t=10 and t=30 — interleaved with A's two emits
      runTurn(bufferB, "provider-b", 7, 10, 20),
    ]);

    expect(bufferA).toHaveLength(2);
    expect(bufferB).toHaveLength(2);
    expect(bufferA.every((u) => u.provider === "provider-a")).toBe(true);
    expect(bufferB.every((u) => u.provider === "provider-b")).toBe(true);

    const summaryA = summarizeBenchmarkTurnUsage(bufferA);
    const summaryB = summarizeBenchmarkTurnUsage(bufferB);
    expect(summaryA.promptTokens).toBe(200);
    expect(summaryA.totalTokens).toBe(400);
    expect(summaryB.promptTokens).toBe(14);
    expect(summaryB.totalTokens).toBe(28);
  });

  it("keeps ten overlapping turns' token counts exactly separated", async () => {
    const usageCapture = new UsageCapture();
    const onModelUsed = makeModelUsedListener(usageCapture);

    const turnCount = 10;
    const buffers = Array.from(
      { length: turnCount },
      () => [] as BenchmarkLlmCallUsage[],
    );

    await Promise.all(
      buffers.map((buffer, i) =>
        usageCapture.run(buffer, async () => {
          // Distinct, prime-ish per-turn token count and staggered awaits so the
          // emits from all ten turns interleave under one shared listener.
          const tokens = (i + 1) * 13;
          await tick(i);
          onModelUsed(usageFor(`turn-${i}`, tokens));
          await tick(turnCount - i);
          onModelUsed(usageFor(`turn-${i}`, tokens));
        }),
      ),
    );

    for (let i = 0; i < turnCount; i += 1) {
      const tokens = (i + 1) * 13;
      const summary = summarizeBenchmarkTurnUsage(buffers[i]);
      expect(buffers[i]).toHaveLength(2);
      expect(buffers[i].every((u) => u.provider === `turn-${i}`)).toBe(true);
      expect(summary.promptTokens).toBe(tokens * 2);
      expect(summary.totalTokens).toBe(tokens * 4);
    }
  });

  it("ignores MODEL_USED events emitted outside any turn (current() is null)", () => {
    const usageCapture = new UsageCapture();
    const onModelUsed = makeModelUsedListener(usageCapture);

    expect(usageCapture.current()).toBeNull();
    // No throw, no capture: an event with no enclosing turn is dropped.
    onModelUsed(usageFor("orphan", 42));
    expect(usageCapture.current()).toBeNull();
  });

  it("matches single-turn behavior: one turn collects all its own calls", async () => {
    const usageCapture = new UsageCapture();
    const onModelUsed = makeModelUsedListener(usageCapture);
    const buffer: BenchmarkLlmCallUsage[] = [];

    await usageCapture.run(buffer, async () => {
      onModelUsed(usageFor("solo", 50));
      await tick(1);
      onModelUsed(usageFor("solo", 30));
    });

    expect(usageCapture.current()).toBeNull(); // binding torn down after run
    const summary = summarizeBenchmarkTurnUsage(buffer);
    expect(buffer).toHaveLength(2);
    expect(summary.promptTokens).toBe(80);
    expect(summary.totalTokens).toBe(160);
  });
});
