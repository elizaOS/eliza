import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ACCOUNT_LIMIT_COOLOFF_MS,
  buildRotatedSubprocessEnv,
  type ChatAccountRotator,
  type ChatAccountSelection,
  createChatAccountRotator,
  isAccountLimitError,
  parseLimitResetMs,
} from "../src/chat-account-rotation";
import { ClaudeSdkSession, type SdkModule } from "../src/claude-sdk-session";
import { type CodexModule, CodexSdkSession } from "../src/codex-sdk-session";

/**
 * Gap A of elizaOS/eliza#11180: on a subscription-limit throw the warm SDK
 * sessions must rotate to the next healthy AccountPool account (via a mocked
 * multi-account bridge/rotator) BEFORE the throw reaches tier-failover — and
 * the subscription token must only ever flow into the SDK subprocess env,
 * never into the runtime's own process.env.
 */

const BRIDGE_SYMBOL = Symbol.for("eliza.account-pool.coding-agent.v1");

const LIMIT_TEXT = "You've hit your session limit · resets 9:30pm (UTC)";

function account(id: string, envPatch: Record<string, string>): ChatAccountSelection {
  return { providerId: "anthropic-subscription", accountId: id, label: id, envPatch };
}

/** Sequential mock rotator: hands out `accounts` in order, recording calls. */
function makeRotator(accounts: ChatAccountSelection[]) {
  const selectCalls: Array<string[] | undefined> = [];
  const limitedCalls: Array<{ accountId: string; detail: string }> = [];
  let i = 0;
  const rotator: ChatAccountRotator = {
    async select(exclude?: string[]) {
      selectCalls.push(exclude);
      const next = accounts[i] ?? null;
      if (next) i += 1;
      return next;
    },
    async markLimited(sel, detail) {
      limitedCalls.push({ accountId: sel.accountId, detail });
    },
  };
  return { rotator, selectCalls, limitedCalls };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("isAccountLimitError", () => {
  it("matches the session's own limit-classed throws and raw provider forms", () => {
    expect(
      isAccountLimitError(
        new Error(`[cli-inference:sdk] subscription rate limit reached: ${LIMIT_TEXT}`)
      )
    ).toBe(true);
    expect(isAccountLimitError(new Error(LIMIT_TEXT))).toBe(true);
    expect(isAccountLimitError(new Error("Claude AI usage limit reached|1893456000"))).toBe(true);
    expect(isAccountLimitError(new Error("API Error: 429 too many requests"))).toBe(true);
    expect(isAccountLimitError(new Error("You've hit your usage limit."))).toBe(true);
  });

  it("does NOT match ordinary session failures (no false-positive eviction)", () => {
    expect(isAccountLimitError(new Error("[cli-inference:sdk] empty completion (subtype=?)"))).toBe(
      false
    );
    expect(isAccountLimitError(new Error("[cli-inference:sdk] turn timed out after 90000ms"))).toBe(
      false
    );
    expect(
      isAccountLimitError(
        new Error("[cli-inference:sdk] route: model emitted no decision (subtype=?)")
      )
    ).toBe(false);
    expect(
      isAccountLimitError(
        new Error("API Error: 400 messages: text content blocks must be non-empty")
      )
    ).toBe(false);
    expect(isAccountLimitError(new Error("boom"))).toBe(false);
  });
});

describe("parseLimitResetMs", () => {
  const now = 1_700_000_000_000;

  it("parses the classic CLI epoch form (seconds and ms)", () => {
    expect(parseLimitResetMs("Claude AI usage limit reached|1893456000", now)).toBe(
      1_893_456_000_000
    );
    expect(parseLimitResetMs("Claude AI usage limit reached|1893456000000", now)).toBe(
      1_893_456_000_000
    );
  });

  it("falls back to the default cool-off for past epochs and unparseable text", () => {
    expect(parseLimitResetMs("Claude AI usage limit reached|1000000000", now)).toBe(
      now + ACCOUNT_LIMIT_COOLOFF_MS
    );
    expect(parseLimitResetMs(LIMIT_TEXT, now)).toBe(now + ACCOUNT_LIMIT_COOLOFF_MS);
  });
});

describe("buildRotatedSubprocessEnv", () => {
  const saved: Record<string, string | undefined> = {};
  const keys = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "CODEX_HOME", "OPENAI_API_KEY"];
  beforeEach(() => {
    for (const k of keys) {
      saved[k] = process.env[k];
      process.env[k] = `ambient-${k}`;
    }
  });
  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("spreads process.env, drops competing ambient auth vars, patch wins — and never mutates process.env", () => {
    const env = buildRotatedSubprocessEnv("claude", { CLAUDE_CODE_OAUTH_TOKEN: "token-1" });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("token-1");
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(env.PATH).toBe(process.env.PATH); // inherited vars survive
    expect(env.CODEX_HOME).toBe("ambient-CODEX_HOME"); // other agent's vars untouched
    // TOS invariant: the merge is pure.
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("ambient-CLAUDE_CODE_OAUTH_TOKEN");
    expect(process.env.ANTHROPIC_API_KEY).toBe("ambient-ANTHROPIC_API_KEY");

    const codexEnv = buildRotatedSubprocessEnv("codex", { CODEX_HOME: "/fake/home" });
    expect(codexEnv.CODEX_HOME).toBe("/fake/home");
    expect(codexEnv).not.toHaveProperty("OPENAI_API_KEY");
    expect(codexEnv.CLAUDE_CODE_OAUTH_TOKEN).toBe("ambient-CLAUDE_CODE_OAUTH_TOKEN");
    expect(process.env.CODEX_HOME).toBe("ambient-CODEX_HOME");
  });
});

