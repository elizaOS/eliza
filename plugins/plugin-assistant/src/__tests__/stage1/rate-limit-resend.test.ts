/**
 * A chat turn waits out a temporary provider rate limit once and re-sends the
 * same Stage 1 request, as its planner and evaluator calls already do. Before
 * this, a 429 on the first model call of a turn ended it with an error reply
 * while a turn refused at a later call recovered.
 */
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentRuntime,
  ChannelType,
  ModelType,
  runWithStreamingContext,
  type State,
  type TextStreamResult,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RATE_LIMIT_RETRY_MAX_WAIT_MS } from "../../runtime/evaluator.ts";
import {
  makeMessage,
  makeRuntime,
  makeState,
  runStage1,
  type Stage1Input,
  stage1Response,
} from "./fixtures.js";

const REPLY = "Hello there.";
const answer = () => stage1Response({ contexts: ["simple"], replyText: REPLY });
const directReply = {
  kind: "direct_reply",
  result: { responseContent: { text: REPLY } },
};

const rateLimited = (fields: Record<string, unknown> = {}) =>
  Object.assign(new Error("Too Many Requests"), { status: 429, ...fields });
/** The typed wait the Cloud gateway attaches to its 429. */
const reportedWait = (retryAfterMs: number, scope?: string) => ({
  rateLimit: {
    kind: "rate_limited",
    retryAfterMs,
    ...(scope ? { scope } : {}),
  },
});
/** A provider that answers a token-bucket 429 with a whole-minute header. */
const minuteHeader = { responseHeaders: { "retry-after": "60" } };

/** Failures that a wait of seconds cannot clear, or that are not rate limits. */
const NOT_RESENT: Array<[string, Error]> = [
  [
    "spent credit",
    rateLimited({ code: "insufficient_quota", ...reportedWait(10) }),
  ],
  [
    "a permanent quota",
    Object.assign(new Error("token quota exceeded"), { status: 429 }),
  ],
  ["a used-up period allowance", rateLimited(reportedWait(10, "period"))],
  [
    "a rate limit named only in prose",
    new Error("subscription rate limit reached: session limit hit"),
  ],
  [
    "a provider outage",
    Object.assign(new Error("unavailable"), {
      status: 503,
      ...reportedWait(10),
    }),
  ],
  ["a transport failure", new Error("socket hang up")],
];

/** What the provider is sent: the parts its prompt cache and limits read. */
const sentRequest = (params: Record<string, unknown>) =>
  JSON.stringify({
    messages: params.messages,
    tools: params.tools,
    toolChoice: params.toolChoice,
    maxTokens: params.maxTokens,
    omitMaxTokens: params.omitMaxTokens,
    providerOptions: params.providerOptions,
  });

/**
 * Starts one direct-message turn whose Stage 1 calls take `outputs` in order,
 * an Error being a provider failure. Each request is captured as it is sent.
 */
function turn(
  outputs: unknown[],
  options: {
    signal?: AbortSignal;
    settings?: Record<string, string>;
    state?: State;
    input?: Partial<Stage1Input>;
    prepare?: (runtime: ReturnType<typeof makeRuntime>) => void;
  } = {},
) {
  const runtime = makeRuntime([], options.settings);
  options.prepare?.(runtime);
  const requests: string[] = [];
  runtime.useModel = vi.fn(
    async (_type: unknown, params: Record<string, unknown>) => {
      requests.push(sentRequest(params));
      const output = outputs.shift();
      if (output === undefined) throw new Error("Unexpected Stage 1 call");
      if (output instanceof Error) throw output;
      return output;
    },
  ) as never;
  const run = () =>
    runStage1({
      runtime,
      message: makeMessage({ text: "hi", channelType: ChannelType.DM }),
      ...(options.state ? { state: options.state } : {}),
      ...options.input,
    });
  const result = options.signal
    ? runWithStreamingContext(
        { onStreamChunk: async () => {}, abortSignal: options.signal },
        run,
      )
    : run();
  // The caller awaits the outcome only after it has advanced the clock.
  const outcome = result.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  return { outcome, requests };
}

