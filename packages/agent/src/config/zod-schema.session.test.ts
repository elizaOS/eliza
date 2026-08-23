/**
 * SessionSchema, MessagesSchema, CommandsSchema, and SessionSendPolicySchema
 * are the parse-time contracts for session scoping, inbound queue/debounce,
 * ack/TTS, and built-in command toggles. Every field is optional; unknown keys
 * fail closed because the objects are strict. Deterministic, no live services.
 */
import { describe, expect, it } from "vitest";
import {
  CommandsSchema,
  MessagesSchema,
  SessionSchema,
  SessionSendPolicySchema,
} from "./zod-schema.session.ts";

function expectOk(
  schema: {
    safeParse: (value: unknown) => { success: boolean; data?: unknown };
  },
  value: unknown,
  data: unknown = value,
) {
  const result = schema.safeParse(value);
  expect(result.success).toBe(true);
  if (result.success) expect(result.data).toEqual(data);
}

function expectFail(
  schema: { safeParse: (value: unknown) => { success: boolean } },
  value: unknown,
) {
  expect(schema.safeParse(value).success).toBe(false);
}

describe("SessionSendPolicySchema", () => {
  it("accepts omission, an empty object, and both default actions", () => {
    expectOk(SessionSendPolicySchema, undefined);
    expectOk(SessionSendPolicySchema, {});
    expectOk(SessionSendPolicySchema, { default: "allow" });
    expectOk(SessionSendPolicySchema, { default: "deny" });
  });

  it("round-trips an empty rules queue, a single rule, and ordered rules", () => {
    expectOk(SessionSendPolicySchema, { rules: [] });
    expectOk(SessionSendPolicySchema, {
      default: "deny",
      rules: [
        {
          action: "allow",
          match: { channel: "telegram", chatType: "direct", keyPrefix: "dm:" },
        },
      ],
    });
    const ordered = {
      rules: [
        { action: "deny" as const, match: { channel: "discord" } },
        { action: "allow" as const, match: { chatType: "group" as const } },
      ],
    };
    expectOk(SessionSendPolicySchema, ordered);
    const parsed = SessionSendPolicySchema.safeParse(ordered);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data?.rules?.map((rule) => rule.action)).toEqual([
        "deny",
        "allow",
      ]);
    }
  });

  it("rejects unknown keys, a missing rule action, and invalid match values", () => {
    expectFail(SessionSendPolicySchema, { extra: true });
    expectFail(SessionSendPolicySchema, { default: "maybe" });
    expectFail(SessionSendPolicySchema, {
      rules: [{ match: { channel: "x" } }],
    });
    expectFail(SessionSendPolicySchema, {
      rules: [{ action: "allow", match: { chatType: "thread" } }],
    });
    expectFail(SessionSendPolicySchema, null);
    expectFail(SessionSendPolicySchema, []);
  });
});

describe("SessionSchema", () => {
  it("accepts omission and an empty object because the root is optional", () => {
    expectOk(SessionSchema, undefined);
    expectOk(SessionSchema, {});
  });

  it("rejects a non-object root and unknown top-level keys (strict)", () => {
    expectFail(SessionSchema, null);
    expectFail(SessionSchema, "per-sender");
    expectFail(SessionSchema, 1);
    expectFail(SessionSchema, []);
    expectFail(SessionSchema, { extra: true });
    expectFail(SessionSchema, { scope: "global", plugins: [] });
  });

  it("round-trips a fully populated valid session", () => {
    const session = {
      scope: "per-sender" as const,
      dmScope: "per-account-channel-peer" as const,
      identityLinks: { alice: ["telegram:1", "discord:2"] },
      resetTriggers: ["/new", "/reset"],
      idleMinutes: 30,
      reset: { mode: "daily" as const, atHour: 4, idleMinutes: 15 },
      resetByType: {
        dm: { mode: "idle" as const, idleMinutes: 10 },
        group: { mode: "daily" as const, atHour: 0 },
        thread: { mode: "daily" as const, atHour: 23 },
      },
      resetByChannel: {
        telegram: { mode: "idle" as const, idleMinutes: 5 },
      },
      store: "sqlite",
      typingIntervalSeconds: 3,
      typingMode: "thinking" as const,
      mainKey: "main",
      sendPolicy: {
        default: "allow" as const,
        rules: [{ action: "deny" as const, match: { channel: "slack" } }],
      },
      agentToAgent: { maxPingPongTurns: 2 },
    };
    expectOk(SessionSchema, session);
  });
});

