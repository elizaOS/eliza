/**
 * Behavioral coverage for the agent config zod primitives in zod-schema.core.ts:
 * enum/union membership, strict unknown-key rejection, required vs optional
 * fields, numeric bounds (including queue cap and seed overflow), model-definition
 * defaults, exec-safety on transcribe/executable tokens, and the open-policy
 * allowFrom helper. Deterministic; drives the real schemas with no mocks.
 */
import { describe, expect, it } from "vitest";
import * as zod from "zod";
import {
  DEFAULT_MODEL_CONTEXT_WINDOW,
  DEFAULT_MODEL_MAX_TOKENS,
} from "./model-metadata.ts";
import {
  AudioElevenlabsConfigSchema,
  AudioElevenlabsSfxConfigSchema,
  AudioElevenlabsVoiceSettingsSchema,
  AudioFalConfigSchema,
  AudioGenConfigSchema,
  AudioGenProviderSchema,
  AudioKindSchema,
  AudioProviderRoutingConfigSchema,
  AudioSunoConfigSchema,
  BedrockDiscoverySchema,
  BlockStreamingChunkSchema,
  BlockStreamingCoalesceSchema,
  ChannelHeartbeatVisibilitySchema,
  CliBackendSchema,
  DebounceMsBySurfaceSchema,
  DmConfigSchema,
  DmPolicySchema,
  ExecutableTokenSchema,
  GroupChatSchema,
  GroupPolicySchema,
  HexColorSchema,
  HumanDelaySchema,
  IdentitySchema,
  ImageConfigSchema,
  ImageFalConfigSchema,
  ImageGoogleConfigSchema,
  ImageOpenaiConfigSchema,
  ImageProviderSchema,
  ImageXaiConfigSchema,
  InboundDebounceSchema,
  LinkModelSchema,
  MarkdownConfigSchema,
  MarkdownTableModeSchema,
  MediaConfigSchema,
  MediaModeSchema,
  MediaUnderstandingAttachmentsSchema,
  MediaUnderstandingCapabilitiesSchema,
  MediaUnderstandingModelSchema,
  MediaUnderstandingScopeSchema,
  MessagePolicySchema,
  ModelApiSchema,
  ModelCompatSchema,
  ModelDefinitionSchema,
  ModelProviderSchema,
  ModelsConfigSchema,
  MSTeamsReplyStyleSchema,
  NativeCommandsSettingSchema,
  normalizeAllowFrom,
  ProviderCommandsSchema,
  QueueDropSchema,
  QueueModeBySurfaceSchema,
  QueueModeSchema,
  QueueSchema,
  ReplyToModeSchema,
  RetryConfigSchema,
  requireOpenAllowFrom,
  ToolsLinksSchema,
  ToolsMediaSchema,
  ToolsMediaUnderstandingSchema,
  TranscribeAudioSchema,
  TtsAutoSchema,
  TtsConfigSchema,
  TtsModeSchema,
  TtsProviderSchema,
  VideoConfigSchema,
  VideoFalConfigSchema,
  VideoGoogleConfigSchema,
  VideoOpenaiConfigSchema,
  VideoProviderSchema,
  VisionAnthropicConfigSchema,
  VisionConfigSchema,
  VisionGoogleConfigSchema,
  VisionOllamaConfigSchema,
  VisionOpenaiConfigSchema,
  VisionProviderSchema,
  VisionXaiConfigSchema,
} from "./zod-schema.core.ts";

const z = (zod as typeof zod & { z?: typeof zod }).z ?? zod;

function expectOk(
  schema: {
    safeParse: (
      value: unknown,
    ) => { success: true; data: unknown } | { success: false };
  },
  value: unknown,
): unknown {
  const result = schema.safeParse(value);
  expect(result.success).toBe(true);
  if (!result.success) {
    throw new Error("expected parse success");
  }
  return result.data;
}

function expectFail(
  schema: { safeParse: (value: unknown) => { success: boolean } },
  value: unknown,
): void {
  expect(schema.safeParse(value).success).toBe(false);
}

const OpenAllowFromSchema = z
  .object({
    policy: z.string().optional(),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
  })
  .superRefine((value, ctx) => {
    requireOpenAllowFrom({
      policy: value.policy,
      allowFrom: value.allowFrom,
      ctx,
      path: ["allowFrom"],
      message: "open policy requires allowFrom to include *",
    });
  });

describe("ModelApiSchema", () => {
  it.each([
    "openai-completions",
    "openai-responses",
    "anthropic-messages",
    "google-generative-ai",
    "bedrock-converse-stream",
  ] as const)("accepts %s", (value) => {
    expect(expectOk(ModelApiSchema, value)).toBe(value);
  });

  it("rejects unknown dialects, empty string, and non-strings", () => {
    expectFail(ModelApiSchema, "openai");
    expectFail(ModelApiSchema, "");
    expectFail(ModelApiSchema, 1);
    expectFail(ModelApiSchema, undefined);
  });
});

