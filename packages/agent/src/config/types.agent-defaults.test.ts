/**
 * Contract coverage for the config-scoped re-export of `@elizaos/shared`
 * (`types.agent-defaults.ts`). Consumers import OwnerContactsConfig,
 * OwnerContactEntry, EscalationConfig, and related AgentDefaultsConfig
 * shapes through this local path. Runtime validators re-exported from the
 * same barrel (AgentDefaultsSchema and sandbox/heartbeat/CLI helpers) must
 * stay the same identity as `@elizaos/shared` and keep their documented
 * branches. Deterministic, no mocks.
 */

import {
  AgentDefaultsSchema as SharedAgentDefaultsSchema,
  CliBackendSchema as SharedCliBackendSchema,
  HeartbeatSchema as SharedHeartbeatSchema,
  SandboxBrowserSchema as SharedSandboxBrowserSchema,
  SandboxDockerSchema as SharedSandboxDockerSchema,
  SandboxPruneSchema as SharedSandboxPruneSchema,
} from "@elizaos/shared";
import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  AgentCompactionConfig,
  AgentContextPruningConfig,
  AgentDefaultsConfig,
  AgentModelListConfig,
  CliBackendConfig,
  EscalationConfig,
  OwnerContactEntry,
  OwnerContactsConfig,
  SandboxBrowserSettings,
  SandboxDockerSettings,
  SandboxPruneSettings,
} from "./types.agent-defaults.ts";
import {
  AgentDefaultsSchema,
  CliBackendSchema,
  HeartbeatSchema,
  SandboxBrowserSchema,
  SandboxDockerSchema,
  SandboxPruneSchema,
} from "./types.agent-defaults.ts";

const VALID_ADMIN_ENTITY_ID = "01234567-89ab-cdef-0123-456789abcdef";

function rejected(
  schema: { safeParse: (value: unknown) => { success: boolean } },
  value: unknown,
) {
  expect(schema.safeParse(value).success).toBe(false);
}

function accepted<T>(
  schema: { safeParse: (value: unknown) => { success: boolean; data?: T } },
  value: unknown,
): T {
  const result = schema.safeParse(value);
  expect(result.success).toBe(true);
  return result.data as T;
}

describe("types.agent-defaults re-export", () => {
  it("re-exports AgentDefaultsSchema from @elizaos/shared by identity", () => {
    expect(AgentDefaultsSchema).toBe(SharedAgentDefaultsSchema);
  });

  it("re-exports heartbeat and sandbox schemas from @elizaos/shared by identity", () => {
    expect(HeartbeatSchema).toBe(SharedHeartbeatSchema);
    expect(SandboxPruneSchema).toBe(SharedSandboxPruneSchema);
    expect(SandboxDockerSchema).toBe(SharedSandboxDockerSchema);
    expect(SandboxBrowserSchema).toBe(SharedSandboxBrowserSchema);
  });

  it("re-exports CliBackendSchema from @elizaos/shared by identity", () => {
    expect(CliBackendSchema).toBe(SharedCliBackendSchema);
  });
});