describe("SessionSchema scope and dmScope", () => {
  it("accepts every documented scope and dmScope literal", () => {
    expectOk(SessionSchema, { scope: "per-sender" });
    expectOk(SessionSchema, { scope: "global" });
    expectOk(SessionSchema, { dmScope: "main" });
    expectOk(SessionSchema, { dmScope: "per-peer" });
    expectOk(SessionSchema, { dmScope: "per-channel-peer" });
    expectOk(SessionSchema, { dmScope: "per-account-channel-peer" });
  });

  it("rejects unknown scope and dmScope values", () => {
    expectFail(SessionSchema, { scope: "per-room" });
    expectFail(SessionSchema, { dmScope: "per-account" });
    expectFail(SessionSchema, { scope: 1 });
  });
});

describe("SessionSchema identityLinks and resetTriggers", () => {
  it("accepts an empty record, an empty queue, a single element, and preserves order", () => {
    expectOk(SessionSchema, { identityLinks: {} });
    expectOk(SessionSchema, { identityLinks: { alice: [] } });
    expectOk(SessionSchema, { identityLinks: { alice: ["telegram:1"] } });
    const ordered = { resetTriggers: ["b", "a", "b"] };
    expectOk(SessionSchema, ordered);
    const parsed = SessionSchema.safeParse(ordered);
    expect(parsed.success).toBe(true);
    if (parsed.success)
      expect(parsed.data?.resetTriggers).toEqual(["b", "a", "b"]);
  });

  it("treats a missing identity link as absent rather than inventing one", () => {
    const parsed = SessionSchema.safeParse({
      identityLinks: { alice: ["telegram:1"] },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data?.identityLinks?.bob).toBeUndefined();
      expect("bob" in (parsed.data?.identityLinks ?? {})).toBe(false);
    }
  });

  it("rejects non-string link values and non-string reset triggers", () => {
    expectFail(SessionSchema, { identityLinks: { alice: [1] } });
    expectFail(SessionSchema, { identityLinks: { alice: "telegram:1" } });
    expectFail(SessionSchema, { resetTriggers: [1] });
    expectFail(SessionSchema, { resetTriggers: "reset" });
  });
});

describe("SessionSchema reset schedules and overflow", () => {
  it("accepts idleMinutes at 1 and reset hour bounds 0 and 23", () => {
    expectOk(SessionSchema, { idleMinutes: 1 });
    expectOk(SessionSchema, { reset: {} });
    expectOk(SessionSchema, { reset: { mode: "daily", atHour: 0 } });
    expectOk(SessionSchema, {
      reset: { mode: "idle", atHour: 23, idleMinutes: 1 },
    });
  });

  it("rejects zero/negative idleMinutes and atHour overflow past 23", () => {
    expectFail(SessionSchema, { idleMinutes: 0 });
    expectFail(SessionSchema, { idleMinutes: -1 });
    expectFail(SessionSchema, { idleMinutes: 1.5 });
    expectFail(SessionSchema, { reset: { atHour: -1 } });
    expectFail(SessionSchema, { reset: { atHour: 24 } });
    expectFail(SessionSchema, { reset: { atHour: 4.5 } });
    expectFail(SessionSchema, { reset: { idleMinutes: 0 } });
    expectFail(SessionSchema, { reset: { mode: "weekly" } });
  });

  it("rejects unknown reset keys (strict nested object)", () => {
    expectFail(SessionSchema, { reset: { extra: true } });
  });
});