describe("ModelCompatSchema", () => {
  it("accepts omission, an empty object, and each optional flag", () => {
    expect(expectOk(ModelCompatSchema, undefined)).toBeUndefined();
    expect(expectOk(ModelCompatSchema, {})).toEqual({});
    expectOk(ModelCompatSchema, {
      supportsStore: true,
      supportsDeveloperRole: false,
      supportsReasoningEffort: true,
      maxTokensField: "max_completion_tokens",
    });
    expectOk(ModelCompatSchema, { maxTokensField: "max_tokens" });
  });

  it("rejects unknown keys, invalid maxTokensField, and null", () => {
    expectFail(ModelCompatSchema, { extra: true });
    expectFail(ModelCompatSchema, { maxTokensField: "max_output_tokens" });
    expectFail(ModelCompatSchema, { supportsStore: "yes" });
    expectFail(ModelCompatSchema, null);
  });
});

describe("ModelDefinitionSchema", () => {
  it("requires a non-empty id and name", () => {
    expectFail(ModelDefinitionSchema, {});
    expectFail(ModelDefinitionSchema, { id: "gpt", name: "" });
    expectFail(ModelDefinitionSchema, { id: "", name: "GPT" });
    expectFail(ModelDefinitionSchema, { id: "gpt" });
    expectOk(ModelDefinitionSchema, { id: "gpt", name: "GPT" });
  });

  it("fills reasoning, input, cost, contextWindow, and maxTokens defaults", () => {
    expect(
      expectOk(ModelDefinitionSchema, {
        id: "gpt",
        name: "GPT",
      }),
    ).toEqual({
      id: "gpt",
      name: "GPT",
      reasoning: false,
      input: ["text"],
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      contextWindow: DEFAULT_MODEL_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MODEL_MAX_TOKENS,
    });
  });

  it("accepts a single image input and both text and image", () => {
    expect(
      expectOk(ModelDefinitionSchema, {
        id: "v",
        name: "V",
        input: ["image"],
      }),
    ).toEqual(
      expect.objectContaining({
        input: ["image"],
      }),
    );
    expectOk(ModelDefinitionSchema, {
      id: "v",
      name: "V",
      input: ["text", "image"],
    });
  });

  it("accepts an empty input queue and fills partial cost fields", () => {
    expect(
      expectOk(ModelDefinitionSchema, {
        id: "gpt",
        name: "GPT",
        input: [],
        cost: { input: 1.5 },
      }),
    ).toEqual(
      expect.objectContaining({
        input: [],
        cost: {
          input: 1.5,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
      }),
    );
  });

  it("rejects negative cost, non-positive windows, unknown keys, and bad input tokens", () => {
    expectFail(ModelDefinitionSchema, {
      id: "gpt",
      name: "GPT",
      cost: { input: -1 },
    });
    expectFail(ModelDefinitionSchema, {
      id: "gpt",
      name: "GPT",
      contextWindow: 0,
    });
    expectFail(ModelDefinitionSchema, {
      id: "gpt",
      name: "GPT",
      maxTokens: 1.5,
    });
    expectFail(ModelDefinitionSchema, {
      id: "gpt",
      name: "GPT",
      extra: true,
    });
    expectFail(ModelDefinitionSchema, {
      id: "gpt",
      name: "GPT",
      input: ["audio"],
    });
  });
});

describe("ModelProviderSchema", () => {
  it("requires a non-empty baseUrl and a models array, including the empty queue", () => {
    expectFail(ModelProviderSchema, {});
    expectFail(ModelProviderSchema, { baseUrl: "", models: [] });
    expectFail(ModelProviderSchema, {
      baseUrl: "https://api.example",
      models: undefined,
    });
    expectOk(ModelProviderSchema, {
      baseUrl: "https://api.example",
      models: [],
    });
    expectOk(ModelProviderSchema, {
      baseUrl: "https://api.example",
      models: [{ id: "gpt", name: "GPT" }],
    });
  });

  it("accepts each auth literal and rejects unknown keys or auth values", () => {
    for (const auth of ["api-key", "aws-sdk", "oauth", "token"] as const) {
      expectOk(ModelProviderSchema, {
        baseUrl: "https://api.example",
        auth,
        models: [],
      });
    }
    expectFail(ModelProviderSchema, {
      baseUrl: "https://api.example",
      auth: "basic",
      models: [],
    });
    expectFail(ModelProviderSchema, {
      baseUrl: "https://api.example",
      models: [],
      extra: true,
    });
  });
});

describe("BedrockDiscoverySchema and ModelsConfigSchema", () => {
  it("accepts omission and rejects negative refresh or non-positive defaults", () => {
    expect(expectOk(BedrockDiscoverySchema, undefined)).toBeUndefined();
    expectOk(BedrockDiscoverySchema, {
      enabled: true,
      region: "us-east-1",
      providerFilter: [],
      refreshInterval: 0,
      defaultContextWindow: 1,
      defaultMaxTokens: 1,
    });
    expectFail(BedrockDiscoverySchema, { refreshInterval: -1 });
    expectFail(BedrockDiscoverySchema, { defaultContextWindow: 0 });
    expectFail(BedrockDiscoverySchema, { extra: true });
  });

  it("accepts merge/replace mode and a single provider, and rejects unknown keys", () => {
    expect(expectOk(ModelsConfigSchema, undefined)).toBeUndefined();
    expectOk(ModelsConfigSchema, { mode: "merge", providers: {} });
    expectOk(ModelsConfigSchema, {
      mode: "replace",
      providers: { openai: { baseUrl: "https://api.openai.com", models: [] } },
    });
    expectFail(ModelsConfigSchema, { mode: "append" });
    expectFail(ModelsConfigSchema, { extra: true });
  });
});

describe("GroupChatSchema, DmConfigSchema, and IdentitySchema", () => {
  it("treats group chat as optional and rejects non-positive historyLimit", () => {
    expect(expectOk(GroupChatSchema, undefined)).toBeUndefined();
    expectOk(GroupChatSchema, { mentionPatterns: [], historyLimit: 1 });
    expectFail(GroupChatSchema, { historyLimit: 0 });
    expectFail(GroupChatSchema, { extra: true });
  });

  it("allows DmConfig historyLimit of 0 and rejects negatives and extra keys", () => {
    expectOk(DmConfigSchema, {});
    expectOk(DmConfigSchema, { historyLimit: 0 });
    expectFail(DmConfigSchema, { historyLimit: -1 });
    expectFail(DmConfigSchema, { extra: true });
    expectFail(DmConfigSchema, undefined);
  });

  it("accepts identity omission and each optional field, and is strict", () => {
    expect(expectOk(IdentitySchema, undefined)).toBeUndefined();
    expectOk(IdentitySchema, {
      name: "Ada",
      theme: "dark",
      emoji: "?",
      avatar: "https://example/a.png",
    });
    expectFail(IdentitySchema, { extra: true });
  });
});

describe("queue, reply, and policy enums", () => {
  it.each([
    "steer",
    "followup",
    "collect",
    "steer-backlog",
    "steer+backlog",
    "queue",
    "interrupt",
  ] as const)("QueueModeSchema accepts %s", (value) => {
    expect(expectOk(QueueModeSchema, value)).toBe(value);
  });

  it("QueueModeSchema rejects unknown modes", () => {
    expectFail(QueueModeSchema, "drop");
    expectFail(QueueModeSchema, "");
  });

  it.each(["old", "new", "summarize"] as const)(
    "QueueDropSchema accepts %s",
    (value) => {
      expect(expectOk(QueueDropSchema, value)).toBe(value);
    },
  );

  it("QueueDropSchema rejects an unknown drop policy", () => {
    expectFail(QueueDropSchema, "keep");
  });

  it.each(["off", "first", "all"] as const)(
    "ReplyToModeSchema accepts %s",
    (value) => {
      expect(expectOk(ReplyToModeSchema, value)).toBe(value);
    },
  );

  it.each(["open", "disabled", "allowlist"] as const)(
    "GroupPolicySchema accepts %s",
    (value) => {
      expect(expectOk(GroupPolicySchema, value)).toBe(value);
    },
  );

  it.each(["pairing", "allowlist", "open", "disabled"] as const)(
    "DmPolicySchema accepts %s",
    (value) => {
      expect(expectOk(DmPolicySchema, value)).toBe(value);
    },
  );

  it.each(["thread", "top-level"] as const)(
    "MSTeamsReplyStyleSchema accepts %s",
    (value) => {
      expect(expectOk(MSTeamsReplyStyleSchema, value)).toBe(value);
    },
  );

  it("rejects values that are not members of those enums", () => {
    expectFail(ReplyToModeSchema, "last");
    expectFail(GroupPolicySchema, "blocklist");
    expectFail(DmPolicySchema, "everyone");
    expectFail(MSTeamsReplyStyleSchema, "reply");
  });
});

describe("BlockStreamingCoalesceSchema and BlockStreamingChunkSchema", () => {
  it("accepts empty objects and bound values, including idleMs 0", () => {
    expectOk(BlockStreamingCoalesceSchema, {});
    expectOk(BlockStreamingCoalesceSchema, {
      minChars: 1,
      maxChars: 2,
      idleMs: 0,
    });
    expectOk(BlockStreamingChunkSchema, {
      minChars: 1,
      maxChars: 80,
      breakPreference: "paragraph",
    });
    expectOk(BlockStreamingChunkSchema, { breakPreference: "newline" });
    expectOk(BlockStreamingChunkSchema, { breakPreference: "sentence" });
  });

  it("rejects non-positive char bounds, negative idle, and unknown breakPreference", () => {
    expectFail(BlockStreamingCoalesceSchema, { minChars: 0 });
    expectFail(BlockStreamingCoalesceSchema, { idleMs: -1 });
    expectFail(BlockStreamingCoalesceSchema, { extra: true });
    expectFail(BlockStreamingChunkSchema, { breakPreference: "word" });
    expectFail(BlockStreamingChunkSchema, { extra: true });
  });
});

describe("MarkdownConfigSchema", () => {
  it.each(["off", "bullets", "code"] as const)(
    "accepts tables mode %s",
    (tables) => {
      expectOk(MarkdownConfigSchema, { tables });
    },
  );

  it("accepts omission and rejects unknown table modes or keys", () => {
    expect(expectOk(MarkdownConfigSchema, undefined)).toBeUndefined();
    expectFail(MarkdownTableModeSchema, "html");
    expectFail(MarkdownConfigSchema, { extra: true });
  });
});

describe("TtsConfigSchema", () => {
  it("accepts each provider/mode/auto enum and a fully populated config", () => {
    expectOk(TtsProviderSchema, "elevenlabs");
    expectOk(TtsProviderSchema, "openai");
    expectOk(TtsProviderSchema, "edge");
    expectOk(TtsModeSchema, "final");
    expectOk(TtsModeSchema, "all");
    expectOk(TtsAutoSchema, "off");
    expectOk(TtsAutoSchema, "always");
    expectOk(TtsAutoSchema, "inbound");
    expectOk(TtsAutoSchema, "tagged");
    expect(expectOk(TtsConfigSchema, undefined)).toBeUndefined();
    expectOk(TtsConfigSchema, {
      auto: "tagged",
      enabled: true,
      mode: "final",
      provider: "elevenlabs",
      elevenlabs: {
        seed: 0,
        applyTextNormalization: "auto",
        voiceSettings: {
          stability: 0,
          similarityBoost: 1,
          style: 0.5,
          speed: 0.5,
        },
      },
      openai: { voice: "alloy" },
      edge: { timeoutMs: 1000 },
      maxTextLength: 1,
      timeoutMs: 120000,
    });
  });

  it("rejects seed overflow, speed out of range, timeout bounds, and extra keys", () => {
    expectFail(TtsConfigSchema, {
      elevenlabs: { seed: 4294967296 },
    });
    expectFail(TtsConfigSchema, {
      elevenlabs: { seed: -1 },
    });
    expectFail(TtsConfigSchema, {
      elevenlabs: { voiceSettings: { speed: 0.49 } },
    });
    expectFail(TtsConfigSchema, {
      elevenlabs: { voiceSettings: { speed: 2.01 } },
    });
    expectFail(TtsConfigSchema, { timeoutMs: 999 });
    expectFail(TtsConfigSchema, { timeoutMs: 120001 });
    expectFail(TtsConfigSchema, { extra: true });
    expectFail(TtsProviderSchema, "google");
  });
});

describe("HumanDelaySchema", () => {
  it("accepts each mode and nonnegative bounds, including 0", () => {
    expectOk(HumanDelaySchema, {});
    expectOk(HumanDelaySchema, { mode: "off", minMs: 0, maxMs: 0 });
    expectOk(HumanDelaySchema, { mode: "natural" });
    expectOk(HumanDelaySchema, { mode: "custom", minMs: 10, maxMs: 20 });
  });

  it("rejects unknown mode, negatives, and extra keys", () => {
    expectFail(HumanDelaySchema, { mode: "fast" });
    expectFail(HumanDelaySchema, { minMs: -1 });
    expectFail(HumanDelaySchema, { extra: true });
    expectFail(HumanDelaySchema, undefined);
  });
});

describe("CliBackendSchema", () => {
  it("requires command and accepts empty args plus each session/output literal", () => {
    expectFail(CliBackendSchema, {});
    expectOk(CliBackendSchema, { command: "" });
    expectOk(CliBackendSchema, {
      command: "claude",
      args: [],
      output: "json",
      resumeOutput: "jsonl",
      input: "stdin",
      sessionMode: "always",
      systemPromptMode: "append",
      systemPromptWhen: "first",
      imageMode: "repeat",
    });
    expectOk(CliBackendSchema, {
      command: "claude",
      output: "text",
      resumeOutput: "text",
      input: "arg",
      sessionMode: "existing",
      systemPromptMode: "replace",
      systemPromptWhen: "always",
      imageMode: "list",
    });
    expectOk(CliBackendSchema, {
      command: "claude",
      sessionMode: "none",
      systemPromptWhen: "never",
    });
  });

  it("rejects unknown literals, non-positive maxPromptArgChars, and extra keys", () => {
    expectFail(CliBackendSchema, { command: "c", output: "yaml" });
    expectFail(CliBackendSchema, { command: "c", maxPromptArgChars: 0 });
    expectFail(CliBackendSchema, { command: "c", extra: true });
  });
});

describe("normalizeAllowFrom", () => {
  it("treats a missing queue as empty", () => {
    expect(normalizeAllowFrom()).toEqual([]);
    expect(normalizeAllowFrom(undefined)).toEqual([]);
    expect(normalizeAllowFrom([])).toEqual([]);
  });

  it("stringifies, trims, and drops blank entries including a lone missing item", () => {
    expect(normalizeAllowFrom(["  ", "", " ada ", 7, 0, "*"])).toEqual([
      "ada",
      "7",
      "0",
      "*",
    ]);
  });
});

describe("requireOpenAllowFrom", () => {
  it("does not require * unless policy is exactly open", () => {
    expectOk(OpenAllowFromSchema, { policy: "allowlist" });
    expectOk(OpenAllowFromSchema, { policy: "Open", allowFrom: [] });
    expectOk(OpenAllowFromSchema, {});
  });

  it("accepts open policy when allowFrom includes a trimmed *", () => {
    expectOk(OpenAllowFromSchema, { policy: "open", allowFrom: ["*"] });
    expectOk(OpenAllowFromSchema, {
      policy: "open",
      allowFrom: ["  *  ", "ada"],
    });
  });

  it("rejects open policy when the allowFrom queue is empty or missing *", () => {
    expectFail(OpenAllowFromSchema, { policy: "open" });
    expectFail(OpenAllowFromSchema, { policy: "open", allowFrom: [] });
    expectFail(OpenAllowFromSchema, { policy: "open", allowFrom: ["ada"] });
    expectFail(OpenAllowFromSchema, { policy: "open", allowFrom: ["", "  "] });
    const failed = OpenAllowFromSchema.safeParse({
      policy: "open",
      allowFrom: ["ada"],
    });
    expect(failed.success).toBe(false);
    if (!failed.success) {
      expect(failed.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ["allowFrom"],
            message: "open policy requires allowFrom to include *",
          }),
        ]),
      );
    }
  });
});

