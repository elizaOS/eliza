/**
 * Behavioral coverage for the assembled Eliza config schema and the
 * standalone CharacterSchema exported from this module. Drives the real
 * validators: empty/single/overflow queues, strict vs passthrough objects,
 * enum and numeric bounds, and the broadcast superRefine that rejects
 * agent ids missing from agents.list. Deterministic, no live services.
 */
import { describe, expect, it } from "vitest";
import { CharacterSchema, ElizaSchema } from "./zod-schema.ts";

type ParseResult = {
  success: boolean;
  data?: unknown;
  error?: { issues: Array<{ message: string; path: PropertyKey[] }> };
};

type Parsable = {
  safeParse: (value: unknown) => ParseResult;
};

function expectOk(schema: Parsable, value: unknown) {
  const result = schema.safeParse(value);
  expect(result.success).toBe(true);
}

function expectRoundTrip(schema: Parsable, value: unknown) {
  const result = schema.safeParse(value);
  expect(result.success).toBe(true);
  if (result.success) expect(result.data).toEqual(value);
}

function expectFail(schema: Parsable, value: unknown) {
  expect(schema.safeParse(value).success).toBe(false);
}

function issueMessages(schema: Parsable, value: unknown): string[] {
  const result = schema.safeParse(value);
  expect(result.success).toBe(false);
  if (result.success) return [];
  return (result.error?.issues ?? []).map((issue) => issue.message);
}

function issuePaths(schema: Parsable, value: unknown): PropertyKey[][] {
  const result = schema.safeParse(value);
  expect(result.success).toBe(false);
  if (result.success) return [];
  return (result.error?.issues ?? []).map((issue) => issue.path);
}

const AGENT = { id: "alpha" };
const AGENT_B = { id: "beta" };

describe("CharacterSchema", () => {
  it("accepts an empty object because every field is optional", () => {
    expectRoundTrip(CharacterSchema, {});
  });

  it("round-trips a fully populated valid character", () => {
    const character = {
      name: "Ada",
      username: "ada",
      bio: ["mathematician"],
      system: "Be precise.",
      adjectives: ["curious"],
      topics: ["math"],
      style: { all: ["terse"], chat: ["warm"], post: ["witty"] },
      messageExamples: [
        {
          examples: [
            {
              name: "Ada",
              content: { text: "hello", actions: ["REPLY"] },
            },
          ],
        },
      ],
      postExamples: ["A note on analysis."],
    };
    expectRoundTrip(CharacterSchema, character);
  });

  it("rejects a non-object root", () => {
    expectFail(CharacterSchema, null);
    expectFail(CharacterSchema, undefined);
    expectFail(CharacterSchema, "Ada");
    expectFail(CharacterSchema, 1);
    expectFail(CharacterSchema, []);
  });

  it("rejects unknown top-level keys (strict)", () => {
    expectFail(CharacterSchema, { extra: true });
    expectFail(CharacterSchema, { name: "Ada", plugins: [] });
  });
});

describe("CharacterSchema name and username", () => {
  it("accepts in-range names and the documented empty username clear form", () => {
    expectRoundTrip(CharacterSchema, { name: "Ada" });
    expectRoundTrip(CharacterSchema, { name: "a".repeat(100) });
    expectRoundTrip(CharacterSchema, { username: "" });
    expectRoundTrip(CharacterSchema, { username: "a".repeat(50) });
  });

  it("rejects empty/overflow name and overflow username", () => {
    expectFail(CharacterSchema, { name: "" });
    expectFail(CharacterSchema, { name: "a".repeat(101) });
    expectFail(CharacterSchema, { name: 1 });
    expectFail(CharacterSchema, { username: "a".repeat(51) });
    expectFail(CharacterSchema, { username: 1 });
  });
});

