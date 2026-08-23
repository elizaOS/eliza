/**
 * Behavioral coverage for the per-agent / agent-defaults zod slice:
 * heartbeat duration and active-hours windows, sandbox docker/browser/prune
 * shapes, tool profiles and allow/alsoAllow conflict refinements, memory
 * search, owner contacts, escalation, inbox triage, AgentEntrySchema, and
 * AgentDefaultsSchema. Drives the real schemas. Deterministic, no live
 * services.
 */
import { describe, expect, it } from "vitest";
import {
  AgentDefaultsSchema,
  AgentEntrySchema,
  AgentModelSchema,
  AgentSandboxSchema,
  AgentToolsSchema,
  ElevatedAllowFromSchema,
  EscalationSchema,
  HeartbeatSchema,
  InboxTriageConfigSchema,
  MemorySearchSchema,
  OwnerContactEntrySchema,
  OwnerContactsSchema,
  SandboxBrowserSchema,
  SandboxDockerSchema,
  SandboxPruneSchema,
  ToolPolicySchema,
  ToolPolicyWithProfileSchema,
  ToolProfileSchema,
  ToolsCacheSchema,
  ToolsSchema,
  ToolsWebFetchSchema,
  ToolsWebSchema,
  ToolsWebSearchSchema,
} from "./zod-schema.agent-runtime.ts";

type ParseResult = {
  success: boolean;
  data?: unknown;
  error?: { issues: Array<{ message: string }> };
};

type Parsable = {
  safeParse: (value: unknown) => ParseResult;
};