describe("SessionSchema resetByType, resetByChannel, and ties", () => {
  it("accepts any subset of dm/group/thread and a missing chat type", () => {
    expectOk(SessionSchema, { resetByType: {} });
    expectOk(SessionSchema, {
      resetByType: { dm: { mode: "idle", idleMinutes: 8 } },
    });
    const parsed = SessionSchema.safeParse({
      resetByType: { dm: { mode: "daily", atHour: 1 } },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data?.resetByType?.group).toBeUndefined();
      expect(parsed.data?.resetByType?.thread).toBeUndefined();
    }
  });

  it("accepts overlapping reset, resetByType, and resetByChannel without dropping any", () => {
    const tied = {
      reset: { mode: "daily" as const, atHour: 6 },
      resetByType: { group: { mode: "idle" as const, idleMinutes: 20 } },
      resetByChannel: { discord: { mode: "daily" as const, atHour: 9 } },
    };
    const parsed = SessionSchema.safeParse(tied);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data?.reset).toEqual({ mode: "daily", atHour: 6 });
      expect(parsed.data?.resetByType?.group).toEqual({
        mode: "idle",
        idleMinutes: 20,
      });
      expect(parsed.data?.resetByChannel?.discord).toEqual({
        mode: "daily",
        atHour: 9,
      });
      expect(parsed.data?.resetByChannel?.telegram).toBeUndefined();
    }
  });

  it("rejects an unknown resetByType key and a nested overflow", () => {
    expectFail(SessionSchema, { resetByType: { channel: { mode: "daily" } } });
    expectFail(SessionSchema, {
      resetByChannel: { telegram: { atHour: 24 } },
    });
    expectFail(SessionSchema, {
      resetByChannel: { telegram: { extra: true } },
    });
  });
});

describe("SessionSchema typing, store, sendPolicy, and ping-pong capacity", () => {
  it("accepts every typingMode and ping-pong bounds 0 and 5", () => {
    expectOk(SessionSchema, { store: "memory", mainKey: "main" });
    expectOk(SessionSchema, { typingIntervalSeconds: 1, typingMode: "never" });
    expectOk(SessionSchema, { typingMode: "instant" });
    expectOk(SessionSchema, { typingMode: "thinking" });
    expectOk(SessionSchema, { typingMode: "message" });
    expectOk(SessionSchema, { agentToAgent: {} });
    expectOk(SessionSchema, { agentToAgent: { maxPingPongTurns: 0 } });
    expectOk(SessionSchema, { agentToAgent: { maxPingPongTurns: 5 } });
  });

  it("rejects typing/ping-pong overflow and unknown nested keys", () => {
    expectFail(SessionSchema, { typingIntervalSeconds: 0 });
    expectFail(SessionSchema, { typingMode: "always" });
    expectFail(SessionSchema, { agentToAgent: { maxPingPongTurns: -1 } });
    expectFail(SessionSchema, { agentToAgent: { maxPingPongTurns: 6 } });
    expectFail(SessionSchema, { agentToAgent: { extra: true } });
    expectFail(SessionSchema, { sendPolicy: { default: "maybe" } });
  });
});

describe("MessagesSchema", () => {
  it("accepts omission, an empty object, and prefix strings", () => {
    expectOk(MessagesSchema, undefined);
    expectOk(MessagesSchema, {});
    expectOk(MessagesSchema, { messagePrefix: "[", responsePrefix: "]" });
  });

  it("rejects a non-object root and unknown top-level keys (strict)", () => {
    expectFail(MessagesSchema, null);
    expectFail(MessagesSchema, []);
    expectFail(MessagesSchema, { extra: true });
  });

  it("accepts groupChat empty mention queue, single pattern, and ordered patterns", () => {
    expectOk(MessagesSchema, { groupChat: {} });
    expectOk(MessagesSchema, { groupChat: { mentionPatterns: [] } });
    expectOk(MessagesSchema, {
      groupChat: { mentionPatterns: ["@bot"], historyLimit: 1 },
    });
    const ordered = { groupChat: { mentionPatterns: ["b", "a"] } };
    const parsed = MessagesSchema.safeParse(ordered);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data?.groupChat?.mentionPatterns).toEqual(["b", "a"]);
    }
  });

  it("rejects groupChat overflow, unknown keys, and non-string patterns", () => {
    expectFail(MessagesSchema, { groupChat: { historyLimit: 0 } });
    expectFail(MessagesSchema, { groupChat: { extra: true } });
    expectFail(MessagesSchema, { groupChat: { mentionPatterns: [1] } });
  });
});

