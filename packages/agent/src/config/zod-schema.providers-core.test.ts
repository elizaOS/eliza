/**
 * Behavioral coverage for the messaging-connector (`channels.*`) Zod schemas:
 * per-platform account/group/DM objects, "open" DM policy requiring allowFrom
 * "*", webhook and HTTP signing-secret refinements, Telegram custom-command
 * normalization, numeric bounds, enum membership, and strict unknown-key
 * rejection. Drives the real schemas. Deterministic, no live services.
 */
import { describe, expect, it } from "vitest";
import {
  CustomRtmpConfigSchema,
  DiscordAccountSchema,
  DiscordConfigSchema,
  DiscordDmSchema,
  DiscordGuildChannelSchema,
  DiscordGuildSchema,
  DiscordLocalConfigSchema,
  GoogleChatAccountSchema,
  GoogleChatConfigSchema,
  GoogleChatDmSchema,
  GoogleChatGroupSchema,
  IMessageAccountSchema,
  IMessageAccountSchemaBase,
  IMessageConfigSchema,
  MSTeamsChannelSchema,
  MSTeamsConfigSchema,
  MSTeamsTeamSchema,
  NamedRtmpSourceSchema,
  PumpfunStreamConfigSchema,
  SlackAccountSchema,
  SlackChannelSchema,
  SlackConfigSchema,
  SlackDmSchema,
  SlackThreadSchema,
  TelegramAccountConnectorSchema,
  TelegramAccountSchema,
  TelegramAccountSchemaBase,
  TelegramConfigSchema,
  TelegramGroupSchema,
  TelegramTopicSchema,
  TwitchConnectorConfigSchema,
  TwitchStreamConfigSchema,
  type TwitterConfig,
  TwitterConfigSchema,
  WhatsAppAccountSchema,
  WhatsAppConfigSchema,
  XStreamConfigSchema,
  YoutubeStreamConfigSchema,
} from "./zod-schema.providers-core.ts";

type IssueList = { issues: Array<{ message: string; path: PropertyKey[] }> };
type ParseResult =
  | { success: true; data: unknown }
  | { success: false; error: IssueList };

function parsed(
  schema: { safeParse: (value: unknown) => ParseResult },
  value: unknown,
): ParseResult {
  return schema.safeParse(value);
}

function expectOk(
  schema: { safeParse: (value: unknown) => ParseResult },
  value: unknown,
): unknown {
  const result = parsed(schema, value);
  expect(result.success).toBe(true);
  return result.success ? result.data : undefined;
}

function expectFail(
  schema: { safeParse: (value: unknown) => ParseResult },
  value: unknown,
): IssueList["issues"] {
  const result = parsed(schema, value);
  expect(result.success).toBe(false);
  return result.success ? [] : result.error.issues;
}

function expectIssue(
  schema: { safeParse: (value: unknown) => ParseResult },
  value: unknown,
  message: string,
) {
  const issues = expectFail(schema, value);
  expect(issues.map((issue) => issue.message)).toContain(message);
}

describe("TelegramTopicSchema", () => {
  it("accepts an empty object because every field is optional", () => {
    expectOk(TelegramTopicSchema, {});
  });

  it("accepts a populated topic with mixed allowFrom types and an empty skills queue", () => {
    expectOk(TelegramTopicSchema, {
      requireMention: true,
      skills: [],
      enabled: false,
      allowFrom: ["alice", 42],
      systemPrompt: "stay on topic",
    });
    expectOk(TelegramTopicSchema, { skills: ["one"] });
  });

  it("rejects unknown keys, a non-object root, and a non-array skills list", () => {
    expectFail(TelegramTopicSchema, { extra: true });
    expectFail(TelegramTopicSchema, null);
    expectFail(TelegramTopicSchema, { skills: "read" });
  });
});

describe("TelegramGroupSchema", () => {
  it("accepts an empty group and a topics record that omits a topic", () => {
    expectOk(TelegramGroupSchema, {});
    expectOk(TelegramGroupSchema, { topics: {} });
    expectOk(TelegramGroupSchema, { topics: { general: undefined } });
    expectOk(TelegramGroupSchema, {
      topics: { general: { enabled: true } },
      allowFrom: [1],
    });
  });

  it("rejects unknown keys and an invalid nested topic", () => {
    expectFail(TelegramGroupSchema, { extra: true });
    expectFail(TelegramGroupSchema, { topics: { general: { extra: true } } });
  });
});

