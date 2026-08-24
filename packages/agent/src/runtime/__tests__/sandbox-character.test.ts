/**
 * Unit tests for the cloud sandbox character loader (Path A fix #1).
 */

import { logger } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  applySandboxCharacterFromEnv,
  applySandboxConnectorOwnership,
  applySandboxIdentityFromEnv,
  type CharacterOverrideFileAccess,
  prepareSandboxRuntimeConfig,
  resolveSandboxRouteAgentId,
  sandboxOwnsConnectors,
} from "../sandbox-character.ts";

vi.mock("@elizaos/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@elizaos/core")>()),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function makeFileAccess(options?: {
  cwd?: string;
  repoRoot?: string | null;
  files?: Record<string, string>;
}): CharacterOverrideFileAccess {
  const files = options?.files ?? {};
  return {
    cwd: options?.cwd ?? "/workspace",
    argv1: "/workspace/packages/agent/src/index.ts",
    existsSync: (filePath) => Object.hasOwn(files, filePath),
    readTextFileSync: (filePath) => {
      const value = files[filePath];
      if (value === undefined) throw new Error(`missing file: ${filePath}`);
      return value;
    },
    resolvePackageRoot: () => options?.repoRoot ?? null,
  };
}

describe("applySandboxCharacterFromEnv", () => {
  it("is a no-op when no character override is present", () => {
    const config = { agents: { list: [] } } as never;
    const out = applySandboxCharacterFromEnv(config, {}, makeFileAccess());
    expect(out).toBe(config);
    expect((out as { agents?: { list?: unknown[] } }).agents?.list).toEqual([]);
  });

  it("merges the injected character onto config.agents.list[0]", () => {
    const character = {
      id: "char-internal",
      name: "Nyx",
      system: "You are Nyx.",
      bio: ["A mysterious agent."],
      topics: ["lore"],
      adjectives: ["sharp"],
      style: { all: ["concise"] },
      settings: { discord: { autoReply: true } },
      knowledge: [{ directory: "/knowledge" }],
    };
    const config = {} as never;
    const out = applySandboxCharacterFromEnv(config, {
      ELIZA_AGENT_CHARACTER_JSON: JSON.stringify(character),
      SANDBOX_ROUTE_AGENT_ID: "char-route",
    });
    const entry = (out as { agents: { list: Array<Record<string, unknown>> } })
      .agents.list[0];
    expect(entry.name).toBe("Nyx");
    expect(entry.system).toBe("You are Nyx.");
    expect(entry.bio).toEqual(["A mysterious agent."]);
    expect(entry.settings).toEqual({ discord: { autoReply: true } });
    expect(entry.knowledge).toEqual([{ directory: "/knowledge" }]);
    // The id MUST be the routing id so runtime.agentId matches the gateway.
    expect(entry.id).toBe("char-route");
    expect(entry.default).toBe(true);
    // UI assistant name surfaces for logging/prompts.
    expect(
      (out as { ui: { assistant: { name: string } } }).ui.assistant.name,
    ).toBe("Nyx");
  });

  it("preserves object knowledge sources when appending lore", () => {
    const config = {} as never;
    const out = applySandboxCharacterFromEnv(config, {
      ELIZA_AGENT_CHARACTER_JSON: JSON.stringify({
        name: "Nyx",
        knowledge: [
          { path: "docs", shared: true },
          { directory: "knowledge" },
          "facts.md",
        ],
        lore: ["Never discard structured knowledge."],
      }),
    });

    expect(
      (out as { agents: { list: Array<{ knowledge: unknown[] }> } }).agents
        .list[0]?.knowledge,
    ).toEqual([
      { path: "docs", shared: true },
      { directory: "knowledge" },
      "facts.md",
      "Never discard structured knowledge.",
    ]);
  });

  it("loads an explicit relative character path through the injected file seam", () => {
    const filePath = "/workspace/characters/nyx.json";
    const out = applySandboxCharacterFromEnv(
      {} as never,
      { ELIZA_CHARACTER_PATH: "characters/nyx.json" },
      makeFileAccess({
        files: { [filePath]: JSON.stringify({ name: "File Nyx" }) },
      }),
    );

    expect(
      (out as { agents: { list: Array<{ name: string }> } }).agents.list[0]
        ?.name,
    ).toBe("File Nyx");
  });

  it("discovers character.json at the injected package root during tests", () => {
    const filePath = "/repo/character.json";
    const out = applySandboxCharacterFromEnv(
      {} as never,
      { NODE_ENV: "test" },
      makeFileAccess({
        repoRoot: "/repo",
        files: { [filePath]: JSON.stringify({ name: "Root Nyx" }) },
      }),
    );

    expect(
      (out as { agents: { list: Array<{ name: string }> } }).agents.list[0]
        ?.name,
    ).toBe("Root Nyx");
  });

  it("normalizes legacy modelProvider ids and replaces stale routing", () => {
    const config = {
      serviceRouting: {
        llmText: {
          backend: "remote",
          transport: "remote",
          remoteApiBase: "https://old.invalid",
          primaryModel: "llama3.2",
        },
      },
    } as never;
    const out = applySandboxCharacterFromEnv(config, {
      ELIZA_AGENT_CHARACTER_JSON: JSON.stringify({
        name: "Nyx",
        modelProvider: "llama_local",
      }),
    });

    expect(out.serviceRouting?.llmText).toEqual({
      backend: "ollama",
      transport: "direct",
      primaryModel: "llama3.2",
    });
  });

  it("retains existing routing for an unsupported modelProvider", () => {
    const existingRoute = {
      backend: "openai",
      transport: "direct",
    } as const;
    const config = {
      serviceRouting: { llmText: existingRoute },
    } as never;
    const out = applySandboxCharacterFromEnv(config, {
      ELIZA_AGENT_CHARACTER_JSON: JSON.stringify({
        name: "Nyx",
        modelProvider: "made-up-provider",
      }),
    });

    expect(out.serviceRouting?.llmText).toEqual(existingRoute);
  });

  it("survives malformed JSON without throwing and keeps the config unchanged", () => {
    const config = { agents: { list: [] } } as never;
    const out = applySandboxCharacterFromEnv(config, {
      NODE_ENV: "test",
      ELIZA_AGENT_CHARACTER_JSON: "{ not json",
    });
    expect((out as { agents: { list: unknown[] } }).agents.list).toEqual([]);
  });

  it("treats an absent config.agents as an empty list (no empty-object sludge)", () => {
    // Regression for the typed-optional read of config.agents: when the field
    // is entirely absent the injected character must still land at list[0]
    // without materializing intermediate `?? {}` objects (guard #9940).
    const config = {} as never;
    const out = applySandboxCharacterFromEnv(config, {
      ELIZA_AGENT_CHARACTER_JSON: JSON.stringify({ name: "Nyx", system: "x" }),
    });
    const agents = (out as { agents: { list: Array<Record<string, unknown>> } })
      .agents;
    expect(Array.isArray(agents.list)).toBe(true);
    expect(agents.list).toHaveLength(1);
    expect(agents.list[0]?.name).toBe("Nyx");
    expect(agents.list[0]?.default).toBe(true);
  });

  it("preserves sibling keys on config.agents while replacing the list", () => {
    // The typed-optional path spreads the existing agents object; sibling
    // settings (e.g. defaults) must survive the character injection.
    const config = {
      agents: { list: [], defaults: { temperature: 0.3 } },
    } as never;
    const out = applySandboxCharacterFromEnv(config, {
      ELIZA_AGENT_CHARACTER_JSON: JSON.stringify({ name: "Nyx", system: "x" }),
    });
    const agents = (
      out as {
        agents: { list: unknown[]; defaults?: { temperature: number } };
      }
    ).agents;
    expect(agents.defaults?.temperature).toBe(0.3);
    expect(agents.list).toHaveLength(1);
  });

  it("falls back to AGENT_NAME when the character has no name", () => {
    const config = {} as never;
    const out = applySandboxCharacterFromEnv(config, {
      ELIZA_AGENT_CHARACTER_JSON: JSON.stringify({ system: "x" }),
      AGENT_NAME: "Nyx",
    });
    const entry = (out as { agents: { list: Array<Record<string, unknown>> } })
      .agents.list[0];
    expect(entry.name).toBe("Nyx");
  });
});

