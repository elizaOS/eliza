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
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "ELIZA_STATE_DIR",
  "ELIZA_PERSIST_CONFIG_PATH",
  "ELIZA_CLOUD_PROVISIONED",
  "ELIZAOS_CLOUD_ENABLED",
  "ELIZAOS_CLOUD_API_KEY",
  "STEWARD_AGENT_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OLLAMA_BASE_URL",
] as const;

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-deferred-boot-"));
  process.env.ELIZA_STATE_DIR = stateDir;
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

/** Persist a completed local-target onboarding, exactly as the handler does. */
function completeLocalOnboarding(): void {
  saveElizaConfig({
    meta: { firstRunComplete: true },
    deploymentTarget: { runtime: "local" },
    serviceRouting: { llmText: { backend: "ollama", transport: "direct" } },
  } as never);
}

describe("shouldDeferRuntimeBootUntilOnboarding (fresh-install gate)", () => {
  it("defers on a genuinely fresh install (no config on disk)", () => {
    expect(shouldDeferRuntimeBootUntilOnboarding()).toBe(true);
  });

  it("does NOT defer once onboarding has persisted (returning user)", () => {
    completeLocalOnboarding();
    expect(shouldDeferRuntimeBootUntilOnboarding()).toBe(false);
  });

  it("does NOT defer when a provider env key is set (CI / env-configured)", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    expect(shouldDeferRuntimeBootUntilOnboarding()).toBe(false);
  });

  it("does NOT defer for a cloud-provisioned container", () => {
    process.env.ELIZA_CLOUD_PROVISIONED = "1";
    process.env.STEWARD_AGENT_TOKEN = "steward-token";
    expect(shouldDeferRuntimeBootUntilOnboarding()).toBe(false);
  });

  it("does NOT defer when OLLAMA_BASE_URL is set (local dev provider)", () => {
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