describe("OwnerContactEntry and OwnerContactsConfig", () => {
  it("keeps every OwnerContactEntry field optional", () => {
    expectTypeOf<OwnerContactEntry>().toEqualTypeOf<{
      source?: string;
      entityId?: string;
      channelId?: string;
      roomId?: string;
    }>();
    const empty: OwnerContactEntry = {};
    expect(empty.source).toBeUndefined();
    expect(empty.entityId).toBeUndefined();
    expect(empty.channelId).toBeUndefined();
    expect(empty.roomId).toBeUndefined();
  });

  it("treats an empty contacts map as a missing lookup for every key", () => {
    const empty: OwnerContactsConfig = {};
    expect(Object.keys(empty)).toEqual([]);
    expect(empty.discord).toBeUndefined();
    expect(empty["telegram-account"]).toBeUndefined();
  });

  it("stores a single contact under its source key and leaves others missing", () => {
    const contacts: OwnerContactsConfig = {
      discord: {
        source: "discord",
        entityId: VALID_ADMIN_ENTITY_ID,
        channelId: "chan-1",
        roomId: "room-1",
      },
    };
    expect(Object.keys(contacts)).toEqual(["discord"]);
    expect(contacts.discord?.channelId).toBe("chan-1");
    expect(contacts.telegram).toBeUndefined();
  });

  it("preserves insertion order of contact keys, including equal-looking ties", () => {
    const contacts: OwnerContactsConfig = {
      telegram: { channelId: "t" },
      discord: { channelId: "d" },
      client_chat: { channelId: "c" },
    };
    expect(Object.keys(contacts)).toEqual([
      "telegram",
      "discord",
      "client_chat",
    ]);
    contacts.discord = { channelId: "d2" };
    expect(Object.keys(contacts)).toEqual([
      "telegram",
      "discord",
      "client_chat",
    ]);
    delete contacts.missing;
    expect(contacts.missing).toBeUndefined();
    expect(Object.keys(contacts)).toEqual([
      "telegram",
      "discord",
      "client_chat",
    ]);
  });
});

describe("EscalationConfig", () => {
  it("keeps channels, waitMinutes, and maxRetries optional", () => {
    expectTypeOf<EscalationConfig["channels"]>().toEqualTypeOf<
      string[] | undefined
    >();
    expectTypeOf<EscalationConfig["waitMinutes"]>().toEqualTypeOf<
      number | undefined
    >();
    expectTypeOf<EscalationConfig["maxRetries"]>().toEqualTypeOf<
      number | undefined
    >();
    const empty: EscalationConfig = {};
    expect(empty.channels).toBeUndefined();
  });

  it("accepts an empty channel queue and a single-element queue", () => {
    const none: EscalationConfig = { channels: [] };
    expect(none.channels).toEqual([]);
    const one: EscalationConfig = { channels: ["telegram"] };
    expect(one.channels).toEqual(["telegram"]);
  });

  it("preserves channel order, including adjacent duplicate ties", () => {
    const ordered: EscalationConfig = {
      channels: ["telegram", "discord", "telegram"],
      waitMinutes: 5,
      maxRetries: 3,
    };
    expect(ordered.channels).toEqual(["telegram", "discord", "telegram"]);
  });
});

describe("AgentDefaultsConfig type surface", () => {
  it("accepts an empty defaults object because every field is optional", () => {
    const empty: AgentDefaultsConfig = {};
    expect(empty.ownerContacts).toBeUndefined();
    expect(empty.escalation).toBeUndefined();
    expect(empty.sandbox).toBeUndefined();
  });

  it("requires CliBackendConfig.command while keeping other CLI fields optional", () => {
    expectTypeOf<CliBackendConfig["command"]>().toEqualTypeOf<string>();
    expectTypeOf<CliBackendConfig["args"]>().toEqualTypeOf<
      string[] | undefined
    >();
    const backend: CliBackendConfig = { command: "claude" };
    expect(backend.command).toBe("claude");
    expect(backend.args).toBeUndefined();
  });

  it("narrows sandbox mode, workspace access, and prune-disable zeros", () => {
    expectTypeOf<
      NonNullable<AgentDefaultsConfig["sandbox"]>["mode"]
    >().toEqualTypeOf<"off" | "non-main" | "all" | undefined>();
    expectTypeOf<SandboxPruneSettings["idleHours"]>().toEqualTypeOf<
      number | undefined
    >();
    expectTypeOf<SandboxDockerSettings["pidsLimit"]>().toEqualTypeOf<
      number | undefined
    >();
    expectTypeOf<SandboxBrowserSettings["allowHostControl"]>().toEqualTypeOf<
      boolean | undefined
    >();
    const prune: SandboxPruneSettings = { idleHours: 0, maxAgeDays: 0 };
    expect(prune.idleHours).toBe(0);
    expect(prune.maxAgeDays).toBe(0);
  });

  it("types model fallbacks as an optional list (empty, single, overflow)", () => {
    expectTypeOf<AgentModelListConfig["fallbacks"]>().toEqualTypeOf<
      string[] | undefined
    >();
    const empty: AgentModelListConfig = {
      primary: "openai/gpt-4.1",
      fallbacks: [],
    };
    expect(empty.fallbacks).toEqual([]);
    const one: AgentModelListConfig = {
      primary: "openai/gpt-4.1",
      fallbacks: ["anthropic/claude-sonnet-4"],
    };
    expect(one.fallbacks).toHaveLength(1);
  });

  it("types compaction maxHistoryShare and context-pruning mode unions", () => {
    expectTypeOf<AgentCompactionConfig["mode"]>().toEqualTypeOf<
      "default" | "safeguard" | undefined
    >();
    expectTypeOf<AgentContextPruningConfig["mode"]>().toEqualTypeOf<
      "off" | "cache-ttl" | undefined
    >();
  });
});

