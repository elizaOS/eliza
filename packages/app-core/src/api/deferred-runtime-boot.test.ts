/**
 * Pins the fresh-install boot-deferral gate + single-flight boot registry
 * (deferred-runtime-boot.ts). Uses the REAL production predicate
 * (`hasCompatPersistedFirstRunState` via `loadElizaConfig`) against a real temp
 * ELIZA_STATE_DIR — no mock stands in for the thing under test — so the gate is
 * exercised exactly as `GET /api/first-run/status` and `startEliza` see it.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { saveElizaConfig } from "@elizaos/agent/config/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isRuntimeBootDeferred,
  registerDeferredRuntimeBoot,
  resetDeferredRuntimeBootForTests,
  shouldDeferRuntimeBootUntilOnboarding,
  triggerDeferredRuntimeBoot,
} from "./deferred-runtime-boot";

let stateDir: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "ELIZA_CONFIG_PATH",
  "ELIZA_STATE_DIR",
  "ELIZA_PERSIST_CONFIG_PATH",
  "ELIZA_CLOUD_PROVISIONED",
  "ELIZA_CHAT_VIA_CLI",
  "ELIZAOS_CLOUD_API_KEY",
  "ELIZAOS_CLOUD_ENABLED",
  "STEWARD_AGENT_TOKEN",
  "ANTHROPIC_API_KEY",
  "CEREBRAS_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GROQ_API_KEY",
  "NEARAI_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "OLLAMA_BASE_URL",
  "XAI_API_KEY",
  "ZAI_API_KEY",
  "Z_AI_API_KEY",
] as const;

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-deferred-boot-"));
  configPath = path.join(stateDir, "eliza.json");
  process.env.ELIZA_STATE_DIR = stateDir;
  process.env.ELIZA_CONFIG_PATH = configPath;
  process.env.ELIZA_PERSIST_CONFIG_PATH = configPath;
  resetDeferredRuntimeBootForTests();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  fs.rmSync(stateDir, { recursive: true, force: true });
  resetDeferredRuntimeBootForTests();
});

function pinDeferredBootConfigEnv(): void {
  process.env.ELIZA_STATE_DIR = stateDir;
  process.env.ELIZA_CONFIG_PATH = configPath;
  process.env.ELIZA_PERSIST_CONFIG_PATH = configPath;
}

/** Persist a completed local-target onboarding, exactly as the handler does. */
function completeLocalOnboarding(): void {
  pinDeferredBootConfigEnv();
  saveElizaConfig({
    meta: { firstRunComplete: true },
    deploymentTarget: { runtime: "local" },
    serviceRouting: { llmText: { backend: "ollama", transport: "direct" } },
  } as never);
}

describe("shouldDeferRuntimeBootUntilOnboarding (fresh-install gate)", () => {
  it("defers on a genuinely fresh install (no config on disk)", () => {
    pinDeferredBootConfigEnv();
    expect(shouldDeferRuntimeBootUntilOnboarding()).toBe(true);
  });

  it("does NOT defer once onboarding has persisted (returning user)", () => {
    completeLocalOnboarding();
    pinDeferredBootConfigEnv();
    expect(shouldDeferRuntimeBootUntilOnboarding()).toBe(false);
  });

  it("does NOT defer when a provider env key is set (CI / env-configured)", () => {
    pinDeferredBootConfigEnv();
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    expect(shouldDeferRuntimeBootUntilOnboarding()).toBe(false);
  });

  it("does NOT defer for a cloud-provisioned container", () => {
    pinDeferredBootConfigEnv();
    process.env.ELIZA_CLOUD_PROVISIONED = "1";
    process.env.STEWARD_AGENT_TOKEN = "steward-token";
    expect(shouldDeferRuntimeBootUntilOnboarding()).toBe(false);
  });

  it("does NOT defer when OLLAMA_BASE_URL is set (local dev provider)", () => {
    pinDeferredBootConfigEnv();
    process.env.OLLAMA_BASE_URL = "http://localhost:11434";
    expect(shouldDeferRuntimeBootUntilOnboarding()).toBe(false);
  });
});

describe("deferred boot registry (single-flight)", () => {
  it("is not deferred until a boot closure is registered", () => {
    expect(isRuntimeBootDeferred()).toBe(false);
    registerDeferredRuntimeBoot(async () => {});
    expect(isRuntimeBootDeferred()).toBe(true);
  });

  it("triggering with nothing registered is a no-op", async () => {
    await expect(triggerDeferredRuntimeBoot("noop")).resolves.toBeUndefined();
  });

  it("runs the boot exactly once for concurrent triggers", async () => {
    let resolveBoot!: () => void;
    const boot = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolveBoot = r;
        }),
    );
    registerDeferredRuntimeBoot(boot);

    const a = triggerDeferredRuntimeBoot("first");
    const b = triggerDeferredRuntimeBoot("second");
    expect(boot).toHaveBeenCalledTimes(1);

    resolveBoot();
    await Promise.all([a, b]);
    expect(boot).toHaveBeenCalledTimes(1);
    // After success the registration clears — later triggers no-op.
    expect(isRuntimeBootDeferred()).toBe(false);
    await triggerDeferredRuntimeBoot("after-success");
    expect(boot).toHaveBeenCalledTimes(1);
  });

  it("keeps the registration after a failed boot so a retry can re-attempt", async () => {
    const boot = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("pglite open failed"))
      .mockResolvedValueOnce(undefined);
    registerDeferredRuntimeBoot(boot);

    await expect(triggerDeferredRuntimeBoot("attempt-1")).rejects.toThrow(
      "pglite open failed",
    );
    // Still deferred — the failure did not clear the registration.
    expect(isRuntimeBootDeferred()).toBe(true);

    await expect(
      triggerDeferredRuntimeBoot("attempt-2"),
    ).resolves.toBeUndefined();
    expect(boot).toHaveBeenCalledTimes(2);
    expect(isRuntimeBootDeferred()).toBe(false);
  });
});