describe("RetryConfigSchema", () => {
  it("accepts omission, attempts of 1, jitter at both ends, and delay 0", () => {
    expect(expectOk(RetryConfigSchema, undefined)).toBeUndefined();
    expectOk(RetryConfigSchema, {
      attempts: 1,
      minDelayMs: 0,
      maxDelayMs: 0,
      jitter: 0,
    });
    expectOk(RetryConfigSchema, { jitter: 1 });
  });

  it("rejects attempts 0, jitter overflow, and extra keys", () => {
    expectFail(RetryConfigSchema, { attempts: 0 });
    expectFail(RetryConfigSchema, { jitter: 1.01 });
    expectFail(RetryConfigSchema, { jitter: -0.01 });
    expectFail(RetryConfigSchema, { extra: true });
  });
});

describe("QueueSchema", () => {
  it("accepts omission, empty object, and a single-channel mode map", () => {
    expect(expectOk(QueueSchema, undefined)).toBeUndefined();
    expectOk(QueueSchema, {});
    expectOk(QueueSchema, {
      mode: "collect",
      byChannel: { telegram: "steer" },
      debounceMs: 0,
      debounceMsByChannel: { telegram: 0 },
      cap: 1,
      drop: "old",
    });
  });

  it("rejects unknown byChannel surfaces, including retired Signal", () => {
    expectFail(QueueSchema, { byChannel: { signal: "collect" } });
    expectFail(QueueModeBySurfaceSchema, { extra: "collect" });
  });

  it("allows unknown keys on debounceMsByChannel because it is a record", () => {
    expectOk(DebounceMsBySurfaceSchema, { signal: 10 });
    expectOk(QueueSchema, { debounceMsByChannel: { signal: 0 } });
    expectFail(DebounceMsBySurfaceSchema, { telegram: -1 });
  });

  it("rejects cap overflow at 0, negatives, and non-integers; drop must be known", () => {
    expectFail(QueueSchema, { cap: 0 });
    expectFail(QueueSchema, { cap: -1 });
    expectFail(QueueSchema, { cap: 1.5 });
    expectOk(QueueSchema, { cap: 1, drop: "new" });
    expectOk(QueueSchema, { drop: "summarize" });
    expectFail(QueueSchema, { drop: "keep" });
    expectFail(QueueSchema, { extra: true });
  });
});

