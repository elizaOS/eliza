/**
 * Unit tests for plugin-config intent detection, form emission, and mutation
 * rejections in server-helpers-plugin. Drives the real module: no mocks of
 * resolvePluginConfigReply or resolvePluginConfigMutationRejections.
 */
import { describe, expect, it } from "vitest";
import {
  BLOCKED_ENV_KEY_PREFIXES,
  BLOCKED_ENV_KEYS,
} from "../config/blocked-env-keys.ts";
import {
  resolvePluginConfigMutationRejections,
  resolvePluginConfigReply,
} from "./server-helpers-plugin.ts";
import type { ServerState } from "./server-types.ts";

const idleState: Pick<ServerState, "config" | "runtime"> = {
  config: {} as ServerState["config"],
  runtime: null,
};

type FormSpec = {
  version: number;
  root: string;
  elements: Record<
    string,
    {
      type: string;
      props?: Record<string, unknown>;
      children: string[];
      on?: {
        press?: { action: string; params?: Record<string, unknown> };
      };
    }
  >;
  state: Record<string, string>;
};

function parseForm(reply: string): FormSpec {
  const match = reply.match(/```json-render\n([\s\S]*?)\n```/);
  if (!match?.[1]) {
    throw new Error(
      `expected json-render form fence, got: ${reply.slice(0, 200)}`,
    );
  }
  return JSON.parse(match[1]) as FormSpec;
}

async function formFor(prompt: string): Promise<FormSpec> {
  const reply = await resolvePluginConfigReply(prompt, idleState);
  expect(reply).not.toBeNull();
  if (typeof reply !== "string") {
    throw new Error(`expected form string for ${prompt}, got ${String(reply)}`);
  }
  return parseForm(reply);
}

const PLUGIN_CATALOG: Record<
  string,
  Array<{ key: string; secret: boolean }>
> = {
  telegram: [{ key: "TELEGRAM_BOT_TOKEN", secret: true }],
  discord: [
    { key: "DISCORD_API_TOKEN", secret: true },
    { key: "DISCORD_APPLICATION_ID", secret: false },
    { key: "ELIZA_DISCORD_OWNER_USER_IDS_JSON", secret: false },
    { key: "DISCORD_DM_POLICY", secret: false },
    { key: "DISCORD_ALLOW_FROM", secret: false },
  ],
  twitter: [
    { key: "TWITTER_USERNAME", secret: false },
    { key: "TWITTER_PASSWORD", secret: true },
    { key: "TWITTER_EMAIL", secret: false },
  ],
  slack: [
    { key: "SLACK_APP_TOKEN", secret: true },
    { key: "SLACK_BOT_TOKEN", secret: true },
    { key: "SLACK_SIGNING_SECRET", secret: true },
  ],
  anthropic: [{ key: "ANTHROPIC_API_KEY", secret: true }],
  openai: [{ key: "OPENAI_API_KEY", secret: true }],
  openrouter: [{ key: "OPENROUTER_API_KEY", secret: true }],
  groq: [{ key: "GROQ_API_KEY", secret: true }],
  google: [{ key: "GOOGLE_GENERATIVE_AI_API_KEY", secret: true }],
  gemini: [{ key: "GOOGLE_GENERATIVE_AI_API_KEY", secret: true }],
  deepseek: [{ key: "DEEPSEEK_API_KEY", secret: true }],
  mistral: [{ key: "MISTRAL_API_KEY", secret: true }],
  together: [{ key: "TOGETHER_API_KEY", secret: true }],
  grok: [{ key: "XAI_API_KEY", secret: true }],
  zai: [{ key: "ZAI_API_KEY", secret: true }],
  moonshot: [{ key: "MOONSHOT_API_KEY", secret: true }],
  kimi: [{ key: "MOONSHOT_API_KEY", secret: true }],
  ollama: [{ key: "OLLAMA_BASE_URL", secret: false }],
};