describe("AgentDefaultsSchema", () => {
  it("accepts undefined and an empty object", () => {
    expect(accepted(AgentDefaultsSchema, undefined)).toBeUndefined();
    expect(accepted(AgentDefaultsSchema, {})).toEqual({});
  });

  it("rejects unknown keys on the defaults object", () => {
    rejected(AgentDefaultsSchema, { notAField: true });
  });

  it("accepts every timeFormat literal and rejects anything else", () => {
    for (const timeFormat of ["auto", "12", "24"] as const) {
      expect(accepted(AgentDefaultsSchema, { timeFormat })).toEqual({
        timeFormat,
      });
    }
    rejected(AgentDefaultsSchema, { timeFormat: "36" });
    rejected(AgentDefaultsSchema, { timeFormat: "" });
  });

  it("requires adminEntityId to be a UUID when set", () => {
    expect(
      accepted(AgentDefaultsSchema, { adminEntityId: VALID_ADMIN_ENTITY_ID }),
    ).toEqual({ adminEntityId: VALID_ADMIN_ENTITY_ID });
    rejected(AgentDefaultsSchema, { adminEntityId: "not-a-uuid" });
    rejected(AgentDefaultsSchema, { adminEntityId: "" });
  });

  it("rejects non-positive contextTokens and maxConcurrent", () => {
    rejected(AgentDefaultsSchema, { contextTokens: 0 });
    rejected(AgentDefaultsSchema, { contextTokens: -1 });
    rejected(AgentDefaultsSchema, { maxConcurrent: 0 });
    expect(
      accepted(AgentDefaultsSchema, { contextTokens: 1, maxConcurrent: 1 }),
    ).toEqual({
      contextTokens: 1,
      maxConcurrent: 1,
    });
  });

  it("enforces compaction maxHistoryShare in [0.1, 0.9]", () => {
    rejected(AgentDefaultsSchema, { compaction: { maxHistoryShare: 0.09 } });
    rejected(AgentDefaultsSchema, { compaction: { maxHistoryShare: 0.91 } });
    expect(
      accepted(AgentDefaultsSchema, { compaction: { maxHistoryShare: 0.1 } }),
    ).toEqual({ compaction: { maxHistoryShare: 0.1 } });
    expect(
      accepted(AgentDefaultsSchema, { compaction: { maxHistoryShare: 0.9 } }),
    ).toEqual({ compaction: { maxHistoryShare: 0.9 } });
  });

  it("accepts empty and single model fallbacks and rejects a non-array", () => {
    expect(
      accepted(AgentDefaultsSchema, { model: { primary: "a", fallbacks: [] } }),
    ).toEqual({ model: { primary: "a", fallbacks: [] } });
    expect(
      accepted(AgentDefaultsSchema, {
        model: { primary: "a", fallbacks: ["b"] },
      }),
    ).toEqual({ model: { primary: "a", fallbacks: ["b"] } });
    rejected(AgentDefaultsSchema, { model: { fallbacks: "b" } });
  });

  it("accepts sandbox mode/access/scope unions and rejects unknown values", () => {
    expect(
      accepted(AgentDefaultsSchema, {
        sandbox: { mode: "off", workspaceAccess: "none", scope: "session" },
      }),
    ).toEqual({
      sandbox: { mode: "off", workspaceAccess: "none", scope: "session" },
    });
    rejected(AgentDefaultsSchema, { sandbox: { mode: "main" } });
    rejected(AgentDefaultsSchema, { sandbox: { workspaceAccess: "rwx" } });
    rejected(AgentDefaultsSchema, { sandbox: { scope: "global" } });
  });

  it("accepts contextPruning mode off/cache-ttl and rejects other modes", () => {
    expect(
      accepted(AgentDefaultsSchema, { contextPruning: { mode: "off" } }),
    ).toEqual({
      contextPruning: { mode: "off" },
    });
    expect(
      accepted(AgentDefaultsSchema, { contextPruning: { mode: "cache-ttl" } }),
    ).toEqual({ contextPruning: { mode: "cache-ttl" } });
    rejected(AgentDefaultsSchema, { contextPruning: { mode: "aggressive" } });
  });

  it("rejects a CLI backend missing the required command", () => {
    rejected(AgentDefaultsSchema, { cliBackends: { claude: {} } });
    expect(
      accepted(AgentDefaultsSchema, {
        cliBackends: { claude: { command: "claude" } },
      }),
    ).toEqual({ cliBackends: { claude: { command: "claude" } } });
    expect(accepted(AgentDefaultsSchema, { cliBackends: {} })).toEqual({
      cliBackends: {},
    });
  });

  it("accepts thinking/verbose/elevated/blockStreaming defaults and envelope flags", () => {
    expect(
      accepted(AgentDefaultsSchema, {
        thinkingDefault: "xhigh",
        verboseDefault: "full",
        elevatedDefault: "ask",
        blockStreamingDefault: "on",
        blockStreamingBreak: "text_end",
        envelopeTimestamp: "off",
        envelopeElapsed: "on",
      }),
    ).toEqual({
      thinkingDefault: "xhigh",
      verboseDefault: "full",
      elevatedDefault: "ask",
      blockStreamingDefault: "on",
      blockStreamingBreak: "text_end",
      envelopeTimestamp: "off",
      envelopeElapsed: "on",
    });
    rejected(AgentDefaultsSchema, { thinkingDefault: "max" });
    rejected(AgentDefaultsSchema, { envelopeTimestamp: "utc" });
  });
});

