/**
 * E2E tests for Eliza Cloud credential persistence.
 *
 * Verifies the full lifecycle:
 *   1. applyCloudConfigToEnv always overwrites stale env vars
 *   2. Cloud plugin loads when cloud is enabled in config
 *   3. Character secrets include the cloud API key
 *   4. Hot-reload picks up cloud config from disk
 *   5. Model defaults are set correctly
 *
 * Pure-function tests — no live server needed.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MiladyConfig } from "../src/config/config";
import {
  applyCloudConfigToEnv,
  buildCharacterFromConfig,
  collectPluginNames,
} from "../src/runtime/eliza";

// ---------------------------------------------------------------------------
// Env snapshot helper
// ---------------------------------------------------------------------------

const CLOUD_ENV_KEYS = [
  "ELIZAOS_CLOUD_ENABLED",
  "ELIZAOS_CLOUD_API_KEY",
  "ELIZAOS_CLOUD_BASE_URL",
  "ELIZAOS_CLOUD_SMALL_MODEL",
  "ELIZAOS_CLOUD_LARGE_MODEL",
  "SMALL_MODEL",
  "LARGE_MODEL",
];

function envSnapshot(keys: string[]): {
  save: () => void;
  restore: () => void;
} {
  const saved = new Map<string, string | undefined>();
  return {
    save() {
      for (const k of keys) saved.set(k, process.env[k]);
    },
    restore() {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. applyCloudConfigToEnv — unit tests
// ═══════════════════════════════════════════════════════════════════════════

describe("applyCloudConfigToEnv — cloud credential persistence", () => {
  const snap = envSnapshot(CLOUD_ENV_KEYS);
  beforeEach(() => {
    snap.save();
    for (const k of CLOUD_ENV_KEYS) delete process.env[k];
  });
  afterEach(() => snap.restore());

  it("sets ELIZAOS_CLOUD_API_KEY from config", () => {
    const config = {
      cloud: { enabled: true, apiKey: "ck-test-123" },
    } as MiladyConfig;
    applyCloudConfigToEnv(config);
    expect(process.env.ELIZAOS_CLOUD_API_KEY).toBe("ck-test-123");
    expect(process.env.ELIZAOS_CLOUD_ENABLED).toBe("true");
  });

  it("ALWAYS overwrites stale env vars (hot-reload safety)", () => {
    process.env.ELIZAOS_CLOUD_API_KEY = "stale-key-from-previous-startup";
    const config = {
      cloud: { enabled: true, apiKey: "fresh-key-after-login" },
    } as MiladyConfig;
    applyCloudConfigToEnv(config);
    expect(process.env.ELIZAOS_CLOUD_API_KEY).toBe("fresh-key-after-login");
  });

  it("sets default model names when cloud is enabled", () => {
    const config = {
      cloud: { enabled: true, apiKey: "ck-test" },
    } as MiladyConfig;
    applyCloudConfigToEnv(config);
    expect(process.env.SMALL_MODEL).toBe("openai/gpt-5-mini");
    expect(process.env.LARGE_MODEL).toBe("anthropic/claude-sonnet-4.5");
  });

  it("uses custom model names from config when set", () => {
    const config = {
      cloud: { enabled: true, apiKey: "ck-test" },
      models: { small: "google/gemini-2.5-flash", large: "openai/gpt-5" },
    } as MiladyConfig;
    applyCloudConfigToEnv(config);
    expect(process.env.SMALL_MODEL).toBe("google/gemini-2.5-flash");
    expect(process.env.LARGE_MODEL).toBe("openai/gpt-5");
  });

  it("does nothing when cloud config is absent", () => {
    applyCloudConfigToEnv({} as MiladyConfig);
    expect(process.env.ELIZAOS_CLOUD_API_KEY).toBeUndefined();
    expect(process.env.ELIZAOS_CLOUD_ENABLED).toBeUndefined();
  });

  it("keeps cloud disabled when enabled flag is explicitly false", () => {
    const config = {
      cloud: { enabled: false, apiKey: "ck-test" },
    } as MiladyConfig;
    applyCloudConfigToEnv(config);
    expect(process.env.ELIZAOS_CLOUD_API_KEY).toBe("ck-test");
    expect(process.env.ELIZAOS_CLOUD_ENABLED).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. collectPluginNames — cloud plugin detection
// ═══════════════════════════════════════════════════════════════════════════

describe("collectPluginNames — cloud plugin inclusion", () => {
  const snap = envSnapshot(CLOUD_ENV_KEYS);
  beforeEach(() => {
    snap.save();
    for (const k of CLOUD_ENV_KEYS) delete process.env[k];
  });
  afterEach(() => snap.restore());

  it("includes cloud plugin when config.cloud.enabled is true", () => {
    const config = { cloud: { enabled: true } } as MiladyConfig;
    const names = collectPluginNames(config);
    expect(names.has("@elizaos/plugin-elizacloud")).toBe(true);
  });

  it("includes cloud plugin when ELIZAOS_CLOUD_API_KEY env var is set", () => {
    process.env.ELIZAOS_CLOUD_API_KEY = "ck-test";
    const names = collectPluginNames({} as MiladyConfig);
    expect(names.has("@elizaos/plugin-elizacloud")).toBe(true);
  });

  it("does not include cloud plugin without cloud config or cloud key", () => {
    const names = collectPluginNames({} as MiladyConfig);
    expect(names.has("@elizaos/plugin-elizacloud")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. buildCharacterFromConfig — cloud key in character secrets
// ═══════════════════════════════════════════════════════════════════════════

describe("buildCharacterFromConfig — cloud secret propagation", () => {
  const snap = envSnapshot(CLOUD_ENV_KEYS);
  beforeEach(() => {
    snap.save();
    for (const k of CLOUD_ENV_KEYS) delete process.env[k];
  });
  afterEach(() => snap.restore());

  it("includes ELIZAOS_CLOUD_API_KEY in character.secrets", () => {
    process.env.ELIZAOS_CLOUD_API_KEY = "ck-secret-test";
    const char = buildCharacterFromConfig({} as MiladyConfig);
    expect(char.secrets).toBeDefined();
    expect((char.secrets as Record<string, string>).ELIZAOS_CLOUD_API_KEY).toBe(
      "ck-secret-test",
    );
  });

  it("does NOT include empty/missing keys in secrets", () => {
    const char = buildCharacterFromConfig({} as MiladyConfig);
    expect(
      (char.secrets as Record<string, string> | undefined)
        ?.ELIZAOS_CLOUD_API_KEY,
    ).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Full login → persist → verify flow (simulated)
// ═══════════════════════════════════════════════════════════════════════════

describe("Cloud login persistence — simulated end-to-end", () => {
  const snap = envSnapshot(CLOUD_ENV_KEYS);

  beforeEach(() => {
    snap.save();
    for (const k of CLOUD_ENV_KEYS) delete process.env[k];
  });
  afterEach(() => snap.restore());

  it("full chain: config → env → character secrets → plugin detection", () => {
    // Step 1: Simulate cloud login saving to config
    const config: MiladyConfig = {
      cloud: { enabled: true, apiKey: "ck-e2e-test-key" },
    } as MiladyConfig;

    // Step 2: Apply config to env (as startEliza / hot-reload does)
    applyCloudConfigToEnv(config);
    expect(process.env.ELIZAOS_CLOUD_API_KEY).toBe("ck-e2e-test-key");
    expect(process.env.ELIZAOS_CLOUD_ENABLED).toBe("true");

    // Step 3: Build character (as startEliza does) — key should be in secrets
    const char = buildCharacterFromConfig(config);
    expect((char.secrets as Record<string, string>).ELIZAOS_CLOUD_API_KEY).toBe(
      "ck-e2e-test-key",
    );

    // Step 4: Plugin resolution should include cloud plugin
    const plugins = collectPluginNames(config);
    expect(plugins.has("@elizaos/plugin-elizacloud")).toBe(true);
  });

  it("hot-reload: fresh config overwrites stale env from prior boot", () => {
    // Simulate initial boot with no cloud
    process.env.ELIZAOS_CLOUD_API_KEY = "";
    process.env.ELIZAOS_CLOUD_ENABLED = "";

    // Simulate user enabling cloud during session → config saved
    const freshConfig: MiladyConfig = {
      cloud: { enabled: true, apiKey: "ck-fresh-key" },
    } as MiladyConfig;

    // Hot-reload applies fresh config
    applyCloudConfigToEnv(freshConfig);

    // Must have FRESH values, not stale empty strings
    expect(process.env.ELIZAOS_CLOUD_API_KEY).toBe("ck-fresh-key");
    expect(process.env.ELIZAOS_CLOUD_ENABLED).toBe("true");

    // Plugin detection should pick it up
    const plugins = collectPluginNames(freshConfig);
    expect(plugins.has("@elizaos/plugin-elizacloud")).toBe(true);
  });

  it("model defaults are set when cloud is enabled without explicit model config", () => {
    const config: MiladyConfig = {
      cloud: { enabled: true, apiKey: "ck-test" },
    } as MiladyConfig;

    applyCloudConfigToEnv(config);

    expect(process.env.SMALL_MODEL).toBe("openai/gpt-5-mini");
    expect(process.env.LARGE_MODEL).toBe("anthropic/claude-sonnet-4.5");
  });

  it("model defaults respect user selections from config", () => {
    const config = {
      cloud: { enabled: true, apiKey: "ck-test" },
      models: {
        small: "anthropic/claude-sonnet-4",
        large: "anthropic/claude-opus-4.5",
      },
    } as MiladyConfig;

    applyCloudConfigToEnv(config);

    expect(process.env.SMALL_MODEL).toBe("anthropic/claude-sonnet-4");
    expect(process.env.LARGE_MODEL).toBe("anthropic/claude-opus-4.5");
  });
});
