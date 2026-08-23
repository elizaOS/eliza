/**
 * Pins the agent-scoped `types.messages` compatibility barrel. The file itself
 * is `export * from "@elizaos/shared"` so plugin and app-shell imports of
 * `@elizaos/agent/config/types.messages` receive the shared message-queue,
 * inbound-debounce, TTS, broadcast, and commands contracts. Type exports have
 * no runtime values; the Zod schemas that enforce those contracts do, and this
 * suite drives those schemas through this barrel (empty / single / overflow /
 * missing-key / extra-key). Deterministic, no live services.
 */
import {
  GroupChatSchema as SharedGroupChatSchema,
  InboundDebounceSchema as SharedInboundDebounceSchema,
  QueueDropSchema as SharedQueueDropSchema,
  QueueModeSchema as SharedQueueModeSchema,
  QueueSchema as SharedQueueSchema,
  TtsConfigSchema as SharedTtsConfigSchema,
} from "@elizaos/shared";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type AudioConfig,
  type BroadcastConfig,
  type BroadcastStrategy,
  type CommandsConfig,
  DebounceMsBySurfaceSchema,
  GroupChatSchema,
  type InboundDebounceByProvider,
  type InboundDebounceConfig,
  InboundDebounceSchema,
  type MessagesConfig,
  NativeCommandsSettingSchema,
  type QueueConfig,
  type QueueDropPolicy,
  QueueDropSchema,
  type QueueMode,
  type QueueModeByProvider,
  QueueModeBySurfaceSchema,
  QueueModeSchema,
  QueueSchema,
  type TtsAutoMode,
  type TtsConfig,
  TtsConfigSchema,
  type TtsMode,
  type TtsModelOverrideConfig,
  TtsModeSchema,
  type TtsProvider,
  TtsProviderSchema,
} from "./types.messages.ts";

const QUEUE_MODES = [
  "steer",
  "followup",
  "collect",
  "steer-backlog",
  "steer+backlog",
  "queue",
  "interrupt",
] as const satisfies readonly QueueMode[];

const QUEUE_DROPS = [
  "old",
  "new",
  "summarize",
] as const satisfies readonly QueueDropPolicy[];

const QUEUE_SURFACES = [
  "whatsapp",
  "telegram",
  "discord",
  "slack",
  "mattermost",
  "imessage",
  "msteams",
  "webchat",
] as const;

function literalUnionValues(
  schema: typeof QueueModeSchema | typeof QueueDropSchema,
): string[] {
  return schema.options.map((option) => option.value);
}

describe("types.messages barrel", () => {
  it("re-exports the shared message-queue schemas by identity", () => {
    expect(QueueSchema).toBe(SharedQueueSchema);
    expect(QueueModeSchema).toBe(SharedQueueModeSchema);
    expect(QueueDropSchema).toBe(SharedQueueDropSchema);
    expect(InboundDebounceSchema).toBe(SharedInboundDebounceSchema);
    expect(TtsConfigSchema).toBe(SharedTtsConfigSchema);
    expect(GroupChatSchema).toBe(SharedGroupChatSchema);
  });
});

describe("QueueMode / QueueDropPolicy", () => {
  it("accepts every documented queue mode and drop policy", () => {
    expect(literalUnionValues(QueueModeSchema)).toEqual([...QUEUE_MODES]);
    expect(literalUnionValues(QueueDropSchema)).toEqual([...QUEUE_DROPS]);
    for (const mode of QUEUE_MODES) {
      expect(QueueModeSchema.parse(mode)).toBe(mode);
    }
    for (const drop of QUEUE_DROPS) {
      expect(QueueDropSchema.parse(drop)).toBe(drop);
    }
  });

  it("rejects unknown modes, drop policies, and empty strings", () => {
    expect(QueueModeSchema.safeParse("").success).toBe(false);
    expect(QueueModeSchema.safeParse("interrupt-all").success).toBe(false);
    expect(QueueModeSchema.safeParse("QUEUE").success).toBe(false);
    expect(QueueDropSchema.safeParse("oldest").success).toBe(false);
    expect(QueueDropSchema.safeParse("").success).toBe(false);
    expect(QueueModeSchema.safeParse(undefined).success).toBe(false);
  });

  it("pins the TypeScript unions to the runtime schema literals", () => {
    expectTypeOf<QueueMode>().toEqualTypeOf<(typeof QUEUE_MODES)[number]>();
    expectTypeOf<QueueDropPolicy>().toEqualTypeOf<
      (typeof QUEUE_DROPS)[number]
    >();
  });
});