describe("CharacterSchema bio, system, adjectives, and topics", () => {
  it("accepts string or array bio, empty queues, and max-length items", () => {
    expectRoundTrip(CharacterSchema, { bio: "mathematician" });
    expectRoundTrip(CharacterSchema, { bio: "" });
    expectRoundTrip(CharacterSchema, { bio: [] });
    expectRoundTrip(CharacterSchema, { bio: ["one", "two"] });
    expectRoundTrip(CharacterSchema, { system: "" });
    expectRoundTrip(CharacterSchema, { system: "a".repeat(10000) });
    expectRoundTrip(CharacterSchema, { adjectives: [] });
    expectRoundTrip(CharacterSchema, { topics: ["math"] });
    expectRoundTrip(CharacterSchema, { adjectives: ["a".repeat(100)] });
  });

  it("rejects overflow, empty items, and non-string elements", () => {
    expectFail(CharacterSchema, { bio: 1 });
    expectFail(CharacterSchema, { bio: [1] });
    expectFail(CharacterSchema, { system: "a".repeat(10001) });
    expectFail(CharacterSchema, { system: ["prompt"] });
    expectFail(CharacterSchema, { adjectives: [""] });
    expectFail(CharacterSchema, { topics: ["a".repeat(101)] });
    expectFail(CharacterSchema, { adjectives: [1] });
  });
});

describe("CharacterSchema style and examples", () => {
  it("accepts empty style, empty postExamples, and a single example group", () => {
    expectRoundTrip(CharacterSchema, { style: {} });
    expectRoundTrip(CharacterSchema, {
      style: { all: [], chat: [], post: [] },
    });
    expectRoundTrip(CharacterSchema, { postExamples: [] });
    expectRoundTrip(CharacterSchema, { postExamples: ["A note.", ""] });
    expectRoundTrip(CharacterSchema, {
      messageExamples: [
        { examples: [{ name: "Ada", content: { text: "hello" } }] },
      ],
    });
    expectRoundTrip(CharacterSchema, { messageExamples: [] });
  });

  it("rejects empty example groups, empty name/text, extra keys, and non-arrays", () => {
    expectFail(CharacterSchema, { style: { extra: [] } });
    expectFail(CharacterSchema, { style: null });
    expectFail(CharacterSchema, { messageExamples: [{ examples: [] }] });
    expectFail(CharacterSchema, { messageExamples: [{}] });
    expectFail(CharacterSchema, {
      messageExamples: [
        { examples: [{ name: "", content: { text: "hello" } }] },
      ],
    });
    expectFail(CharacterSchema, {
      messageExamples: [{ examples: [{ name: "Ada", content: { text: "" } }] }],
    });
    expectFail(CharacterSchema, {
      messageExamples: [
        {
          examples: [{ name: "Ada", content: { text: "hello", extra: true } }],
        },
      ],
    });
    expectFail(CharacterSchema, { postExamples: "A note." });
    expectFail(CharacterSchema, { postExamples: [1] });
  });
});

describe("ElizaSchema root", () => {
  it("accepts an empty object because every top-level field is optional", () => {
    expectOk(ElizaSchema, {});
  });

  it("applies CommandsSchema defaults when commands is omitted", () => {
    const result = ElizaSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.commands).toEqual({
        native: "auto",
        nativeSkills: "auto",
      });
    }
  });

  it("rejects a non-object root", () => {
    expectFail(ElizaSchema, null);
    expectFail(ElizaSchema, undefined);
    expectFail(ElizaSchema, "config");
    expectFail(ElizaSchema, 1);
    expectFail(ElizaSchema, []);
  });

  it("rejects unknown top-level keys (strict)", () => {
    expectFail(ElizaSchema, { extra: true });
    expectFail(ElizaSchema, { agents: {}, notAField: 1 });
  });
});

