import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type PersistedDeployment,
  resolveCloudHostedAgentApiBase,
  resolveDesktopRuntimeModeWithDeployment,
} from "./api-base";
import { readPersistedDeployment } from "./persisted-deployment";

/**
 * Electrobun is excluded from app-core's default vitest run
 * (`platforms/electrobun/**` in `packages/app-core/vitest.config.ts`). Run this
 * file with the electrobun-aware config:
 *
 *   cd packages/app-core && \
 *     bun x vitest run --config platforms/electrobun/vitest.electrobun.config.ts \
 *       platforms/electrobun/src/api-base.test.ts
 *
 * (or `bun run --cwd packages/app-core/platforms/electrobun test` to run the
 * whole electrobun suite).
 */

const CLOUD_AGENT_URL = "https://agent-abc123.elizacloud.ai";
const REMOTE_AGENT_URL = "http://10.0.0.5:31337";

const localDeployment: PersistedDeployment = {
  runtime: "local",
  remoteApiBase: null,
};
const cloudDeployment: PersistedDeployment = {
  runtime: "cloud",
  remoteApiBase: CLOUD_AGENT_URL,
};
const remoteDeployment: PersistedDeployment = {
  runtime: "remote",
  remoteApiBase: REMOTE_AGENT_URL,
};

describe("resolveDesktopRuntimeModeWithDeployment — three topologies", () => {
  it("topology 1 (local agent → cloud inference): runtime 'local' boots the embedded agent", () => {
    const resolution = resolveDesktopRuntimeModeWithDeployment(
      {},
      localDeployment,
    );
    expect(resolution.mode).toBe("local");
    expect(resolution.externalApi.base).toBeNull();
  });

  it("topology 2 (all-local): no persisted deployment boots the embedded agent", () => {
    const resolution = resolveDesktopRuntimeModeWithDeployment({}, null);
    expect(resolution.mode).toBe("local");
    expect(resolution.externalApi.base).toBeNull();
  });

  it("topology 3 (cloud-hosted): runtime 'cloud' with a persisted remoteApiBase skips the embedded agent", () => {
    const resolution = resolveDesktopRuntimeModeWithDeployment(
      {},
      cloudDeployment,
    );
    expect(resolution.mode).toBe("external");
    expect(resolution.externalApi.base).toBe(CLOUD_AGENT_URL);
    expect(resolution.externalApi.source).toBeNull();
  });

  it("topology 3 (external agent): runtime 'remote' with a persisted remoteApiBase skips the embedded agent", () => {
    const resolution = resolveDesktopRuntimeModeWithDeployment(
      {},
      remoteDeployment,
    );
    expect(resolution.mode).toBe("external");
    // origin-normalized (no path/trailing slash) by normalizeApiBase.
    expect(resolution.externalApi.base).toBe("http://10.0.0.5:31337");
  });

  it("fail-safe: runtime 'cloud' with NO resolvable base keeps the local-agent boot", () => {
    const resolution = resolveDesktopRuntimeModeWithDeployment(
      {},
      { runtime: "cloud", remoteApiBase: null },
    );
    expect(resolution.mode).toBe("local");
    expect(resolution.externalApi.base).toBeNull();
  });

  it("fail-safe: a non-http persisted base (on-device IPC) is rejected → local boot", () => {
    const resolution = resolveDesktopRuntimeModeWithDeployment(
      {},
      { runtime: "cloud", remoteApiBase: "eliza-local-agent://ipc" },
    );
    expect(resolution.mode).toBe("local");
    expect(resolution.externalApi.base).toBeNull();
  });

  it("env ELIZA_DESKTOP_CLOUD_AGENT_BASE overrides the persisted base", () => {
    const override = "https://override.example.com";
    const resolution = resolveDesktopRuntimeModeWithDeployment(
      { ELIZA_DESKTOP_CLOUD_AGENT_BASE: override },
      cloudDeployment,
    );
    expect(resolution.mode).toBe("external");
    expect(resolution.externalApi.base).toBe(override);
  });

  it("an explicit external env base still wins over a local deployment (unchanged)", () => {
    const resolution = resolveDesktopRuntimeModeWithDeployment(
      { ELIZA_DESKTOP_API_BASE: "http://127.0.0.1:9999" },
      localDeployment,
    );
    expect(resolution.mode).toBe("external");
    expect(resolution.externalApi.base).toBe("http://127.0.0.1:9999");
    expect(resolution.externalApi.source).toBe("ELIZA_DESKTOP_API_BASE");
  });
});