describe("HeartbeatSchema", () => {
  it("accepts undefined, empty, and a missing every (no duration to parse)", () => {
    expect(accepted(HeartbeatSchema, undefined)).toBeUndefined();
    expect(accepted(HeartbeatSchema, {})).toEqual({});
    expect(accepted(HeartbeatSchema, { session: "main" })).toEqual({
      session: "main",
    });
  });

  it("treats a falsy every as missing, and rejects unparseable durations", () => {
    // HeartbeatSchema's superRefine returns early on !val.every, so "" is not parsed.
    expect(accepted(HeartbeatSchema, { every: "" })).toEqual({ every: "" });
    rejected(HeartbeatSchema, { every: "   " });
    rejected(HeartbeatSchema, { every: "soon" });
    rejected(HeartbeatSchema, { every: "-1m" });
  });

  it("accepts a bare number as minutes and explicit ms/s/m/h units", () => {
    expect(accepted(HeartbeatSchema, { every: "30" })).toEqual({ every: "30" });
    expect(accepted(HeartbeatSchema, { every: "500ms" })).toEqual({
      every: "500ms",
    });
    expect(accepted(HeartbeatSchema, { every: "30s" })).toEqual({
      every: "30s",
    });
    expect(accepted(HeartbeatSchema, { every: "2h" })).toEqual({ every: "2h" });
  });

  it("rejects start=24:00, allows end=24:00, and rejects 24:01", () => {
    rejected(HeartbeatSchema, {
      every: "30m",
      activeHours: { start: "24:00", end: "08:00" },
    });
    expect(
      accepted(HeartbeatSchema, {
        every: "30m",
        activeHours: { start: "00:00", end: "24:00" },
      }),
    ).toEqual({
      every: "30m",
      activeHours: { start: "00:00", end: "24:00" },
    });
    rejected(HeartbeatSchema, {
      every: "30m",
      activeHours: { start: "08:00", end: "24:01" },
    });
    rejected(HeartbeatSchema, {
      every: "30m",
      activeHours: { start: "9:00" },
    });
  });

  it("rejects extra heartbeat keys and negative ackMaxChars", () => {
    rejected(HeartbeatSchema, { extra: true });
    rejected(HeartbeatSchema, { ackMaxChars: -1 });
    expect(accepted(HeartbeatSchema, { ackMaxChars: 0 })).toEqual({
      ackMaxChars: 0,
    });
  });
});

