/**
 * Colocated unit coverage for settings-actions.ts. Sibling suites already pin
 * backend helpers and the chat-config provider/capability/section legs; this
 * file drives the remaining exported surface and handler branches: trimToString
 * overflow, SETTINGS_OPS, set_owner_name, worldSettings set (empty / single /
 * bulk / missing key / dependency order / persist failure), show_backends,
 * set_backend success/tag/brain, and dispatch aliases. Deterministic: real
 * temp config store + stub runtime, no live model.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type ActionResult,
  getSalt,
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
  ModelType,
  type Setting,
  saltWorldSettings,
  unsaltWorldSettings,
  type World,
  type WorldSettings,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SETTINGS_OPS,
  settingsAction,
  trimToString,
} from "./settings-actions.ts";

const OWNER_MESSAGE = { entityId: "owner" } as unknown as Memory;

function invoke(
  runtime: IAgentRuntime,
  parameters: Record<string, unknown>,
  message: Memory = OWNER_MESSAGE,
): Promise<ActionResult> {
  return settingsAction.handler(runtime, message, undefined, {
    parameters,
  } as HandlerOptions) as Promise<ActionResult>;
}

function setting(overrides: Partial<Setting> & Pick<Setting, "name">): Setting {
  return {
    description: overrides.name,
    usageDescription: overrides.name,
    required: false,
    value: "seed",
    dependsOn: [],
    ...overrides,
  };
}

function ownerWorldRuntime(world: World): {
  runtime: IAgentRuntime;
  updated: World[];
} {
  const updated: World[] = [];
  const runtime = {
    character: {},
    agentId: "agent-1",
    getAllWorlds: async () => [world],
    updateWorld: async (next: World) => {
      updated.push(next);
    },
  } as unknown as IAgentRuntime;
  return { runtime, updated };
}

function saltedWorld(settings: Record<string, Setting>): World {
  return {
    id: "world-1",
    name: "Owner World",
    agentId: "agent-1",
    serverId: "server-1",
    metadata: {
      ownership: { ownerId: "owner" },
      settings: saltWorldSettings({ settings }, getSalt()),
    },
  } as unknown as World;
}

let tempDir: string;
let configPath: string;
let priorConfigPath: string | undefined;
let priorPersistPath: string | undefined;

function readConfig(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(configPath, "utf-8")) as Record<
    string,
    unknown
  >;
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-actions-"));
  configPath = path.join(tempDir, "eliza.json");
  fs.writeFileSync(configPath, JSON.stringify({ ui: {} }));
  priorConfigPath = process.env.ELIZA_CONFIG_PATH;
  priorPersistPath = process.env.ELIZA_PERSIST_CONFIG_PATH;
  process.env.ELIZA_CONFIG_PATH = configPath;
  process.env.ELIZA_PERSIST_CONFIG_PATH = configPath;
});

afterEach(() => {
  if (priorConfigPath === undefined) delete process.env.ELIZA_CONFIG_PATH;
  else process.env.ELIZA_CONFIG_PATH = priorConfigPath;
  if (priorPersistPath === undefined) {
    delete process.env.ELIZA_PERSIST_CONFIG_PATH;
  } else {
    process.env.ELIZA_PERSIST_CONFIG_PATH = priorPersistPath;
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("trimToString", () => {
  it("returns undefined for non-strings, empties, and overflow", () => {
    expect(trimToString(undefined, 8)).toBeUndefined();
    expect(trimToString(12, 8)).toBeUndefined();
    expect(trimToString("", 8)).toBeUndefined();
    expect(trimToString("   ", 8)).toBeUndefined();
    expect(trimToString("overflow!", 5)).toBeUndefined();
  });

  it("trims and keeps a value at the exact max length", () => {
    expect(trimToString("  hello  ", 5)).toBe("hello");
    expect(trimToString("hello", 5)).toBe("hello");
  });
});

describe("SETTINGS_OPS and action metadata", () => {
  it("exports the full op catalog the handler dispatches on", () => {
    expect([...SETTINGS_OPS]).toEqual([
      "get",
      "list",
      "update_ai_provider",
      "toggle_capability",
      "set_owner_name",
      "set",
      "show_backends",
      "set_backend",
    ]);
  });

  it("declares SETTINGS with an OWNER gate and owner-name/backend similes", () => {
    expect(settingsAction.name).toBe("SETTINGS");
    expect(settingsAction.roleGate).toEqual({ minRole: "OWNER" });
    expect(settingsAction.similes).toEqual(
      expect.arrayContaining([
        "SET_OWNER_NAME",
        "SHOW_BACKENDS",
        "SET_BACKEND",
      ]),
    );
  });

  it("validate() is unconditionally true", async () => {
    await expect(
      settingsAction.validate(
        { character: {} } as unknown as IAgentRuntime,
        OWNER_MESSAGE,
      ),
    ).resolves.toBe(true);
  });
});

describe("SETTINGS dispatch aliases and invalid params", () => {
  const runtime = { character: {} } as unknown as IAgentRuntime;

  it("accepts `subaction` and `op` as the discriminator", async () => {
    const viaSub = await invoke(runtime, { subaction: "show_backends" });
    expect(viaSub.success).toBe(true);
    expect(viaSub.data?.op).toBe("show_backends");

    const viaOp = await invoke(runtime, { op: "show_backends" });
    expect(viaOp.success).toBe(true);
    expect(viaOp.data?.op).toBe("show_backends");
  });

  it("rejects a non-record parameters payload as SETTINGS_INVALID", async () => {
    const result = (await settingsAction.handler(
      runtime,
      OWNER_MESSAGE,
      undefined,
      { parameters: ["show_backends"] } as unknown as HandlerOptions,
    )) as ActionResult;
    expect(result.success).toBe(false);
    expect(result.data?.error).toBe("SETTINGS_INVALID");
    expect(result.data?.op).toBeNull();
  });

  it("does not trim or case-fold the switch discriminator", async () => {
    const spaced = await invoke(runtime, { action: " show_backends " });
    expect(spaced.success).toBe(false);
    expect(spaced.data?.error).toBe("SETTINGS_INVALID");

    const cased = await invoke(runtime, { action: "SHOW_BACKENDS" });
    expect(cased.success).toBe(false);
    expect(cased.data?.error).toBe("SETTINGS_INVALID");
  });
});

describe("SETTINGS set_owner_name", () => {
  const runtime = { character: {} } as unknown as IAgentRuntime;

  it("rejects a missing, non-string, or whitespace-only name", async () => {
    for (const parameters of [
      { action: "set_owner_name" },
      { action: "set_owner_name", name: 12 },
      { action: "set_owner_name", name: "   " },
    ]) {
      const result = await invoke(runtime, parameters);
      expect(result.success).toBe(false);
      expect(result.data?.error).toBe("INVALID_PARAMETERS");
    }
  });

  it("persists the first owner name to the real config store", async () => {
    const result = await invoke(runtime, {
      action: "set_owner_name",
      name: "  Sam  ",
    });
    expect(result.success).toBe(true);
    expect(result.text).toBe('Owner name set to "Sam".');
    expect(result.data).toMatchObject({
      op: "set_owner_name",
      name: "Sam",
      previous: null,
    });
    expect((readConfig().ui as { ownerName?: string }).ownerName).toBe("Sam");
  });

  it("reports the previous name on a subsequent write", async () => {
    await invoke(runtime, { action: "set_owner_name", name: "Sam" });
    const result = await invoke(runtime, {
      action: "set_owner_name",
      name: "Alex",
    });
    expect(result.success).toBe(true);
    expect(result.text).toBe('Owner name updated from "Sam" to "Alex".');
    expect(result.data).toMatchObject({
      op: "set_owner_name",
      name: "Alex",
      previous: "Sam",
    });
  });
});

describe("SETTINGS set — worldSettings registry edges", () => {
  it("fails with INVALID_PARAMETERS when the update queue is empty", async () => {
    const { runtime, updated } = ownerWorldRuntime(
      saltedWorld({ greeting: setting({ name: "Greeting" }) }),
    );
    const empty = await invoke(runtime, { action: "set" });
    expect(empty.success).toBe(false);
    expect(empty.data?.error).toBe("INVALID_PARAMETERS");

    const skippedNull = await invoke(runtime, {
      action: "set",
      key: "greeting",
      value: null,
    });
    expect(skippedNull.success).toBe(false);
    expect(skippedNull.data?.error).toBe("INVALID_PARAMETERS");
    expect(updated).toHaveLength(0);
  });

  it("fails with NO_OWNER_ENTITY when the calling message has no entityId", async () => {
    const { runtime } = ownerWorldRuntime(
      saltedWorld({ greeting: setting({ name: "Greeting" }) }),
    );
    const result = await invoke(
      runtime,
      { action: "set", key: "greeting", value: "hello" },
      {} as Memory,
    );
    expect(result.success).toBe(false);
    expect(result.data?.error).toBe("NO_OWNER_ENTITY");
  });

  it("fails with NO_OWNER_WORLD when no owned world has a settings registry", async () => {
    const runtime = {
      character: {},
      getAllWorlds: async () => [
        {
          id: "other",
          metadata: { ownership: { ownerId: "someone-else" } },
        },
        {
          id: "bare",
          metadata: { ownership: { ownerId: "owner" } },
        },
      ],
    } as unknown as IAgentRuntime;
    const result = await invoke(runtime, {
      action: "set",
      key: "greeting",
      value: "hello",
    });
    expect(result.success).toBe(false);
    expect(result.data?.error).toBe("NO_OWNER_WORLD");
  });

  it("skips a missing key and a dependency that is not yet met", async () => {
    const { runtime, updated } = ownerWorldRuntime(
      saltedWorld({
        greeting: setting({ name: "Greeting", value: null }),
        theme: setting({ name: "Theme", dependsOn: ["greeting"], value: null }),
      }),
    );
    const result = await invoke(runtime, {
      action: "set",
      updates: [
        { key: "theme", value: "dark" },
        { key: "missing", value: "x" },
        { not: "a-record" },
        { key: "  ", value: "blank" },
      ],
    });
    expect(result.success).toBe(false);
    expect(result.data?.error).toBe("NO_VALID_UPDATES");
    expect(result.data?.skipped).toEqual([
      { key: "theme", reason: "DEPENDENCY_NOT_MET" },
      { key: "missing", reason: "UNKNOWN_KEY" },
    ]);
    expect(updated).toHaveLength(0);
  });

  it("applies a later bulk entry once an earlier one satisfies dependsOn", async () => {
    const onSet: Array<string | boolean | null> = [];
    const { runtime, updated } = ownerWorldRuntime(
      saltedWorld({
        greeting: setting({ name: "Greeting", value: null }),
        theme: setting({
          name: "Theme",
          dependsOn: ["greeting"],
          value: null,
          onSetAction: (value) => {
            onSet.push(value);
            return "ok";
          },
        }),
      }),
    );
    const result = await invoke(runtime, {
      action: "set",
      updates: [
        { key: "greeting", value: 7 },
        { key: "theme", value: true },
        { key: "missing", value: "x" },
      ],
    });
    expect(result.success).toBe(true);
    expect(result.text).toBe("Updated 2 settings.");
    expect(result.data).toMatchObject({
      op: "set",
      applied: [
        { key: "greeting", value: "7" },
        { key: "theme", value: true },
      ],
      skipped: [{ key: "missing", reason: "UNKNOWN_KEY" }],
      worldId: "world-1",
    });
    expect(onSet).toEqual([true]);
    expect(updated).toHaveLength(1);
    const unsalted = unsaltWorldSettings(
      updated[0].metadata?.settings as WorldSettings,
      getSalt(),
    );
    expect(unsalted.settings?.greeting?.value).toBe("7");
    expect(unsalted.settings?.theme?.value).toBe(true);
  });

  it("keeps a single-element update's wording singular and boolean values", async () => {
    const { runtime } = ownerWorldRuntime(
      saltedWorld({ quiet: setting({ name: "Quiet", value: false }) }),
    );
    const result = await invoke(runtime, {
      action: "set",
      key: "quiet",
      value: false,
    });
    expect(result.success).toBe(true);
    expect(result.text).toBe("Updated 1 setting.");
    expect(result.data?.applied).toEqual([{ key: "quiet", value: false }]);
  });

  it("returns SETTINGS_SET_FAILED when updateWorld throws", async () => {
    const world = saltedWorld({
      greeting: setting({ name: "Greeting" }),
    });
    const runtime = {
      character: {},
      getAllWorlds: async () => [world],
      updateWorld: async () => {
        throw new Error("disk full");
      },
    } as unknown as IAgentRuntime;
    const result = await invoke(runtime, {
      action: "set",
      key: "greeting",
      value: "hello",
    });
    expect(result.success).toBe(false);
    expect(result.data?.error).toBe("SETTINGS_SET_FAILED");
    expect(result.text).toContain("disk full");
  });
});

describe("SETTINGS show_backends", () => {
  it("reports empty routing and a boot-default brain", async () => {
    const result = await invoke({ character: {} } as unknown as IAgentRuntime, {
      action: "show_backends",
    });
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      op: "show_backends",
      coding: {},
      brain: null,
    });
    expect(result.text).toContain(
      "- coding default: (operator pin / planner choice)",
    );
    expect(result.text).toContain("- chat brain: (boot default)");
  });

  it("prefers character routing (byTag + allow) over env and prints the lock-list", async () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        env: {
          ELIZA_BACKEND_ROUTING: JSON.stringify({
            coding: { default: "elizaos" },
          }),
        },
      }),
    );
    const runtime = {
      character: {
        settings: {
          routing: {
            coding: {
              default: "claude",
              byTag: { Hard: "codex" },
              allow: ["claude", "codex"],
            },
          },
        },
      },
      getSetting: (key: string) =>
        key === "ELIZA_BRAIN_PROVIDER" ? "anthropic" : null,
    } as unknown as IAgentRuntime;
    const result = await invoke(runtime, { action: "show_backends" });
    expect(result.success).toBe(true);
    expect(result.data?.coding).toEqual({
      default: "claude",
      byTag: { hard: "codex" },
      allow: ["claude", "codex"],
    });
    expect(result.data?.brain).toBe("anthropic");
    expect(result.text).toContain("- coding default: claude");
    expect(result.text).toContain("- coding when hard: codex");
    expect(result.text).toContain(
      "- coding allowed (lock-list): claude, codex",
    );
    expect(result.text).toContain("- chat brain: anthropic");
  });
});

describe("SETTINGS set_backend", () => {
  it("rejects an unknown coding backend without touching the store", async () => {
    const before = fs.readFileSync(configPath, "utf-8");
    const result = await invoke({ character: {} } as unknown as IAgentRuntime, {
      action: "set_backend",
      backend: "gpt-9000",
    });
    expect(result.success).toBe(false);
    expect(result.data?.error).toBe("SETTINGS_BACKEND_INVALID");
    expect(result.data?.provided).toBe("gpt-9000");
    expect(fs.readFileSync(configPath, "utf-8")).toBe(before);
  });

  it("sets the coding default, aliases openai→codex, and write-throughs the character", async () => {
    const runtime = { character: {} } as unknown as IAgentRuntime;
    const result = await invoke(runtime, {
      action: "set_backend",
      backend: "openai",
    });
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      op: "set_backend",
      axis: "coding",
      backend: "codex",
      tag: null,
    });
    expect(result.text).toContain("coding tasks (default)");
    const env = readConfig().env as { ELIZA_BACKEND_ROUTING?: string };
    expect(JSON.parse(env.ELIZA_BACKEND_ROUTING ?? "{}")).toEqual({
      coding: { default: "codex" },
    });
    expect(
      (runtime as { character: { settings?: { routing?: unknown } } }).character
        .settings?.routing,
    ).toEqual({ coding: { default: "codex" } });
  });

  it("treats an unknown difficulty tag as the default and a known tag as byTag", async () => {
    const runtime = { character: {} } as unknown as IAgentRuntime;
    const ignored = await invoke(runtime, {
      action: "set_backend",
      backend: "elizaos",
      tag: "extreme",
    });
    expect(ignored.success).toBe(true);
    expect(ignored.data?.tag).toBeNull();

    const tagged = await invoke(runtime, {
      action: "set_backend",
      backend: "claude",
      tag: "HARD",
    });
    expect(tagged.success).toBe(true);
    expect(tagged.data).toMatchObject({
      backend: "claude",
      tag: "hard",
    });
    expect(tagged.text).toContain("hard coding tasks");
    const env = readConfig().env as { ELIZA_BACKEND_ROUTING?: string };
    expect(JSON.parse(env.ELIZA_BACKEND_ROUTING ?? "{}")).toEqual({
      coding: { default: "elizaos", byTag: { hard: "claude" } },
    });
  });

  it("refuses every coding backend when the allow lock-list is empty", async () => {
    const runtime = {
      character: {
        settings: { routing: { coding: { allow: [] } } },
      },
    } as unknown as IAgentRuntime;
    const result = await invoke(runtime, {
      action: "set_backend",
      backend: "claude",
    });
    expect(result.success).toBe(false);
    expect(result.data?.error).toBe("SETTINGS_BACKEND_DISALLOWED");
    expect(result.data?.allow).toEqual([]);
  });

  it("rejects a brain switch without a backend or without a loaded handler", async () => {
    const runtime = {
      character: {},
      models: new Map([[ModelType.TEXT_LARGE, [{ provider: "anthropic" }]]]),
    } as unknown as IAgentRuntime;
    const missing = await invoke(runtime, {
      action: "set_backend",
      axis: "brain",
    });
    expect(missing.success).toBe(false);
    expect(missing.data?.error).toBe("SETTINGS_BACKEND_INVALID");

    const unavailable = await invoke(runtime, {
      action: "set_backend",
      axis: " BRAIN ",
      backend: "openai",
    });
    expect(unavailable.success).toBe(false);
    expect(unavailable.data?.error).toBe("SETTINGS_BACKEND_UNAVAILABLE");
    expect(unavailable.data?.provider).toBe("openai");
  });

  it("persists a loaded brain provider and calls setSetting for immediate effect", async () => {
    const settings: Record<string, string> = {};
    const runtime = {
      character: {},
      models: new Map([
        [ModelType.TEXT_REASONING_LARGE, [{ provider: "anthropic" }]],
      ]),
      setSetting: (key: string, value: string) => {
        settings[key] = value;
      },
    } as unknown as IAgentRuntime;
    const result = await invoke(runtime, {
      action: "set_backend",
      axis: "brain",
      backend: "Anthropic",
    });
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      op: "set_backend",
      axis: "brain",
      provider: "anthropic",
    });
    expect(
      (readConfig().env as { ELIZA_BRAIN_PROVIDER?: string })
        .ELIZA_BRAIN_PROVIDER,
    ).toBe("anthropic");
    expect(settings.ELIZA_BRAIN_PROVIDER).toBe("anthropic");
  });
});

describe("SETTINGS update_ai_provider modelConfigs overflow", () => {
  it("writes model slots and ignores an over-length apiKey / slot", async () => {
    const result = await invoke({ character: {} } as unknown as IAgentRuntime, {
      action: "update_ai_provider",
      provider: "openai",
      apiKey: "k".repeat(513),
      modelConfigs: {
        primary: "gpt-4.1",
        nano: "n",
        small: "s",
        medium: "m",
        large: "l",
        mega: "g".repeat(257),
        ignored: 1,
      },
    });
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      op: "update_ai_provider",
      provider: "openai",
      primaryModel: "gpt-4.1",
      requiresRestart: true,
    });
    const config = readConfig();
    expect(JSON.stringify(config)).not.toContain("k".repeat(513));
    expect(config.models).toEqual({
      nano: "n",
      small: "s",
      medium: "m",
      large: "l",
    });
  });

  it("treats a whitespace-only provider as missing", async () => {
    const before = fs.readFileSync(configPath, "utf-8");
    const result = await invoke({ character: {} } as unknown as IAgentRuntime, {
      action: "update_ai_provider",
      provider: "   ",
    });
    expect(result.success).toBe(false);
    expect(result.data?.error).toBe("MISSING_PROVIDER");
    expect(fs.readFileSync(configPath, "utf-8")).toBe(before);
  });
});

describe("SETTINGS toggle_capability — missing ui object", () => {
  it("creates ui.capabilities when the store has no ui block", async () => {
    fs.writeFileSync(configPath, JSON.stringify({}));
    const result = await invoke({ character: {} } as unknown as IAgentRuntime, {
      action: "toggle_capability",
      capability: "browser",
      enabled: true,
    });
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      op: "toggle_capability",
      capability: "browser",
      enabled: true,
    });
    expect(
      (
        readConfig().ui as {
          capabilities?: Record<string, boolean>;
        }
      ).capabilities?.browser,
    ).toBe(true);
  });
});