describe("TelegramAccountSchemaBase", () => {
  it("applies pairing, allowlist, and partial-stream defaults on an empty object", () => {
    const data = expectOk(TelegramAccountSchemaBase, {}) as {
      dmPolicy: string;
      groupPolicy: string;
      streamMode: string;
    };
    expect(data.dmPolicy).toBe("pairing");
    expect(data.groupPolicy).toBe("allowlist");
    expect(data.streamMode).toBe("partial");
  });

  it("does not enforce open-DM allowFrom because the base schema has no refine", () => {
    expectOk(TelegramAccountSchemaBase, { dmPolicy: "open" });
  });

  it("accepts both capabilities shapes and every inline-button scope", () => {
    expectOk(TelegramAccountSchemaBase, { capabilities: ["inline"] });
    expectOk(TelegramAccountSchemaBase, { capabilities: [] });
    for (const inlineButtons of [
      "off",
      "dm",
      "group",
      "all",
      "allowlist",
    ] as const) {
      expectOk(TelegramAccountSchemaBase, {
        capabilities: { inlineButtons },
      });
    }
  });

  it("rejects an unknown capabilities object key and an invalid inline-button scope", () => {
    expectFail(TelegramAccountSchemaBase, {
      capabilities: { extra: true },
    });
    expectFail(TelegramAccountSchemaBase, {
      capabilities: { inlineButtons: "nope" },
    });
  });

  it("accepts historyLimit at zero and rejects overflow below zero or a non-integer", () => {
    expectOk(TelegramAccountSchemaBase, { historyLimit: 0, dmHistoryLimit: 0 });
    expectFail(TelegramAccountSchemaBase, { historyLimit: -1 });
    expectFail(TelegramAccountSchemaBase, { dmHistoryLimit: 1.5 });
  });

  it("accepts a positive textChunkLimit and rejects zero", () => {
    expectOk(TelegramAccountSchemaBase, { textChunkLimit: 1 });
    expectFail(TelegramAccountSchemaBase, { textChunkLimit: 0 });
  });

  it("accepts chunkMode and streamMode members and rejects unknown values", () => {
    expectOk(TelegramAccountSchemaBase, { chunkMode: "length" });
    expectOk(TelegramAccountSchemaBase, { chunkMode: "newline" });
    expectOk(TelegramAccountSchemaBase, { streamMode: "off" });
    expectOk(TelegramAccountSchemaBase, { streamMode: "block" });
    expectFail(TelegramAccountSchemaBase, { chunkMode: "words" });
    expectFail(TelegramAccountSchemaBase, { streamMode: "live" });
  });

  it("rejects unknown top-level keys and extra nested action or network keys", () => {
    expectFail(TelegramAccountSchemaBase, { extra: true });
    expectFail(TelegramAccountSchemaBase, { actions: { extra: true } });
    expectFail(TelegramAccountSchemaBase, { network: { extra: true } });
  });
});

describe("TelegramAccountSchema", () => {
  it("accepts pairing without allowFrom and open when allowFrom includes *", () => {
    expectOk(TelegramAccountSchema, {});
    expectOk(TelegramAccountSchema, {
      dmPolicy: "open",
      allowFrom: ["*"],
    });
    expectOk(TelegramAccountSchema, {
      dmPolicy: "open",
      allowFrom: ["  *  "],
    });
  });

  it("rejects open DM policy when allowFrom is missing, empty, or has no *", () => {
    expectIssue(
      TelegramAccountSchema,
      { dmPolicy: "open" },
      'channels.telegram.dmPolicy="open" requires channels.telegram.allowFrom to include "*"',
    );
    expectIssue(
      TelegramAccountSchema,
      { dmPolicy: "open", allowFrom: [] },
      'channels.telegram.dmPolicy="open" requires channels.telegram.allowFrom to include "*"',
    );
    expectIssue(
      TelegramAccountSchema,
      { dmPolicy: "open", allowFrom: ["alice"] },
      'channels.telegram.dmPolicy="open" requires channels.telegram.allowFrom to include "*"',
    );
  });

  it("normalizes a custom command name and description on parse", () => {
    const data = expectOk(TelegramAccountSchema, {
      customCommands: [{ command: "/Help", description: "  show help  " }],
    }) as {
      customCommands: Array<{ command: string; description: string }>;
    };
    expect(data.customCommands).toEqual([
      { command: "help", description: "show help" },
    ]);
  });

  it("accepts an empty customCommands queue and a single valid command", () => {
    expectOk(TelegramAccountSchema, { customCommands: [] });
    expectOk(TelegramAccountSchema, {
      customCommands: [{ command: "ping", description: "pong" }],
    });
  });

  it("rejects a custom command with an empty name, invalid pattern, or empty description", () => {
    expectFail(TelegramAccountSchema, {
      customCommands: [{ command: "   ", description: "x" }],
    });
    expectFail(TelegramAccountSchema, {
      customCommands: [{ command: "!!!", description: "x" }],
    });
    expectFail(TelegramAccountSchema, {
      customCommands: [{ command: "help", description: "   " }],
    });
  });

  it("does not reject duplicate custom commands because the schema disables that check", () => {
    expectOk(TelegramAccountSchema, {
      customCommands: [
        { command: "help", description: "one" },
        { command: "help", description: "two" },
      ],
    });
  });

  it("rejects a custom command name past the 32-character Telegram cap", () => {
    expectFail(TelegramAccountSchema, {
      customCommands: [{ command: "a".repeat(33), description: "too long" }],
    });
    expectOk(TelegramAccountSchema, {
      customCommands: [{ command: "a".repeat(32), description: "at cap" }],
    });
  });
});

