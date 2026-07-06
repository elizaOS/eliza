/**
 * Chat-settings leg of #14325: the owner-gated SETTINGS action must, when the
 * chat surface asks to configure a plugin ("configure telegram") or switch the
 * model provider ("switch my model provider to openai"), mutate the REAL on-disk
 * eliza.json config store — not a mock. This drives `settingsAction.handler`
 * against a temp config file (via ELIZA_CONFIG_PATH / ELIZA_PERSIST_CONFIG_PATH,
 * the same load/write path the running agent uses) and asserts the persisted
 * bytes, so a regression that silently stops persisting provider/capability
 * changes fails here. The `[CONFIG:pluginId]` card's fetch/edit/save/enable
 * round-trip is covered deterministically in
 * `packages/ui/src/components/chat/MessageContent.config.test.tsx`; the live
 * chat round-trip (real model emits `[CONFIG:telegram]` / drives SETTINGS) is
 * covered by the `live-only` scenarios in
 * `plugins/plugin-app-control/test/scenarios/settings-in-chat-*.scenario.ts`.
 *
 * Deterministic: real config store on a temp dir, stub runtime, no live model.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { settingsAction } from "./settings-actions.ts";

// A stub runtime is enough for the config-store ops (toggle_capability /
// update_ai_provider) — they read/write eliza.json and never touch the runtime.
// `character: {}` lets set_backend's live-character write-through no-op safely.
const RUNTIME = { character: {} } as unknown as IAgentRuntime;
const OWNER_MESSAGE = { entityId: "owner" } as unknown as Memory;

function invoke(parameters: Record<string, unknown>): Promise<ActionResult> {
  return settingsAction.handler(RUNTIME, OWNER_MESSAGE, undefined, {
    parameters,
  } as HandlerOptions) as Promise<ActionResult>;
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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-chat-ops-"));
  configPath = path.join(tempDir, "eliza.json");
  // Seed a minimal-but-real config so load/merge/save exercise the real path.
  fs.writeFileSync(
    configPath,
    JSON.stringify({ ui: { capabilities: { wallet: false } } }),
  );
  priorConfigPath = process.env.ELIZA_CONFIG_PATH;
  priorPersistPath = process.env.ELIZA_PERSIST_CONFIG_PATH;
  // Point BOTH the read resolver (ELIZA_CONFIG_PATH) and the write resolver
  // (ELIZA_PERSIST_CONFIG_PATH) at the temp file so load and save agree.
  process.env.ELIZA_CONFIG_PATH = configPath;
  process.env.ELIZA_PERSIST_CONFIG_PATH = configPath;
});

afterEach(() => {
  if (priorConfigPath === undefined) delete process.env.ELIZA_CONFIG_PATH;
  else process.env.ELIZA_CONFIG_PATH = priorConfigPath;
  if (priorPersistPath === undefined)
    delete process.env.ELIZA_PERSIST_CONFIG_PATH;
  else process.env.ELIZA_PERSIST_CONFIG_PATH = priorPersistPath;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("SETTINGS action — always available at the chat boundary", () => {
  it("declares the OWNER role gate the chat settings surface relies on", () => {
    // The chat settings direction ("settings is just settings in chat") depends
    // on this gate: any authenticated non-owner in chat must not reach it.
    expect(settingsAction.roleGate).toEqual({ minRole: "OWNER" });
  });

  it("validate() resolves true (gate is structural, not validate-time)", async () => {
    // SETTINGS has no validate-time preconditions — the OWNER gate is enforced
    // structurally by core (satisfiesRoleGate) before the handler runs, so the
    // action stays selectable and the gate can't be bypassed by a passing
    // validate.
    await expect(settingsAction.validate(RUNTIME, OWNER_MESSAGE)).resolves.toBe(
      true,
    );
  });
});

describe("SETTINGS update_ai_provider — persists to the real config store", () => {
  it('"switch my model provider to openai" writes provider routing to eliza.json', async () => {
    const result = await invoke({
      action: "update_ai_provider",
      provider: "openai",
    });

    expect(result.success).toBe(true);
    expect(result.data?.op).toBe("update_ai_provider");
    expect(result.data?.provider).toBe("openai");
    expect(result.data?.requiresRestart).toBe(true);

    // The write actually landed on disk with the real provider routing the
    // running agent reads back — not a fabricated success.
    const config = readConfig();
    const routing = config.serviceRouting as
      | { llmText?: { backend?: string } }
      | undefined;
    expect(routing?.llmText?.backend).toBe("openai");
    const agents = config.agents as
      | { defaults?: { model?: { primary?: string } } }
      | undefined;
    expect(agents?.defaults?.model?.primary).toBe("@elizaos/plugin-openai");
  });

  it("carries an API key through to config when supplied", async () => {
    const result = await invoke({
      action: "update_ai_provider",
      provider: "openai",
      apiKey: "sk-test-openai-key",
    });
    expect(result.success).toBe(true);
    // The key must be persisted somewhere reachable via config.env so the
    // switched provider can authenticate on the next boot.
    const raw = fs.readFileSync(configPath, "utf-8");
    expect(raw).toContain("sk-test-openai-key");
  });

  it("rejects a missing provider without touching the store", async () => {
    const before = fs.readFileSync(configPath, "utf-8");
    const result = await invoke({ action: "update_ai_provider" });
    expect(result.success).toBe(false);
    expect(result.data?.error).toBe("MISSING_PROVIDER");
    expect(fs.readFileSync(configPath, "utf-8")).toBe(before);
  });

  it("rejects an unknown provider with UNKNOWN_PROVIDER", async () => {
    const result = await invoke({
      action: "update_ai_provider",
      provider: "totally-not-a-provider",
    });
    expect(result.success).toBe(false);
    expect(result.data?.error).toBe("UNKNOWN_PROVIDER");
  });
});

describe("SETTINGS toggle_capability — persists to the real config store", () => {
  it("enabling the wallet capability flips config.ui.capabilities on disk", async () => {
    const result = await invoke({
      action: "toggle_capability",
      capability: "wallet",
      enabled: true,
    });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      op: "toggle_capability",
      capability: "wallet",
      enabled: true,
    });

    const config = readConfig();
    const capabilities = (
      config.ui as { capabilities?: Record<string, unknown> }
    )?.capabilities;
    expect(capabilities?.wallet).toBe(true);
  });

  it("disabling round-trips back to false on disk", async () => {
    await invoke({
      action: "toggle_capability",
      capability: "wallet",
      enabled: true,
    });
    const enabled = readConfig();
    expect(
      (enabled.ui as { capabilities?: Record<string, unknown> })?.capabilities
        ?.wallet,
    ).toBe(true);

    const result = await invoke({
      action: "toggle_capability",
      capability: "wallet",
      enabled: false,
    });
    expect(result.success).toBe(true);
    const config = readConfig();
    expect(
      (config.ui as { capabilities?: Record<string, unknown> })?.capabilities
        ?.wallet,
    ).toBe(false);
  });

  it("rejects an unknown capability with UNKNOWN_CAPABILITY", async () => {
    const result = await invoke({
      action: "toggle_capability",
      capability: "teleportation",
      enabled: true,
    });
    expect(result.success).toBe(false);
    expect(result.data?.error).toBe("UNKNOWN_CAPABILITY");
  });

  it("rejects a non-boolean `enabled` with MISSING_ENABLED", async () => {
    const result = await invoke({
      action: "toggle_capability",
      capability: "wallet",
      enabled: "yes",
    });
    expect(result.success).toBe(false);
    expect(result.data?.error).toBe("MISSING_ENABLED");
  });
});

describe("SETTINGS dispatch — unknown op fails explicitly", () => {
  it("returns SETTINGS_INVALID (never a fabricated success) for an unknown action", async () => {
    const result = await invoke({ action: "frobnicate" });
    expect(result.success).toBe(false);
    expect(result.data?.error).toBe("SETTINGS_INVALID");
  });

  it("returns SETTINGS_INVALID when no action discriminator is supplied", async () => {
    const result = await invoke({});
    expect(result.success).toBe(false);
    expect(result.data?.error).toBe("SETTINGS_INVALID");
  });
});