describe("QueueSchema", () => {
  it("treats an omitted / empty queue as valid (no items, no overflow)", () => {
    expect(QueueSchema.parse(undefined)).toBeUndefined();
    expect(QueueSchema.parse({})).toEqual({});
  });

  it("accepts a single-element queue (one mode, cap 1, drop old)", () => {
    expect(
      QueueSchema.parse({
        mode: "queue",
        cap: 1,
        drop: "old",
        debounceMs: 0,
      }),
    ).toEqual({
      mode: "queue",
      cap: 1,
      drop: "old",
      debounceMs: 0,
    });
  });

  it("accepts every mode and drop pairing without reordering keys", () => {
    for (const mode of QUEUE_MODES) {
      for (const drop of QUEUE_DROPS) {
        expect(QueueSchema.parse({ mode, drop })).toEqual({ mode, drop });
      }
    }
  });

  it("rejects capacity overflow and non-integer caps", () => {
    expect(QueueSchema.safeParse({ cap: 0 }).success).toBe(false);
    expect(QueueSchema.safeParse({ cap: -1 }).success).toBe(false);
    expect(QueueSchema.safeParse({ cap: 1.5 }).success).toBe(false);
    expect(QueueSchema.parse({ cap: 2 })).toEqual({ cap: 2 });
  });

  it("rejects a missing drop policy value and unknown extra keys", () => {
    expect(QueueSchema.safeParse({ drop: "missing" }).success).toBe(false);
    expect(QueueSchema.safeParse({ mode: "queue", extra: true }).success).toBe(
      false,
    );
  });

  it("rejects a negative debounce and accepts a zero debounce", () => {
    expect(QueueSchema.safeParse({ debounceMs: -1 }).success).toBe(false);
    expect(QueueSchema.parse({ debounceMs: 0 })).toEqual({ debounceMs: 0 });
  });
});

describe("QueueModeBySurfaceSchema", () => {
  it("accepts an empty channel map and a single known channel", () => {
    expect(QueueModeBySurfaceSchema.parse(undefined)).toBeUndefined();
    expect(QueueModeBySurfaceSchema.parse({})).toEqual({});
    expect(QueueModeBySurfaceSchema.parse({ telegram: "collect" })).toEqual({
      telegram: "collect",
    });
  });

  it("accepts the same mode on every known surface (ties keep insertion values)", () => {
    const tied = Object.fromEntries(
      QUEUE_SURFACES.map((surface) => [surface, "followup"]),
    );
    expect(QueueModeBySurfaceSchema.parse(tied)).toEqual(tied);
  });

  it("rejects a missing / retired channel key (signal, googlechat)", () => {
    expect(
      QueueModeBySurfaceSchema.safeParse({ signal: "collect" }).success,
    ).toBe(false);
    expect(
      QueueModeBySurfaceSchema.safeParse({ googlechat: "queue" }).success,
    ).toBe(false);
    expect(
      QueueModeBySurfaceSchema.safeParse({ unknown: "steer" }).success,
    ).toBe(false);
  });

  it("keeps mattermost on the schema even though QueueModeByProvider omits it", () => {
    expect(QueueModeBySurfaceSchema.parse({ mattermost: "interrupt" })).toEqual(
      { mattermost: "interrupt" },
    );
  });

  it("rejects an unknown mode on an otherwise valid channel", () => {
    expect(
      QueueModeBySurfaceSchema.safeParse({ discord: "pause" }).success,
    ).toBe(false);
  });
});