describe("TelegramConfigSchema", () => {
  it("requires a webhook secret when webhookUrl is a non-empty URL", () => {
    expectIssue(
      TelegramConfigSchema,
      { webhookUrl: "https://example.com/hook" },
      "channels.telegram.webhookUrl requires channels.telegram.webhookSecret",
    );
    expectIssue(
      TelegramConfigSchema,
      { webhookUrl: "https://example.com/hook", webhookSecret: "   " },
      "channels.telegram.webhookUrl requires channels.telegram.webhookSecret",
    );
  });

  it("does not require a secret when webhookUrl is omitted or whitespace-only", () => {
    expectOk(TelegramConfigSchema, {});
    expectOk(TelegramConfigSchema, { webhookUrl: "   " });
    expectOk(TelegramConfigSchema, {
      webhookUrl: "https://example.com/hook",
      webhookSecret: "secret",
    });
  });

  it("skips account webhook checks when accounts is missing, the entry is omitted, or the account is disabled", () => {
    expectOk(TelegramConfigSchema, { accounts: { a: undefined } });
    expectOk(TelegramConfigSchema, {
      accounts: {
        a: { enabled: false, webhookUrl: "https://example.com/hook" },
      },
    });
    expectOk(TelegramConfigSchema, {
      accounts: { a: { webhookUrl: "   " } },
    });
  });

  it("requires an account or base webhook secret when an enabled account declares a webhook URL", () => {
    expectIssue(
      TelegramConfigSchema,
      { accounts: { bot: { webhookUrl: "https://example.com/hook" } } },
      "channels.telegram.accounts.*.webhookUrl requires channels.telegram.webhookSecret or channels.telegram.accounts.*.webhookSecret",
    );
    expectOk(TelegramConfigSchema, {
      webhookSecret: "base",
      accounts: { bot: { webhookUrl: "https://example.com/hook" } },
    });
    expectOk(TelegramConfigSchema, {
      accounts: {
        bot: {
          webhookUrl: "https://example.com/hook",
          webhookSecret: "account",
        },
      },
    });
  });

  it("treats a whitespace-only account webhook secret as missing", () => {
    expectIssue(
      TelegramConfigSchema,
      {
        accounts: {
          bot: {
            webhookUrl: "https://example.com/hook",
            webhookSecret: "  ",
          },
        },
      },
      "channels.telegram.accounts.*.webhookUrl requires channels.telegram.webhookSecret or channels.telegram.accounts.*.webhookSecret",
    );
  });

  it("still enforces open-DM allowFrom on the top-level config", () => {
    expectIssue(
      TelegramConfigSchema,
      { dmPolicy: "open" },
      'channels.telegram.dmPolicy="open" requires channels.telegram.allowFrom to include "*"',
    );
  });
});

describe("TelegramAccountConnectorSchema", () => {
  it("accepts an empty connector and appId as either a string or an integer", () => {
    expectOk(TelegramAccountConnectorSchema, {});
    expectOk(TelegramAccountConnectorSchema, { appId: "123" });
    expectOk(TelegramAccountConnectorSchema, { appId: 123 });
  });

  it("rejects a non-integer appId and unknown keys", () => {
    expectFail(TelegramAccountConnectorSchema, { appId: 1.5 });
    expectFail(TelegramAccountConnectorSchema, { extra: true });
  });
});