describe("ElizaSchema agents", () => {
  it("accepts omission, an empty object, and empty or single-element lists", () => {
    expectOk(ElizaSchema, { agents: {} });
    expectOk(ElizaSchema, { agents: { list: [] } });
    expectOk(ElizaSchema, { agents: { list: [AGENT] } });
    expectOk(ElizaSchema, { agents: { list: [AGENT, AGENT_B] } });
    expectOk(ElizaSchema, { agents: { defaults: {} } });
  });

  it("rejects a missing id, extra agent keys, and extra agents-object keys", () => {
    expectFail(ElizaSchema, { agents: { list: [{}] } });
    expectFail(ElizaSchema, {
      agents: { list: [{ id: "alpha", extra: true }] },
    });
    expectFail(ElizaSchema, { agents: { extra: true } });
    expectFail(ElizaSchema, { agents: { list: "alpha" } });
  });
});

describe("ElizaSchema broadcast superRefine", () => {
  it("skips cross-check when agents.list is missing or empty", () => {
    expectOk(ElizaSchema, { broadcast: { telegram: ["ghost"] } });
    expectOk(ElizaSchema, {
      agents: { list: [] },
      broadcast: { telegram: ["ghost"] },
    });
  });

  it("skips cross-check when broadcast is omitted, even with a declared agent", () => {
    expectOk(ElizaSchema, { agents: { list: [AGENT] } });
  });

  it("accepts an empty broadcast object and a strategy-only object", () => {
    expectOk(ElizaSchema, {
      agents: { list: [AGENT] },
      broadcast: {},
    });
    expectOk(ElizaSchema, {
      agents: { list: [AGENT] },
      broadcast: { strategy: "parallel" },
    });
    expectOk(ElizaSchema, {
      agents: { list: [AGENT] },
      broadcast: { strategy: "sequential" },
    });
  });

  it("accepts an empty peer queue and a single known agent id", () => {
    expectOk(ElizaSchema, {
      agents: { list: [AGENT] },
      broadcast: { telegram: [] },
    });
    expectOk(ElizaSchema, {
      agents: { list: [AGENT] },
      broadcast: { telegram: ["alpha"] },
    });
  });

  it("accepts multiple known ids across peers and ignores strategy during the walk", () => {
    expectOk(ElizaSchema, {
      agents: { list: [AGENT, AGENT_B] },
      broadcast: {
        strategy: "parallel",
        telegram: ["alpha", "beta"],
        discord: ["beta"],
      },
    });
  });

  it("rejects an unknown agent id with the documented message and path", () => {
    const value = {
      agents: { list: [AGENT] },
      broadcast: { telegram: ["ghost"] },
    };
    expect(issueMessages(ElizaSchema, value)).toContain(
      'Unknown agent id "ghost" (not in agents.list).',
    );
    expect(issuePaths(ElizaSchema, value)).toContainEqual([
      "broadcast",
      "telegram",
      0,
    ]);
  });

  it("reports every unknown id in a mixed queue, including later indexes", () => {
    const value = {
      agents: { list: [AGENT] },
      broadcast: { telegram: ["alpha", "ghost", "spectre"] },
    };
    const messages = issueMessages(ElizaSchema, value);
    expect(messages).toContain(
      'Unknown agent id "ghost" (not in agents.list).',
    );
    expect(messages).toContain(
      'Unknown agent id "spectre" (not in agents.list).',
    );
    expect(messages).not.toContain(
      'Unknown agent id "alpha" (not in agents.list).',
    );
    expect(issuePaths(ElizaSchema, value)).toEqual([
      ["broadcast", "telegram", 1],
      ["broadcast", "telegram", 2],
    ]);
  });

  it("rejects a non-enum strategy and a non-array catchall value", () => {
    expectFail(ElizaSchema, { broadcast: { strategy: "round-robin" } });
    expectFail(ElizaSchema, { broadcast: { telegram: "alpha" } });
    expectFail(ElizaSchema, { broadcast: { telegram: [1] } });
  });
});

