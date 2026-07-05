/**
 * Legacy-runtime-config migration contract: pruning must remove only fields
 * that have a modern replacement. `cloud.enabled === false` is the sole
 * persisted representation of the local-only opt-out (no deploymentTarget or
 * serviceRouting equivalent exists), and migrated configs are written back to
 * disk by the provider-switch/first-run routes — so pruning it destroys the
 * opt-out permanently.
 */
import { describe, expect, it } from "vitest";
import { migrateLegacyRuntimeConfig } from "./first-run-options";

describe("migrateLegacyRuntimeConfig", () => {
  it("preserves cloud.enabled === false while pruning legacy routing keys", () => {
    const config: Record<string, unknown> = {
      cloud: { enabled: false, inferenceMode: "local", runtime: "local" },
    };
    migrateLegacyRuntimeConfig(config);
    expect(config.cloud).toEqual({ enabled: false });
  });

  it("preserves cloud.enabled === true alongside its migrated routing", () => {
    const config: Record<string, unknown> = {
      cloud: { enabled: true, provider: "elizacloud" },
    };
    migrateLegacyRuntimeConfig(config);
    expect(config.cloud).toEqual({ enabled: true });
    expect(config.serviceRouting).toMatchObject({
      llmText: { backend: "elizacloud", transport: "cloud-proxy" },
    });
  });

  it("still drops a cloud block that only held legacy routing keys", () => {
    const config: Record<string, unknown> = {
      cloud: { inferenceMode: "local" },
    };
    migrateLegacyRuntimeConfig(config);
    expect(config.cloud).toBeUndefined();
  });
});