describe("DiscordDmSchema", () => {
  it("defaults policy to pairing and accepts mixed allowFrom and groupChannels types", () => {
    const data = expectOk(DiscordDmSchema, {}) as { policy: string };
    expect(data.policy).toBe("pairing");
    expectOk(DiscordDmSchema, {
      allowFrom: ["alice", 7],
      groupChannels: ["general", 1],
    });
  });

  it("rejects open policy without * and unknown keys", () => {
    expectIssue(
      DiscordDmSchema,
      { policy: "open" },
      'channels.discord.dm.policy="open" requires channels.discord.dm.allowFrom to include "*"',
    );
    expectOk(DiscordDmSchema, { policy: "open", allowFrom: ["*"] });
    expectFail(DiscordDmSchema, { extra: true });
  });
});

describe("DiscordGuildChannelSchema and DiscordGuildSchema", () => {
  it("accepts empty objects, an empty users queue, and a single user", () => {
    expectOk(DiscordGuildChannelSchema, {});
    expectOk(DiscordGuildChannelSchema, { users: [] });
    expectOk(DiscordGuildChannelSchema, { users: ["alice"] });
    expectOk(DiscordGuildSchema, {});
    expectOk(DiscordGuildSchema, {
      channels: { lobby: undefined },
    });
  });

  it("accepts every guild reactionNotifications member and rejects an unknown value", () => {
    for (const reactionNotifications of [
      "off",
      "own",
      "all",
      "allowlist",
    ] as const) {
      expectOk(DiscordGuildSchema, { reactionNotifications });
    }
    expectFail(DiscordGuildSchema, { reactionNotifications: "bots" });
  });

  it("rejects unknown keys on the channel and the guild", () => {
    expectFail(DiscordGuildChannelSchema, { extra: true });
    expectFail(DiscordGuildSchema, { extra: true });
  });
});

describe("DiscordAccountSchema and DiscordConfigSchema", () => {
  it("defaults groupPolicy to allowlist on an empty account", () => {
    const data = expectOk(DiscordAccountSchema, {}) as { groupPolicy: string };
    expect(data.groupPolicy).toBe("allowlist");
  });

  it("accepts nested guilds and dms records that omit an entry", () => {
    expectOk(DiscordAccountSchema, {
      guilds: { "1": undefined },
      dms: { "2": undefined },
    });
    expectOk(DiscordConfigSchema, { accounts: { bot: undefined } });
  });

  it("rejects unknown keys on the account and on nested action, intent, and pluralkit objects", () => {
    expectFail(DiscordAccountSchema, { extra: true });
    expectFail(DiscordAccountSchema, { actions: { extra: true } });
    expectFail(DiscordAccountSchema, { intents: { extra: true } });
    expectFail(DiscordAccountSchema, { pluralkit: { extra: true } });
    expectFail(DiscordAccountSchema, { execApprovals: { extra: true } });
  });

  it("enforces the nested DM open-policy refine through the account schema", () => {
    expectIssue(
      DiscordAccountSchema,
      { dm: { policy: "open" } },
      'channels.discord.dm.policy="open" requires channels.discord.dm.allowFrom to include "*"',
    );
  });
});

describe("DiscordLocalConfigSchema", () => {
  it("accepts sendDelayMs at the 100ms floor and rejects overflow below it", () => {
    expectOk(DiscordLocalConfigSchema, {});
    expectOk(DiscordLocalConfigSchema, { sendDelayMs: 100 });
    expectFail(DiscordLocalConfigSchema, { sendDelayMs: 99 });
    expectFail(DiscordLocalConfigSchema, { sendDelayMs: 100.5 });
  });

  it("rejects unknown keys", () => {
    expectFail(DiscordLocalConfigSchema, { extra: true });
  });
});