describe("applySandboxIdentityFromEnv", () => {
  it("re-applies the injected character and routing id to a fresh reload config", () => {
    const env = {
      ELIZA_AGENT_CHARACTER_JSON: JSON.stringify({
        id: "embedded-id",
        name: "Sol",
        system: "You are Sol.",
      }),
      SANDBOX_ROUTE_AGENT_ID: "route-id",
    };

    const initial = {} as never;
    const reloaded = {
      agents: { list: [{ name: "Eliza", default: true }] },
    } as never;
    expect(applySandboxIdentityFromEnv(initial, env)).toBe("route-id");
    expect(applySandboxIdentityFromEnv(reloaded, env)).toBe("route-id");

    const reloadedPrimary = (
      reloaded as { agents: { list: Array<Record<string, unknown>> } }
    ).agents.list[0];
    expect(reloadedPrimary).toMatchObject({
      id: "route-id",
      name: "Sol",
      system: "You are Sol.",
      default: true,
    });
  });
});

describe("prepareSandboxRuntimeConfig", () => {
  it("strips gateway-owned credentials projected from a reload config", () => {
    const env: NodeJS.ProcessEnv = {
      ELIZA_CLOUD_PROVISIONED: "1",
      ELIZA_AGENT_CHARACTER_JSON: JSON.stringify({
        name: "Sol",
        system: "You are Sol.",
        settings: {
          telegram: { botToken: "identity-telegram-secret" },
          secrets: { DISCORD_BOT_TOKEN: "identity-discord-secret" },
        },
      }),
      SANDBOX_ROUTE_AGENT_ID: "route-id",
    };
    const reloaded = {
      agents: {
        list: [
          { name: "Secondary", system: "Secondary system.", default: false },
          { name: "Eliza", system: "Old primary system.", default: true },
        ],
      },
      connectors: {
        discord: { token: "discord-secret" },
        telegram: { botToken: "telegram-secret" },
      },
      channels: {
        discord: { token: "legacy-discord-secret" },
        telegram: { botToken: "legacy-telegram-secret" },
      },
      env: {
        DISCORD_API_TOKEN: "env-discord-secret",
        vars: { TELEGRAM_BOT_TOKEN: "vars-telegram-secret" },
      },
    };

    const routeAgentId = prepareSandboxRuntimeConfig(
      reloaded as never,
      (config, projectedEnv) => {
        const connectors = config.connectors as {
          discord?: { token?: string };
          telegram?: { botToken?: string };
        };
        projectedEnv.DISCORD_API_TOKEN = connectors.discord?.token;
        projectedEnv.DISCORD_BOT_TOKEN = connectors.discord?.token;
        projectedEnv.TELEGRAM_BOT_TOKEN = connectors.telegram?.botToken;
      },
      env,
    );

    expect(routeAgentId).toBe("route-id");
    expect(env.DISCORD_API_TOKEN).toBeUndefined();
    expect(env.DISCORD_BOT_TOKEN).toBeUndefined();
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(reloaded.connectors.discord).toBeUndefined();
    expect(reloaded.connectors.telegram).toBeUndefined();
    expect(reloaded.channels.discord).toBeUndefined();
    expect(reloaded.channels.telegram).toBeUndefined();
    expect(reloaded.env.DISCORD_API_TOKEN).toBeUndefined();
    expect(reloaded.env.vars.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(reloaded.agents.list[0]).toMatchObject({
      id: "route-id",
      name: "Sol",
      system: "You are Sol.",
      default: true,
    });
    expect(reloaded.agents.list[0]).not.toHaveProperty("settings.telegram");
    expect(reloaded.agents.list[0]).not.toHaveProperty(
      "settings.secrets.DISCORD_BOT_TOKEN",
    );
    expect(reloaded.agents.list[1]?.name).toBe("Secondary");
  });
});

describe("resolveSandboxRouteAgentId", () => {
  it("returns the route id when present", () => {
    expect(resolveSandboxRouteAgentId({ SANDBOX_ROUTE_AGENT_ID: "abc" })).toBe(
      "abc",
    );
  });
  it("returns null when absent", () => {
    expect(resolveSandboxRouteAgentId({})).toBeNull();
  });
});

describe("connector ownership (double-connect resolution)", () => {
  const characterWithDiscord = JSON.stringify({
    name: "Nyx",
    connectors: { discord: { dmPolicy: "pairing" } },
  });

  it("does NOT apply connectors by default (gateway owns the connection)", () => {
    const config = {} as never;
    const out = applySandboxCharacterFromEnv(config, {
      ELIZA_AGENT_CHARACTER_JSON: characterWithDiscord,
    });
    expect((out as { connectors?: unknown }).connectors).toBeUndefined();
  });

  it("applies connectors when ELIZA_SANDBOX_OWNS_CONNECTORS=1", () => {
    const config = {} as never;
    const out = applySandboxCharacterFromEnv(config, {
      ELIZA_AGENT_CHARACTER_JSON: characterWithDiscord,
      ELIZA_SANDBOX_OWNS_CONNECTORS: "1",
    });
    const connectors = (
      out as { connectors: Record<string, { dmPolicy?: string }> }
    ).connectors;
    expect(connectors.discord.dmPolicy).toBe("pairing");
  });
});

describe("applySandboxConnectorOwnership", () => {
  it("strips connector tokens AND config blocks in a provisioned container by default", async () => {
    const { applySandboxConnectorOwnership } = await import(
      "../sandbox-character.ts"
    );
    const env: NodeJS.ProcessEnv = {
      ELIZA_CLOUD_PROVISIONED: "1",
      DISCORD_API_TOKEN: "tok",
      DISCORD_BOT_TOKEN: "tok",
      TELEGRAM_BOT_TOKEN: "tg",
    };
    const config = {
      connectors: { discord: { token: "x" }, telegram: { botToken: "y" } },
    } as never;
    applySandboxConnectorOwnership(env, config);
    expect(env.DISCORD_API_TOKEN).toBeUndefined();
    expect(env.DISCORD_BOT_TOKEN).toBeUndefined();
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    // Config connector blocks must be cleared so nothing re-derives the token.
    const conns = (config as { connectors: Record<string, unknown> })
      .connectors;
    expect(conns.discord).toBeUndefined();
    expect(conns.telegram).toBeUndefined();
  });

  it("keeps connector tokens when the container owns connectors", async () => {
    const { applySandboxConnectorOwnership } = await import(
      "../sandbox-character.ts"
    );
    const env: NodeJS.ProcessEnv = {
      ELIZA_CLOUD_PROVISIONED: "1",
      ELIZA_SANDBOX_OWNS_CONNECTORS: "1",
      DISCORD_API_TOKEN: "tok",
    };
    applySandboxConnectorOwnership(env);
    expect(env.DISCORD_API_TOKEN).toBe("tok");
  });

  it("is a no-op outside a provisioned container", async () => {
    const { applySandboxConnectorOwnership } = await import(
      "../sandbox-character.ts"
    );
    const env: NodeJS.ProcessEnv = { DISCORD_API_TOKEN: "tok" };
    applySandboxConnectorOwnership(env);
    expect(env.DISCORD_API_TOKEN).toBe("tok");
  });

  it('requires the provisioned flag to be exactly "1" (untrimmed values are ignored)', () => {
    const env: NodeJS.ProcessEnv = {
      ELIZA_CLOUD_PROVISIONED: " 1 ",
      DISCORD_API_TOKEN: "tok",
    };
    applySandboxConnectorOwnership(env);
    expect(env.DISCORD_API_TOKEN).toBe("tok");
  });
});

describe("sandboxOwnsConnectors", () => {
  it('is true only when the variable trims to exactly "1"', () => {
    expect(sandboxOwnsConnectors({ ELIZA_SANDBOX_OWNS_CONNECTORS: "1" })).toBe(
      true,
    );
    expect(
      sandboxOwnsConnectors({ ELIZA_SANDBOX_OWNS_CONNECTORS: " 1 " }),
    ).toBe(true);
    expect(sandboxOwnsConnectors({ ELIZA_SANDBOX_OWNS_CONNECTORS: "0" })).toBe(
      false,
    );
    expect(
      sandboxOwnsConnectors({ ELIZA_SANDBOX_OWNS_CONNECTORS: "true" }),
    ).toBe(false);
    expect(sandboxOwnsConnectors({ ELIZA_SANDBOX_OWNS_CONNECTORS: "" })).toBe(
      false,
    );
    expect(sandboxOwnsConnectors({})).toBe(false);
  });
});

describe("resolveSandboxRouteAgentId trimming", () => {
  it("trims surrounding whitespace off a present id", () => {
    expect(
      resolveSandboxRouteAgentId({ SANDBOX_ROUTE_AGENT_ID: "  r-9 " }),
    ).toBe("r-9");
  });

  it("treats a whitespace-only id as absent", () => {
    expect(
      resolveSandboxRouteAgentId({ SANDBOX_ROUTE_AGENT_ID: "   " }),
    ).toBeNull();
  });
});

describe("applySandboxCharacterFromEnv field mapping and precedence", () => {
  it("maps every supported character field onto list[0] and returns the same config object", () => {
    const config = {} as never;
    const out = applySandboxCharacterFromEnv(config, {
      ELIZA_AGENT_CHARACTER_JSON: JSON.stringify({
        name: "Nova",
        username: "nova_bot",
        system: "You are Nova.",
        bio: "Built from a single string.",
        topics: ["orbit"],
        adjectives: ["bright"],
        postExamples: "Example post.",
        style: { all: ["terse"] },
        messageExamples: [[{ user: "human", content: { text: "hi" } }]],
        settings: { telegram: { botToken: "st" } },
        knowledge: [{ directory: "kb" }],
        lore: ["Ancient lore."],
      }),
      SANDBOX_ROUTE_AGENT_ID: "route-nova",
    });

    expect(out).toBe(config);
    const entry = (out as { agents: { list: Array<Record<string, unknown>> } })
      .agents.list[0];
    expect(entry.id).toBe("route-nova");
    expect(entry.default).toBe(true);
    expect(entry.name).toBe("Nova");
    expect(entry.username).toBe("nova_bot");
    expect(entry.bio).toEqual(["Built from a single string."]);
    expect(entry.topics).toEqual(["orbit"]);
    expect(entry.adjectives).toEqual(["bright"]);
    expect(entry.postExamples).toEqual(["Example post."]);
    expect(entry.style).toEqual({ all: ["terse"] });
    expect(entry.messageExamples).toEqual([
      [{ user: "human", content: { text: "hi" } }],
    ]);
    expect(entry.settings).toEqual({ telegram: { botToken: "st" } });
    expect(entry.knowledge).toEqual([{ directory: "kb" }, "Ancient lore."]);
    expect(
      (out as { ui: { assistant: { name: string } } }).ui.assistant.name,
    ).toBe("Nova");
  });

  it("normalizes scalar list fields to single-element arrays and filters non-string array members", () => {
    const out = applySandboxCharacterFromEnv({} as never, {
      ELIZA_AGENT_CHARACTER_JSON: JSON.stringify({
        name: "Nyx",
        topics: ["keep", 7, null],
        adjectives: "   ",
        bio: "",
      }),
    });
    const entry = (out as { agents: { list: Array<Record<string, unknown>> } })
      .agents.list[0];
    expect(entry.topics).toEqual(["keep"]);
    // Blank scalar strings omit the field entirely.
    expect(entry).not.toHaveProperty("adjectives");
    expect(entry).not.toHaveProperty("bio");
  });

  it("preserves an explicitly empty array field", () => {
    const out = applySandboxCharacterFromEnv({} as never, {
      ELIZA_AGENT_CHARACTER_JSON: JSON.stringify({
        name: "Nyx",
        postExamples: [],
      }),
    });
    const entry = (out as { agents: { list: Array<Record<string, unknown>> } })
      .agents.list[0];
    expect(entry.postExamples).toEqual([]);
  });

  it("resolves the name from parsed.name before ELIZA_AGENT_NAME before AGENT_NAME", () => {
    const base = { ELIZA_AGENT_NAME: "Env Name", AGENT_NAME: "Agent Env" };

    const named = applySandboxCharacterFromEnv({} as never, {
      ...base,
      ELIZA_AGENT_CHARACTER_JSON: JSON.stringify({ name: "Parsed" }),
    });
    expect(
      (named as { agents: { list: Array<{ name: string }> } }).agents.list[0]
        ?.name,
    ).toBe("Parsed");

    const blankParsed = applySandboxCharacterFromEnv({} as never, {
      ...base,
      ELIZA_AGENT_CHARACTER_JSON: JSON.stringify({ name: "   " }),
    });
    expect(
      (blankParsed as { agents: { list: Array<{ name: string }> } }).agents
        .list[0]?.name,
    ).toBe("Env Name");
  });

  it("derives the id from parsed.id, then SANDBOX_AGENT_ID, then a name slug", () => {
    const entryId = (env: NodeJS.ProcessEnv) =>
      (
        applySandboxCharacterFromEnv({} as never, env) as {
          agents: { list: Array<{ id: string }> };
        }
      ).agents.list[0]?.id;

    expect(
      entryId({
        ELIZA_AGENT_CHARACTER_JSON: JSON.stringify({
          id: "char-id",
          name: "A",
        }),
      }),
    ).toBe("char-id");
    expect(
      entryId({
        ELIZA_AGENT_CHARACTER_JSON: JSON.stringify({ name: "B" }),
        SANDBOX_AGENT_ID: "  sbx-9  ",
      }),
    ).toBe("sbx-9");
    expect(
      entryId({
        ELIZA_AGENT_CHARACTER_JSON: JSON.stringify({ name: "Nyx Prime" }),
      }),
    ).toBe("nyx-prime");
    // A non-string embedded id cannot win; the name slug follows.
    expect(
      entryId({
        ELIZA_AGENT_CHARACTER_JSON: JSON.stringify({ id: 123, name: "Num" }),
      }),
    ).toBe("num");
  });

  it("ignores JSON bodies that are null or a primitive", () => {
    for (const raw of ["null", "42", '"bare string"']) {
      const config = { agents: { list: [] } } as never;
      const out = applySandboxCharacterFromEnv(config, {
        ELIZA_AGENT_CHARACTER_JSON: raw,
      });
      expect(out).toBe(config);
      expect((out as { agents: { list: unknown[] } }).agents.list).toEqual([]);
    }
  });

  it("warns and keeps the config unchanged when no usable name exists anywhere", () => {
    const config = { agents: { list: [] } } as never;
    const out = applySandboxCharacterFromEnv(config, {
      ELIZA_AGENT_CHARACTER_JSON: JSON.stringify({ system: "x" }),
    });
    expect(out).toBe(config);
    expect((out as { agents: { list: unknown[] } }).agents.list).toEqual([]);
    expect(
      vi
        .mocked(logger.warn)
        .mock.calls.some(([message]) =>
          String(message).includes("has no name"),
        ),
    ).toBe(true);
  });

  it("merges onto an existing default agent, preserving its unrelated fields", () => {
    const config = {
      agents: {
        list: [
          { name: "Secondary", system: "secondary system." },
          {
            name: "Old Default",
            default: true,
            system: "old system.",
            persona: "keep-me",
          },
        ],
      },
    } as never;
    const out = applySandboxCharacterFromEnv(config, {
      ELIZA_AGENT_CHARACTER_JSON: JSON.stringify({
        name: "Sol",
        system: "new system.",
      }),
    });
    const list = (out as { agents: { list: Array<Record<string, unknown>> } })
      .agents.list;
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({
      default: true,
      name: "Sol",
      system: "new system.",
      persona: "keep-me",
    });
    expect(list[1]?.name).toBe("Secondary");
  });

  it("loads an absolute ELIZA_CHARACTER_PATH verbatim", () => {
    const out = applySandboxCharacterFromEnv(
      {} as never,
      { ELIZA_CHARACTER_PATH: "/abs/nova.json" },
      makeFileAccess({
        cwd: "/somewhere-else",
        files: { "/abs/nova.json": JSON.stringify({ name: "Abs Nova" }) },
      }),
    );
    expect(
      (out as { agents: { list: Array<{ name: string }> } }).agents.list[0]
        ?.name,
    ).toBe("Abs Nova");
  });

  it("prefers injected JSON over any local character file", () => {
    const out = applySandboxCharacterFromEnv(
      {} as never,
      {
        ELIZA_AGENT_CHARACTER_JSON: JSON.stringify({ name: "Json Wins" }),
        ELIZA_CHARACTER_PATH: "characters/local.json",
      },
      makeFileAccess({
        files: {
          "/workspace/characters/local.json": JSON.stringify({
            name: "File Loses",
          }),
        },
      }),
    );
    expect(
      (out as { agents: { list: Array<{ name: string }> } }).agents.list[0]
        ?.name,
    ).toBe("Json Wins");
  });

  it("skips local discovery when ELIZA_DISABLE_LOCAL_CHARACTER=1", () => {
    const config = { agents: { list: [] } } as never;
    const out = applySandboxCharacterFromEnv(
      config,
      { ELIZA_DISABLE_LOCAL_CHARACTER: "1" },
      makeFileAccess({
        repoRoot: "/repo",
        files: {
          "/repo/character.json": JSON.stringify({ name: "Root Nyx" }),
        },
      }),
    );
    expect(out).toBe(config);
    expect((out as { agents: { list: unknown[] } }).agents.list).toEqual([]);
  });

  it("still applies injected JSON when local discovery is disabled", () => {
    const out = applySandboxCharacterFromEnv(
      {} as never,
      {
        ELIZA_DISABLE_LOCAL_CHARACTER: "1",
        ELIZA_AGENT_CHARACTER_JSON: JSON.stringify({ name: "Still Applied" }),
      },
      makeFileAccess(),
    );
    expect(
      (out as { agents: { list: Array<{ name: string }> } }).agents.list[0]
        ?.name,
    ).toBe("Still Applied");
  });

  it("warns and boots with the default character when the local file cannot be read", () => {
    const config = { agents: { list: [] } } as never;
    const out = applySandboxCharacterFromEnv(
      config,
      { ELIZA_CHARACTER_PATH: "missing.json" },
      makeFileAccess({ files: {} }),
    );
    expect(out).toBe(config);
    expect((out as { agents: { list: unknown[] } }).agents.list).toEqual([]);
    expect(
      vi
        .mocked(logger.warn)
        .mock.calls.some(([message]) =>
          String(message).includes("Failed to read local character file"),
        ),
    ).toBe(true);
  });

  it("treats an empty local file as absent without warning", () => {
    const config = { agents: { list: [] } } as never;
    const warnsBefore = vi.mocked(logger.warn).mock.calls.length;
    const out = applySandboxCharacterFromEnv(
      config,
      { ELIZA_CHARACTER_PATH: "blank.json" },
      makeFileAccess({ files: { "/workspace/blank.json": "   " } }),
    );
    expect(out).toBe(config);
    expect((out as { agents: { list: unknown[] } }).agents.list).toEqual([]);
    expect(vi.mocked(logger.warn).mock.calls.length).toBe(warnsBefore);
  });
});

describe("applySandboxCharacterFromEnv connector application", () => {
  const ownsEnv = (json: string): NodeJS.ProcessEnv => ({
    ELIZA_AGENT_CHARACTER_JSON: json,
    ELIZA_SANDBOX_OWNS_CONNECTORS: "1",
  });

  it("merges character connectors over existing config connectors", () => {
    const config = { connectors: { telegram: { legacy: true } } } as never;
    const out = applySandboxCharacterFromEnv(
      config,
      ownsEnv(
        JSON.stringify({
          name: "Nyx",
          connectors: { discord: { dmPolicy: "pairing" } },
        }),
      ),
    );
    const connectors = (out as { connectors: Record<string, unknown> })
      .connectors;
    expect(connectors.discord).toEqual({ dmPolicy: "pairing" });
    expect(connectors.telegram).toEqual({ legacy: true });
  });

  it("rejects array-valued connector config", () => {
    const out = applySandboxCharacterFromEnv(
      {} as never,
      ownsEnv(JSON.stringify({ name: "Nyx", connectors: ["discord"] })),
    );
    expect((out as { connectors?: unknown }).connectors).toBeUndefined();
  });

  it("rejects scalar-valued connector config", () => {
    const out = applySandboxCharacterFromEnv(
      {} as never,
      ownsEnv(JSON.stringify({ name: "Nyx", connectors: "discord" })),
    );
    expect((out as { connectors?: unknown }).connectors).toBeUndefined();
  });

  it("logs the owned connector keys when applying them", () => {
    applySandboxCharacterFromEnv(
      {} as never,
      ownsEnv(
        JSON.stringify({
          name: "Nyx",
          connectors: { discord: { dmPolicy: "allowlist" } },
        }),
      ),
    );
    expect(
      vi
        .mocked(logger.info)
        .mock.calls.some(([message]) =>
          String(message).includes("Container owns connectors"),
        ),
    ).toBe(true);
  });
});

describe("applySandboxConnectorOwnership nested stripping", () => {
  const provisionedEnv = (
    extra: NodeJS.ProcessEnv = {},
  ): NodeJS.ProcessEnv => ({
    ELIZA_CLOUD_PROVISIONED: "1",
    ...extra,
  });

  it("keeps empty-string token values (stripping tests truthiness)", () => {
    const env = provisionedEnv({ TELEGRAM_BOT_TOKEN: "" });
    applySandboxConnectorOwnership(env);
    expect(env.TELEGRAM_BOT_TOKEN).toBe("");
  });

  it("strips tokens and connector blocks from every nested credential location", () => {
    const env = provisionedEnv();
    const config = {
      connectors: { discord: { token: "d" }, slack: { keep: true } },
      channels: { telegram: { t: "tg" }, slack: { keep: true } },
      env: {
        DISCORD_API_TOKEN: "env-level",
        KEEP: "kept-env",
        vars: { DISCORD_BOT_TOKEN: "vars-level", KEEP: "kept-vars" },
      },
      agents: {
        list: [
          {
            name: "A",
            settings: {
              discord: { nested: true },
              extra: { TELEGRAM_BOT_TOKEN: "extra", KEEP: "kept-extra" },
              secrets: { DISCORD_API_TOKEN: "secret", KEEP: "kept-secrets" },
            },
          },
          { name: "B" },
        ],
      },
    };
    applySandboxConnectorOwnership(env, config as never);

    const connectors = config.connectors as Record<string, unknown>;
    expect(connectors.discord).toBeUndefined();
    expect(connectors.slack).toEqual({ keep: true });
    const channels = config.channels as Record<string, unknown>;
    expect(channels.telegram).toBeUndefined();
    expect(channels.slack).toEqual({ keep: true });
    expect(config.env.DISCORD_API_TOKEN).toBeUndefined();
    expect(config.env.KEEP).toBe("kept-env");
    expect(config.env.vars.DISCORD_BOT_TOKEN).toBeUndefined();
    expect(config.env.vars.KEEP).toBe("kept-vars");
    const settings = config.agents.list[0].settings as Record<string, unknown>;
    expect(settings.discord).toBeUndefined();
    expect(settings.extra).toEqual({ KEEP: "kept-extra" });
    expect(settings.secrets).toEqual({ KEEP: "kept-secrets" });
    expect(config.agents.list[1]).toEqual({ name: "B" });
    expect(Object.keys(env)).toEqual(["ELIZA_CLOUD_PROVISIONED"]);
  });

  it("does not log a summary when there was nothing to strip", () => {
    const infosBefore = vi.mocked(logger.info).mock.calls.length;
    applySandboxConnectorOwnership(provisionedEnv(), {});
    expect(vi.mocked(logger.info).mock.calls.length).toBe(infosBefore);
  });

  it("tolerates a missing config argument", () => {
    const env = provisionedEnv({ DISCORD_BOT_TOKEN: "tok" });
    expect(() => applySandboxConnectorOwnership(env)).not.toThrow();
    expect(env.DISCORD_BOT_TOKEN).toBeUndefined();
  });
});

describe("prepareSandboxRuntimeConfig sequencing", () => {
  it("applies identity before projection and strips projected gateway-owned credentials last", () => {
    const env: NodeJS.ProcessEnv = {
      ELIZA_CLOUD_PROVISIONED: "1",
      ELIZA_AGENT_CHARACTER_JSON: JSON.stringify({ name: "Sol" }),
      SANDBOX_ROUTE_AGENT_ID: "route-sol",
    };
    const config = {} as never;
    let observedDuringProjection: unknown;
    const routeAgentId = prepareSandboxRuntimeConfig(
      config,
      (projectedConfig, projectedEnv) => {
        observedDuringProjection = (
          projectedConfig as {
            agents?: { list?: Array<{ name?: string }> };
          }
        )?.agents?.list?.[0]?.name;
        projectedEnv.DISCORD_API_TOKEN = "from-projection";
        (projectedConfig as { connectors?: unknown }).connectors = {
          discord: {},
        };
      },
      env,
    );

    expect(routeAgentId).toBe("route-sol");
    expect(observedDuringProjection).toBe("Sol");
    expect(env.DISCORD_API_TOKEN).toBeUndefined();
    expect(
      (config as { connectors?: Record<string, unknown> }).connectors?.discord,
    ).toBeUndefined();
  });

  it("keeps container-owned character connectors through projection and stripping", () => {
    const env: NodeJS.ProcessEnv = {
      ELIZA_CLOUD_PROVISIONED: "1",
      ELIZA_SANDBOX_OWNS_CONNECTORS: "1",
      ELIZA_AGENT_CHARACTER_JSON: JSON.stringify({
        name: "Owner",
        connectors: { discord: { dmPolicy: "pairing" } },
      }),
    };
    const config = {} as never;
    let sawConnectorsDuringProjection = false;
    prepareSandboxRuntimeConfig(
      config,
      (projectedConfig) => {
        sawConnectorsDuringProjection =
          (projectedConfig as { connectors?: Record<string, unknown> })
            .connectors?.discord !== undefined;
      },
      env,
    );

    expect(sawConnectorsDuringProjection).toBe(true);
    expect(
      (config as { connectors?: Record<string, unknown> }).connectors?.discord,
    ).toEqual({ dmPolicy: "pairing" });
  });

  it("returns null while still applying identity when no route id exists", () => {
    const env: NodeJS.ProcessEnv = {
      ELIZA_AGENT_CHARACTER_JSON: JSON.stringify({ name: "No Route" }),
    };
    const config = {} as never;
    const routeAgentId = prepareSandboxRuntimeConfig(config, () => {}, env);
    expect(routeAgentId).toBeNull();
    expect(
      (config as { agents?: { list?: Array<{ name?: string }> } }).agents
        ?.list?.[0]?.name,
    ).toBe("No Route");
  });
});

describe("applySandboxIdentityFromEnv without a route id", () => {
  it("still applies the character identity and returns null", () => {
    const config = {} as never;
    const out = applySandboxIdentityFromEnv(config, {
      ELIZA_AGENT_CHARACTER_JSON: JSON.stringify({ name: "Solo" }),
    });
    expect(out).toBeNull();
    expect(
      (config as { agents?: { list?: Array<{ name?: string }> } }).agents
        ?.list?.[0]?.name,
    ).toBe("Solo");
  });
});