function expectOk(schema: Parsable, value: unknown, data: unknown = value) {
  const result = schema.safeParse(value);
  expect(result.success).toBe(true);
  if (result.success) expect(result.data).toEqual(data);
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

const UUID = "550e8400-e29b-41d4-a716-446655440000";

describe("HeartbeatSchema", () => {
  it("accepts omission, an empty object, and a finite interval", () => {
    expectOk(HeartbeatSchema, undefined);
    expectOk(HeartbeatSchema, {});
    expectOk(HeartbeatSchema, { every: "30m" });
    expectOk(HeartbeatSchema, { every: "500ms" });
    expectOk(HeartbeatSchema, { every: "2h" });
    expectOk(HeartbeatSchema, { every: "45" });
  });

  it("skips duration validation when every is missing or empty", () => {
    expectOk(HeartbeatSchema, { every: "" });
    expectOk(HeartbeatSchema, {
      activeHours: { start: "not-a-time", end: "also-bad" },
    });
  });

  it("rejects an unparseable or overflowing interval", () => {
    expectFail(HeartbeatSchema, { every: "nope" });
    expectFail(HeartbeatSchema, { every: "-5m" });
    expectFail(HeartbeatSchema, { every: "   " });
    expectFail(HeartbeatSchema, { every: `1${"0".repeat(306)}` });
    expect(issueMessages(HeartbeatSchema, { every: "nope" })).toContain(
      "invalid duration (use ms, s, m, h)",
    );
  });

  it("accepts valid activeHours windows including end-of-day 24:00", () => {
    expectOk(HeartbeatSchema, {
      every: "15m",
      activeHours: { start: "00:00", end: "23:59", timezone: "UTC" },
    });
    expectOk(HeartbeatSchema, {
      every: "15m",
      activeHours: { start: "09:05", end: "24:00" },
    });
  });

  it("rejects malformed times and 24:xx other than 24:00", () => {
    expect(
      issueMessages(HeartbeatSchema, {
        every: "1m",
        activeHours: { start: "9:00" },
      }),
    ).toContain('invalid time (use "HH:MM" 24h format)');
    expectFail(HeartbeatSchema, { every: "1m", activeHours: { end: "25:00" } });
    expectFail(HeartbeatSchema, { every: "1m", activeHours: { end: "12:60" } });
    expect(
      issueMessages(HeartbeatSchema, {
        every: "1m",
        activeHours: { end: "24:01" },
      }),
    ).toContain("invalid time (24:00 is the only allowed 24:xx value)");
    expect(
      issueMessages(HeartbeatSchema, {
        every: "1m",
        activeHours: { start: "24:00" },
      }),
    ).toContain("invalid time (start cannot be 24:00)");
  });

  it("rejects unknown keys, non-int ackMaxChars, and a non-object root", () => {
    expectFail(HeartbeatSchema, { extra: true });
    expectFail(HeartbeatSchema, { ackMaxChars: -1 });
    expectFail(HeartbeatSchema, { ackMaxChars: 1.5 });
    expectOk(HeartbeatSchema, { ackMaxChars: 0, includeReasoning: true });
    expectFail(HeartbeatSchema, []);
    expectFail(HeartbeatSchema, "30m");
  });
});

describe("SandboxDockerSchema", () => {
  it("accepts empty, string-or-number memory, and ulimit shapes", () => {
    expectOk(SandboxDockerSchema, undefined);
    expectOk(SandboxDockerSchema, {});
    expectOk(SandboxDockerSchema, {
      image: "eliza:sandbox",
      memory: "512m",
      memorySwap: 1024,
      cpus: 0.5,
      pidsLimit: 64,
      env: { FOO: "bar" },
      tmpfs: ["/tmp"],
      ulimits: {
        nofile: { soft: 64, hard: 128 },
        nproc: 32,
        core: "0",
      },
    });
  });

  it("rejects zero/negative limits, unknown keys, and invalid ulimits", () => {
    expectFail(SandboxDockerSchema, { pidsLimit: 0 });
    expectFail(SandboxDockerSchema, { cpus: 0 });
    expectFail(SandboxDockerSchema, { extra: true });
    expectFail(SandboxDockerSchema, { ulimits: { nofile: { soft: -1 } } });
    expectFail(SandboxDockerSchema, { ulimits: { nofile: { extra: 1 } } });
    expectFail(SandboxDockerSchema, { memory: true });
  });
});

describe("SandboxBrowserSchema and SandboxPruneSchema", () => {
  it("accepts empty objects and positive browser ports", () => {
    expectOk(SandboxBrowserSchema, {});
    expectOk(SandboxBrowserSchema, {
      enabled: true,
      cdpPort: 9222,
      vncPort: 5900,
      noVncPort: 6080,
      autoStartTimeoutMs: 1,
    });
    expectOk(SandboxPruneSchema, { idleHours: 0, maxAgeDays: 0 });
  });

  it("rejects non-positive ports and negative prune ages", () => {
    expectFail(SandboxBrowserSchema, { cdpPort: 0 });
    expectFail(SandboxBrowserSchema, { extra: true });
    expectFail(SandboxPruneSchema, { idleHours: -1 });
    expectFail(SandboxPruneSchema, { maxAgeDays: 1.5 });
  });
});

describe("ToolsWebSearchSchema, ToolsWebFetchSchema, ToolsWebSchema, ToolsCacheSchema", () => {
  it("accepts empty nested web/cache objects and the known search providers", () => {
    expectOk(ToolsWebSearchSchema, {
      provider: "brave",
      maxResults: 1,
      cacheTtlMinutes: 0,
    });
    expectOk(ToolsWebSearchSchema, {
      provider: "perplexity",
      perplexity: { apiKey: "k", baseUrl: "https://x", model: "pplx" },
    });
    expectOk(ToolsWebFetchSchema, {
      maxChars: 1,
      maxRedirects: 0,
      cacheTtlMinutes: 0,
    });
    expectOk(ToolsWebSchema, {
      search: { enabled: false },
      fetch: { enabled: true },
    });
    expectOk(ToolsCacheSchema, {
      enabled: true,
      memoryCapacity: 1,
      perTool: { web_search: { ttlMinutes: 0, version: "1" } },
    });
  });

  it("rejects unknown providers, overflow, and extra nested keys", () => {
    expectFail(ToolsWebSearchSchema, { provider: "google" });
    expectFail(ToolsWebSearchSchema, { maxResults: 0 });
    expectFail(ToolsWebSearchSchema, { perplexity: { extra: true } });
    expectFail(ToolsWebFetchSchema, { maxChars: 0 });
    expectFail(ToolsWebFetchSchema, { maxRedirects: -1 });
    expectFail(ToolsWebSchema, { extra: true });
    expectFail(ToolsCacheSchema, { memoryCapacity: 0 });
    expectFail(ToolsCacheSchema, { perTool: { web_search: { extra: true } } });
  });
});

describe("ToolProfileSchema and tool-policy allow/alsoAllow conflict", () => {
  it("accepts the four profiles and undefined", () => {
    expectOk(ToolProfileSchema, undefined);
    expectOk(ToolProfileSchema, "minimal");
    expectOk(ToolProfileSchema, "coding");
    expectOk(ToolProfileSchema, "messaging");
    expectOk(ToolProfileSchema, "full");
    expectFail(ToolProfileSchema, "custom");
  });

  it("treats empty allow or alsoAllow as no conflict, including a missing list", () => {
    expectOk(ToolPolicySchema, {});
    expectOk(ToolPolicySchema, { allow: ["exec"] });
    expectOk(ToolPolicySchema, { alsoAllow: ["read"] });
    expectOk(ToolPolicySchema, { allow: [], alsoAllow: ["read"] });
    expectOk(ToolPolicySchema, { allow: ["exec"], alsoAllow: [] });
    expectOk(ToolPolicySchema, { deny: ["write"] });
  });

  it("rejects a non-empty allow paired with a non-empty alsoAllow", () => {
    const messages = issueMessages(ToolPolicySchema, {
      allow: ["exec"],
      alsoAllow: ["read"],
    });
    expect(messages).toContain(
      "tools policy cannot set both allow and alsoAllow in the same scope (merge alsoAllow into allow, or remove allow and use profile + alsoAllow)",
    );
  });

  it("accepts a by-provider policy with a profile and rejects the same conflict", () => {
    expectOk(ToolPolicyWithProfileSchema, {
      profile: "coding",
      allow: ["exec"],
    });
    expectFail(ToolPolicyWithProfileSchema, {
      allow: ["exec"],
      alsoAllow: ["read"],
    });
    expectFail(ToolPolicyWithProfileSchema, { profile: "nope" });
    expectFail(ToolPolicyWithProfileSchema, { extra: true });
  });
});

describe("ElevatedAllowFromSchema and AgentSandboxSchema", () => {
  it("accepts mixed string/number allowFrom entries and sandbox enums", () => {
    expectOk(ElevatedAllowFromSchema, { discord: ["owner", 42] });
    expectFail(ElevatedAllowFromSchema, { discord: [true] });
    expectOk(AgentSandboxSchema, {
      mode: "non-main",
      workspaceAccess: "ro",
      sessionToolsVisibility: "spawned",
      scope: "session",
      perSession: true,
      docker: { image: "sandbox" },
      browser: { enabled: false },
      prune: { idleHours: 2 },
    });
  });

  it("rejects unknown sandbox enums and extra keys", () => {
    expectFail(AgentSandboxSchema, { mode: "always" });
    expectFail(AgentSandboxSchema, { workspaceAccess: "write" });
    expectFail(AgentSandboxSchema, { sessionToolsVisibility: "none" });
    expectFail(AgentSandboxSchema, { scope: "global" });
    expectFail(AgentSandboxSchema, { extra: true });
  });
});

describe("AgentToolsSchema", () => {
  it("accepts a populated tools block including exec.approvalRunningNoticeMs", () => {
    expectOk(AgentToolsSchema, {
      profile: "full",
      allow: ["exec"],
      deny: ["write"],
      byProvider: { discord: { profile: "messaging", allow: ["react"] } },
      elevated: { enabled: true, allowFrom: { discord: ["owner"] } },
      exec: {
        host: "sandbox",
        security: "allowlist",
        ask: "on-miss",
        backgroundMs: 1,
        timeoutSec: 1,
        approvalRunningNoticeMs: 0,
        cleanupMs: 1,
        applyPatch: { enabled: true, allowModels: ["gpt"] },
      },
      sandbox: { tools: { deny: ["exec"] } },
    });
  });

  it("rejects allow+alsoAllow at the agent-tools, byProvider, and sandbox.tools scopes", () => {
    expect(
      issueMessages(AgentToolsSchema, { allow: ["a"], alsoAllow: ["b"] }),
    ).toContain(
      "agent tools cannot set both allow and alsoAllow in the same scope (merge alsoAllow into allow, or remove allow and use profile + alsoAllow)",
    );
    expectFail(AgentToolsSchema, {
      byProvider: { discord: { allow: ["a"], alsoAllow: ["b"] } },
    });
    expectFail(AgentToolsSchema, {
      sandbox: { tools: { allow: ["a"], alsoAllow: ["b"] } },
    });
  });

  it("rejects unknown exec enums and extra keys", () => {
    expectFail(AgentToolsSchema, { exec: { host: "local" } });
    expectFail(AgentToolsSchema, { exec: { security: "open" } });
    expectFail(AgentToolsSchema, { exec: { ask: "sometimes" } });
    expectFail(AgentToolsSchema, { extra: true });
  });
});

describe("MemorySearchSchema", () => {
  it("accepts empty, known sources/providers, and in-range query scores", () => {
    expectOk(MemorySearchSchema, {});
    expectOk(MemorySearchSchema, {
      sources: ["memory", "sessions"],
      provider: "local",
      fallback: "none",
      store: { driver: "sqlite", path: "./mem.db", vector: { enabled: true } },
      chunking: { tokens: 1, overlap: 0 },
      query: {
        maxResults: 1,
        minScore: 0,
        hybrid: {
          enabled: true,
          vectorWeight: 1,
          textWeight: 0,
          candidateMultiplier: 1,
        },
      },
      cache: { enabled: true, maxEntries: 1 },
      remote: {
        batch: { concurrency: 1, pollIntervalMs: 0, timeoutMinutes: 1 },
      },
    });
  });

  it("rejects unknown sources, out-of-range scores, and extra keys", () => {
    expectFail(MemorySearchSchema, { sources: ["transcripts"] });
    expectFail(MemorySearchSchema, { provider: "anthropic" });
    expectFail(MemorySearchSchema, { fallback: "remote" });
    expectFail(MemorySearchSchema, { store: { driver: "postgres" } });
    expectFail(MemorySearchSchema, { query: { minScore: -0.1 } });
    expectFail(MemorySearchSchema, { query: { minScore: 1.1 } });
    expectFail(MemorySearchSchema, { extra: true });
  });
});

describe("AgentModelSchema", () => {
  it("accepts a string or a strict primary/fallbacks object", () => {
    expectOk(AgentModelSchema, "gpt-4");
    expectOk(AgentModelSchema, { primary: "gpt-4", fallbacks: ["gpt-4o"] });
    expectFail(AgentModelSchema, 1);
    expectFail(AgentModelSchema, { extra: true });
    expectFail(AgentModelSchema, { primary: 1 });
  });
});

describe("AgentEntrySchema", () => {
  it("requires id and round-trips a populated agent", () => {
    expectFail(AgentEntrySchema, {});
    expectFail(AgentEntrySchema, { name: "Ada" });
    const agent = {
      id: "main",
      default: true,
      name: "Ada",
      workspace: "/tmp/ada",
      agentDir: "/tmp/ada/.eliza",
      model: "gpt-4",
      skills: ["search"],
      memorySearch: { enabled: false },
      advancedMemory: false,
      agentOrchestrator: false,
      gitpathologist: false,
      humanDelay: { mode: "off" as const },
      heartbeat: { every: "30m" },
      identity: { name: "Ada" },
      groupChat: { historyLimit: 10 },
      subagents: {
        allowAgents: ["helper"],
        model: { primary: "gpt-4o", fallbacks: [] },
        thinking: "low",
      },
      sandbox: { mode: "off" as const },
      tools: { profile: "minimal" as const },
    };
    expectOk(AgentEntrySchema, agent);
  });

  it("accepts a string or object subagent model and rejects unknown keys", () => {
    expectOk(AgentEntrySchema, {
      id: "helper",
      subagents: { model: "gpt-4o" },
    });
    expectFail(AgentEntrySchema, { id: "helper", extra: true });
    expectFail(AgentEntrySchema, { id: "helper", subagents: { extra: true } });
    expectFail(AgentEntrySchema, { id: 1 });
  });
});

describe("ToolsSchema", () => {
  it("accepts a populated top-level tools block", () => {
    expectOk(ToolsSchema, {
      profile: "coding",
      allow: ["read"],
      web: { search: { enabled: true }, fetch: { enabled: true } },
      cache: { enabled: false },
      media: { concurrency: 1 },
      links: { enabled: false },
      message: {
        allowCrossContextSend: false,
        crossContext: {
          allowWithinProvider: true,
          marker: { enabled: true, prefix: "[", suffix: "]" },
        },
        broadcast: { enabled: false },
      },
      agentToAgent: { enabled: true, allow: ["helper"] },
      elevated: { enabled: false },
      exec: { host: "gateway", security: "deny", ask: "always", cleanupMs: 1 },
      subagents: { tools: { deny: ["exec"] } },
      sandbox: { tools: { allow: ["read"] } },
    });
  });

  it("rejects allow+alsoAllow at tools, subagents.tools, and sandbox.tools", () => {
    expect(
      issueMessages(ToolsSchema, { allow: ["a"], alsoAllow: ["b"] }),
    ).toContain(
      "tools cannot set both allow and alsoAllow in the same scope (merge alsoAllow into allow, or remove allow and use profile + alsoAllow)",
    );
    expectFail(ToolsSchema, {
      subagents: { tools: { allow: ["a"], alsoAllow: ["b"] } },
    });
    expectFail(ToolsSchema, {
      sandbox: { tools: { allow: ["a"], alsoAllow: ["b"] } },
    });
  });

  it("rejects unknown keys including agent-only exec.approvalRunningNoticeMs", () => {
    expectFail(ToolsSchema, { extra: true });
    expectFail(ToolsSchema, { exec: { approvalRunningNoticeMs: 0 } });
  });
});

describe("OwnerContactEntrySchema and OwnerContactsSchema", () => {
  it("accepts a trimmed source and UUID entity/room ids", () => {
    expectOk(OwnerContactEntrySchema, {
      source: "discord",
      entityId: UUID,
      channelId: "general",
      roomId: UUID,
    });
    expectOk(OwnerContactsSchema, { owner: { source: "telegram" } });
    expectOk(OwnerContactsSchema, undefined);
  });

  it("rejects a blank source, a missing item's invalid UUID, and extra keys", () => {
    expectFail(OwnerContactEntrySchema, { source: "   " });
    expectFail(OwnerContactEntrySchema, { source: "" });
    expectFail(OwnerContactEntrySchema, { entityId: "not-a-uuid" });
    expectFail(OwnerContactEntrySchema, { roomId: "550e8400-e29b-41d4-a716" });
    expectFail(OwnerContactEntrySchema, { extra: true });
    expectFail(OwnerContactsSchema, { owner: { entityId: "nope" } });
    expect(
      issueMessages(OwnerContactEntrySchema, { entityId: "nope" }),
    ).toContain("invalid UUID");
  });
});

describe("EscalationSchema", () => {
  it("accepts in-range wait and retry bounds", () => {
    expectOk(EscalationSchema, {});
    expectOk(EscalationSchema, {
      channels: ["discord"],
      waitMinutes: 1,
      maxRetries: 1,
    });
    expectOk(EscalationSchema, { waitMinutes: 60, maxRetries: 10 });
  });

  it("rejects overflow, underflow, a non-int retry count, and extra keys", () => {
    expectFail(EscalationSchema, { waitMinutes: 0 });
    expectFail(EscalationSchema, { waitMinutes: 61 });
    expectFail(EscalationSchema, { maxRetries: 0 });
    expectFail(EscalationSchema, { maxRetries: 11 });
    expectFail(EscalationSchema, { maxRetries: 1.5 });
    expectFail(EscalationSchema, { extra: true });
  });
});

describe("InboxTriageConfigSchema", () => {
  it("accepts empty, nested auto-reply, and triage rules", () => {
    expectOk(InboxTriageConfigSchema, {});
    expectOk(InboxTriageConfigSchema, {
      enabled: true,
      autoReply: {
        enabled: true,
        confidenceThreshold: 0,
        senderWhitelist: ["ada@example.com"],
        maxAutoRepliesPerHour: 0,
      },
      triageRules: {
        alwaysUrgent: ["pager"],
        alwaysIgnore: ["noreply"],
        alwaysNotify: ["ceo"],
      },
      retentionDays: 1,
    });
  });

  it("rejects out-of-range confidence, negative hourly caps, and extra keys", () => {
    expectFail(InboxTriageConfigSchema, {
      autoReply: { confidenceThreshold: 1.1 },
    });
    expectFail(InboxTriageConfigSchema, {
      autoReply: { maxAutoRepliesPerHour: -1 },
    });
    expectFail(InboxTriageConfigSchema, { retentionDays: 0 });
    expectFail(InboxTriageConfigSchema, { extra: true });
    expectFail(InboxTriageConfigSchema, { autoReply: { extra: true } });
  });
});

describe("AgentDefaultsSchema", () => {
  it("accepts omission, an empty object, and a populated defaults slice", () => {
    expectOk(AgentDefaultsSchema, undefined);
    expectOk(AgentDefaultsSchema, {});
    expectOk(AgentDefaultsSchema, {
      model: { primary: "gpt-4", fallbacks: ["gpt-4o"] },
      imageModel: { primary: "dall-e", fallbacks: [] },
      models: { fast: { alias: "gpt-4o-mini", params: { thinking: true } } },
      adminEntityId: UUID,
      ownerContacts: { owner: { source: "discord" } },
      escalation: { waitMinutes: 5 },
      timeFormat: "24",
      envelopeTimestamp: "on",
      envelopeElapsed: "off",
      contextTokens: 1,
      thinkingDefault: "xhigh",
      verboseDefault: "full",
      elevatedDefault: "ask",
      blockStreamingDefault: "off",
      blockStreamingBreak: "text_end",
      typingMode: "thinking",
      heartbeat: { every: "1h" },
      maxConcurrent: 1,
      subagents: { maxConcurrent: 1, archiveAfterMinutes: 1, model: "gpt-4o" },
      sandbox: { mode: "all", workspaceAccess: "rw", scope: "shared" },
      inboxTriage: { enabled: false },
      contextPruning: {
        mode: "cache-ttl",
        softTrimRatio: 0,
        hardClearRatio: 1,
        keepLastAssistants: 0,
        minPrunableToolChars: 0,
        tools: { allow: ["exec"] },
        softTrim: { maxChars: 0, headChars: 0, tailChars: 0 },
        hardClear: { enabled: true, placeholder: "[cleared]" },
      },
      compaction: {
        mode: "safeguard",
        reserveTokensFloor: 0,
        maxHistoryShare: 0.1,
        memoryFlush: { enabled: true, softThresholdTokens: 0 },
      },
    });
  });

  it("rejects invalid UUIDs, enum overflow, and extra keys", () => {
    expectFail(AgentDefaultsSchema, { adminEntityId: "not-a-uuid" });
    expect(
      issueMessages(AgentDefaultsSchema, { adminEntityId: "nope" }),
    ).toContain("invalid UUID format");
    expectFail(AgentDefaultsSchema, { timeFormat: "36" });
    expectFail(AgentDefaultsSchema, { thinkingDefault: "max" });
    expectFail(AgentDefaultsSchema, { verboseDefault: "debug" });
    expectFail(AgentDefaultsSchema, { elevatedDefault: "always" });
    expectFail(AgentDefaultsSchema, { typingMode: "always" });
    expectFail(AgentDefaultsSchema, { compaction: { maxHistoryShare: 0.09 } });
    expectFail(AgentDefaultsSchema, { compaction: { maxHistoryShare: 0.91 } });
    expectFail(AgentDefaultsSchema, {
      contextPruning: { softTrimRatio: -0.1 },
    });
    expectFail(AgentDefaultsSchema, { extra: true });
    expectFail(AgentDefaultsSchema, { sandbox: { mode: "always" } });
  });
});