describe("InboundDebounceSchema", () => {
  it("accepts omission, debounceMs 0, and per-channel records", () => {
    expect(expectOk(InboundDebounceSchema, undefined)).toBeUndefined();
    expectOk(InboundDebounceSchema, {
      debounceMs: 0,
      byChannel: { webchat: 5 },
    });
    expectFail(InboundDebounceSchema, { debounceMs: -1 });
    expectFail(InboundDebounceSchema, { extra: true });
  });
});

describe("TranscribeAudioSchema and ExecutableTokenSchema", () => {
  it("accepts a bare executable name and a path, including extra argv after the token", () => {
    expect(expectOk(TranscribeAudioSchema, undefined)).toBeUndefined();
    expectOk(TranscribeAudioSchema, { command: ["ffmpeg"] });
    expectOk(TranscribeAudioSchema, {
      command: ["/usr/bin/whisper", "file.wav"],
      timeoutSeconds: 1,
    });
    expectOk(ExecutableTokenSchema, "ffmpeg");
    expectOk(ExecutableTokenSchema, "/usr/bin/ffmpeg");
  });

  it("rejects an empty command queue and an unsafe first token", () => {
    expectFail(TranscribeAudioSchema, { command: [] });
    expectFail(TranscribeAudioSchema, { command: ["ffmpeg; rm -rf /"] });
    expectFail(TranscribeAudioSchema, { command: ["-ffmpeg"] });
    expectFail(TranscribeAudioSchema, { command: [""] });
    expectFail(TranscribeAudioSchema, { timeoutSeconds: 0 });
    expectFail(ExecutableTokenSchema, "ffmpeg;id");
    expectFail(ExecutableTokenSchema, "");
    expectFail(ExecutableTokenSchema, "-ffmpeg");
  });
});