describe("resolvePluginConfigReply", () => {
  it("returns null for an empty prompt, a missing-item prompt, and a non-config sentence", async () => {
    expect(await resolvePluginConfigReply("", idleState)).toBeNull();
    expect(await resolvePluginConfigReply("configure", idleState)).toBeNull();
    expect(await resolvePluginConfigReply("telegram", idleState)).toBeNull();
    expect(
      await resolvePluginConfigReply("what is the weather today", idleState),
    ).toBeNull();
    expect(
      await resolvePluginConfigReply("configure unknownplugin", idleState),
    ).toBeNull();
  });

  it("matches verb-then-name intents (set up / configure / connect / enable / install / setup)", async () => {
    expect((await formFor("set up telegram")).state.pluginId).toBe("telegram");
    expect((await formFor("configure openai")).state.pluginId).toBe("openai");
    expect((await formFor("connect slack")).state.pluginId).toBe("slack");
    expect((await formFor("enable groq")).state.pluginId).toBe("groq");
    expect((await formFor("install ollama")).state.pluginId).toBe("ollama");
    expect((await formFor("setup grok")).state.pluginId).toBe("grok");
  });

  it("matches name-then-verb intents (plugin / connector / set up / configure)", async () => {
    expect((await formFor("telegram plugin")).state.pluginId).toBe("telegram");
    expect((await formFor("openai connector")).state.pluginId).toBe("openai");
    expect((await formFor("discord set up")).state.pluginId).toBe("discord");
    expect((await formFor("slack configure")).state.pluginId).toBe("slack");
    expect(
      (await formFor("help me with the openai plugin")).state.pluginId,
    ).toBe("openai");
  });

  it("is case-insensitive and lowercases the resolved plugin id", async () => {
    const form = await formFor("CONFIGURE DISCORD");
    expect(form.state.pluginId).toBe("discord");
    expect(form.elements.title?.props?.text).toBe("Configure Discord");
  });

  it("emits a json-render form for every catalogued plugin, including aliases that share a key", async () => {
    for (const [pluginName, params] of Object.entries(PLUGIN_CATALOG)) {
      const form = await formFor(`configure ${pluginName}`);
      const displayName =
        pluginName.charAt(0).toUpperCase() + pluginName.slice(1);
      const fieldIds = params.map((param) => `f_${param.key}`);

      expect(form.version).toBe(1);
      expect(form.root).toBe("root");
      expect(form.state.pluginId).toBe(pluginName);
      expect(form.elements.title?.props?.text).toBe(`Configure ${displayName}`);
      expect(form.elements.root?.children).toEqual([
        "title",
        "sep",
        "fields",
        "actions",
      ]);
      expect(form.elements.fields?.children).toEqual(fieldIds);
      expect(form.elements.actions?.children).toEqual(["saveBtn"]);

      for (const param of params) {
        expect(form.state[`config.${param.key}`]).toBe("");
        const input = form.elements[`f_${param.key}`];
        expect(input?.type).toBe("Input");
        expect(input?.props?.type).toBe(param.secret ? "password" : "text");
        expect(input?.props?.placeholder).toBe(param.key);
        expect(input?.props?.statePath).toBe(`config.${param.key}`);
        expect(
          form.elements.saveBtn?.on?.press?.params?.[`config.${param.key}`],
        ).toEqual({ $path: `config.${param.key}` });
      }

      expect(form.elements.saveBtn?.on?.press?.action).toBe("plugin:save");
      expect(form.elements.saveBtn?.on?.press?.params?.pluginId).toBe(
        pluginName,
      );
    }
  });

  it("treats a single-element plugin (telegram) and a multi-field plugin (twitter) as ordered catalogs", async () => {
    const telegram = await formFor("set up telegram");
    expect(telegram.elements.fields?.children).toEqual([
      "f_TELEGRAM_BOT_TOKEN",
    ]);
    expect(telegram.elements.f_TELEGRAM_BOT_TOKEN?.props?.type).toBe(
      "password",
    );

    const twitter = await formFor("configure twitter");
    expect(twitter.elements.fields?.children).toEqual([
      "f_TWITTER_USERNAME",
      "f_TWITTER_PASSWORD",
      "f_TWITTER_EMAIL",
    ]);
    expect(twitter.elements.f_TWITTER_USERNAME?.props?.type).toBe("text");
    expect(twitter.elements.f_TWITTER_PASSWORD?.props?.type).toBe("password");
    expect(twitter.elements.f_TWITTER_EMAIL?.props?.type).toBe("text");
  });

  it("does not consult ServerState when emitting the form", async () => {
    const otherState: Pick<ServerState, "config" | "runtime"> = {
      config: {
        env: { OPENAI_API_KEY: "should-not-leak" },
      } as ServerState["config"],
      runtime: null,
    };
    const a = await resolvePluginConfigReply("configure openai", idleState);
    const b = await resolvePluginConfigReply("configure openai", otherState);
    expect(a).toBe(b);
    if (typeof a !== "string") {
      throw new Error("expected openai form");
    }
    expect(a).toContain("here's the config form for Openai");
    expect(a).not.toContain("should-not-leak");
  });
});

