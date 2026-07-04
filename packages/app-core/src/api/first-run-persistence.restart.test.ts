/**
 * Regression guard for issue #11506 (symptom 2: "onboarding never persists").
 *
 * On-device forensics attributed the *observed* "returns to onboarding after
 * every restart" to the process dying (LMK kill + FGS restart crash cascade,
 * fixed in #11738) BEFORE the completion write could run — not to a defect in
 * the persistence mechanism itself. These tests lock the persistence contract
 * so a regression that drops a completed onboarding on the next process boot
 * fails CI instead of only surfacing as a hard-to-repro on-device symptom.
 *
 * The contract exercised end-to-end with the REAL production functions (no
 * mock stands in for the thing under test):
 *   1. `saveElizaConfig`   — the exact durable write the /api/first-run handler
 *                            performs on completion (atomic tmp + rename).
 *   2. `loadElizaConfig`   — the exact fresh-process-boot read (re-reads the
 *                            on-disk eliza.json; a NEW process has no in-memory
 *                            state, so this is a faithful "restart").
 *   3. `hasCompatPersistedFirstRunState` — the exact predicate GET
 *                            /api/first-run/status answers `complete` with, and
 *                            which the client startup coordinator turns into
 *                            "go home" vs "show onboarding".
 *
 * A fresh temp ELIZA_STATE_DIR per test guarantees each case starts from a true
 * first-run filesystem (no config on disk), then simulates a restart by calling
 * `loadElizaConfig()` again against that same on-disk state.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
// Import from narrow subpaths, not the "@elizaos/agent" barrel: the barrel's
// runtime/eliza.ts has dynamic plugin imports (e.g. @elizaos/plugin-birdclaw)
// that the test bundler cannot resolve. These are the same production functions.
import { applyCanonicalFirstRunConfig } from "@elizaos/agent/api/provider-switch-config";
import { loadElizaConfig, saveElizaConfig } from "@elizaos/agent/config/config";
import {
  normalizeDeploymentTargetConfig,
  normalizeServiceRoutingConfig,
} from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hasCompatPersistedFirstRunState } from "./compat-route-shared";

let stateDir: string;
let priorStateDir: string | undefined;
let priorPersistPath: string | undefined;

beforeEach(() => {
  priorStateDir = process.env.ELIZA_STATE_DIR;
  priorPersistPath = process.env.ELIZA_PERSIST_CONFIG_PATH;
  delete process.env.ELIZA_PERSIST_CONFIG_PATH;
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-firstrun-persist-"));
  process.env.ELIZA_STATE_DIR = stateDir;
});

afterEach(() => {
  if (priorStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
  else process.env.ELIZA_STATE_DIR = priorStateDir;
  if (priorPersistPath === undefined)
    delete process.env.ELIZA_PERSIST_CONFIG_PATH;
  else process.env.ELIZA_PERSIST_CONFIG_PATH = priorPersistPath;
  fs.rmSync(stateDir, { recursive: true, force: true });
});

/**
 * Reproduce exactly what `handleFirstRunRoute` writes to disk on completion:
 * load the (empty) config, set `meta.firstRunComplete = true`, apply the
 * canonical deployment-target/service-routing the user chose, then persist.
 */
function completeOnboarding(args: {
  deploymentTarget?: unknown;
  serviceRouting?: unknown;
}): void {
  const config = loadElizaConfig();
  if (!config.meta) {
    (config as Record<string, unknown>).meta = {};
  }
  (config.meta as Record<string, unknown>).firstRunComplete = true;
  applyCanonicalFirstRunConfig(config as never, {
    deploymentTarget: normalizeDeploymentTargetConfig(args.deploymentTarget),
    serviceRouting: normalizeServiceRoutingConfig(args.serviceRouting),
  });
  saveElizaConfig(config);
}

/** A fresh process boot: re-read on-disk config, answer the status predicate. */
function bootAndProbeComplete(): boolean {
  return hasCompatPersistedFirstRunState(loadElizaConfig());
}

describe("first-run persistence survives a process restart (#11506)", () => {
  it("a genuine first run (no config on disk) reports NOT complete → onboarding shows", () => {
    // No completeOnboarding() call: the temp state dir has no eliza.json.
    expect(bootAndProbeComplete()).toBe(false);
  });

  it("local on-device onboarding stays complete across a restart", () => {
    completeOnboarding({
      deploymentTarget: { runtime: "local" },
      serviceRouting: { llmText: { backend: "ollama", transport: "direct" } },
    });
    expect(bootAndProbeComplete()).toBe(true);
  });

  it("Eliza Cloud onboarding stays complete across a restart", () => {
    completeOnboarding({
      deploymentTarget: { runtime: "local" },
      serviceRouting: {
        llmText: {
          backend: "elizacloud",
          transport: "cloud-proxy",
          smallModel: "gemma-4-small",
          largeModel: "gemma-4-large",
        },
      },
    });
    expect(bootAndProbeComplete()).toBe(true);
  });

  it("remote-backend onboarding stays complete across a restart", () => {
    completeOnboarding({
      deploymentTarget: {
        runtime: "remote",
        remoteApiBase: "http://desktop.local:31337",
      },
      serviceRouting: {
        llmText: {
          backend: "remote",
          transport: "remote",
          remoteApiBase: "http://desktop.local:31337",
        },
      },
    });
    expect(bootAndProbeComplete()).toBe(true);
  });

  it("stays complete across MANY consecutive restarts (the reported ~1-2 min churn)", () => {
    completeOnboarding({
      deploymentTarget: { runtime: "local" },
      serviceRouting: { llmText: { backend: "ollama", transport: "direct" } },
    });
    // Emulate the churn: reload -> re-persist -> reload, repeatedly. Each
    // reload is a fresh-process read; each save is a settings write that must
    // not drop the completion flag.
    for (let restart = 0; restart < 6; restart += 1) {
      const config = loadElizaConfig();
      expect(hasCompatPersistedFirstRunState(config)).toBe(true);
      saveElizaConfig(config);
    }
    expect(bootAndProbeComplete()).toBe(true);
  });

  it("persists the completion flag byte-for-byte through save→load (no migrate strip)", () => {
    completeOnboarding({
      deploymentTarget: { runtime: "local" },
      serviceRouting: { llmText: { backend: "ollama", transport: "direct" } },
    });
    const reloaded = loadElizaConfig();
    expect((reloaded.meta as Record<string, unknown>)?.firstRunComplete).toBe(
      true,
    );
  });

  it("the runtime-mode choice ALONE keeps onboarding complete even if the meta flag is absent", () => {
    // Older installs / partial writes may lack meta.firstRunComplete but still
    // carry a complete canonical routing choice. That choice must be honored as
    // "onboarding done" so the user is not re-prompted for where to run.
    completeOnboarding({
      deploymentTarget: { runtime: "local" },
      serviceRouting: { llmText: { backend: "ollama", transport: "direct" } },
    });
    const config = loadElizaConfig();
    delete (config.meta as Record<string, unknown>).firstRunComplete;
    saveElizaConfig(config);

    const rebooted = loadElizaConfig();
    expect(
      (rebooted.meta as Record<string, unknown>)?.firstRunComplete,
    ).toBeUndefined();
    // Canonical routing (local direct backend) is enough on its own.
    expect(hasCompatPersistedFirstRunState(rebooted)).toBe(true);
  });
});