describe("HexColorSchema", () => {
  it("accepts six hex digits with or without a leading hash, any case", () => {
    expect(expectOk(HexColorSchema, "ff00aa")).toBe("ff00aa");
    expect(expectOk(HexColorSchema, "#FF00AA")).toBe("#FF00AA");
    expectOk(HexColorSchema, "#abcdef");
    expectOk(HexColorSchema, "012345");
  });

  it("rejects short, long, non-hex, and empty values", () => {
    expectFail(HexColorSchema, "#fff");
    expectFail(HexColorSchema, "fff");
    expectFail(HexColorSchema, "#ff00a");
    expectFail(HexColorSchema, "#ff00aaa");
    expectFail(HexColorSchema, "#gg0000");
    expectFail(HexColorSchema, "");
  });
});

describe("MessagePolicySchema and MediaUnderstandingScopeSchema", () => {
  it("accepts omission, empty policy, and a single allow/deny rule", () => {
    expect(expectOk(MessagePolicySchema, undefined)).toBeUndefined();
    expect(expectOk(MediaUnderstandingScopeSchema, undefined)).toBeUndefined();
    expectOk(MessagePolicySchema, { default: "allow", rules: [] });
    expectOk(MessagePolicySchema, {
      default: "deny",
      rules: [
        {
          action: "allow",
          match: { channel: "telegram", chatType: "direct", keyPrefix: "dm:" },
        },
      ],
    });
    expectOk(MessagePolicySchema, {
      rules: [{ action: "deny", match: { chatType: "group" } }],
    });
    expectOk(MessagePolicySchema, {
      rules: [{ action: "allow", match: { chatType: "channel" } }],
    });
  });

  it("rejects unknown actions, chatTypes, and extra keys", () => {
    expectFail(MessagePolicySchema, { default: "maybe" });
    expectFail(MessagePolicySchema, {
      rules: [{ action: "allow", match: { chatType: "thread" } }],
    });
    expectFail(MessagePolicySchema, { extra: true });
    expectFail(MessagePolicySchema, {
      rules: [{ action: "allow", extra: true }],
    });
  });
});