describe("ElizaSchema bindings", () => {
  it("accepts an empty queue and a single binding with required channel", () => {
    expectOk(ElizaSchema, { bindings: [] });
    expectOk(ElizaSchema, {
      bindings: [{ agentId: "alpha", match: { channel: "telegram" } }],
    });
  });

  it("accepts optional peer kinds, accountId, guildId, and teamId", () => {
    expectOk(ElizaSchema, {
      bindings: [
        {
          agentId: "alpha",
          match: {
            channel: "discord",
            accountId: "acct-1",
            peer: { kind: "dm", id: "u1" },
            guildId: "g1",
            teamId: "t1",
          },
        },
        {
          agentId: "beta",
          match: {
            channel: "slack",
            peer: { kind: "group", id: "g" },
          },
        },
        {
          agentId: "gamma",
          match: {
            channel: "telegram",
            peer: { kind: "channel", id: "c" },
          },
        },
      ],
    });
  });

  it("rejects a missing agentId/channel, invalid peer kind, and extra keys", () => {
    expectFail(ElizaSchema, {
      bindings: [{ match: { channel: "telegram" } }],
    });
    expectFail(ElizaSchema, { bindings: [{ agentId: "alpha", match: {} }] });
    expectFail(ElizaSchema, {
      bindings: [
        {
          agentId: "alpha",
          match: { channel: "telegram", peer: { kind: "thread", id: "x" } },
        },
      ],
    });
    expectFail(ElizaSchema, {
      bindings: [
        {
          agentId: "alpha",
          match: { channel: "telegram" },
          extra: true,
        },
      ],
    });
    expectFail(ElizaSchema, {
      bindings: [
        {
          agentId: "alpha",
          match: { channel: "telegram", extra: true },
        },
      ],
    });
  });
});

describe("ElizaSchema approvals", () => {
  it("accepts exec forwarding modes and a fully populated target", () => {
    expectOk(ElizaSchema, { approvals: {} });
    expectOk(ElizaSchema, { approvals: { exec: {} } });
    expectOk(ElizaSchema, {
      approvals: {
        exec: {
          enabled: true,
          mode: "both",
          agentFilter: [],
          sessionFilter: ["s1"],
          targets: [
            {
              channel: "telegram",
              to: "owner",
              accountId: "acct",
              threadId: 12,
            },
            { channel: "discord", to: "ops", threadId: "thread-1" },
          ],
        },
      },
    });
    expectOk(ElizaSchema, { approvals: { exec: { mode: "session" } } });
    expectOk(ElizaSchema, { approvals: { exec: { mode: "targets" } } });
  });

  it("rejects invalid mode, empty channel/to, extra keys, and non-int thread-only types", () => {
    expectFail(ElizaSchema, { approvals: { exec: { mode: "all" } } });
    expectFail(ElizaSchema, {
      approvals: { exec: { targets: [{ channel: "", to: "x" }] } },
    });
    expectFail(ElizaSchema, {
      approvals: { exec: { targets: [{ channel: "telegram", to: "" }] } },
    });
    expectFail(ElizaSchema, {
      approvals: {
        exec: { targets: [{ channel: "telegram", to: "x", extra: true }] },
      },
    });
    expectFail(ElizaSchema, { approvals: { extra: true } });
  });
});

describe("ElizaSchema connectors and streaming passthrough", () => {
  it("accepts empty connectors/streaming and unknown extension keys", () => {
    expectOk(ElizaSchema, { connectors: {} });
    expectOk(ElizaSchema, { connectors: { nostr: { enabled: true } } });
    expectOk(ElizaSchema, { streaming: {} });
    expectOk(ElizaSchema, {
      streaming: { activeDestination: "twitch", matrix: { room: "x" } },
    });
  });

  it("accepts connector defaults and rejects extra keys on the strict defaults object", () => {
    expectOk(ElizaSchema, { connectors: { defaults: {} } });
    expectOk(ElizaSchema, {
      connectors: { defaults: { heartbeat: { showOk: true } } },
    });
    expectFail(ElizaSchema, {
      connectors: { defaults: { extra: true } },
    });
  });
});