describe("GoogleChat schemas", () => {
  it("defaults DM policy to pairing and rejects open without *", () => {
    const data = expectOk(GoogleChatDmSchema, {}) as { policy: string };
    expect(data.policy).toBe("pairing");
    expectIssue(
      GoogleChatDmSchema,
      { policy: "open" },
      'channels.googlechat.dm.policy="open" requires channels.googlechat.dm.allowFrom to include "*"',
    );
    expectOk(GoogleChatDmSchema, { policy: "open", allowFrom: ["*"] });
  });

  it("accepts an empty group and rejects unknown group keys", () => {
    expectOk(GoogleChatGroupSchema, {});
    expectFail(GoogleChatGroupSchema, { extra: true });
  });

  it("accepts serviceAccount as a string or a record and audienceType members", () => {
    expectOk(GoogleChatAccountSchema, { serviceAccount: "/keys/sa.json" });
    expectOk(GoogleChatAccountSchema, { serviceAccount: { type: "service" } });
    expectOk(GoogleChatAccountSchema, { audienceType: "app-url" });
    expectOk(GoogleChatAccountSchema, { audienceType: "project-number" });
    expectFail(GoogleChatAccountSchema, { audienceType: "custom" });
  });

  it("accepts typingIndicator members and rejects an unknown value", () => {
    expectOk(GoogleChatAccountSchema, { typingIndicator: "none" });
    expectOk(GoogleChatAccountSchema, { typingIndicator: "message" });
    expectOk(GoogleChatAccountSchema, { typingIndicator: "reaction" });
    expectFail(GoogleChatAccountSchema, { typingIndicator: "always" });
  });

  it("accepts defaultAccount and an omitted nested account on the config schema", () => {
    expectOk(GoogleChatConfigSchema, {
      defaultAccount: "bot",
      accounts: { bot: undefined },
    });
    expectFail(GoogleChatConfigSchema, { extra: true });
  });
});

describe("Slack schemas", () => {
  it("defaults DM policy to pairing and rejects open without *", () => {
    const data = expectOk(SlackDmSchema, {}) as { policy: string };
    expect(data.policy).toBe("pairing");
    expectIssue(
      SlackDmSchema,
      { policy: "open" },
      'channels.slack.dm.policy="open" requires channels.slack.dm.allowFrom to include "*"',
    );
    expectOk(SlackDmSchema, { policy: "open", allowFrom: ["*"] });
    expectFail(SlackDmSchema, { extra: true });
  });

  it("accepts empty channel and thread objects and thread historyScope members", () => {
    expectOk(SlackChannelSchema, {});
    expectOk(SlackThreadSchema, {});
    expectOk(SlackThreadSchema, { historyScope: "thread" });
    expectOk(SlackThreadSchema, { historyScope: "channel" });
    expectFail(SlackChannelSchema, { extra: true });
    expectFail(SlackThreadSchema, { historyScope: "dm" });
  });

  it("defaults account userTokenReadOnly to true", () => {
    const data = expectOk(SlackAccountSchema, {}) as {
      userTokenReadOnly: boolean;
      groupPolicy: string;
    };
    expect(data.userTokenReadOnly).toBe(true);
    expect(data.groupPolicy).toBe("allowlist");
  });

  it("defaults config mode to socket and webhookPath to /slack/events", () => {
    const data = expectOk(SlackConfigSchema, {}) as {
      mode: string;
      webhookPath: string;
    };
    expect(data.mode).toBe("socket");
    expect(data.webhookPath).toBe("/slack/events");
  });

  it("requires a signing secret in http mode, including an empty string secret", () => {
    expectIssue(
      SlackConfigSchema,
      { mode: "http" },
      'channels.slack.mode="http" requires channels.slack.signingSecret',
    );
    expectIssue(
      SlackConfigSchema,
      { mode: "http", signingSecret: "" },
      'channels.slack.mode="http" requires channels.slack.signingSecret',
    );
    expectOk(SlackConfigSchema, { mode: "http", signingSecret: "s" });
    expectOk(SlackConfigSchema, { mode: "socket" });
  });

  it("skips account http-secret checks when accounts is missing, omitted, disabled, or not http", () => {
    expectOk(SlackConfigSchema, { accounts: { a: undefined } });
    expectOk(SlackConfigSchema, {
      accounts: { a: { enabled: false, mode: "http" } },
    });
    expectOk(SlackConfigSchema, {
      mode: "http",
      signingSecret: "base",
      accounts: { a: { mode: "socket" } },
    });
  });

  it("requires a base or account signing secret when an enabled account is in http mode", () => {
    expectIssue(
      SlackConfigSchema,
      { accounts: { bot: { mode: "http" } } },
      'channels.slack.accounts.*.mode="http" requires channels.slack.signingSecret or channels.slack.accounts.*.signingSecret',
    );
    expectOk(SlackConfigSchema, {
      signingSecret: "base",
      accounts: { bot: { mode: "http" } },
    });
    expectOk(SlackConfigSchema, {
      accounts: { bot: { mode: "http", signingSecret: "account" } },
    });
  });

  it("inherits the base mode when an account omits mode", () => {
    expectIssue(
      SlackConfigSchema,
      { mode: "http", accounts: { bot: {} } },
      'channels.slack.mode="http" requires channels.slack.signingSecret',
    );
    expectOk(SlackConfigSchema, {
      mode: "http",
      signingSecret: "base",
      accounts: { bot: {} },
    });
  });
});