describe("createChatAccountRotator (globalThis bridge reader)", () => {
  afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[BRIDGE_SYMBOL];
  });

  it("no-ops (null) when no bridge is installed", async () => {
    const rotator = createChatAccountRotator("claude", "key-1");
    expect(await rotator.select()).toBeNull();
    await rotator.markLimited(account("a", {}), "detail"); // must not throw
  });

  it("forwards agentType/sessionKey/exclude to bridge.select and untilMs to markRateLimited", async () => {
    const selectArgs: unknown[] = [];
    const limitArgs: unknown[] = [];
    (globalThis as Record<symbol, unknown>)[BRIDGE_SYMBOL] = {
      select: async (agentType: string, opts: unknown) => {
        selectArgs.push([agentType, opts]);
        return account("acc-1", { CLAUDE_CODE_OAUTH_TOKEN: "t1" });
      },
      markRateLimited: async (...args: unknown[]) => {
        limitArgs.push(args);
      },
    };
    const rotator = createChatAccountRotator("claude", "key-1");
    const picked = await rotator.select(["dead-account"]);
    expect(picked?.accountId).toBe("acc-1");
    expect(selectArgs[0]).toEqual(["claude", { sessionKey: "key-1", exclude: ["dead-account"] }]);

    await rotator.markLimited(
      picked as ChatAccountSelection,
      "Claude AI usage limit reached|1893456000"
    );
    const [providerId, accountId, untilMs, detail] = limitArgs[0] as [
      string,
      string,
      number,
      string,
    ];
    expect(providerId).toBe("anthropic-subscription");
    expect(accountId).toBe("acc-1");
    expect(untilMs).toBe(1_893_456_000_000);
    expect(detail).toContain("usage limit reached");
  });

  it("returns null on a throwing or empty-envPatch bridge (never throws into the inference path)", async () => {
    (globalThis as Record<symbol, unknown>)[BRIDGE_SYMBOL] = {
      select: async () => {
        throw new Error("pool exploded");
      },
      markRateLimited: async () => {
        throw new Error("pool exploded");
      },
    };
    const rotator = createChatAccountRotator("codex", "key-2");
    expect(await rotator.select()).toBeNull();
    await rotator.markLimited(account("a", {}), "detail"); // swallowed

    (globalThis as Record<symbol, unknown>)[BRIDGE_SYMBOL] = {
      select: async () => account("acc-empty", {}),
      markRateLimited: async () => {},
    };
    expect(await createChatAccountRotator("claude", "key-3").select()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ClaudeSdkSession rotation (fake SDK + mock rotator)
// ---------------------------------------------------------------------------

interface TurnScript {
  toolCall?: { action: unknown; params?: unknown };
  text?: string;
  subtype?: string;
  noResult?: boolean;
}

type ToolHandler = (args: {
  action?: unknown;
  params?: unknown;
}) => Promise<{ content: Array<{ type: string; text: string }> }>;

/** Fake SdkModule replaying `scripts` turn-by-turn, capturing options per start. */
function makeFakeSdk(scripts: TurnScript[]): {
  sdk: SdkModule;
  starts: () => number;
  optionsPerStart: Array<Record<string, unknown>>;
} {
  let startCount = 0;
  let turn = 0;
  const optionsPerStart: Array<Record<string, unknown>> = [];
  const sdk: SdkModule = {
    tool: (_name, _desc, _schema, handler) => ({ handler }) as unknown,
    createSdkMcpServer: (opts) => ({ tools: opts.tools }) as unknown,
    query: ({ options }) => {
      startCount += 1;
      optionsPerStart.push(options);
      const servers = options.mcpServers as
        | { eliza?: { tools?: Array<{ handler: ToolHandler }> } }
        | undefined;
      const handler = servers?.eliza?.tools?.[0]?.handler;
      async function* gen() {
        while (turn < scripts.length) {
          const s = scripts[turn++];
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
            yield { type: "result", subtype: s.subtype ?? "success", result: undefined };
          }
        }
      }
      const iter = gen();
      return {
        [Symbol.asyncIterator]: () => iter,
        interrupt: async () => {},
      } as unknown as ReturnType<SdkModule["query"]>;
    },
  };
  return { sdk, starts: () => startCount, optionsPerStart };
}

const fakeZod = { z: { string: () => ({}), any: () => ({}), record: () => ({}) } };

function makeClaudeSession(
  scripts: TurnScript[],
  rotator: ChatAccountRotator | null,
  opts: { router?: boolean; restartAfterTurns?: number } = {}
) {
  const fake = makeFakeSdk(scripts);
  const session = new ClaudeSdkSession({
    model: "test-model",
    systemPrompt: "test system",
    router: opts.router ?? false,
    restartAfterTurns: opts.restartAfterTurns,
    sdkModule: fake.sdk,
    zodModule: fakeZod,
    accountRotator: rotator,
  });
  return { session, ...fake };
}

describe("ClaudeSdkSession — rotate-on-limit (Gap A #11180)", () => {
  const savedToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const savedKey = process.env.ANTHROPIC_API_KEY;
  beforeEach(() => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
  });
  afterEach(() => {
    if (savedToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = savedToken;
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
  });

  it("marks the limited account, rotates to the next healthy one, and retries ONCE — token stays out of process.env", async () => {
    const { rotator, selectCalls, limitedCalls } = makeRotator([
      account("acc-1", { CLAUDE_CODE_OAUTH_TOKEN: "token-1" }),
      account("acc-2", { CLAUDE_CODE_OAUTH_TOKEN: "token-2" }),
    ]);
    const { session, starts, optionsPerStart } = makeClaudeSession(
      [
        { text: LIMIT_TEXT, subtype: "success" }, // acc-1's turn hits the limit
        { text: "recovered", subtype: "success" }, // acc-2's retry succeeds
      ],
      rotator
    );

    expect(await session.generate("hi")).toBe("recovered");
    expect(starts()).toBe(2);
    // Initial selection + the exclude-the-limited-account re-pick. No third pick.
    expect(selectCalls).toEqual([undefined, ["acc-1"]]);
    expect(limitedCalls).toHaveLength(1);
    expect(limitedCalls[0]?.accountId).toBe("acc-1");
    expect(limitedCalls[0]?.detail).toMatch(/rate limit/i);
    // Each warm process authenticated AS its account, in the SUBPROCESS env only.
    const env1 = optionsPerStart[0]?.env as Record<string, string | undefined>;
    const env2 = optionsPerStart[1]?.env as Record<string, string | undefined>;
    expect(env1?.CLAUDE_CODE_OAUTH_TOKEN).toBe("token-1");
    expect(env2?.CLAUDE_CODE_OAUTH_TOKEN).toBe("token-2");
    expect(env1?.PATH).toBe(process.env.PATH);
    // TOS invariant: the runtime's own env never saw either token.
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
    await session.dispose();
  });

  it("falls to tier-failover ONLY when the pool has no other healthy account", async () => {
    const { rotator, selectCalls, limitedCalls } = makeRotator([
      account("acc-1", { CLAUDE_CODE_OAUTH_TOKEN: "token-1" }),
      // no second account: the exclude re-pick returns null (all limited)
    ]);
    const { session, starts } = makeClaudeSession(
      [{ text: LIMIT_TEXT, subtype: "success" }],
      rotator
    );

    await expect(session.generate("hi")).rejects.toThrow(/subscription rate limit reached/);
    expect(starts()).toBe(1); // no retry without a replacement account
    expect(selectCalls).toEqual([undefined, ["acc-1"]]);
    expect(limitedCalls.map((c) => c.accountId)).toEqual(["acc-1"]); // limit recorded before failover
    await session.dispose();
  });

  it("records the replacement account's limit too when the single retry also limits (no rotation loop)", async () => {
    const { rotator, selectCalls, limitedCalls } = makeRotator([
      account("acc-1", { CLAUDE_CODE_OAUTH_TOKEN: "token-1" }),
      account("acc-2", { CLAUDE_CODE_OAUTH_TOKEN: "token-2" }),
      account("acc-3", { CLAUDE_CODE_OAUTH_TOKEN: "token-3" }), // must never be reached
    ]);
    const { session, starts } = makeClaudeSession(
      [
        { text: LIMIT_TEXT, subtype: "success" },
        { text: LIMIT_TEXT, subtype: "success" },
      ],
      rotator
    );

    await expect(session.generate("hi")).rejects.toThrow(/subscription rate limit reached/);
    expect(starts()).toBe(2); // exactly one rotation retry
    expect(selectCalls).toHaveLength(2); // acc-3 never selected
    expect(limitedCalls.map((c) => c.accountId)).toEqual(["acc-1", "acc-2"]);
    await session.dispose();
  });

  it("does NOT rotate on a non-limit failure", async () => {
    const { rotator, selectCalls, limitedCalls } = makeRotator([
      account("acc-1", { CLAUDE_CODE_OAUTH_TOKEN: "token-1" }),
      account("acc-2", { CLAUDE_CODE_OAUTH_TOKEN: "token-2" }),
    ]);
    const { session } = makeClaudeSession([{ text: "partial", noResult: true }], rotator);

    await expect(session.generate("hi")).rejects.toThrow(/session-ended|empty completion/);
    expect(selectCalls).toEqual([undefined]); // only the start-time selection
    expect(limitedCalls).toHaveLength(0);
    await session.dispose();
  });

  it("keeps the pre-pool behavior when rotation is disabled (no env injection, straight throw)", async () => {
    const { session, optionsPerStart } = makeClaudeSession(
      [{ text: LIMIT_TEXT, subtype: "success" }],
      null
    );
    await expect(session.generate("hi")).rejects.toThrow(/subscription rate limit reached/);
    expect(optionsPerStart[0]?.env).toBeUndefined(); // ambient ~/.claude creds
    await session.dispose();
  });

  it("re-selects on every scheduled restart so a fresh token is injected", async () => {
    const { rotator, selectCalls } = makeRotator([
      account("acc-1", { CLAUDE_CODE_OAUTH_TOKEN: "token-a" }),
      account("acc-1", { CLAUDE_CODE_OAUTH_TOKEN: "token-b" }), // same account, fresh token
    ]);
    const { session, optionsPerStart } = makeClaudeSession(
      [
        { text: "one", subtype: "success" },
        { text: "two", subtype: "success" },
      ],
      rotator,
      { restartAfterTurns: 1 }
    );
    expect(await session.generate("1")).toBe("one");
    expect(await session.generate("2")).toBe("two");
    expect(selectCalls).toEqual([undefined, undefined]);
    expect((optionsPerStart[1]?.env as Record<string, string>)?.CLAUDE_CODE_OAUTH_TOKEN).toBe(
      "token-b"
    );
    await session.dispose();
  });

  it("rotates in ROUTE mode too and the retried turn's decision is returned", async () => {
    const { rotator, limitedCalls } = makeRotator([
      account("acc-1", { CLAUDE_CODE_OAUTH_TOKEN: "token-1" }),
      account("acc-2", { CLAUDE_CODE_OAUTH_TOKEN: "token-2" }),
    ]);
    const { session } = makeClaudeSession(
      [
        { text: LIMIT_TEXT, subtype: "error_max_turns" }, // no decision + limit envelope
        { toolCall: { action: "WEB_FETCH", params: { url: "u" } }, subtype: "error_max_turns" },
      ],
      rotator,
      { router: true }
    );
    const out = JSON.parse(await session.route("price?"));
    expect(out).toEqual({ action: "WEB_FETCH", params: { url: "u" } });
    expect(limitedCalls.map((c) => c.accountId)).toEqual(["acc-1"]);
    await session.dispose();
  });
});

// ---------------------------------------------------------------------------
// CodexSdkSession rotation (fake Codex + mock rotator)
// ---------------------------------------------------------------------------

interface CodexTurnScript {
  finalResponse?: string;
  throws?: string;
}

function makeFakeCodex(scripts: CodexTurnScript[]): {
  codexModule: CodexModule;
  starts: () => number;
  ctorOptions: Array<Record<string, unknown>>;
} {
  let startCount = 0;
  let turn = 0;
  const ctorOptions: Array<Record<string, unknown>> = [];
  const codexModule = {
    Codex: class {
      constructor(options?: Record<string, unknown>) {
        ctorOptions.push(options ?? {});
      }
      startThread() {
        startCount += 1;
        return {
          run: async () => {
            const s = scripts[turn++] ?? {};
            if (s.throws) throw new Error(s.throws);
            return { items: [], finalResponse: s.finalResponse, usage: null };
          },
        };
      }
    },
  } as unknown as CodexModule;
  return { codexModule, starts: () => startCount, ctorOptions };
}

function makeCodexSession(scripts: CodexTurnScript[], rotator: ChatAccountRotator | null) {
  const fake = makeFakeCodex(scripts);
  const session = new CodexSdkSession({
    model: "gpt-test",
    codexModule: fake.codexModule,
    accountRotator: rotator,
  });
  return { session, ...fake };
}

function codexAccount(id: string, home: string): ChatAccountSelection {
  return { providerId: "openai-codex", accountId: id, label: id, envPatch: { CODEX_HOME: home } };
}

describe("CodexSdkSession — rotate-on-limit (Gap A #11180)", () => {
  const savedHome = process.env.CODEX_HOME;
  beforeEach(() => {
    delete process.env.CODEX_HOME;
  });
  afterEach(() => {
    if (savedHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = savedHome;
  });

  it("swaps the per-account CODEX_HOME and retries once — CODEX_HOME stays out of process.env", async () => {
    const { rotator, selectCalls, limitedCalls } = makeRotator([
      codexAccount("acc-1", "/fake/codex-home/acc-1"),
      codexAccount("acc-2", "/fake/codex-home/acc-2"),
    ]);
    const { session, starts, ctorOptions } = makeCodexSession(
      [{ throws: "You've hit your usage limit. Try again later." }, { finalResponse: "recovered" }],
      rotator
    );

    expect(await session.generate("hi")).toBe("recovered");
    expect(starts()).toBe(2);
    expect(selectCalls).toEqual([undefined, ["acc-1"]]);
    expect(limitedCalls.map((c) => c.accountId)).toEqual(["acc-1"]);
    const env1 = ctorOptions[0]?.env as Record<string, string | undefined>;
    const env2 = ctorOptions[1]?.env as Record<string, string | undefined>;
    expect(env1?.CODEX_HOME).toBe("/fake/codex-home/acc-1");
    expect(env2?.CODEX_HOME).toBe("/fake/codex-home/acc-2");
    expect(env1?.PATH).toBe(process.env.PATH); // codex env REPLACES; PATH must survive
    expect(process.env.CODEX_HOME).toBeUndefined(); // TOS invariant
    session.dispose();
  });

  it("falls to tier-failover only when the pool is exhausted, recording the limit first", async () => {
    const { rotator, selectCalls, limitedCalls } = makeRotator([codexAccount("acc-1", "/fake/a")]);
    const { session, starts } = makeCodexSession(
      [{ throws: "quota exceeded for this billing cycle" }],
      rotator
    );

    await expect(session.generate("hi")).rejects.toThrow(/quota exceeded/);
    expect(starts()).toBe(1);
    expect(selectCalls).toEqual([undefined, ["acc-1"]]);
    expect(limitedCalls.map((c) => c.accountId)).toEqual(["acc-1"]);
    session.dispose();
  });

  it("does NOT rotate on a non-limit failure", async () => {
    const { rotator, selectCalls, limitedCalls } = makeRotator([
      codexAccount("acc-1", "/fake/a"),
      codexAccount("acc-2", "/fake/b"),
    ]);
    const { session } = makeCodexSession([{ throws: "boom" }], rotator);

    await expect(session.generate("hi")).rejects.toThrow(/boom/);
    expect(selectCalls).toEqual([undefined]);
    expect(limitedCalls).toHaveLength(0);
    session.dispose();
  });

  it("keeps the pre-pool behavior when rotation is disabled (no env option at all)", async () => {
    const { session, ctorOptions } = makeCodexSession([{ finalResponse: "ok" }], null);
    expect(await session.generate("hi")).toBe("ok");
    expect(ctorOptions[0]?.env).toBeUndefined(); // ambient ~/.codex creds
    session.dispose();
  });
});