describe("media understanding attachments, capabilities, and models", () => {
  it("accepts each capability and attachment prefer/mode literal", () => {
    expect(
      expectOk(MediaUnderstandingCapabilitiesSchema, undefined),
    ).toBeUndefined();
    expectOk(MediaUnderstandingCapabilitiesSchema, []);
    expectOk(MediaUnderstandingCapabilitiesSchema, ["image", "audio", "video"]);
    expectFail(MediaUnderstandingCapabilitiesSchema, ["text"]);
    expect(
      expectOk(MediaUnderstandingAttachmentsSchema, undefined),
    ).toBeUndefined();
    expectOk(MediaUnderstandingAttachmentsSchema, {
      mode: "first",
      maxAttachments: 1,
      prefer: "path",
    });
    expectOk(MediaUnderstandingAttachmentsSchema, {
      mode: "all",
      prefer: "last",
    });
    expectOk(MediaUnderstandingAttachmentsSchema, { prefer: "first" });
    expectOk(MediaUnderstandingAttachmentsSchema, { prefer: "url" });
  });

  it("rejects non-positive maxAttachments and unknown prefer values", () => {
    expectFail(MediaUnderstandingAttachmentsSchema, { maxAttachments: 0 });
    expectFail(MediaUnderstandingAttachmentsSchema, { prefer: "largest" });
    expectFail(MediaUnderstandingAttachmentsSchema, { extra: true });
  });

  it("accepts provider and cli model types, including empty args", () => {
    expect(expectOk(MediaUnderstandingModelSchema, undefined)).toBeUndefined();
    expectOk(MediaUnderstandingModelSchema, {
      type: "provider",
      provider: "openai",
      model: "gpt-4o",
      capabilities: ["image"],
      maxChars: 1,
      maxBytes: 1,
      timeoutSeconds: 1,
      providerOptions: { openai: { temperature: 0, flag: true, name: "x" } },
      deepgram: { detectLanguage: true, punctuate: false, smartFormat: true },
    });
    expectOk(MediaUnderstandingModelSchema, {
      type: "cli",
      command: "describe",
      args: [],
    });
  });

  it("rejects unknown type, non-positive bounds, and extra keys", () => {
    expectFail(MediaUnderstandingModelSchema, { type: "http" });
    expectFail(MediaUnderstandingModelSchema, { maxChars: 0 });
    expectFail(MediaUnderstandingModelSchema, { extra: true });
  });
});