describe("resolvePluginConfigMutationRejections", () => {
  const telegramParams = [{ key: "TELEGRAM_BOT_TOKEN" }];

  it("returns an empty queue for empty config, including when params are empty or a declared key is missing", () => {
    expect(resolvePluginConfigMutationRejections([], {})).toEqual([]);
    expect(resolvePluginConfigMutationRejections(telegramParams, {})).toEqual(
      [],
    );
    expect(
      resolvePluginConfigMutationRejections(
        [{ key: "TELEGRAM_BOT_TOKEN" }, { key: "UNUSED_KEY" }],
        { TELEGRAM_BOT_TOKEN: "tok" },
      ),
    ).toEqual([]);
  });

  it("accepts a single allowed key and ignores unused declared params", () => {
    expect(
      resolvePluginConfigMutationRejections(telegramParams, {
        TELEGRAM_BOT_TOKEN: "tok",
      }),
    ).toEqual([]);
  });

  it("rejects an undeclared key and preserves the original field name", () => {
    expect(
      resolvePluginConfigMutationRejections(telegramParams, {
        EXTRA_KEY: "nope",
      }),
    ).toEqual([
      {
        field: "EXTRA_KEY",
        message: "EXTRA_KEY is not a declared config key for this plugin",
      },
    ]);
  });

  it("matches allowed keys case-insensitively and after trim (tie on normalized key)", () => {
    expect(
      resolvePluginConfigMutationRejections([{ key: " telegram_bot_token " }], {
        " TELEGRAM_BOT_TOKEN ": "tok",
      }),
    ).toEqual([]);
  });

  it("rejects a declared blocked env key for security, including prefix families", () => {
    const blockedExact = [...BLOCKED_ENV_KEYS][0];
    expect(blockedExact).toBeDefined();
    if (blockedExact === undefined) {
      throw new Error("expected BLOCKED_ENV_KEYS to be non-empty");
    }
    expect(
      resolvePluginConfigMutationRejections([{ key: blockedExact }], {
        [blockedExact]: "secret",
      }),
    ).toEqual([
      {
        field: blockedExact,
        message: `${blockedExact} is blocked for security reasons`,
      },
    ]);

    const prefix = BLOCKED_ENV_KEY_PREFIXES[0];
    expect(prefix).toBeDefined();
    if (prefix === undefined) {
      throw new Error("expected BLOCKED_ENV_KEY_PREFIXES to be non-empty");
    }
    const prefixed = `${prefix}CUSTOM_CHANNEL`;
    expect(
      resolvePluginConfigMutationRejections([{ key: prefixed }], {
        [prefixed]: "secret",
      }),
    ).toEqual([
      {
        field: prefixed,
        message: `${prefixed} is blocked for security reasons`,
      },
    ]);
  });

  it("prefers the undeclared-key rejection over the blocked-key check", () => {
    const blockedExact = [...BLOCKED_ENV_KEYS][0];
    expect(blockedExact).toBeDefined();
    if (blockedExact === undefined) {
      throw new Error("expected BLOCKED_ENV_KEYS to be non-empty");
    }
    expect(
      resolvePluginConfigMutationRejections(telegramParams, {
        [blockedExact]: "secret",
      }),
    ).toEqual([
      {
        field: blockedExact,
        message: `${blockedExact} is not a declared config key for this plugin`,
      },
    ]);
  });

  it("reports mixed allowed, undeclared, and blocked keys in Object.keys order", () => {
    const blockedExact = [...BLOCKED_ENV_KEYS][0];
    expect(blockedExact).toBeDefined();
    if (blockedExact === undefined) {
      throw new Error("expected BLOCKED_ENV_KEYS to be non-empty");
    }
    const config: Record<string, unknown> = {
      TELEGRAM_BOT_TOKEN: "tok",
      rogue: 1,
      [blockedExact]: "secret",
    };
    expect(
      resolvePluginConfigMutationRejections(
        [{ key: "TELEGRAM_BOT_TOKEN" }, { key: blockedExact }],
        config,
      ),
    ).toEqual([
      {
        field: "rogue",
        message: "rogue is not a declared config key for this plugin",
      },
      {
        field: blockedExact,
        message: `${blockedExact} is blocked for security reasons`,
      },
    ]);
  });

  it("rejects overflow of undeclared keys without dropping earlier findings", () => {
    const overflow: Record<string, unknown> = {};
    for (let i = 0; i < 12; i += 1) {
      overflow[`extra_${i}`] = i;
    }
    const rejections = resolvePluginConfigMutationRejections(
      telegramParams,
      overflow,
    );
    expect(rejections).toHaveLength(12);
    expect(rejections[0]).toEqual({
      field: "extra_0",
      message: "extra_0 is not a declared config key for this plugin",
    });
    expect(rejections[11]).toEqual({
      field: "extra_11",
      message: "extra_11 is not a declared config key for this plugin",
    });
  });
});