describe("MessagesSchema inbound queue and debounce", () => {
  it("accepts every queue mode and drop policy, including cap 1 and debounce 0", () => {
    for (const mode of [
      "steer",
      "followup",
      "collect",
      "steer-backlog",
      "steer+backlog",
      "queue",
      "interrupt",
    ] as const) {
      expectOk(MessagesSchema, { queue: { mode } });
    }
    expectOk(MessagesSchema, { queue: { drop: "old" } });
    expectOk(MessagesSchema, { queue: { drop: "new" } });
    expectOk(MessagesSchema, { queue: { drop: "summarize" } });
    expectOk(MessagesSchema, { queue: { cap: 1, debounceMs: 0 } });
    expectOk(MessagesSchema, {
      queue: {
        byChannel: { telegram: "steer", discord: "interrupt" },
        debounceMsByChannel: { telegram: 0, "unknown-surface": 25 },
      },
    });
    expectOk(MessagesSchema, {
      inbound: { debounceMs: 0, byChannel: { slack: 10 } },
    });
  });

  it("rejects queue cap/debounce overflow, unknown modes, and unknown byChannel keys", () => {
    expectFail(MessagesSchema, { queue: { cap: 0 } });
    expectFail(MessagesSchema, { queue: { cap: -1 } });
    expectFail(MessagesSchema, { queue: { debounceMs: -1 } });
    expectFail(MessagesSchema, { queue: { mode: "drop" } });
    expectFail(MessagesSchema, { queue: { drop: "newest" } });
    expectFail(MessagesSchema, { queue: { extra: true } });
    expectFail(MessagesSchema, { queue: { byChannel: { irc: "steer" } } });
    expectFail(MessagesSchema, { inbound: { debounceMs: -1 } });
    expectFail(MessagesSchema, { inbound: { extra: true } });
  });
});

describe("MessagesSchema ack reactions and tts", () => {
  it("accepts every ackReactionScope and a nested tts config", () => {
    expectOk(MessagesSchema, { ackReaction: "👀", removeAckAfterReply: true });
    expectOk(MessagesSchema, { ackReactionScope: "group-mentions" });
    expectOk(MessagesSchema, { ackReactionScope: "group-all" });
    expectOk(MessagesSchema, { ackReactionScope: "direct" });
    expectOk(MessagesSchema, { ackReactionScope: "all" });
    expectOk(MessagesSchema, {
      tts: {
        auto: "tagged",
        enabled: true,
        provider: "elevenlabs",
        mode: "final",
      },
    });
  });

  it("rejects unknown ack scope, non-boolean removeAckAfterReply, and invalid tts", () => {
    expectFail(MessagesSchema, { ackReactionScope: "mentions" });
    expectFail(MessagesSchema, { removeAckAfterReply: "yes" });
    expectFail(MessagesSchema, { tts: { auto: "sometimes" } });
    expectFail(MessagesSchema, { tts: { extra: true } });
  });
});

describe("CommandsSchema", () => {
  const defaults = { native: "auto", nativeSkills: "auto" };

  it("applies native/nativeSkills auto defaults for omission and empty object", () => {
    expectOk(CommandsSchema, undefined, defaults);
    expectOk(CommandsSchema, {}, defaults);
    expectOk(CommandsSchema, { text: true }, { ...defaults, text: true });
  });

  it("accepts boolean and auto native settings without replacing an explicit false", () => {
    expectOk(
      CommandsSchema,
      { native: true, nativeSkills: false },
      {
        native: true,
        nativeSkills: false,
      },
    );
    expectOk(
      CommandsSchema,
      { native: "auto", nativeSkills: "auto" },
      defaults,
    );
  });

  it("accepts bashForegroundMs bounds 0 and 30000 and boolean command toggles", () => {
    expectOk(
      CommandsSchema,
      {
        text: false,
        bash: true,
        bashForegroundMs: 0,
        config: true,
        debug: false,
        restart: true,
        useAccessGroups: false,
      },
      {
        ...defaults,
        text: false,
        bash: true,
        bashForegroundMs: 0,
        config: true,
        debug: false,
        restart: true,
        useAccessGroups: false,
      },
    );
    expectOk(
      CommandsSchema,
      { bashForegroundMs: 30_000 },
      {
        ...defaults,
        bashForegroundMs: 30_000,
      },
    );
  });

  it("rejects overflow past 30000, unknown native values, and extra keys", () => {
    expectFail(CommandsSchema, { bashForegroundMs: -1 });
    expectFail(CommandsSchema, { bashForegroundMs: 30_001 });
    expectFail(CommandsSchema, { bashForegroundMs: 1.5 });
    expectFail(CommandsSchema, { native: "manual" });
    expectFail(CommandsSchema, { nativeSkills: "always" });
    expectFail(CommandsSchema, { extra: true });
    expectFail(CommandsSchema, { text: "yes" });
    expectFail(CommandsSchema, null);
    expectFail(CommandsSchema, []);
  });
});