/** Resolves once the turn is waiting on a timer. */
async function untilWaiting(): Promise<void> {
  for (let turns = 0; vi.getTimerCount() === 0; turns++) {
    if (turns > 1_000) throw new Error("The turn never started waiting");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("Stage 1 rate-limit re-send", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("re-sends the same request once after the hinted wait and answers the turn", async () => {
    const { outcome, requests } = turn([
      rateLimited(reportedWait(1_200)),
      answer(),
    ]);
    await untilWaiting();
    await vi.advanceTimersByTimeAsync(1_199);
    expect(requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toMatchObject({ value: directReply });
    expect(requests).toHaveLength(2);
    // The provider's prompt cache applies only to an identical request.
    expect(requests[1]).toBe(requests[0]);
  });

  it.each([
    ["longer than the bound", rateLimited(minuteHeader)],
    ["absent", rateLimited()],
  ])("waits only the bound when the hint is %s", async (_label, failure) => {
    const { outcome, requests } = turn([failure, answer()]);
    await untilWaiting();
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_RETRY_MAX_WAIT_MS - 1);
    expect(requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toMatchObject({ value: directReply });
    expect(requests).toHaveLength(2);
  });

  it("fails as before when the re-sent request is rate limited again", async () => {
    const second = rateLimited(reportedWait(1_200));
    const { outcome, requests } = turn([
      rateLimited(reportedWait(1_200)),
      second,
      answer(),
    ]);
    await untilWaiting();
    await vi.advanceTimersByTimeAsync(1_200);
    expect(await outcome).toEqual({ error: second });
    expect(requests).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(NOT_RESENT)(
    "fails without a wait or re-send on %s",
    async (_label, failure) => {
      const { outcome, requests } = turn([failure, answer()]);
      expect(await outcome).toEqual({ error: failure });
      expect(requests).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("stops the turn at once when it is aborted during the wait", async () => {
    const controller = new AbortController();
    const reason = new Error("caller cancelled during the wait");
    const { outcome, requests } = turn([rateLimited(minuteHeader), answer()], {
      signal: controller.signal,
    });
    await untilWaiting();
    controller.abort(reason);
    expect(await outcome).toEqual({ error: reason });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_RETRY_MAX_WAIT_MS);
    expect(requests).toHaveLength(1);
  });

  it("keeps the whole empty-output retry budget after a re-send", async () => {
    // One empty-output retry is configured. A refusal returned no answer to
    // judge, so its re-send must not use that retry up.
    const { outcome, requests } = turn(
      [rateLimited(reportedWait(1_200)), { text: "" }, answer()],
      { settings: { ELIZA_RESPONSE_HANDLER_EMPTY_RETRIES: "1" } },
    );
    await untilWaiting();
    await vi.advanceTimersByTimeAsync(1_200);
    expect(await outcome).toMatchObject({ value: directReply });
    expect(requests).toHaveLength(3);
  });

  describe("on a request after the first", () => {
    const REFERENCE = "userPersonalityPreferences";
    /** A turn that can read one deferred provider reference. */
    function readTurn(outputs: unknown[]) {
      const state = makeState();
      state.data.providers = {
        [REFERENCE]: {
          text: "Complete character preferences: address the user as Sam.",
          discoveryText: `context_discovery: ${REFERENCE}`,
        },
      };
      return turn(outputs, {
        state,
        prepare: (runtime) => {
          runtime.providers = [
            { name: REFERENCE, cacheStable: true, get: vi.fn() },
          ];
          runtime.composeState = vi.fn(async () => structuredClone(state));
        },
      });
    }
    const read = () =>
      stage1Response({ contextRequests: [REFERENCE], contexts: ["simple"] });

    it.each([
      // Each first output makes Stage 1 send a second request: the same one
      // again for an empty output, a longer one for a repair or a read.
      ["a retry of an empty output", turn, { text: "" }, true],
      [
        "a repair of a decision without an answer",
        turn,
        stage1Response({ contexts: ["simple"], replyText: "" }),
        false,
      ],
      ["the request after a context read", readTurn, read(), false],
    ])("re-sends %s that is refused", async (_label, start, first, repeats) => {
      const { outcome, requests } = start([
        first,
        rateLimited(reportedWait(1_200)),
        answer(),
      ]);
      await untilWaiting();
      expect(requests).toHaveLength(2);
      expect(requests[1] === requests[0]).toBe(repeats);
      await vi.advanceTimersByTimeAsync(1_200);
      expect(await outcome).toMatchObject({ value: directReply });
      expect(requests).toHaveLength(3);
      expect(requests[2]).toBe(requests[1]);
    });

    it("allows one re-send for the whole Stage 1 run, not one for each request", async () => {
      const second = rateLimited(reportedWait(1_200));
      const { outcome, requests } = readTurn([
        rateLimited(reportedWait(1_200)),
        read(),
        second,
        answer(),
      ]);
      await untilWaiting();
      await vi.advanceTimersByTimeAsync(1_200);
      expect(await outcome).toEqual({ error: second });
      expect(requests).toHaveLength(3);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it("records the refusal as a failed attempt and the re-send as its own completed call", async () => {
    const directory = await mkdtemp(join(tmpdir(), "stage1-resend-recording-"));
    vi.stubEnv("ELIZA_TRAJECTORY_LOGGING", "1");
    vi.stubEnv("ELIZA_TRAJECTORY_DIR", directory);
    vi.stubEnv("ELIZA_AWAIT_FACTS_STAGE", "true");
    try {
      const { outcome } = turn(
        [
          rateLimited(reportedWait(1_200)),
          {
            ...answer(),
            usage: { promptTokens: 101, completionTokens: 7, totalTokens: 108 },
          },
        ],
        {
          input: { stage1DecisionOnly: true },
          // The recorder looks for the trajectory store; this host has none.
          prepare: (runtime) => {
            runtime.getServicesByType = vi.fn(() => []) as never;
          },
        },
      );
      await untilWaiting();
      await vi.advanceTimersByTimeAsync(1_200);
      expect(await outcome).toMatchObject({ value: { kind: "decision" } });
      const files = (await readdir(directory, { recursive: true })).filter(
        (name) => name.endsWith(".json"),
      );
      expect(files).toHaveLength(1);
      const trajectory = JSON.parse(
        await readFile(join(directory, files[0] as string), "utf8"),
      );
      expect(trajectory.status).toBe("finished");
      const [refused, resent, ...rest] = trajectory.stages;
      expect(rest).toEqual([]);
      expect(refused.kind).toBe("messageHandler");
      expect(refused.model.finishReason).toBe("error");
      expect(refused.model.response).toContain("[messageHandler stage failed]");
      for (const field of ["provider", "usage", "toolCalls", "costUsd"])
        expect(refused.model[field]).toBeUndefined();
      expect(resent.kind).toBe("messageHandler");
      expect(resent.stageId).not.toBe(refused.stageId);
      expect(resent.model.finishReason).not.toBe("error");
      expect(resent.model.toolCalls[0].args.replyText).toBe(REPLY);
      expect(resent.model.messages).toEqual(refused.model.messages);
      expect(resent.model.tools).toEqual(refused.model.tools);
      // Only the answered call has usage, and the wait is in neither call.
      expect(trajectory.metrics.totalPromptTokens).toBe(101);
      expect(resent.startedAt - refused.endedAt).toBeGreaterThanOrEqual(1_200);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("Stage 1 rate-limit re-send through model dispatch", () => {
  const dispatchers: AgentRuntime[] = [];
  afterEach(async () => {
    for (const dispatcher of dispatchers.splice(0)) await dispatcher.stop();
  });

  it("streams the reply once, from the re-sent request only, under the host's cap", async () => {
    const dispatcher = new AgentRuntime({
      character: {
        name: "stage1-rate-limit-resend",
        bio: [],
        settings: { RESPONSE_HANDLER_MAX_TOKENS: "2048" },
      },
      logLevel: "fatal",
    });
    dispatcher.registerDatabaseAdapter({
      createLogs: async () => undefined,
    } as never);
    dispatchers.push(dispatcher);
    const chunks: { chunk: string; accumulated?: string; revision?: number }[] =
      [];
    const received: string[] = [];
    let streamedBeforeResend: number | undefined;
    dispatcher.registerModel(
      ModelType.RESPONSE_HANDLER,
      async (_runtime, params): Promise<TextStreamResult> => {
        const request = params as Record<string, unknown> & {
          tools: Array<{
            name: string;
            parameters: { properties: Record<string, unknown> };
          }>;
        };
        received.push(sentRequest(request));
        // A refusal carries no response body. Its 20 ms hint is the wait.
        if (received.length === 1) throw rateLimited({ retryAfterMs: 20 });
        streamedBeforeResend = chunks.length;
        // A direct answer in each field the request's tool asks for.
        const direct: Record<string, unknown> = {
          shouldRespond: "RESPOND",
          contexts: ["simple"],
          replyEffectStatus: "none",
          replyText: REPLY,
          emotion: "none",
        };
        const fields = Object.keys(
          request.tools.find((tool) => tool.name === "HANDLE_RESPONSE")
            ?.parameters.properties ?? {},
        );
        const decision = Object.fromEntries(
          fields.map((field) => [field, direct[field] ?? []]),
        );
        const envelope = JSON.stringify(decision);
        return {
          text: Promise.resolve(envelope),
          textStream: (async function* () {
            for (let index = 0; index < envelope.length; index += 7)
              yield envelope.slice(index, index + 7);
          })(),
          toolCalls: Promise.resolve([
            {
              id: "handle-response-1",
              name: "HANDLE_RESPONSE",
              arguments: decision,
            },
          ]),
          finishReason: Promise.resolve("tool_calls"),
          usage: Promise.resolve(undefined),
        } as TextStreamResult;
      },
      "openai",
      100,
    );
    const runtime = makeRuntime([]);
    runtime.useModel = dispatcher.useModel.bind(dispatcher);
    const result = await runWithStreamingContext(
      {
        onStreamChunk: async (chunk, _messageId, accumulated, revision) => {
          chunks.push({ chunk, accumulated, revision });
        },
      },
      () =>
        runStage1({
          runtime,
          message: makeMessage({ text: "hi", channelType: ChannelType.DM }),
        }),
    );

    expect(received).toHaveLength(2);
    expect(JSON.parse(received[0] as string)).toMatchObject({
      maxTokens: 2048,
      omitMaxTokens: false,
    });
    expect(received[1]).toBe(received[0]);
    // Nothing of the refused attempt reached the stream, and the re-sent
    // attempt's text arrives once, growing, under a single revision.
    expect(streamedBeforeResend).toBe(0);
    expect(chunks.map((entry) => entry.chunk).join("")).toBe(REPLY);
    const accumulations = chunks.map((entry) => entry.accumulated ?? "");
    for (const [index, accumulated] of accumulations.entries()) {
      expect(REPLY.startsWith(accumulated)).toBe(true);
      expect(accumulated.length).toBeGreaterThan(
        accumulations[index - 1]?.length ?? 0,
      );
    }
    expect(accumulations.at(-1)).toBe(REPLY);
    expect(new Set(chunks.map((entry) => entry.revision)).size).toBe(1);
    expect(result).toMatchObject(directReply);
  });
});