describe("IMessage schemas", () => {
  it("does not enforce open-DM allowFrom on the base schema", () => {
    expectOk(IMessageAccountSchemaBase, { dmPolicy: "open" });
  });

  it("rejects open DM policy without * on the refined account and config schemas", () => {
    expectIssue(
      IMessageAccountSchema,
      { dmPolicy: "open" },
      'channels.imessage.dmPolicy="open" requires channels.imessage.allowFrom to include "*"',
    );
    expectIssue(
      IMessageConfigSchema,
      { dmPolicy: "open" },
      'channels.imessage.dmPolicy="open" requires channels.imessage.allowFrom to include "*"',
    );
    expectOk(IMessageAccountSchema, {
      dmPolicy: "open",
      allowFrom: ["*"],
    });
  });

  it("accepts service members and a safe cliPath, and rejects an unsafe executable token", () => {
    expectOk(IMessageAccountSchema, { service: "imessage" });
    expectOk(IMessageAccountSchema, { service: "sms" });
    expectOk(IMessageAccountSchema, { service: "auto" });
    expectOk(IMessageAccountSchema, { cliPath: "imsg" });
    expectFail(IMessageAccountSchema, { service: "rcs" });
    expectFail(IMessageAccountSchema, { cliPath: "imsg; rm -rf /" });
    expectFail(IMessageAccountSchema, { cliPath: "" });
  });

  it("accepts mediaMaxMb as a positive integer and rejects zero or a non-integer", () => {
    expectOk(IMessageAccountSchema, { mediaMaxMb: 1 });
    expectFail(IMessageAccountSchema, { mediaMaxMb: 0 });
    expectFail(IMessageAccountSchema, { mediaMaxMb: 1.5 });
  });

  it("accepts an omitted nested account and rejects unknown keys", () => {
    expectOk(IMessageConfigSchema, { accounts: { phone: undefined } });
    expectFail(IMessageAccountSchema, { extra: true });
  });
});

describe("Twitch connector and streaming destination schemas", () => {
  it("accepts empty objects and rejects unknown keys", () => {
    expectOk(TwitchConnectorConfigSchema, {});
    expectOk(TwitchStreamConfigSchema, {});
    expectOk(CustomRtmpConfigSchema, {});
    expectOk(PumpfunStreamConfigSchema, {});
    expectOk(XStreamConfigSchema, {});
    expectFail(TwitchConnectorConfigSchema, { extra: true });
    expectFail(TwitchStreamConfigSchema, { extra: true });
    expectFail(CustomRtmpConfigSchema, { extra: true });
    expectFail(PumpfunStreamConfigSchema, { extra: true });
    expectFail(XStreamConfigSchema, { extra: true });
  });

  it("accepts a valid YouTube rtmpUrl and rejects a non-URL", () => {
    expectOk(YoutubeStreamConfigSchema, {});
    expectOk(YoutubeStreamConfigSchema, {
      rtmpUrl: "https://a.youtube.com/live2",
    });
    expectFail(YoutubeStreamConfigSchema, { rtmpUrl: "not-a-url" });
    expectFail(YoutubeStreamConfigSchema, { rtmpUrl: "" });
    expectFail(YoutubeStreamConfigSchema, { extra: true });
  });
});

describe("NamedRtmpSourceSchema", () => {
  it("requires non-empty id, rtmpUrl, and rtmpKey", () => {
    expectOk(NamedRtmpSourceSchema, {
      id: "cam-1",
      rtmpUrl: "rtmp://live.example.com/app",
      rtmpKey: "secret",
    });
    expectOk(NamedRtmpSourceSchema, {
      id: "cam-1",
      name: "stage",
      rtmpUrl: "rtmp://live.example.com/app",
      rtmpKey: "secret",
    });
    expectFail(NamedRtmpSourceSchema, {});
    expectFail(NamedRtmpSourceSchema, {
      id: "",
      rtmpUrl: "rtmp://live.example.com/app",
      rtmpKey: "secret",
    });
    expectFail(NamedRtmpSourceSchema, {
      id: "cam-1",
      rtmpUrl: "",
      rtmpKey: "secret",
    });
    expectFail(NamedRtmpSourceSchema, {
      id: "cam-1",
      rtmpUrl: "rtmp://live.example.com/app",
      rtmpKey: "",
    });
    expectFail(NamedRtmpSourceSchema, {
      id: "cam-1",
      rtmpUrl: "rtmp://live.example.com/app",
      rtmpKey: "secret",
      extra: true,
    });
  });
});