describe("ToolsMediaSchema and ToolsLinksSchema", () => {
  it("accepts empty media/links objects and a single link model", () => {
    expect(expectOk(ToolsMediaSchema, undefined)).toBeUndefined();
    expectOk(ToolsMediaSchema, {
      models: [],
      concurrency: 1,
      image: {},
      audio: {},
      video: {},
    });
    expect(expectOk(ToolsMediaUnderstandingSchema, undefined)).toBeUndefined();
    expectOk(ToolsMediaUnderstandingSchema, {
      enabled: false,
      models: [],
      attachments: { mode: "first" },
    });
    expect(expectOk(ToolsLinksSchema, undefined)).toBeUndefined();
    expectOk(ToolsLinksSchema, {
      enabled: true,
      maxLinks: 1,
      timeoutSeconds: 1,
      models: [{ command: "fetch-url", args: [], type: "cli" }],
    });
  });

  it("requires a non-empty LinkModel command and rejects extra keys", () => {
    expectFail(LinkModelSchema, { command: "" });
    expectFail(LinkModelSchema, {});
    expectOk(LinkModelSchema, { command: "fetch" });
    expectFail(LinkModelSchema, { command: "fetch", type: "provider" });
    expectFail(LinkModelSchema, { command: "fetch", extra: true });
    expectFail(ToolsMediaSchema, { concurrency: 0 });
    expectFail(ToolsLinksSchema, { extra: true });
  });
});

describe("NativeCommandsSettingSchema and ProviderCommandsSchema", () => {
  it("accepts boolean and auto, including both command flags omitted", () => {
    expectOk(NativeCommandsSettingSchema, true);
    expectOk(NativeCommandsSettingSchema, false);
    expectOk(NativeCommandsSettingSchema, "auto");
    expect(expectOk(ProviderCommandsSchema, undefined)).toBeUndefined();
    expectOk(ProviderCommandsSchema, { native: "auto", nativeSkills: false });
  });

  it("rejects unknown native settings and extra keys", () => {
    expectFail(NativeCommandsSettingSchema, "always");
    expectFail(ProviderCommandsSchema, { extra: true });
  });
});

describe("ChannelHeartbeatVisibilitySchema", () => {
  it("accepts omission and each boolean flag", () => {
    expect(
      expectOk(ChannelHeartbeatVisibilitySchema, undefined),
    ).toBeUndefined();
    expectOk(ChannelHeartbeatVisibilitySchema, {
      showOk: true,
      showAlerts: false,
      useIndicator: true,
    });
    expectFail(ChannelHeartbeatVisibilitySchema, { extra: true });
  });
});

describe("image, video, and vision generation schemas", () => {
  it.each(["cloud", "own-key"] as const)(
    "MediaModeSchema accepts %s",
    (value) => {
      expect(expectOk(MediaModeSchema, value)).toBe(value);
    },
  );

  it.each(["cloud", "fal", "openai", "google", "xai"] as const)(
    "ImageProviderSchema accepts %s",
    (value) => {
      expect(expectOk(ImageProviderSchema, value)).toBe(value);
    },
  );

  it.each(["cloud", "fal", "openai", "google"] as const)(
    "VideoProviderSchema accepts %s",
    (value) => {
      expect(expectOk(VideoProviderSchema, value)).toBe(value);
    },
  );

  it.each(["cloud", "openai", "google", "anthropic", "xai", "ollama"] as const)(
    "VisionProviderSchema accepts %s",
    (value) => {
      expect(expectOk(VisionProviderSchema, value)).toBe(value);
    },
  );

  it("accepts empty nested provider objects and a combined media config", () => {
    expect(expectOk(ImageFalConfigSchema, undefined)).toBeUndefined();
    expectOk(ImageFalConfigSchema, {
      apiKey: "k",
      model: "m",
      baseUrl: "https://fal",
    });
    expectOk(ImageOpenaiConfigSchema, { quality: "hd", style: "vivid" });
    expectOk(ImageOpenaiConfigSchema, {
      quality: "standard",
      style: "natural",
    });
    expectOk(ImageGoogleConfigSchema, { aspectRatio: "1:1" });
    expectOk(ImageXaiConfigSchema, { model: "grok-imagine" });
    expect(expectOk(ImageConfigSchema, undefined)).toBeUndefined();
    expectOk(ImageConfigSchema, {
      enabled: true,
      mode: "cloud",
      provider: "openai",
      defaultSize: "1024x1024",
      fal: {},
      openai: {},
      google: {},
      xai: {},
    });
    expect(expectOk(VideoConfigSchema, undefined)).toBeUndefined();
    expectOk(VideoConfigSchema, {
      enabled: true,
      mode: "own-key",
      provider: "google",
      defaultDuration: 1,
      fal: {},
      openai: {},
      google: {},
    });
    expectOk(VideoFalConfigSchema, { model: "kling" });
    expectOk(VideoOpenaiConfigSchema, { model: "sora" });
    expectOk(VideoGoogleConfigSchema, { model: "veo" });
    expect(expectOk(VisionConfigSchema, undefined)).toBeUndefined();
    expectOk(VisionConfigSchema, {
      enabled: true,
      mode: "cloud",
      provider: "ollama",
      openai: { maxTokens: 1 },
      google: {},
      anthropic: {},
      xai: {},
      ollama: {
        baseUrl: "http://127.0.0.1:11434",
        autoDownload: false,
        maxTokens: 1,
      },
    });
    expectOk(VisionOpenaiConfigSchema, { model: "gpt-4o" });
    expectOk(VisionGoogleConfigSchema, { model: "gemini" });
    expectOk(VisionAnthropicConfigSchema, { model: "claude" });
    expectOk(VisionXaiConfigSchema, { model: "grok" });
    expect(expectOk(MediaConfigSchema, undefined)).toBeUndefined();
    expectOk(MediaConfigSchema, {
      preserveFilenames: true,
      image: {},
      video: {},
      audio: {},
      vision: {},
    });
  });

  it("rejects unknown providers, invalid ollama URLs, non-positive durations, and extra keys", () => {
    expectFail(MediaModeSchema, "local");
    expectFail(ImageProviderSchema, "stability");
    expectFail(VideoProviderSchema, "xai");
    expectFail(VisionProviderSchema, "fal");
    expectFail(ImageOpenaiConfigSchema, { quality: "low" });
    expectFail(ImageConfigSchema, { extra: true });
    expectFail(VideoConfigSchema, { defaultDuration: 0 });
    expectFail(VisionOllamaConfigSchema, { baseUrl: "not-a-url" });
    expectFail(VisionOpenaiConfigSchema, { maxTokens: 0 });
    expectFail(MediaConfigSchema, { extra: true });
  });
});

