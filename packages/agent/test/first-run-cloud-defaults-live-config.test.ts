/**
 * The cloud-container character defaults that GET /api/first-run/status
 * writes to eliza.json (load -> modify -> save) must also update the live
 * server config. Other routes persist by saving the whole in-memory
 * `state.config`, so a disk-only write is erased by the next such save —
 * the same contract #35471 fixed for custom actions and the database
 * config, and #35466 fixed for setup-panel connector writes.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ElizaConfig } from "@elizaos/host/protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  type FirstRunRouteContext,
  handleFirstRunRoutes,
} from "../src/api/first-run-routes.ts";
import { loadElizaConfig, saveElizaConfig } from "../src/config/config.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "first-run-live-config-"));
  const configPath = path.join(dir, "eliza.json");
  vi.stubEnv("ELIZA_STATE_DIR", dir);
  vi.stubEnv("ELIZA_CONFIG_PATH", configPath);
  vi.stubEnv("ELIZA_PERSIST_CONFIG_PATH", configPath);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

function cloudStatusContext(state: {
  config: ElizaConfig;
}): FirstRunRouteContext {
  return {
    req: {},
    res: {},
    method: "GET",
    pathname: "/api/first-run/status",
    url: new URL("http://127.0.0.1/api/first-run/status"),
    state: {
      config: state.config,
      runtime: null,
      agentName: "",
      adminEntityId: null,
      chatUserId: null,
      chatConnectionReady: null,
      chatConnectionPromise: null,
    },
    json: () => {},
    error: () => {},
    readJsonBody: async () => null,
    isCloudProvisionedContainer: () => true,
    hasPersistedFirstRunState: () => false,
    ensureWalletKeysInEnvAndConfig: async () => false,
    getWalletAddresses: () => ({}),
    pickRandomNames: () => [],
    getStylePresets: () => [
      {
        id: "preset-cloud-default",
        name: "Eliza",
        avatarIndex: 3,
        voicePresetId: "voice-1",
        bio: ["Default bio"],
        system: "Default system",
      },
    ],
    getProviderOptions: () => [],
    getCloudProviderOptions: () => [],
    getModelOptions: () => ({}),
    getInventoryProviderOptions: () => [],
    resolveConfiguredCharacterLanguage: () => "en",
    normalizeCharacterLanguage: (lang: string | undefined) => lang ?? "en",
    readUiLanguageHeader: () => null,
    applyFirstRunVoicePreset: () => {},
    saveElizaConfig,
  } as unknown as FirstRunRouteContext;
}

it("keeps cloud container character defaults after a full save of the live config", async () => {
  // Disk and live config both start without a character preset, as on a
  // freshly provisioned cloud container.
  saveElizaConfig({});
  const state: { config: ElizaConfig } = { config: loadElizaConfig() };

  const handled = await handleFirstRunRoutes(cloudStatusContext(state));
  expect(handled).toBe(true);

  const onDisk = loadElizaConfig() as Record<string, unknown>;
  const diskUi = onDisk.ui as Record<string, unknown> | undefined;
  expect(diskUi?.presetId).toBe("preset-cloud-default");
  expect(onDisk.serviceRouting).toBeDefined();

  // The live config must carry the same defaults.
  const live = state.config as Record<string, unknown>;
  const liveUi = live.ui as Record<string, unknown> | undefined;
  expect(liveUi?.presetId).toBe("preset-cloud-default");
  expect(live.serviceRouting).toEqual(onDisk.serviceRouting);
  const liveAgents = live.agents as
    | { list?: Array<Record<string, unknown>> }
    | undefined;
  expect(liveAgents?.list?.[0]?.name).toBe("Eliza");

  // What PUT /api/permissions/automation-mode and similar routes do.
  saveElizaConfig(state.config);

  const afterFullSave = loadElizaConfig() as Record<string, unknown>;
  const afterUi = afterFullSave.ui as Record<string, unknown> | undefined;
  expect(afterUi?.presetId).toBe("preset-cloud-default");
  expect(afterFullSave.serviceRouting).toBeDefined();
});
