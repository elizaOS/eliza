/**
 * Unit tests for the cloud sandbox character loader (Path A fix #1).
 */

import { describe, expect, it, vi } from "vitest";
import {
  applySandboxCharacterFromEnv,
  applySandboxIdentityFromEnv,
  type CharacterOverrideFileAccess,
  prepareSandboxRuntimeConfig,
  resolveSandboxRouteAgentId,
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
    // without materializing intermediate `?? {}` objects (ratchet #9940).
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
});
