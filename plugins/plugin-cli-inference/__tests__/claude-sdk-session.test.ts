import { toWellFormedUnicode } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { ClaudeSdkSession, type SdkModule } from "../src/claude-sdk-session";
import { ProviderApiError } from "../src/provider-errors";

/**
 * Unit tests for the warm Agent SDK session, driven by a FAKE SdkModule via the
 * constructor's injectable `sdkModule` / `zodModule` seam (no real SDK, no real
 * `claude` process). Each "turn script" describes what the fake SDK does for one
 * turn: optionally invoke the in-process route tool handler (to set a decision),
 * optionally stream assistant text, then emit a terminal `result` with a subtype.
 */

interface TurnScript {
  /** Never yield a message, used to test the per-turn timeout budget. */
  hang?: boolean;
  /** Sleep this long before proceeding (slow-but-healthy turn shape). */
  delayMs?: number;
  /** ROUTE mode: invoke the captured tool handler with this decision. */
  toolCall?: { action: unknown; params?: unknown };
  /** Stream this as assistant text before the result. */
  text?: string;
  /** Terminal result subtype ("success" | "error_max_turns" | ...). */
  subtype?: string;
  /** The `result` echo string the SDK carries on the terminal message. */
  resultText?: string;
  /** Omit the terminal `result` message entirely (simulate a mid-turn death). */
  noResult?: boolean;
}

type ToolHandler = (args: {
  action?: unknown;
  params?: unknown;
}) => Promise<{ content: Array<{ type: string; text: string }> }>;

/** Build a fake SdkModule that replays `scripts` turn-by-turn over one warm query. */
function makeFakeSdk(
  scripts: TurnScript[],
  fakeOpts: { interrupt?: () => Promise<void> } = {}
): {
  sdk: SdkModule;
  starts: () => number;
  queryOptions: () => Array<Record<string, unknown>>;
} {
  let startCount = 0;
  const startedOptions: Array<Record<string, unknown>> = [];
  // Script progression is GLOBAL across query restarts: a self-heal/restart
  // creates a fresh query() but should continue consuming the next scripted
  // turn (mirroring a real warm session that gets fresh turns after a restart).
  let turn = 0;
  const sdk: SdkModule = {
    tool: (_name, _desc, _schema, handler) => ({ handler }) as unknown,
    createSdkMcpServer: (opts) => ({ tools: opts.tools }) as unknown,
    query: ({ options }) => {
      startCount += 1;
      startedOptions.push(options);
      // Reach the route tool handler the session registered (ROUTE mode only).
      const servers = options.mcpServers as
        | { eliza?: { tools?: Array<{ handler: ToolHandler }> } }
        | undefined;
      const handler = servers?.eliza?.tools?.[0]?.handler;
      async function* gen() {
        while (turn < scripts.length) {
          const s = scripts[turn++];
          if (s.hang) {
            await new Promise(() => undefined);
          }
          if (s.delayMs) {
            await new Promise((res) => setTimeout(res, s.delayMs));
          }
          if (s.toolCall && handler) {
            await handler({ action: s.toolCall.action, params: s.toolCall.params });
          }
          if (s.text !== undefined) {
            yield {
              type: "assistant",
              message: { content: [{ type: "text", text: s.text }] },
            };
          }
          if (!s.noResult) {
            yield {
              type: "result",
              subtype: s.subtype ?? "success",
              result: s.resultText,
            };
          }
          // One script entry == one turn; pause until the next sendAndRead pull.
        }
      }
      const iter = gen();
      return {
        [Symbol.asyncIterator]: () => iter,
        interrupt: fakeOpts.interrupt ?? (async () => {}),
      } as unknown as ReturnType<SdkModule["query"]>;
    },
  };
  return { sdk, starts: () => startCount, queryOptions: () => startedOptions };
}

const fakeZod = {
  z: { string: () => ({}), any: () => ({}), record: () => ({}) },
};