describe("ElizaSchema memory", () => {
  it("accepts builtin/qmd backends, citation modes, and a populated qmd block", () => {
    expectOk(ElizaSchema, { memory: {} });
    expectOk(ElizaSchema, {
      memory: { backend: "builtin", citations: "auto" },
    });
    expectOk(ElizaSchema, { memory: { backend: "qmd", citations: "off" } });
    expectOk(ElizaSchema, {
      memory: {
        backend: "qmd",
        citations: "on",
        qmd: {
          command: "qmd",
          includeDefaultMemory: true,
          paths: [{ path: "/notes", name: "notes", pattern: "*.md" }],
          sessions: {
            enabled: true,
            exportDir: "/export",
            retentionDays: 0,
          },
          update: {
            interval: "1h",
            debounceMs: 0,
            onBoot: true,
            embedInterval: "1d",
          },
          limits: {
            maxResults: 1,
            maxSnippetChars: 1,
            maxInjectedChars: 1,
            timeoutMs: 0,
          },
        },
      },
    });
  });

  it("rejects invalid enums, missing path, negative/non-int limits, and extra keys", () => {
    expectFail(ElizaSchema, { memory: { backend: "redis" } });
    expectFail(ElizaSchema, { memory: { citations: "maybe" } });
    expectFail(ElizaSchema, { memory: { qmd: { paths: [{}] } } });
    expectFail(ElizaSchema, {
      memory: { qmd: { sessions: { retentionDays: -1 } } },
    });
    expectFail(ElizaSchema, {
      memory: { qmd: { sessions: { retentionDays: 1.5 } } },
    });
    expectFail(ElizaSchema, {
      memory: { qmd: { limits: { maxResults: 0 } } },
    });
    expectFail(ElizaSchema, {
      memory: { qmd: { limits: { timeoutMs: -1 } } },
    });
    expectFail(ElizaSchema, { memory: { extra: true } });
    expectFail(ElizaSchema, { memory: { qmd: { extra: true } } });
  });
});

describe("ElizaSchema env catchall and meta", () => {
  it("accepts shellEnv, vars, and extra string env keys", () => {
    expectOk(ElizaSchema, {
      env: {
        shellEnv: { enabled: true, timeoutMs: 0 },
        vars: { FOO: "bar" },
        OPENAI_API_KEY: "sk",
      },
    });
    expectOk(ElizaSchema, { meta: {} });
    expectOk(ElizaSchema, {
      meta: {
        firstRunComplete: true,
        lastTouchedVersion: "1.0.0",
        lastTouchedAt: "2026-01-01",
      },
    });
  });

  it("rejects non-string catchall env values, negative timeout, and extra meta keys", () => {
    expectFail(ElizaSchema, { env: { OPENAI_API_KEY: 1 } });
    expectFail(ElizaSchema, { env: { shellEnv: { timeoutMs: -1 } } });
    expectFail(ElizaSchema, { env: { shellEnv: { extra: true } } });
    expectFail(ElizaSchema, { meta: { extra: true } });
  });
});