describe("MS Teams schemas", () => {
  it("accepts empty channel and team objects and nested omitted channels", () => {
    expectOk(MSTeamsChannelSchema, {});
    expectOk(MSTeamsTeamSchema, {});
    expectOk(MSTeamsTeamSchema, { channels: { general: undefined } });
    expectFail(MSTeamsChannelSchema, { extra: true });
    expectFail(MSTeamsTeamSchema, { extra: true });
  });

  it("defaults dmPolicy to pairing and groupPolicy to allowlist", () => {
    const data = expectOk(MSTeamsConfigSchema, {}) as {
      dmPolicy: string;
      groupPolicy: string;
    };
    expect(data.dmPolicy).toBe("pairing");
    expect(data.groupPolicy).toBe("allowlist");
  });

  it("rejects open DM policy without * and accepts allowFrom as strings only", () => {
    expectIssue(
      MSTeamsConfigSchema,
      { dmPolicy: "open" },
      'channels.msteams.dmPolicy="open" requires channels.msteams.allowFrom to include "*"',
    );
    expectOk(MSTeamsConfigSchema, {
      dmPolicy: "open",
      allowFrom: ["*"],
    });
    expectFail(MSTeamsConfigSchema, { allowFrom: [1] });
  });

  it("accepts replyStyle members and a positive webhook port, and rejects overflow", () => {
    expectOk(MSTeamsConfigSchema, { replyStyle: "thread" });
    expectOk(MSTeamsConfigSchema, { replyStyle: "top-level" });
    expectFail(MSTeamsConfigSchema, { replyStyle: "inline" });
    expectOk(MSTeamsConfigSchema, { webhook: { port: 1 } });
    expectFail(MSTeamsConfigSchema, { webhook: { port: 0 } });
    expectFail(MSTeamsConfigSchema, { webhook: { extra: true } });
  });
});

describe("WhatsAppAccountSchema", () => {
  it("defaults dmPolicy to pairing and debounceMs to 0", () => {
    const data = expectOk(WhatsAppAccountSchema, {}) as {
      dmPolicy: string;
      debounceMs: number;
    };
    expect(data.dmPolicy).toBe("pairing");
    expect(data.debounceMs).toBe(0);
  });

  it("rejects open DM policy when allowFrom is missing, blank, or has no *", () => {
    expectIssue(
      WhatsAppAccountSchema,
      { dmPolicy: "open" },
      'channels.whatsapp.accounts.*.dmPolicy="open" requires allowFrom to include "*"',
    );
    expectIssue(
      WhatsAppAccountSchema,
      { dmPolicy: "open", allowFrom: ["", "  "] },
      'channels.whatsapp.accounts.*.dmPolicy="open" requires allowFrom to include "*"',
    );
    expectIssue(
      WhatsAppAccountSchema,
      { dmPolicy: "open", allowFrom: ["alice"] },
      'channels.whatsapp.accounts.*.dmPolicy="open" requires allowFrom to include "*"',
    );
  });

  it("accepts open DM policy when a trimmed allowFrom entry is *", () => {
    expectOk(WhatsAppAccountSchema, {
      dmPolicy: "open",
      allowFrom: ["*"],
    });
    expectOk(WhatsAppAccountSchema, {
      dmPolicy: "open",
      allowFrom: ["  *  "],
    });
  });

  it("does not apply the open-policy refine for pairing or allowlist", () => {
    expectOk(WhatsAppAccountSchema, { dmPolicy: "pairing" });
    expectOk(WhatsAppAccountSchema, { dmPolicy: "allowlist" });
    expectOk(WhatsAppAccountSchema, { dmPolicy: "disabled" });
  });

  it("applies ackReaction defaults and rejects an unknown group ack mode", () => {
    const data = expectOk(WhatsAppAccountSchema, { ackReaction: {} }) as {
      ackReaction: { direct: boolean; group: string };
    };
    expect(data.ackReaction.direct).toBe(true);
    expect(data.ackReaction.group).toBe("mentions");
    expectOk(WhatsAppAccountSchema, {
      ackReaction: { group: "always" },
    });
    expectOk(WhatsAppAccountSchema, {
      ackReaction: { group: "never" },
    });
    expectFail(WhatsAppAccountSchema, {
      ackReaction: { group: "sometimes" },
    });
  });

  it("rejects a negative debounceMs and a non-integer mediaMaxMb", () => {
    expectFail(WhatsAppAccountSchema, { debounceMs: -1 });
    expectOk(WhatsAppAccountSchema, { debounceMs: 0 });
    expectFail(WhatsAppAccountSchema, { mediaMaxMb: 0 });
    expectFail(WhatsAppAccountSchema, { mediaMaxMb: 1.5 });
    expectOk(WhatsAppAccountSchema, { mediaMaxMb: 1 });
  });

  it("accepts an omitted nested group and rejects unknown keys", () => {
    expectOk(WhatsAppAccountSchema, { groups: { family: undefined } });
    expectFail(WhatsAppAccountSchema, { extra: true });
  });
});

