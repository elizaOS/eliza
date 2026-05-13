/**
 * Tests for the runtime dispatcher.
 *
 * The dispatcher unifies the spawn (HTTP) and FFI backends behind one
 * async-iterable. Tests use lightweight mocks for both adapters so the
 * test suite never touches a native library or an HTTP server.
 */

import { describe, expect, it, vi } from "vitest";

import { FfiStreamingRunner } from "../ffi-streaming-runner";
import {
  dispatchGenerate,
  type HttpStreamingAdapter,
  type InferenceStreamEvent,
} from "../runtime-dispatcher";
import type {
  ElizaInferenceContextHandle,
  ElizaInferenceFfi,
  LlmStreamHandle,
  LlmStreamStep,
} from "../voice/ffi-bindings";

const FFI_STEPS: LlmStreamStep[] = [
  {
    tokens: [10, 11],
    text: "hi",
    done: false,
    drafterDrafted: 2,
    drafterAccepted: 2,
  },
  {
    tokens: [12],
    text: "!",
    done: true,
    drafterDrafted: 1,
    drafterAccepted: 1,
  },
];

function makeFfiRunner(steps: LlmStreamStep[]): FfiStreamingRunner {
  let idx = 0;
  const ffi = {
    libraryPath: "/fake",
    libraryAbiVersion: "3",
    create: vi.fn(),
    destroy: vi.fn(),
    mmapAcquire: vi.fn(),
    mmapEvict: vi.fn(),
    ttsSynthesize: vi.fn().mockReturnValue(0),
    asrTranscribe: vi.fn().mockReturnValue(""),
    ttsStreamSupported: () => false,
    ttsSynthesizeStream: vi.fn(),
    llmStreamSupported: () => true,
    llmStreamOpen: vi.fn().mockReturnValue(1n as LlmStreamHandle),
    llmStreamPrefill: vi.fn(),
    llmStreamNext: vi.fn(() => steps[idx++]!),
    llmStreamCancel: vi.fn(),
    llmStreamSaveSlot: vi.fn(),
    llmStreamRestoreSlot: vi.fn(),
    llmStreamClose: vi.fn(),
    close: vi.fn(),
  } as unknown as ElizaInferenceFfi;
  const ctx: ElizaInferenceContextHandle = 1n;
  return new FfiStreamingRunner(ffi, ctx);
}

/** A trivial HTTP adapter that drives the dispatcher via the supplied callbacks. */
function makeHttpAdapter(
  scripted: {
    chunks: string[];
    finalText?: string;
    firstTokenMs?: number | null;
  },
  opts: { fail?: Error } = {},
): HttpStreamingAdapter {
  return {
    async generateWithUsage(args) {
      if (opts.fail) throw opts.fail;
      let tokenIdx = 0;
      for (const chunk of scripted.chunks) {
        await args.onTextChunk?.(chunk);
        await args.onVerifierEvent?.({
          kind: "accept",
          tokens: [{ index: tokenIdx++, text: chunk, id: 100 + tokenIdx }],
          meta: tokenIdx === 1 ? { firstTokenMs: 12 } : undefined,
        });
      }
      return {
        text: scripted.finalText ?? scripted.chunks.join(""),
        slotId: args.slotId ?? -1,
        firstTokenMs: scripted.firstTokenMs ?? 12,
      };
    },
  };
}

async function drain(
  iter: AsyncIterable<InferenceStreamEvent>,
): Promise<InferenceStreamEvent[]> {
  const out: InferenceStreamEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

describe("dispatchGenerate (ffi-streaming)", () => {
  it("yields text + accept + done events in order", async () => {
    const runner = makeFfiRunner(FFI_STEPS);
    const events = await drain(
      dispatchGenerate({
        backend: "ffi-streaming",
        ffi: {
          runner,
          args: {
            promptTokens: new Int32Array([1, 2]),
            slotId: 0,
            maxTokens: 32,
            temperature: 0.8,
            topP: 0.95,
            topK: 40,
            repeatPenalty: 1.0,
            draftMin: 0,
            draftMax: 0,
            dflashDrafterPath: null,
          },
        },
      }),
    );

    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual(["text", "accept", "text", "accept", "done"]);
    const done = events.at(-1)! as Extract<
      InferenceStreamEvent,
      { kind: "done" }
    >;
    expect(done.text).toBe("hi!");
    expect(done.drafted).toBe(3);
    expect(done.accepted).toBe(3);
  });

  it("throws when ffi config is missing", async () => {
    const run = async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of dispatchGenerate({ backend: "ffi-streaming" })) {
        /* drain */
      }
    };
    await expect(run()).rejects.toThrow(
      /backend=ffi-streaming but no ffi.runner/,
    );
  });
});

describe("dispatchGenerate (http-server)", () => {
  it("yields text + accept + done events", async () => {
    const adapter = makeHttpAdapter({ chunks: ["hel", "lo"] });
    const events = await drain(
      dispatchGenerate({
        backend: "http-server",
        http: {
          runner: adapter,
          prompt: "say hi",
          maxTokens: 64,
          temperature: 0.7,
          topP: 0.95,
        },
      }),
    );

    expect(events.map((e) => e.kind)).toEqual([
      "text",
      "accept",
      "text",
      "accept",
      "done",
    ]);
    const done = events.at(-1)! as Extract<
      InferenceStreamEvent,
      { kind: "done" }
    >;
    expect(done.text).toBe("hello");
    expect(done.firstTokenMs).toBe(12);
  });

  it("propagates backend failures as iterator throws", async () => {
    const adapter = makeHttpAdapter(
      { chunks: [] },
      { fail: new Error("upstream 500") },
    );
    const run = async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of dispatchGenerate({
        backend: "http-server",
        http: {
          runner: adapter,
          prompt: "x",
          maxTokens: 4,
          temperature: 0.7,
          topP: 0.95,
        },
      })) {
        /* drain */
      }
    };
    await expect(run()).rejects.toThrow(/upstream 500/);
  });

  it("forwards native DFlash reject events into the unified stream", async () => {
    const adapter: HttpStreamingAdapter = {
      async generateWithUsage(args) {
        await args.onTextChunk?.("ok");
        await args.onDflashEvent?.({
          kind: "reject",
          drafted: [1, 2, 3],
          rejectRange: [1, 2],
          correctedToken: 99,
          ts: 1,
        });
        return { text: "ok", slotId: -1, firstTokenMs: 5 };
      },
    };
    const events = await drain(
      dispatchGenerate({
        backend: "http-server",
        http: {
          runner: adapter,
          prompt: "x",
          maxTokens: 4,
          temperature: 0.7,
          topP: 0.95,
          onDflashEvent: () => undefined,
        },
      }),
    );

    const reject = events.find((e) => e.kind === "reject");
    expect(reject).toBeDefined();
    expect(
      (reject as Extract<InferenceStreamEvent, { kind: "reject" }>).rejectRange,
    ).toEqual([1, 2]);
  });

  it("throws when http config is missing", async () => {
    const run = async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of dispatchGenerate({ backend: "http-server" })) {
        /* drain */
      }
    };
    await expect(run()).rejects.toThrow(
      /backend=http-server but no http.runner/,
    );
  });
});