describe("ElizaSchema browser profiles", () => {
  it("accepts snapshotDefaults and a profile with cdpPort or cdpUrl", () => {
    expectOk(ElizaSchema, { browser: {} });
    expectOk(ElizaSchema, {
      browser: { snapshotDefaults: { mode: "efficient" } },
    });
    expectOk(ElizaSchema, {
      browser: {
        profiles: {
          "work-1": { cdpPort: 1, color: "ff00aa" },
          ext: {
            cdpUrl: "http://127.0.0.1:9222",
            driver: "extension",
            color: "#00FF00",
          },
        },
      },
    });
    expectOk(ElizaSchema, {
      browser: { profiles: { local: { cdpPort: 65535, color: "#00FF00" } } },
    });
  });

  it("rejects bad profile names, missing cdp endpoint, port overflow, and extra keys", () => {
    expectFail(ElizaSchema, {
      browser: { profiles: { Work: { cdpPort: 9222, color: "000000" } } },
    });
    expectFail(ElizaSchema, {
      browser: { profiles: { work: { color: "000000" } } },
    });
    expect(
      issueMessages(ElizaSchema, {
        browser: { profiles: { work: { color: "000000" } } },
      }),
    ).toContain("Profile must set cdpPort or cdpUrl");
    expectFail(ElizaSchema, {
      browser: { profiles: { work: { cdpPort: 0, color: "000000" } } },
    });
    expectFail(ElizaSchema, {
      browser: { profiles: { work: { cdpPort: 65536, color: "000000" } } },
    });
    expectFail(ElizaSchema, {
      browser: { snapshotDefaults: { mode: "full" } },
    });
    expectFail(ElizaSchema, { browser: { extra: true } });
    expectFail(ElizaSchema, {
      browser: { profiles: { work: { cdpPort: 1, extra: true } } },
    });
  });
});

describe("ElizaSchema gateway, web, and discovery", () => {
  it("accepts gateway unions including non-strict tls extra keys", () => {
    expectOk(ElizaSchema, {
      gateway: {
        port: 1,
        mode: "local",
        bind: "loopback",
        reload: { mode: "hot", debounceMs: 0 },
        tailscale: { mode: "serve" },
        auth: { mode: "token" },
        tls: { enabled: true, extra: "allowed-because-not-strict" },
        nodes: {
          browser: { mode: "off" },
          allowCommands: [],
          denyCommands: [],
        },
      },
    });
    expectOk(ElizaSchema, {
      web: {
        heartbeatSeconds: 1,
        reconnect: { jitter: 0, maxAttempts: 0, factor: 1 },
      },
    });
    expectOk(ElizaSchema, {
      discovery: { mdns: { mode: "minimal" }, wideArea: { enabled: false } },
    });
  });

  it("rejects invalid unions, non-positive ports, and jitter overflow", () => {
    expectFail(ElizaSchema, { gateway: { port: 0 } });
    expectFail(ElizaSchema, { gateway: { bind: "public" } });
    expectFail(ElizaSchema, { gateway: { reload: { mode: "warm" } } });
    expectFail(ElizaSchema, { gateway: { extra: true } });
    expectFail(ElizaSchema, { web: { reconnect: { jitter: 1.1 } } });
    expectFail(ElizaSchema, { web: { reconnect: { jitter: -0.1 } } });
    expectFail(ElizaSchema, { web: { heartbeatSeconds: 0 } });
    expectFail(ElizaSchema, { discovery: { mdns: { mode: "loud" } } });
  });
});

describe("ElizaSchema auth, logging, diagnostics, and embedding", () => {
  it("accepts valid enums and a fully populated logging/diagnostics/auth block", () => {
    expectOk(ElizaSchema, {
      logging: {
        level: "debug",
        consoleLevel: "silent",
        consoleStyle: "json",
        redactSensitive: "tools",
        redactPatterns: [],
      },
    });
    expectOk(ElizaSchema, {
      diagnostics: {
        enabled: true,
        flags: [],
        otel: {
          protocol: "grpc",
          sampleRate: 0,
          flushIntervalMs: 0,
        },
        cacheTrace: { enabled: false },
      },
    });
    expectOk(ElizaSchema, {
      auth: {
        profiles: {
          default: { provider: "openai", mode: "api_key" },
        },
        order: { openai: ["default"] },
        cooldowns: { billingBackoffHours: 1 },
      },
    });
    expectOk(ElizaSchema, {
      embedding: {
        dimensions: 1,
        gpuLayers: "auto",
        idleTimeoutMinutes: 0,
      },
    });
    expectOk(ElizaSchema, { embedding: { gpuLayers: "max" } });
    expectOk(ElizaSchema, { embedding: { gpuLayers: 0 } });
  });

  it("rejects missing auth provider/mode, out-of-range numbers, and extra keys", () => {
    expectFail(ElizaSchema, { logging: { level: "verbose" } });
    expectFail(ElizaSchema, { logging: { extra: true } });
    expectFail(ElizaSchema, {
      diagnostics: { otel: { sampleRate: 1.1 } },
    });
    expectFail(ElizaSchema, {
      auth: { profiles: { default: { provider: "openai" } } },
    });
    expectFail(ElizaSchema, {
      auth: { profiles: { default: { provider: "openai", mode: "basic" } } },
    });
    expectFail(ElizaSchema, { embedding: { gpuLayers: -1 } });
    expectFail(ElizaSchema, { embedding: { dimensions: 0 } });
    expectFail(ElizaSchema, { embedding: { extra: true } });
  });
});