describe("SandboxPruneSchema", () => {
  it("accepts empty prune settings and the documented 0=disable values", () => {
    expect(accepted(SandboxPruneSchema, undefined)).toBeUndefined();
    expect(accepted(SandboxPruneSchema, {})).toEqual({});
    expect(
      accepted(SandboxPruneSchema, { idleHours: 0, maxAgeDays: 0 }),
    ).toEqual({
      idleHours: 0,
      maxAgeDays: 0,
    });
  });

  it("rejects negative prune windows and unknown keys", () => {
    rejected(SandboxPruneSchema, { idleHours: -1 });
    rejected(SandboxPruneSchema, { maxAgeDays: -1 });
    rejected(SandboxPruneSchema, { idleHours: 1.5 });
    rejected(SandboxPruneSchema, { extra: 1 });
  });
});

describe("SandboxDockerSchema and SandboxBrowserSchema", () => {
  it("rejects pidsLimit 0 (schema is positive; 0 is not the Docker default here)", () => {
    rejected(SandboxDockerSchema, { pidsLimit: 0 });
    rejected(SandboxDockerSchema, { pidsLimit: -1 });
    expect(accepted(SandboxDockerSchema, { pidsLimit: 1 })).toEqual({
      pidsLimit: 1,
    });
  });

  it("rejects non-positive cpus and accepts ulimit string/number/object forms", () => {
    rejected(SandboxDockerSchema, { cpus: 0 });
    expect(
      accepted(SandboxDockerSchema, {
        ulimits: {
          nofile: "1024:2048",
          nproc: 256,
          core: { soft: 0, hard: 0 },
        },
      }),
    ).toEqual({
      ulimits: {
        nofile: "1024:2048",
        nproc: 256,
        core: { soft: 0, hard: 0 },
      },
    });
  });

  it("rejects non-positive browser ports and autoStartTimeoutMs", () => {
    rejected(SandboxBrowserSchema, { cdpPort: 0 });
    rejected(SandboxBrowserSchema, { autoStartTimeoutMs: 0 });
    expect(
      accepted(SandboxBrowserSchema, {
        enabled: true,
        cdpPort: 9222,
        allowHostControl: false,
        autoStartTimeoutMs: 1,
      }),
    ).toEqual({
      enabled: true,
      cdpPort: 9222,
      allowHostControl: false,
      autoStartTimeoutMs: 1,
    });
  });
});

describe("CliBackendSchema", () => {
  it("requires command and accepts an empty args queue or a single arg", () => {
    rejected(CliBackendSchema, {});
    expect(accepted(CliBackendSchema, { command: "claude" })).toEqual({
      command: "claude",
    });
    expect(accepted(CliBackendSchema, { command: "claude", args: [] })).toEqual(
      {
        command: "claude",
        args: [],
      },
    );
    expect(
      accepted(CliBackendSchema, { command: "claude", args: ["--print"] }),
    ).toEqual({
      command: "claude",
      args: ["--print"],
    });
  });

  it("accepts sessionMode unions and rejects unknown modes or extra keys", () => {
    expect(
      accepted(CliBackendSchema, { command: "claude", sessionMode: "none" }),
    ).toEqual({
      command: "claude",
      sessionMode: "none",
    });
    rejected(CliBackendSchema, { command: "claude", sessionMode: "sometimes" });
    rejected(CliBackendSchema, { command: "claude", extra: true });
  });
});
