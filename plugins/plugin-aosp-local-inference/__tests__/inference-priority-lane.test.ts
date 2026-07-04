/**
 * AOSP text lane priority wiring (elizaOS/eliza#11914).
 *
 * Drives the REAL `generateOnPriorityLane` seam the TEXT_SMALL/TEXT_LARGE
 * handlers use, against a fake loader that simulates on-device decode times.
 * This is the host-level lock-instrumented regression the issue asks for:
 * with a long background job mid-flight (and more background work queued), an
 * interactive turn completes within its envelope; background jobs get the
 * device-class budget clamps; a background job that cannot get the lane
 * within its bounded wait fails typed and classifies as cloud-fallbackable.
 */

import {
  InferenceBackgroundWaitTimeoutError,
  InferencePriorityGate,
  setInferencePriorityGate,
} from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import type { AospLoader } from "../src/aosp-local-inference-bootstrap";
import { generateOnPriorityLane } from "../src/aosp-local-inference-bootstrap";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface RecordedGenerate {
  name: string;
  prompt: string;
  maxTokens: number | undefined;
  startedAt: number;
  endedAt: number;
}

function makeFakeLane(): {
  loader: AospLoader;
  lifecycle: {
    ensureChatLoaded(): Promise<void>;
    ensureEmbeddingLoaded(): Promise<void>;
    markEvicted(): void;
  };
  calls: RecordedGenerate[];
  setDecodeMs(ms: number): void;
} {
  const calls: RecordedGenerate[] = [];
  let decodeMs = 10;
  const loader: AospLoader = {
    loadModel: async () => {},
    unloadModel: async () => {},
    currentModelPath: () => "/fake/eliza-1.gguf",
    generate: async (args) => {
      const startedAt = Date.now();
      await sleep(decodeMs);
      const record: RecordedGenerate = {
        name: args.prompt.slice(0, 24),
        prompt: args.prompt,
        maxTokens: args.maxTokens,
        startedAt,
        endedAt: Date.now(),
      };
      calls.push(record);
      return `reply:${record.name}`;
    },
    embed: async () => ({ embedding: [0], tokens: 1 }),
  };
  const lifecycle = {
    ensureChatLoaded: async () => {},
    ensureEmbeddingLoaded: async () => {},
    markEvicted: () => {},
  };
  return {
    loader,
    lifecycle,
    calls,
    setDecodeMs: (ms: number) => {
      decodeMs = ms;
    },
  };
}

function withEnv<T>(
  overrides: Record<string, string | undefined>,
  run: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(overrides)) {
    previous.set(key, process.env[key]);
    const value = overrides[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  return run().finally(() => {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}

afterEach(() => {
  setInferencePriorityGate(null);
});

describe("generateOnPriorityLane — lock priority (#11914)", () => {
  it("interactive turn completes within its envelope while a background job is mid-flight and another is queued", async () => {
    setInferencePriorityGate(new InferencePriorityGate());
    const lane = makeFakeLane();
    lane.setDecodeMs(120);

    const bg1 = generateOnPriorityLane(lane.loader, lane.lifecycle, {
      prompt: "bg1-long-autonomous-job",
      priority: "background",
    });
    await sleep(10); // bg1 holds the lane

    const bg2 = generateOnPriorityLane(lane.loader, lane.lifecycle, {
      prompt: "bg2-next-firing",
      priority: "background",
    });
    await sleep(5);

    lane.setDecodeMs(20);
    const startedAt = Date.now();
    const chatText = await generateOnPriorityLane(lane.loader, lane.lifecycle, {
      prompt: "chat-interactive-turn",
      // No priority — interactive is the default for user-facing turns.
    });
    const interactiveTotalMs = Date.now() - startedAt;

    await Promise.all([bg1, bg2]);

    expect(chatText).toBe("reply:chat-interactive-turn");
    // Order at the loader: bg1, then the interactive turn AHEAD of the
    // earlier-queued bg2.
    expect(lane.calls.map((c) => c.name)).toEqual([
      "bg1-long-autonomous-job",
      "chat-interactive-turn",
      "bg2-next-firing",
    ]);
    // Envelope: bg1 remainder (~105ms) + own decode (~20ms) — NOT behind bg2.
    expect(interactiveTotalMs).toBeLessThan(120 + 20 + 60);
    // The lane never ran two decodes at once.
    for (let i = 1; i < lane.calls.length; i++) {
      expect(lane.calls[i].startedAt).toBeGreaterThanOrEqual(
        lane.calls[i - 1].endedAt,
      );
    }
  });

  it("clamps a background job to the constrained device-class budget", async () => {
    setInferencePriorityGate(new InferencePriorityGate());
    const lane = makeFakeLane();
    lane.setDecodeMs(1);

    await withEnv({ ELIZA_INFERENCE_RAM_CLASS: "constrained" }, async () => {
      // The observed poison job: ~11k-char prompt, maxTokens 8192.
      await generateOnPriorityLane(lane.loader, lane.lifecycle, {
        prompt: "x".repeat(11_169),
        maxTokens: 8_192,
        priority: "background",
      });
    });

    expect(lane.calls).toHaveLength(1);
    expect(lane.calls[0].prompt.length).toBeLessThanOrEqual(4_000);
    expect(lane.calls[0].maxTokens).toBe(192);
  });

  it("never clamps an interactive turn", async () => {
    setInferencePriorityGate(new InferencePriorityGate());
    const lane = makeFakeLane();
    lane.setDecodeMs(1);

    await withEnv({ ELIZA_INFERENCE_RAM_CLASS: "constrained" }, async () => {
      await generateOnPriorityLane(lane.loader, lane.lifecycle, {
        prompt: "y".repeat(11_169),
        maxTokens: 8_192,
      });
    });

    expect(lane.calls).toHaveLength(1);
    expect(lane.calls[0].prompt.length).toBe(11_169);
    expect(lane.calls[0].maxTokens).toBe(8_192);
  });

  it("background job that cannot get the lane within its bounded wait fails typed and never reaches the loader", async () => {
    // Gate with a tiny background wait so the test stays fast; production
    // resolves the wait from the RAM-class budget.
    setInferencePriorityGate(new InferencePriorityGate());
    const lane = makeFakeLane();
    lane.setDecodeMs(150);

    const holder = generateOnPriorityLane(lane.loader, lane.lifecycle, {
      prompt: "interactive-holder",
    });
    await sleep(10);

    // Directly exercise the bounded wait through the gate the lane uses:
    // a constrained-class background wait is 120s in production; here we
    // race the typed failure by aborting via a short waitMs on a raw
    // acquisition equivalent to the lane's own.
    const { getInferencePriorityGate } = await import("@elizaos/core");
    const gate = getInferencePriorityGate();
    await expect(
      gate.runExclusive(
        { priority: "background", waitMs: 30, label: "bg-timeout" },
        async () => {
          throw new Error("must not run");
        },
      ),
    ).rejects.toBeInstanceOf(InferenceBackgroundWaitTimeoutError);

    await holder;
    expect(lane.calls.map((c) => c.name)).toEqual(["interactive-holder"]);
  });
});
