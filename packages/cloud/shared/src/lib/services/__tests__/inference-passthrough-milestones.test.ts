/**
 * Stream milestone extraction for the pass-through meter (#16079).
 * Deterministic harness: a scripted clock pins every milestone timestamp, so
 * each test asserts the exact elapsed value tied to a specific frame — not a
 * timing race.
 */

import { describe, expect, test } from "bun:test";
import {
  type PassthroughStreamMilestones,
  readPassthroughStreamTail,
} from "../inference-passthrough";

const encoder = new TextEncoder();

function sseStream(frames: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
}

/** Clock the tests control: every await tick advances the virtual time. */
function scriptedClock(start = 0, stepMs = 5) {
  let now = start;
  return {
    now: () => now,
    tick: () => {
      now += stepMs;
    },
  };
}

async function readWithClock(
  frames: string[],
  startedAt: number,
  clock: ReturnType<typeof scriptedClock>,
) {
  // Interleave: each reader.read() resolves between clock ticks, mirroring
  // frame arrival over time. The meter parses on delivery, so milestones land
  // on the tick active when their frame arrived.
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (i >= frames.length) {
        controller.close();
        return;
      }
      clock.tick();
      controller.enqueue(encoder.encode(frames[i]));
      i += 1;
    },
  });
  return readPassthroughStreamTail(stream, undefined, {
    startedAt,
    now: clock.now,
  });
}

describe("readPassthroughStreamTail — milestones (#16079)", () => {
  test("records first event, reasoning, content, and completion from a full reasoning stream", async () => {
    const clock = scriptedClock(0, 10);
    const startedAt = 0;
    const tail = await readWithClock(
      [
        `data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","reasoning":"hmm"},"finish_reason":null}]}\n\n`,
        `data: {"id":"c1","choices":[{"index":0,"delta":{"content":"Hel"},"finish_reason":null}]}\n\n`,
        `data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":null}\n\n`,
        `data: {"id":"c1","choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}}\n\n`,
        `data: [DONE]\n\n`,
      ],
      startedAt,
      clock,
    );
    const m = tail.milestones;
    // Frame 1 (reasoning frame) arrives at tick 10 — it is both the first
    // event and the first reasoning delta.
    expect(m.firstEventMs).toBe(10);
    expect(m.firstReasoningMs).toBe(10);
    expect(m.firstContentMs).toBe(20);
    expect(m.completionMs).toBe(50);
    expect(tail.usage).toEqual({
      inputTokens: 7,
      outputTokens: 3,
      totalTokens: 10,
    });
    expect(tail.deliveredText).toBe("Hel");
    expect(tail.readError).toBeNull();
  });

  test("reasoning_content and thinking carriers also mark firstReasoning", async () => {
    for (const field of ["reasoning_content", "thinking"]) {
      const clock = scriptedClock(0, 7);
      const tail = await readWithClock(
        [
          `data: {"id":"c1","choices":[{"index":0,"delta":{${JSON.stringify(field)}:"x"},"finish_reason":null}]}\n\n`,
          `data: [DONE]\n\n`,
        ],
        0,
        clock,
      );
      expect(tail.milestones.firstReasoningMs).toBe(7);
      expect(tail.milestones.firstContentMs).toBeNull();
    }
  });

  test("first event without any delta still marks firstEvent only", async () => {
    const clock = scriptedClock(0, 3);
    const tail = await readWithClock(
      [`data: {"id":"c1","choices":[],"usage":null}\n\n`, `data: [DONE]\n\n`],
      0,
      clock,
    );
    expect(tail.milestones.firstEventMs).toBe(3);
    expect(tail.milestones.firstReasoningMs).toBeNull();
    expect(tail.milestones.firstContentMs).toBeNull();
    expect(tail.milestones.completionMs).toBe(6);
  });

  test("empty-string content delta does not mark firstContent", async () => {
    const clock = scriptedClock(0, 4);
    const tail = await readWithClock(
      [
        `data: {"id":"c1","choices":[{"index":0,"delta":{"content":""},"finish_reason":null}]}\n\n`,
        `data: [DONE]\n\n`,
      ],
      0,
      clock,
    );
    expect(tail.milestones.firstContentMs).toBeNull();
    expect(tail.milestones.firstEventMs).toBe(4);
  });

  test("malformed frames never produce milestones", async () => {
    const clock = scriptedClock(0, 2);
    const tail = await readWithClock(
      [`data: not-json\n\n`, `: comment line\n\n`, `data: [DONE]\n\n`],
      0,
      clock,
    );
    expect(tail.milestones.firstEventMs).toBeNull();
    expect(tail.milestones.completionMs).toBe(6);
  });

  test("abort leaves completion null and observed partial milestones intact", async () => {
    const frames = [
      `data: {"id":"c1","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}\n\n`,
    ];
    const clock = scriptedClock(100, 5);
    const controller = new AbortController();
    let i = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(inner) {
        if (i >= frames.length) {
          // Simulate the client aborting mid-drain: the signal fires and the
          // upstream errors out on the next read.
          controller.abort(new Error("client stopped"));
          inner.error(new Error("upstream dropped"));
          return;
        }
        clock.tick();
        inner.enqueue(encoder.encode(frames[i]));
        i += 1;
      },
    });
    const tail = await readPassthroughStreamTail(stream, controller.signal, {
      startedAt: 100,
      now: clock.now,
    });
    expect(tail.readError).not.toBeNull();
    expect(tail.milestones.firstEventMs).toBe(5);
    expect(tail.milestones.firstContentMs).toBe(5);
    expect(tail.milestones.completionMs).toBeNull();
  });

  test("milestones default to null for a stream with no data frames", async () => {
    const tail = await readPassthroughStreamTail(sseStream(["event: ping\n\n"]), undefined, {
      startedAt: 0,
      now: () => 42,
    });
    const allNull: PassthroughStreamMilestones = {
      firstEventMs: null,
      firstReasoningMs: null,
      firstContentMs: null,
      completionMs: 42,
    };
    expect(tail.milestones).toEqual(allNull);
  });

  test("defaults: startedAt/now resolve to performance.now when omitted", async () => {
    const tail = await readPassthroughStreamTail(sseStream([`data: [DONE]\n\n`]));
    // No crash, milestone fields present and completion observed.
    expect(tail.milestones.firstEventMs).toBeNull();
    expect(typeof tail.milestones.completionMs).toBe("number");
    expect(tail.milestones.completionMs).not.toBeNull();
  });
});