describe("ElizaSchema remaining nested objects", () => {
  it("accepts valid deployment, linked accounts, routing, ui, roles, cron, talk, skills, plugins", () => {
    expectOk(ElizaSchema, {
      deploymentTarget: { runtime: "local" },
      linkedAccounts: {
        openai: { status: "linked", source: "api-key" },
      },
      serviceRouting: {
        llmText: { transport: "direct", backend: "openai" },
      },
      ui: { seamColor: "#abcdef", assistant: { name: "Ada", avatar: "a.png" } },
      roles: { connectorAdmins: { telegram: ["u1"] } },
      cron: { enabled: true, maxConcurrentRuns: 1 },
      talk: { interruptOnSpeech: false, voiceAliases: {} },
      update: { channel: "stable", checkOnStart: false },
      wizard: { lastRunMode: "local" },
      nodeHost: { browserProxy: { enabled: false, allowProfiles: [] } },
      audio: {},
      skills: {
        allowBundled: [],
        denyBundled: [],
        load: { extraDirs: [], watchDebounceMs: 0 },
        install: { nodeManager: "bun" },
        entries: {
          weather: { enabled: true, env: {}, config: { k: 1 } },
        },
      },
      plugins: {
        enabled: true,
        allow: [],
        deny: [],
        load: { paths: [] },
        slots: { memory: "qmd" },
        entries: { x: { enabled: false, config: {} } },
        installs: { x: { source: "npm" } },
      },
    });
  });

  it("rejects invalid unions, overflow, missing required nested fields, and extra keys", () => {
    expectFail(ElizaSchema, { deploymentTarget: {} });
    expectFail(ElizaSchema, { deploymentTarget: { runtime: "k8s" } });
    expectFail(ElizaSchema, {
      linkedAccounts: { openai: { status: "pending" } },
    });
    expectFail(ElizaSchema, {
      serviceRouting: { llmText: { transport: "http" } },
    });
    expectFail(ElizaSchema, { ui: { assistant: { name: "a".repeat(51) } } });
    expectFail(ElizaSchema, { ui: { extra: true } });
    expectFail(ElizaSchema, { roles: { extra: true } });
    expectFail(ElizaSchema, { cron: { maxConcurrentRuns: 0 } });
    expectFail(ElizaSchema, { update: { channel: "nightly" } });
    expectFail(ElizaSchema, { wizard: { lastRunMode: "hybrid" } });
    expectFail(ElizaSchema, { nodeHost: { extra: true } });
    expectFail(ElizaSchema, { audio: { extra: true } });
    expectFail(ElizaSchema, { skills: { install: { nodeManager: "pnpm" } } });
    expectFail(ElizaSchema, { skills: { extra: true } });
    expectFail(ElizaSchema, {
      plugins: { installs: { x: { source: "git" } } },
    });
    expectFail(ElizaSchema, { plugins: { extra: true } });
  });
});
