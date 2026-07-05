/**
 * Disk-backed runtime-mode resolution through the REAL loadElizaConfig() in a
 * throwaway ELIZA_STATE_DIR — no mocks. Guards the migration/resolver seam:
 * `migrateLegacyRuntimeConfig` runs inside every loadElizaConfig(), so a prune
 * of `cloud.enabled` there makes local-only unreachable from persisted config
 * while pure-resolver tests (route-mode-matrix.test.ts) stay green.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getRuntimeModeSnapshot } from "./runtime-mode";

const ENV_KEYS = [
  "ELIZA_STATE_DIR",
  "ELIZA_HOME",
  "ELIZA_CONFIG_PATH",
  "ELIZA_PERSIST_CONFIG_PATH",
] as const;

let savedEnv: Record<(typeof ENV_KEYS)[number], string | undefined>;
let stateDir: string;

const writeConfig = (config: Record<string, unknown>) => {
  fs.writeFileSync(path.join(stateDir, "eliza.json"), JSON.stringify(config));
};

beforeEach(() => {
  savedEnv = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as typeof savedEnv;
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-mode-disk-"));
  process.env.ELIZA_STATE_DIR = stateDir;
  process.env.ELIZA_HOME = stateDir;
  delete process.env.ELIZA_CONFIG_PATH;
  delete process.env.ELIZA_PERSIST_CONFIG_PATH;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("getRuntimeModeSnapshot (disk-backed)", () => {
  it("resolves cloud.enabled === false on disk to local-only", () => {
    writeConfig({ cloud: { enabled: false } });
    expect(getRuntimeModeSnapshot().mode).toBe("local-only");
  });

  it("keeps the opt-out when migration prunes sibling legacy keys", () => {
    writeConfig({ cloud: { enabled: false, inferenceMode: "local" } });
    expect(getRuntimeModeSnapshot().mode).toBe("local-only");
  });

  it("resolves an empty config to plain local", () => {
    writeConfig({});
    expect(getRuntimeModeSnapshot().mode).toBe("local");
  });

  it("resolves a persisted cloud deploymentTarget to cloud", () => {
    writeConfig({
      deploymentTarget: { runtime: "cloud", provider: "elizacloud" },
    });
    expect(getRuntimeModeSnapshot().mode).toBe("cloud");
  });
});