describe("readPassthroughStreamTail — RP review round 1 hardening (#16079)", () => {
  test("clean SSE error frame then close: completion stays null (no fake healthy end)", async () => {
    const clock = scriptedClock(0, 10);
    const tail = await readWithClock(
      [
        `data: {"id":"c1","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}\n\n`,
        `data: {"error":{"message":"upstream overloaded","code":503}}\n\n`,
      ],
      0,
      clock,
    );
    expect(tail.sawErrorFrame).toBe(true);
    expect(tail.readError).toBeNull();
    // The provider reported failure mid-stream: absence reported as absence.
    expect(tail.milestones.firstContentMs).not.toBeNull();
    expect(tail.milestones.completionMs).toBeNull();
  });

  test("completion records at [DONE] parse time, not EOF time", async () => {
    const clock = scriptedClock(0, 10);
    let i = 0;
    const frames = [
      `data: {"id":"c1","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}\n\n`,
      `data: [DONE]\n\n`,
    ];
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (i >= frames.length) {
          // Provider delays the connection close well past [DONE]; the
          // completion boundary must reflect [DONE], not this late EOF.
          clock.tick();
          clock.tick();
          clock.tick();
          clock.tick();
          controller.close();
          return;
        }
        clock.tick();
        controller.enqueue(encoder.encode(frames[i]));
        i += 1;
      },
    });
    const tail = await readPassthroughStreamTail(stream, undefined, {
      startedAt: 0,
      now: clock.now,
    });
    // [DONE] arrived at tick 20 (frames 1 and 2); EOF happened at tick 60.
    expect(tail.milestones.completionMs).toBe(20);
  });

  test("empty reasoning carriers do not fabricate firstReasoningMs", async () => {
    const clock = scriptedClock(0, 10);
    const tail = await readWithClock(
      [
        `data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","reasoning":"","reasoning_content":""},"finish_reason":null}]}\n\n`,
        `data: {"id":"c1","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}\n\n`,
        `data: [DONE]\n\n`,
      ],
      0,
      clock,
    );
    expect(tail.milestones.firstEventMs).toBe(10);
    expect(tail.milestones.firstReasoningMs).toBeNull();
    expect(tail.milestones.firstContentMs).toBe(20);
  });
});