function makeSession(
  scripts: TurnScript[],
  opts: {
    mode?: "text" | "route" | "envelope";
    restartAfterTurns?: number;
    turnTimeoutMs?: number;
    subprocessEnv?: Record<string, string | undefined>;
    interrupt?: () => Promise<void>;
  } = {}
) {
  const { sdk, starts, queryOptions } = makeFakeSdk(scripts, {
    interrupt: opts.interrupt,
  });
  const session = new ClaudeSdkSession({
    model: "test-model",
    systemPrompt: "test system",
    mode: opts.mode ?? "text",
    restartAfterTurns: opts.restartAfterTurns,
    turnTimeoutMs: opts.turnTimeoutMs,
    subprocessEnv: opts.subprocessEnv,
    sdkModule: sdk,
    zodModule: fakeZod,
  });
  return { session, starts, queryOptions };
}

describe("ClaudeSdkSession — TEXT mode", () => {
  it("defaults to the current Opus model when no model is configured", async () => {
    const { sdk, queryOptions } = makeFakeSdk([{ text: "hello world", subtype: "success" }]);
    const session = new ClaudeSdkSession({
      systemPrompt: "test system",
      sdkModule: sdk,
      zodModule: fakeZod,
    });

    expect(await session.send("hi")).toBe("hello world");
    expect(queryOptions()[0].model).toBe("claude-opus-4-8");
    await session.dispose();
  });

  it("returns streamed assistant text", async () => {
    const { session } = makeSession([{ text: "hello world", subtype: "success" }]);
    expect(await session.send("hi")).toBe("hello world");
    await session.dispose();
  });

  it("passes rotated account env to the Claude SDK query options only", async () => {
    const subprocessEnv = { PATH: "/bin", CLAUDE_CODE_OAUTH_TOKEN: "selected-token" };
    const { session, queryOptions } = makeSession([{ text: "hello world", subtype: "success" }], {
      subprocessEnv,
    });
    expect(await session.send("hi")).toBe("hello world");
    expect(queryOptions()[0].env).toBe(subprocessEnv);
    await session.dispose();
  });

  it("falls back to result.result only on a clean success turn", async () => {
    const { session } = makeSession([{ text: "", subtype: "success", resultText: "the answer" }]);
    expect(await session.send("hi")).toBe("the answer");
    await session.dispose();
  });

  it("THROWS (fails over) on error_max_turns with no streamed text — never returns the SDK meta string", async () => {
    const { session } = makeSession([
      { text: "", subtype: "error_max_turns", resultText: "Reached maximum turns" },
    ]);
    await expect(session.send("hi")).rejects.toThrow(/empty completion/);
    await session.dispose();
  });

  it("THROWS when the generator ends before a result (session died mid-turn)", async () => {
    const { session } = makeSession([{ text: "partial", noResult: true }]);
    await expect(session.send("hi")).rejects.toThrow(/session-ended|empty completion/);
    await session.dispose();
  });

  it("THROWS when the subscription-limit envelope is only in result.result", async () => {
    const { session } = makeSession([
      {
        text: "",
        subtype: "success",
        resultText: "You've hit your session limit · resets 9:30pm (UTC)",
      },
    ]);
    await expect(session.send("hi")).rejects.toThrow(/subscription rate limit reached/);
    await session.dispose();
  });

  it("throws a typed provider error instead of returning streamed API Error text", async () => {
    const { session } = makeSession([
      {
        text: "API Error: 529 Overloaded. This is a server-side issue, check https://status.claude.com.",
        subtype: "success",
      },
    ]);
    await expect(session.send("hi")).rejects.toMatchObject({
      name: "ProviderApiError",
      statusCode: 529,
      retryable: true,
    });
    await session.dispose();
  });

  it("bounds a hung SDK turn below connector timeouts", async () => {
    const { session } = makeSession([{ hang: true }], { turnTimeoutMs: 5 });
    const started = Date.now();
    await expect(session.send("hi")).rejects.toBeInstanceOf(ProviderApiError);
    expect(Date.now() - started).toBeLessThan(1_000);
    await session.dispose();
  });

  it("a wedged interrupt cannot swallow the turn-timeout rejection (#16553)", async () => {
    // The production incident shape: the turn hangs AND the CLI process never
    // ACKs the interrupt. The 90s timer used to fire into a catch that awaited
    // dispose() → interrupt() unboundedly, so the turn never rejected and the
    // whole inbound pipeline serialized behind it. The bounded teardown must
    // abandon the wedged interrupt and let the timeout surface.
    vi.useFakeTimers();
    try {
      const { session } = makeSession([{ hang: true }], {
        turnTimeoutMs: 5_000,
        interrupt: () => new Promise<void>(() => undefined), // never ACKs
      });
      const outcome = session.send("hi");
      const settled = expect(outcome).rejects.toBeInstanceOf(ProviderApiError);
      await vi.advanceTimersByTimeAsync(5_000); // turn timeout fires
      await vi.advanceTimersByTimeAsync(5_000); // dispose teardown budget expires
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });

  it("explicit turnTimeoutMs 0 opts out to an unbounded turn (#16553)", async () => {
    vi.useFakeTimers();
    try {
      // With a bounded budget this slow turn rejects…
      const bounded = makeSession([{ delayMs: 200, text: "late", subtype: "success" }], {
        turnTimeoutMs: 100,
      });
      const boundedOutcome = bounded.session.send("hi");
      const boundedSettled = expect(boundedOutcome).rejects.toBeInstanceOf(ProviderApiError);
      await vi.advanceTimersByTimeAsync(200);
      await boundedSettled;
      // …while the explicit 0 opt-out lets it finish.
      const unbounded = makeSession([{ delayMs: 200, text: "late", subtype: "success" }], {
        turnTimeoutMs: 0,
      });
      const unboundedOutcome = unbounded.session.send("hi");
      await vi.advanceTimersByTimeAsync(200);
      expect(await unboundedOutcome).toBe("late");
      await unbounded.session.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("self-heals: a throwing turn disposes, the next call re-starts the session", async () => {
    const { session, starts } = makeSession([
      { text: "", subtype: "error_max_turns" }, // turn 1 throws
      { text: "recovered", subtype: "success" }, // turn 2 ok (fresh start)
    ]);
    await expect(session.send("a")).rejects.toThrow();
    expect(await session.send("b")).toBe("recovered");
    expect(starts()).toBe(2); // re-started after the failure
    await session.dispose();
  });

  it("restarts the warm session after restartAfterTurns to bound context", async () => {
    const { session, starts } = makeSession(
      [
        { text: "one", subtype: "success" },
        { text: "two", subtype: "success" },
        { text: "three", subtype: "success" },
      ],
      { restartAfterTurns: 1 }
    );
    expect(await session.send("1")).toBe("one");
    expect(await session.send("2")).toBe("two");
    expect(starts()).toBeGreaterThanOrEqual(2); // restarted between turns
    await session.dispose();
  });

  it("rejects an empty prompt body", async () => {
    const { session } = makeSession([{ text: "x", subtype: "success" }]);
    await expect(session.send("   ")).rejects.toThrow(/empty prompt body/);
    await session.dispose();
  });
});

describe("ClaudeSdkSession — ROUTE mode", () => {
  it("captures the tool decision and returns it as bare {action,params} JSON", async () => {
    const { session } = makeSession(
      [{ toolCall: { action: "WEB_FETCH", params: { url: "u" } }, subtype: "error_max_turns" }],
      { mode: "route" }
    );
    const out = JSON.parse(await session.send("price?"));
    expect(out).toEqual({ action: "WEB_FETCH", params: { url: "u" } });
    await session.dispose();
  });

  it("the captured decision wins over any streamed text", async () => {
    const { session } = makeSession(
      [
        {
          toolCall: { action: "REPLY", params: { text: "real" } },
          text: "I'll route this...", // agentic preamble, must be ignored
          subtype: "error_max_turns",
        },
      ],
      { mode: "route" }
    );
    const out = JSON.parse(await session.send("hi"));
    expect(out.action).toBe("REPLY");
    expect(out.params.text).toBe("real");
    await session.dispose();
  });

  it("the captured decision wins over residual subscription-limit text", async () => {
    const { session } = makeSession(
      [
        {
          toolCall: { action: "WEB_FETCH", params: { url: "https://example.test" } },
          text: "You've hit your session limit · resets 9:30pm (UTC)",
          subtype: "error_max_turns",
        },
      ],
      { mode: "route" }
    );
    const out = JSON.parse(await session.send("price?"));
    expect(out).toEqual({
      action: "WEB_FETCH",
      params: { url: "https://example.test" },
    });
    await session.dispose();
  });

  it("does NOT surface an agentic preamble as a REPLY when the model skips the tool (error_max_turns)", async () => {
    const { session } = makeSession(
      [{ text: "I'll route this to WEB_FETCH...", subtype: "error_max_turns" }],
      { mode: "route" }
    );
    // No decision + non-success subtype => throw, never leak the thought.
    await expect(session.send("hi")).rejects.toThrow(/no decision/);
    await session.dispose();
  });

  it("accepts a genuine terminal answer (clean success, no tool) as a REPLY", async () => {
    const { session } = makeSession([{ text: "2 + 2 is 4.", subtype: "success" }], {
      mode: "route",
    });
    const out = JSON.parse(await session.send("2+2?"));
    expect(out).toEqual({ action: "REPLY", params: { text: "2 + 2 is 4." } });
    await session.dispose();
  });

  it("coerces malformed params to {} but keeps the action", async () => {
    const { session } = makeSession(
      [{ toolCall: { action: "IGNORE", params: "not-an-object" }, subtype: "error_max_turns" }],
      { mode: "route" }
    );
    const out = JSON.parse(await session.send("hi"));
    expect(out).toEqual({ action: "IGNORE", params: {} });
    await session.dispose();
  });
});

describe("ClaudeSdkSession — serialization", () => {
  it("serializes concurrent calls so decisions/text never interleave", async () => {
    // Two route turns scripted; fire both without awaiting between them.
    const { session } = makeSession(
      [
        { toolCall: { action: "A", params: {} }, subtype: "error_max_turns" },
        { toolCall: { action: "B", params: {} }, subtype: "error_max_turns" },
      ],
      { mode: "route" }
    );
    const [r1, r2] = await Promise.all([session.send("one"), session.send("two")]);
    const actions = [JSON.parse(r1).action, JSON.parse(r2).action].sort();
    expect(actions).toEqual(["A", "B"]); // both distinct, no cross-contamination
    await session.dispose();
  });
});

describe("start-path timeout (#16553)", () => {
  it("bounds a hung session start with the turn budget and fails retryable", async () => {
    const { session } = makeSession([{ text: "unused", subtype: "success" }], {
      turnTimeoutMs: 40,
    });
    // Simulate the unbounded startup await (SDK dynamic import / spawn
    // handshake hanging on a CLI version download): start never resolves.
    (session as unknown as { start: () => Promise<void> }).start = () =>
      new Promise<void>(() => {});
    const started = Date.now();
    await expect(session.send("hi")).rejects.toThrow(/session start timed out/);
    expect(Date.now() - started).toBeLessThan(2_000);
    // Self-healed: a follow-up dispose is safe and the session holds no query.
    await session.dispose();
  });

  it("tears down a start that resolves after dispose instead of resurrecting", async () => {
    const { session } = makeSession([{ text: "late", subtype: "success" }], {
      turnTimeoutMs: 30,
    });
    const inner = session as unknown as {
      start: (...args: unknown[]) => Promise<void>;
      query: unknown;
    };
    const realStart = inner.start.bind(session);
    let releaseStart: (() => void) | undefined;
    inner.start = async (...args: unknown[]) => {
      await new Promise<void>((res) => {
        releaseStart = res;
      });
      await realStart(...args);
    };
    const turn = session.send("hi");
    // The bounded start times out (30ms) and disposes, bumping the epoch.
    await expect(turn).rejects.toThrow(/session start timed out/);
    // Now let the stale start finish — it must tear itself down, not attach.
    releaseStart?.();
    await new Promise((res) => setTimeout(res, 20));
    expect(inner.query).toBeNull();
  });
});

describe("ClaudeSdkSession — surrogate-safe error envelopes", () => {
  // The SDK's leaked UI strings are truncated (120 / 160 code units) before they
  // become error messages. A raw `.slice()` that lands on the lead half of an
  // astral character leaves a lone surrogate, and a lone surrogate already in
  // the envelope is preserved verbatim; either makes the thrown message
  // ill-formed. The fixtures place a lone high surrogate early in the text and
  // an astral emoji exactly straddling the cut index.
  const LONE_HIGH_SURROGATE = "\uD83D";
  const EMOJI = "\u{1F600}"; // two UTF-16 code units

  /** Pad `prefix` with `x` so the next code unit sits at `index`, then append `tail`. */
  function buildEnvelope(prefix: string, index: number, tail: string): string {
    const body = `${prefix}${LONE_HIGH_SURROGATE} `;
    const padded = body + "x".repeat(index - body.length);
    expect(padded.length).toBe(index);
    return `${padded}${EMOJI}${tail}`;
  }

  function isWellFormed(value: string): boolean {
    return toWellFormedUnicode(value) === value;
  }

  it("subscription-limit envelope: cut at 120 never splits a pair and lone surrogates are sanitized", async () => {
    const envelope = buildEnvelope(
      "You've hit your session limit · resets 9:30pm (UTC)",
      119,
      " tail"
    );
    // Keep the fixture inside the detector's length guard (<= 160).
    expect(envelope.length).toBeLessThanOrEqual(160);
    expect(isWellFormed(envelope)).toBe(false);
    const { session } = makeSession([{ text: envelope, subtype: "success" }]);
    let message = "";
    await expect(
      session.send("hi").catch((error: unknown) => {
        message = (error as Error).message;
        throw error;
      })
    ).rejects.toThrow(/subscription rate limit reached/);
    await session.dispose();

    const prefix = "[cli-inference:sdk] subscription rate limit reached: ";
    expect(message.startsWith(prefix)).toBe(true);
    const truncated = message.slice(prefix.length);
    expect(isWellFormed(message)).toBe(true);
    expect(truncated.length).toBeLessThanOrEqual(120);
    // The emoji straddling index 119/120 is dropped whole rather than halved.
    expect(truncated.length).toBe(119);
    expect(truncated.endsWith("x")).toBe(true);
    expect(truncated).toContain("\uFFFD");
    expect(truncated).not.toContain(LONE_HIGH_SURROGATE);
  });

  it("upstream API error envelope: cut at 160 never splits a pair and lone surrogates are sanitized", async () => {
    const envelope = buildEnvelope("API Error: 529 Overloaded.", 159, " more detail");
    expect(isWellFormed(envelope)).toBe(false);
    const { session } = makeSession([{ text: envelope, subtype: "success" }]);
    let message = "";
    await expect(
      session.send("hi").catch((error: unknown) => {
        message = (error as Error).message;
        throw error;
      })
    ).rejects.toMatchObject({ name: "ProviderApiError", statusCode: 529 });
    await session.dispose();

    const prefix = "[cli-inference:sdk] upstream ";
    expect(message.startsWith(prefix)).toBe(true);
    const truncated = message.slice(prefix.length);
    expect(isWellFormed(message)).toBe(true);
    expect(truncated.length).toBeLessThanOrEqual(160);
    // The emoji straddling index 159/160 is dropped whole rather than halved.
    expect(truncated.length).toBe(159);
    expect(truncated.endsWith("x")).toBe(true);
    expect(truncated).toContain("\uFFFD");
    expect(truncated).not.toContain(LONE_HIGH_SURROGATE);
  });
});