describe("resolveCloudHostedAgentApiBase — precedence + validation", () => {
  it("returns null when nothing is resolvable", () => {
    expect(resolveCloudHostedAgentApiBase({})).toBeNull();
    expect(resolveCloudHostedAgentApiBase({}, null)).toBeNull();
    expect(resolveCloudHostedAgentApiBase({}, "")).toBeNull();
  });

  it("normalizes the persisted base to its origin", () => {
    expect(
      resolveCloudHostedAgentApiBase({}, `${CLOUD_AGENT_URL}/api/agents`),
    ).toBe(CLOUD_AGENT_URL);
  });

  it("env override takes priority over the persisted base", () => {
    expect(
      resolveCloudHostedAgentApiBase(
        { ELIZA_DESKTOP_CLOUD_AGENT_BASE: "https://env.example.com" },
        CLOUD_AGENT_URL,
      ),
    ).toBe("https://env.example.com");
  });

  it("rejects a non-http persisted base", () => {
    expect(
      resolveCloudHostedAgentApiBase({}, "eliza-local-agent://ipc"),
    ).toBeNull();
  });
});

describe("readPersistedDeployment — eliza.json reader", () => {
  const tmpFiles: string[] = [];
  const originalConfigPath = process.env.ELIZA_CONFIG_PATH;

  function writeConfig(contents: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "persisted-deploy-"));
    const file = path.join(dir, "eliza.json");
    fs.writeFileSync(file, contents);
    tmpFiles.push(file);
    return file;
  }

  afterEach(() => {
    for (const file of tmpFiles.splice(0)) {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
    if (originalConfigPath === undefined) {
      delete process.env.ELIZA_CONFIG_PATH;
    } else {
      process.env.ELIZA_CONFIG_PATH = originalConfigPath;
    }
  });

  it("reads a cloud deployment target with remoteApiBase", () => {
    const file = writeConfig(
      JSON.stringify({
        deploymentTarget: {
          runtime: "cloud",
          provider: "elizacloud",
          remoteApiBase: CLOUD_AGENT_URL,
        },
      }),
    );
    expect(readPersistedDeployment({ ELIZA_CONFIG_PATH: file })).toEqual({
      runtime: "cloud",
      remoteApiBase: CLOUD_AGENT_URL,
    });
  });

  it("reads a local deployment target (topology 1) → remoteApiBase null", () => {
    const file = writeConfig(
      JSON.stringify({
        deploymentTarget: { runtime: "local", provider: "elizacloud" },
      }),
    );
    expect(readPersistedDeployment({ ELIZA_CONFIG_PATH: file })).toEqual({
      runtime: "local",
      remoteApiBase: null,
    });
  });

  it("returns null when there is no deployment target", () => {
    const file = writeConfig(JSON.stringify({ ui: { presetId: "eliza" } }));
    expect(readPersistedDeployment({ ELIZA_CONFIG_PATH: file })).toBeNull();
  });

  it("returns null for a missing eliza.json (fail-safe)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "persisted-deploy-"));
    const missing = path.join(dir, "does-not-exist.json");
    expect(readPersistedDeployment({ ELIZA_CONFIG_PATH: missing })).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns null for malformed JSON (fail-safe)", () => {
    const file = writeConfig("{ not valid json ");
    expect(readPersistedDeployment({ ELIZA_CONFIG_PATH: file })).toBeNull();
  });
});

describe("end-to-end: persisted cloud target → external mode", () => {
  const originalConfigPath = process.env.ELIZA_CONFIG_PATH;

  afterEach(() => {
    if (originalConfigPath === undefined) {
      delete process.env.ELIZA_CONFIG_PATH;
    } else {
      process.env.ELIZA_CONFIG_PATH = originalConfigPath;
    }
  });

  it("a persisted cloud-hosted eliza.json resolves to external mode with that base, no env var", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "persisted-deploy-e2e-"));
    const file = path.join(dir, "eliza.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        deploymentTarget: {
          runtime: "cloud",
          provider: "elizacloud",
          remoteApiBase: CLOUD_AGENT_URL,
        },
      }),
    );

    const deployment = readPersistedDeployment({ ELIZA_CONFIG_PATH: file });
    const resolution = resolveDesktopRuntimeModeWithDeployment({}, deployment);

    expect(resolution.mode).toBe("external");
    expect(resolution.externalApi.base).toBe(CLOUD_AGENT_URL);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