describe("audio generation schemas", () => {
  it.each(["music", "sfx", "tts"] as const)(
    "AudioKindSchema accepts %s",
    (value) => {
      expect(expectOk(AudioKindSchema, value)).toBe(value);
    },
  );

  it.each(["cloud", "suno", "elevenlabs", "fal"] as const)(
    "AudioGenProviderSchema accepts %s",
    (value) => {
      expect(expectOk(AudioGenProviderSchema, value)).toBe(value);
    },
  );

  it("AudioElevenlabsSfxConfigSchema is the elevenlabs config schema", () => {
    expect(AudioElevenlabsSfxConfigSchema).toBe(AudioElevenlabsConfigSchema);
  });

  it("accepts routing, suno, fal bounds, and elevenlabs at inclusive numeric edges", () => {
    expect(
      expectOk(AudioProviderRoutingConfigSchema, undefined),
    ).toBeUndefined();
    expectOk(AudioProviderRoutingConfigSchema, {
      default: "cloud",
      music: "suno",
      sfx: "elevenlabs",
      tts: "fal",
    });
    expectOk(AudioSunoConfigSchema, {
      apiKey: "k",
      model: "v3",
      baseUrl: "https://suno",
    });
    expectOk(AudioFalConfigSchema, {
      secondsStart: 0,
      secondsTotal: 1,
      steps: 1,
      timeoutMs: 1000,
      extraInput: { prompt: "x" },
    });
    expectOk(AudioElevenlabsVoiceSettingsSchema, {
      stability: 0,
      similarityBoost: 1,
      style: 0,
      speed: 2,
    });
    expectOk(AudioElevenlabsConfigSchema, {
      duration: 0.5,
      promptInfluence: 0,
      seed: 0,
      applyTextNormalization: "off",
      timeoutMs: 600000,
    });
    expectOk(AudioElevenlabsConfigSchema, {
      duration: 600,
      promptInfluence: 1,
      seed: 4294967295,
      applyTextNormalization: "on",
      timeoutMs: 1000,
    });
    expect(expectOk(AudioGenConfigSchema, undefined)).toBeUndefined();
    expectOk(AudioGenConfigSchema, {
      enabled: true,
      mode: "own-key",
      provider: "suno",
      providers: { default: "suno" },
      defaultKind: "music",
      audioKind: "sfx",
      kind: "tts",
      suno: {},
      elevenlabs: {},
      fal: {},
    });
  });

  it("rejects unknown kinds/providers and numeric overflow on fal and elevenlabs", () => {
    expectFail(AudioKindSchema, "speech");
    expectFail(AudioGenProviderSchema, "openai");
    expectFail(AudioFalConfigSchema, { secondsStart: -1 });
    expectFail(AudioFalConfigSchema, { secondsTotal: 0 });
    expectFail(AudioFalConfigSchema, { timeoutMs: 999 });
    expectFail(AudioFalConfigSchema, { timeoutMs: 600001 });
    expectFail(AudioElevenlabsConfigSchema, { duration: 0.49 });
    expectFail(AudioElevenlabsConfigSchema, { duration: 600.01 });
    expectFail(AudioElevenlabsConfigSchema, { seed: 4294967296 });
    expectFail(AudioElevenlabsVoiceSettingsSchema, { speed: 0.49 });
    expectFail(AudioGenConfigSchema, { extra: true });
  });
});
