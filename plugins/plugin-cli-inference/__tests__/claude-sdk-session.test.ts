import { describe, expect, it } from "vitest";
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
function makeFakeSdk(scripts: TurnScript[]): {
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
        interrupt: async () => {},
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
    router?: boolean;
    restartAfterTurns?: number;
    turnTimeoutMs?: number;
    subprocessEnv?: Record<string, string | undefined>;
  } = {}
) {
  const { sdk, starts, queryOptions } = makeFakeSdk(scripts);
  const session = new ClaudeSdkSession({
    model: "test-model",
    systemPrompt: "test system",
    router: opts.router ?? false,
    restartAfterTurns: opts.restartAfterTurns,
    turnTimeoutMs: opts.turnTimeoutMs,
    subprocessEnv: opts.subprocessEnv,
    sdkModule: sdk,
    zodModule: fakeZod,
  });
  return { session, starts, queryOptions };
}

describe("ClaudeSdkSession — TEXT mode", () => {
  it("returns streamed assistant text", async () => {
    const { session } = makeSession([{ text: "hello world", subtype: "success" }]);
    expect(await session.generate("hi")).toBe("hello world");
    await session.dispose();
  });

  it("passes rotated account env to the Claude SDK query options only", async () => {
    const subprocessEnv = { PATH: "/bin", CLAUDE_CODE_OAUTH_TOKEN: "selected-token" };
    const { session, queryOptions } = makeSession([{ text: "hello world", subtype: "success" }], {
      subprocessEnv,
    });
    expect(await session.generate("hi")).toBe("hello world");
    expect(queryOptions()[0].env).toBe(subprocessEnv);
    await session.dispose();
  });

  it("falls back to result.result only on a clean success turn", async () => {
    const { session } = makeSession([{ text: "", subtype: "success", resultText: "the answer" }]);
    expect(await session.generate("hi")).toBe("the answer");
    await session.dispose();
  });

  it("THROWS (fails over) on error_max_turns with no streamed text — never returns the SDK meta string", async () => {
    const { session } = makeSession([
      { text: "", subtype: "error_max_turns", resultText: "Reached maximum turns" },
    ]);
    await expect(session.generate("hi")).rejects.toThrow(/empty completion/);
    await session.dispose();
  });

  it("THROWS when the generator ends before a result (session died mid-turn)", async () => {
    const { session } = makeSession([{ text: "partial", noResult: true }]);
    await expect(session.generate("hi")).rejects.toThrow(/session-ended|empty completion/);
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
    await expect(session.generate("hi")).rejects.toThrow(/subscription rate limit reached/);
    await session.dispose();
  });

  it("throws a typed provider error instead of returning streamed API Error text", async () => {
    const { session } = makeSession([
      {
        text: "API Error: 529 Overloaded. This is a server-side issue, check https://status.claude.com.",
        subtype: "success",
      },
    ]);
    await expect(session.generate("hi")).rejects.toMatchObject({
      name: "ProviderApiError",
      statusCode: 529,
      retryable: true,
    });
    await session.dispose();
  });

  it("bounds a hung SDK turn below connector timeouts", async () => {
    const { session } = makeSession([{ hang: true }], { turnTimeoutMs: 5 });
    const started = Date.now();
    await expect(session.generate("hi")).rejects.toBeInstanceOf(ProviderApiError);
    expect(Date.now() - started).toBeLessThan(1_000);
    await session.dispose();
  });

  it("self-heals: a throwing turn disposes, the next call re-starts the session", async () => {
    const { session, starts } = makeSession([
      { text: "", subtype: "error_max_turns" }, // turn 1 throws
      { text: "recovered", subtype: "success" }, // turn 2 ok (fresh start)
    ]);
    await expect(session.generate("a")).rejects.toThrow();
    expect(await session.generate("b")).toBe("recovered");
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
    expect(await session.generate("1")).toBe("one");
    expect(await session.generate("2")).toBe("two");
    expect(starts()).toBeGreaterThanOrEqual(2); // restarted between turns
    await session.dispose();
  });

  it("rejects an empty prompt body", async () => {
    const { session } = makeSession([{ text: "x", subtype: "success" }]);
    await expect(session.generate("   ")).rejects.toThrow(/empty prompt body/);
    await session.dispose();
  });
});

describe("ClaudeSdkSession — ROUTE mode", () => {
  it("captures the tool decision and returns it as bare {action,params} JSON", async () => {
    const { session } = makeSession(
      [{ toolCall: { action: "WEB_FETCH", params: { url: "u" } }, subtype: "error_max_turns" }],
      { router: true }
    );
    const out = JSON.parse(await session.route("price?"));
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
      { router: true }
    );
    const out = JSON.parse(await session.route("hi"));
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
      { router: true }
    );
    const out = JSON.parse(await session.route("price?"));
    expect(out).toEqual({
      action: "WEB_FETCH",
      params: { url: "https://example.test" },
    });
    await session.dispose();
  });

  it("does NOT surface an agentic preamble as a REPLY when the model skips the tool (error_max_turns)", async () => {
    const { session } = makeSession(
      [{ text: "I'll route this to WEB_FETCH...", subtype: "error_max_turns" }],
      { router: true }
    );
    // No decision + non-success subtype => throw, never leak the thought.
    await expect(session.route("hi")).rejects.toThrow(/no decision/);
    await session.dispose();
  });

  it("accepts a genuine terminal answer (clean success, no tool) as a REPLY", async () => {
    const { session } = makeSession([{ text: "2 + 2 is 4.", subtype: "success" }], {
      router: true,
    });
    const out = JSON.parse(await session.route("2+2?"));
    expect(out).toEqual({ action: "REPLY", params: { text: "2 + 2 is 4." } });
    await session.dispose();
  });

  it("coerces malformed params to {} but keeps the action", async () => {
    const { session } = makeSession(
      [{ toolCall: { action: "IGNORE", params: "not-an-object" }, subtype: "error_max_turns" }],
      { router: true }
    );
    const out = JSON.parse(await session.route("hi"));
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
      { router: true }
    );
    const [r1, r2] = await Promise.all([session.route("one"), session.route("two")]);
    const actions = [JSON.parse(r1).action, JSON.parse(r2).action].sort();
    expect(actions).toEqual(["A", "B"]); // both distinct, no cross-contamination
    await session.dispose();
  });
});