describe("InboundDebounceSchema", () => {
  it("accepts empty inbound config and a single per-channel override", () => {
    expect(InboundDebounceSchema.parse(undefined)).toBeUndefined();
    expect(InboundDebounceSchema.parse({})).toEqual({});
    expect(
      InboundDebounceSchema.parse({
        debounceMs: 0,
        byChannel: { telegram: 250 },
      }),
    ).toEqual({ debounceMs: 0, byChannel: { telegram: 250 } });
  });

  it("rejects negative debounce values (global and per-channel)", () => {
    expect(InboundDebounceSchema.safeParse({ debounceMs: -1 }).success).toBe(
      false,
    );
    expect(DebounceMsBySurfaceSchema.safeParse({ telegram: -5 }).success).toBe(
      false,
    );
    expect(DebounceMsBySurfaceSchema.parse({ telegram: 0 })).toEqual({
      telegram: 0,
    });
  });
});

describe("TtsConfigSchema", () => {
  it("accepts omitted / empty TTS config", () => {
    expect(TtsConfigSchema.parse(undefined)).toBeUndefined();
    expect(TtsConfigSchema.parse({})).toEqual({});
  });

  it("accepts every documented provider, mode, and auto setting", () => {
    expect([...TtsProviderSchema.options]).toEqual([
      "elevenlabs",
      "openai",
      "edge",
    ]);
    expect([...TtsModeSchema.options]).toEqual(["final", "all"]);
    for (const provider of TtsProviderSchema.options) {
      expect(TtsConfigSchema.parse({ provider })).toEqual({ provider });
    }
    for (const mode of ["final", "all"] as const) {
      expect(TtsConfigSchema.parse({ mode })).toEqual({ mode });
    }
    for (const auto of ["off", "always", "inbound", "tagged"] as const) {
      expect(TtsConfigSchema.parse({ auto })).toEqual({ auto });
    }
  });

  it("rejects an unknown provider even though TtsProvider allows extra strings", () => {
    const custom: TtsProvider = "custom-tts";
    expect(custom).toBe("custom-tts");
    expect(TtsProviderSchema.safeParse("custom-tts").success).toBe(false);
    expect(TtsConfigSchema.safeParse({ provider: "custom-tts" }).success).toBe(
      false,
    );
  });

  it("enforces timeout and maxTextLength overflow bounds", () => {
    expect(TtsConfigSchema.safeParse({ timeoutMs: 999 }).success).toBe(false);
    expect(TtsConfigSchema.safeParse({ timeoutMs: 120_001 }).success).toBe(
      false,
    );
    expect(TtsConfigSchema.parse({ timeoutMs: 1000 })).toEqual({
      timeoutMs: 1000,
    });
    expect(TtsConfigSchema.safeParse({ maxTextLength: 0 }).success).toBe(false);
    expect(TtsConfigSchema.parse({ maxTextLength: 1 })).toEqual({
      maxTextLength: 1,
    });
  });

  it("enforces ElevenLabs seed and voice-setting bounds", () => {
    expect(
      TtsConfigSchema.safeParse({
        elevenlabs: { seed: -1 },
      }).success,
    ).toBe(false);
    expect(
      TtsConfigSchema.safeParse({
        elevenlabs: { seed: 4_294_967_296 },
      }).success,
    ).toBe(false);
    expect(
      TtsConfigSchema.parse({
        elevenlabs: { seed: 0, voiceSettings: { stability: 0, speed: 0.5 } },
      }),
    ).toEqual({
      elevenlabs: { seed: 0, voiceSettings: { stability: 0, speed: 0.5 } },
    });
    expect(
      TtsConfigSchema.safeParse({
        elevenlabs: { voiceSettings: { speed: 0.49 } },
      }).success,
    ).toBe(false);
    expect(
      TtsConfigSchema.safeParse({
        elevenlabs: { voiceSettings: { stability: 1.1 } },
      }).success,
    ).toBe(false);
  });

  it("rejects extra TTS keys", () => {
    expect(TtsConfigSchema.safeParse({ unknown: true }).success).toBe(false);
  });
});

