/**
 * Covers the agent host-bridge seam (`host-bridge.ts`) that lets a host inject
 * platform capabilities (account pool, vault bootstrap/shared vault, build
 * variant, cloud-pair route) into `@elizaos/agent`: the no-op default when no
 * host has installed a bridge, `ELIZA_BUILD_VARIANT`-driven build-variant flags,
 * and get/set/reset of an installed bridge. Deterministic and in-process — the
 * real default bridge plus a hand-built stub, no actual host.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  _resetAgentHostBridge,
  type AgentHostBridge,
  defaultAgentHostBridge,
  getAgentHostBridge,
  setAgentHostBridge,
} from "./host-bridge.ts";

describe("agent host bridge (downward injection seam)", () => {
  afterEach(() => {
    _resetAgentHostBridge();
  });

  it("falls back to the no-op default when no host has installed a bridge", async () => {
    const bridge = getAgentHostBridge();
    expect(bridge).toBe(defaultAgentHostBridge);

    // Mirrors the mobile `app-core-runtime.cjs` stub behavior exactly.
    expect(bridge.getDefaultAccountPool()).toBeNull();
    await expect(bridge.runVaultBootstrap()).resolves.toEqual({
      migrated: 0,
      failed: [],
    });
    await expect(bridge.sharedVault().has("ANY")).resolves.toBe(false);
    await expect(bridge.sharedVault().get("ANY")).resolves.toBe("");
    expect(bridge.handleCloudPairRoute).toBeUndefined();
  });

  it("honors ELIZA_BUILD_VARIANT in the default build-variant flags", () => {
    const prev = process.env.ELIZA_BUILD_VARIANT;
    try {
      process.env.ELIZA_BUILD_VARIANT = "store";
      expect(defaultAgentHostBridge.getBuildVariant()).toBe("store");
      expect(defaultAgentHostBridge.isStoreBuild()).toBe(true);
      process.env.ELIZA_BUILD_VARIANT = "direct";
      expect(defaultAgentHostBridge.getBuildVariant()).toBe("direct");
      expect(defaultAgentHostBridge.isStoreBuild()).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.ELIZA_BUILD_VARIANT;
      else process.env.ELIZA_BUILD_VARIANT = prev;
    }
  });

  it("returns the host-installed bridge after setAgentHostBridge", () => {
    const pool = { id: "installed-pool" };
    let keepAliveStarted = false;
    const installed: AgentHostBridge = {
      captureWalletEnvBootBaseline: () => undefined,
      hydrateWalletKeysFromNodePlatformSecureStore: () => undefined,
      runVaultBootstrap: () => Promise.resolve({ migrated: 3, failed: [] }),
      sharedVault: defaultAgentHostBridge.sharedVault,
      getDefaultAccountPool: () => pool,
      applyAccountPoolApiCredentials: () => undefined,
      startAccountPoolKeepAlive: () => {
        keepAliveStarted = true;
      },
      getBuildVariant: () => "direct",
      isStoreBuild: () => false,
      handleCloudPairRoute: () => Promise.resolve(true),
    };

    setAgentHostBridge(installed);

    const bridge = getAgentHostBridge();
    expect(bridge).toBe(installed);
    expect(bridge.getDefaultAccountPool()).toBe(pool);
    bridge.startAccountPoolKeepAlive();
    expect(keepAliveStarted).toBe(true);
    expect(typeof bridge.handleCloudPairRoute).toBe("function");
  });

  it("resets back to the default after _resetAgentHostBridge", () => {
    setAgentHostBridge({
      ...defaultAgentHostBridge,
      getDefaultAccountPool: () => ({ replaced: true }),
    });
    expect(getAgentHostBridge().getDefaultAccountPool()).toEqual({
      replaced: true,
    });

    _resetAgentHostBridge();
    expect(getAgentHostBridge()).toBe(defaultAgentHostBridge);
  });
});