describe("WhatsAppConfigSchema", () => {
  it("defaults mediaMaxMb to 50 and debounceMs to 0", () => {
    const data = expectOk(WhatsAppConfigSchema, {}) as {
      mediaMaxMb: number;
      debounceMs: number;
      dmPolicy: string;
    };
    expect(data.mediaMaxMb).toBe(50);
    expect(data.debounceMs).toBe(0);
    expect(data.dmPolicy).toBe("pairing");
  });

  it("rejects top-level open DM policy without * with the config-level message", () => {
    expectIssue(
      WhatsAppConfigSchema,
      { dmPolicy: "open" },
      'channels.whatsapp.dmPolicy="open" requires channels.whatsapp.allowFrom to include "*"',
    );
    expectOk(WhatsAppConfigSchema, {
      dmPolicy: "open",
      allowFrom: ["*"],
    });
  });

  it("still runs the nested account refine inside accounts", () => {
    expectIssue(
      WhatsAppConfigSchema,
      { accounts: { phone: { dmPolicy: "open" } } },
      'channels.whatsapp.accounts.*.dmPolicy="open" requires allowFrom to include "*"',
    );
  });

  it("rejects unknown action keys and accepts an omitted nested account", () => {
    expectFail(WhatsAppConfigSchema, { actions: { extra: true } });
    expectOk(WhatsAppConfigSchema, { accounts: { phone: undefined } });
  });
});

describe("TwitterConfigSchema", () => {
  it("applies posting, interaction, and safety defaults on an empty object", () => {
    const parsedConfig = TwitterConfigSchema.parse({});
    const typed: TwitterConfig = parsedConfig;
    expect(typed.postEnable).toBe(true);
    expect(typed.postImmediately).toBe(false);
    expect(typed.postIntervalMin).toBe(90);
    expect(typed.postIntervalMax).toBe(180);
    expect(typed.postIntervalVariance).toBe(0.1);
    expect(typed.searchEnable).toBe(false);
    expect(typed.autoRespondMentions).toBe(true);
    expect(typed.enableActionProcessing).toBe(true);
    expect(typed.timelineAlgorithm).toBe("weighted");
    expect(typed.dmPolicy).toBe("pairing");
    expect(typed.dryRun).toBe(false);
    expect(typed.retryLimit).toBe(3);
    expect(typed.pollInterval).toBe(120);
    expect(typed.maxTweetLength).toBe(4000);
  });

  it("accepts timelineAlgorithm members and variance at both 0 and 1", () => {
    expectOk(TwitterConfigSchema, { timelineAlgorithm: "latest" });
    expectOk(TwitterConfigSchema, { postIntervalVariance: 0 });
    expectOk(TwitterConfigSchema, { postIntervalVariance: 1 });
  });

  it("rejects variance overflow, non-positive intervals, and unknown keys", () => {
    expectFail(TwitterConfigSchema, { postIntervalVariance: -0.01 });
    expectFail(TwitterConfigSchema, { postIntervalVariance: 1.01 });
    expectFail(TwitterConfigSchema, { postIntervalMin: 0 });
    expectFail(TwitterConfigSchema, { retryLimit: 0 });
    expectFail(TwitterConfigSchema, { maxTweetLength: 0 });
    expectFail(TwitterConfigSchema, { extra: true });
    expectFail(TwitterConfigSchema, { timelineAlgorithm: "for-you" });
  });

  it("does not refine open DM policy because TwitterConfigSchema has no allowFrom field", () => {
    expectOk(TwitterConfigSchema, { dmPolicy: "open" });
  });
});