describe("GroupChatSchema and NativeCommandsSettingSchema", () => {
  it("accepts empty group-chat config and a single mention pattern", () => {
    expect(GroupChatSchema.parse(undefined)).toBeUndefined();
    expect(GroupChatSchema.parse({})).toEqual({});
    expect(
      GroupChatSchema.parse({
        mentionPatterns: ["@eliza"],
        historyLimit: 1,
      }),
    ).toEqual({ mentionPatterns: ["@eliza"], historyLimit: 1 });
  });

  it("rejects a missing / overflow historyLimit", () => {
    expect(GroupChatSchema.safeParse({ historyLimit: 0 }).success).toBe(false);
    expect(GroupChatSchema.safeParse({ historyLimit: -1 }).success).toBe(false);
    expect(GroupChatSchema.safeParse({ extra: true }).success).toBe(false);
  });

  it("accepts boolean and auto native-command settings", () => {
    expect(NativeCommandsSettingSchema.parse(true)).toBe(true);
    expect(NativeCommandsSettingSchema.parse(false)).toBe(false);
    expect(NativeCommandsSettingSchema.parse("auto")).toBe("auto");
    expect(NativeCommandsSettingSchema.safeParse("always").success).toBe(false);
  });
});

describe("exported TypeScript contracts", () => {
  it("pins MessagesConfig optional fields used by the config tree", () => {
    const empty: MessagesConfig = {};
    const full: MessagesConfig = {
      responsePrefix: "[{model}]",
      queue: { mode: "steer", cap: 8, drop: "summarize" },
      inbound: { debounceMs: 50, byChannel: { discord: 100 } },
      ackReaction: "✅",
      ackReactionScope: "group-mentions",
      removeAckAfterReply: true,
      tts: { auto: "inbound", provider: "edge" },
    };
    expect(empty).toEqual({});
    expect(full.ackReactionScope).toBe("group-mentions");
    expectTypeOf<MessagesConfig["ackReactionScope"]>().toEqualTypeOf<
      "group-mentions" | "group-all" | "direct" | "all" | undefined
    >();
    expectTypeOf<QueueConfig["mode"]>().toEqualTypeOf<QueueMode | undefined>();
    expectTypeOf<InboundDebounceConfig["byChannel"]>().toEqualTypeOf<
      InboundDebounceByProvider | undefined
    >();
  });

  it("pins QueueModeByProvider keys that the Zod surface no longer accepts", () => {
    const typed: QueueModeByProvider = {
      signal: "collect",
      googlechat: "queue",
    };
    expect(typed.signal).toBe("collect");
    expect(
      QueueModeBySurfaceSchema.safeParse({ signal: "collect" }).success,
    ).toBe(false);
    expect(
      QueueModeBySurfaceSchema.safeParse({ googlechat: "queue" }).success,
    ).toBe(false);
  });

  it("pins broadcast strategy and open-ended audio config", () => {
    expectTypeOf<BroadcastStrategy>().toEqualTypeOf<
      "parallel" | "sequential"
    >();
    const broadcast: BroadcastConfig = {
      strategy: "parallel",
      "peer-a": ["agent-1", "agent-2"],
    };
    expect(broadcast.strategy).toBe("parallel");
    expect(broadcast["peer-a"]).toEqual(["agent-1", "agent-2"]);
    const audio: AudioConfig = { transcription: { command: ["whisper"] } };
    expect(audio.transcription).toEqual({ command: ["whisper"] });
  });

  it("pins commands and TTS override shapes", () => {
    const commands: CommandsConfig = {
      native: "auto",
      nativeSkills: false,
      text: true,
      bash: false,
      bashForegroundMs: 0,
      config: false,
      debug: false,
      restart: false,
      useAccessGroups: true,
    };
    expect(commands.bashForegroundMs).toBe(0);
    const overrides: TtsModelOverrideConfig = {
      enabled: true,
      allowText: true,
      allowProvider: false,
    };
    expect(overrides.allowProvider).toBe(false);
    expectTypeOf<TtsMode>().toEqualTypeOf<"final" | "all">();
    expectTypeOf<TtsAutoMode>().toEqualTypeOf<
      "off" | "always" | "inbound" | "tagged"
    >();
    expectTypeOf<"elevenlabs">().toMatchTypeOf<TtsProvider>();
    expectTypeOf<TtsConfig["provider"]>().toEqualTypeOf<
      TtsProvider | undefined
    >();
  });
});
