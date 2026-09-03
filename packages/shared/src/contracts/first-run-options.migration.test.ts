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

  /**
   * Each routing key needs its own case: the loop deletes them one at a time,
   * so dropping a single name from the list leaves that field behind while the
   * other four still migrate and every other assertion stays green. `enabled:
   * false` is carried in each case so the `cloud` block survives the prune and
   * can be compared exactly.
   */
  it.each([
    ["provider", "elizacloud"],
    ["remoteApiBase", "https://legacy.example"],
    ["remoteAccessToken", "legacy-token"],
    ["inferenceMode", "local"],
    ["runtime", "local"],
  ])("prunes the legacy cloud.%s field", (key, value) => {
    const config: Record<string, unknown> = {
      cloud: { enabled: false, [key]: value },
    };
    migrateLegacyRuntimeConfig(config);
    expect(config.cloud).toEqual({ enabled: false });
  });

  // A generated table over an empty list registers zero cases and reports
  // green, so pin the arity the table is generated from.
  it("covers every legacy routing key", () => {
    const config: Record<string, unknown> = {
      cloud: {
        enabled: false,
        provider: "elizacloud",
        remoteApiBase: "https://legacy.example",
        remoteAccessToken: "legacy-token",
        inferenceMode: "local",
        runtime: "local",
      },
    };
    migrateLegacyRuntimeConfig(config);
    expect(config.cloud).toEqual({ enabled: false });
  });

  /**
   * The legacy remote credential is MIGRATED, not discarded — it moves to
   * `deploymentTarget.remoteAccessToken`. That makes a missed prune a
   * duplication rather than a loss: the same secret would remain in the legacy
   * `cloud` block as well, and migrated configs are written back to disk. Assert
   * it exists exactly once in the serialized result.
   */
  it("moves the legacy remote credential instead of copying it", () => {
    const config: Record<string, unknown> = {
      cloud: {
        enabled: false,
        remoteApiBase: "https://legacy.example",
        remoteAccessToken: "legacy-token",
      },
    };
    migrateLegacyRuntimeConfig(config);

    expect(config.cloud).toEqual({ enabled: false });
    expect(config.deploymentTarget).toMatchObject({
      runtime: "remote",
      remoteApiBase: "https://legacy.example",
      remoteAccessToken: "legacy-token",
    });
    expect(JSON.stringify(config).split("legacy-token")).toHaveLength(2);
  });

  /**
   * `LEGACY_CLOUD_SERVICE_KEYS` is a second, independent list pruned from
   * `cloud.services`. Nothing referenced any of its five names, so each is
   * isolated here the same way.
   */
  it.each(["inference", "tts", "media", "embeddings", "rpc"])(
    "prunes the legacy cloud.services.%s flag",
    (key) => {
      const config: Record<string, unknown> = {
        cloud: { enabled: false, services: { [key]: true } },
      };
      migrateLegacyRuntimeConfig(config);
      expect(config.cloud).toEqual({ enabled: false });
    },
  );

  it("covers every legacy service key", () => {
    const config: Record<string, unknown> = {
      cloud: {
        enabled: false,
        services: {
          inference: true,
          tts: true,
          media: true,
          embeddings: true,
          rpc: true,
        },
      },
    };
    migrateLegacyRuntimeConfig(config);
    expect(config.cloud).toEqual({ enabled: false });
  });

  /**
   * The two collapse steps are separate and both conditional: an emptied
   * `services` block is removed, and a `cloud` block emptied by that removal is
   * removed in turn. Without the first, migration leaves `cloud: { services: {} }`
   * behind — which is not a legacy field, so nothing later prunes it.
   */
  it("drops a services block emptied by the prune", () => {
    const config: Record<string, unknown> = {
      cloud: { services: { tts: true } },
    };
    migrateLegacyRuntimeConfig(config);
    expect(config.cloud).toBeUndefined();
  });

  it("keeps a services block that still holds an unrecognized flag", () => {
    const config: Record<string, unknown> = {
      cloud: { services: { tts: true, custom: true } },
    };
    migrateLegacyRuntimeConfig(config);
    expect(config.cloud).toEqual({ services: { custom: true } });
  });

  it("keeps a cloud block that still holds an unrecognized field", () => {
    const config: Record<string, unknown> = {
      cloud: { enabled: false, agentId: "agent-1" },
    };
    migrateLegacyRuntimeConfig(config);
    expect(config.cloud).toEqual({ enabled: false, agentId: "agent-1" });
  });

  it("drops an already-empty services block without touching cloud.enabled", () => {
    const config: Record<string, unknown> = {
      cloud: { enabled: false, services: {} },
    };
    migrateLegacyRuntimeConfig(config);
    expect(config.cloud).toEqual({ enabled: false });
  });

  it("still drops a cloud block that only held legacy routing keys", () => {
    const config: Record<string, unknown> = {
      cloud: { inferenceMode: "local" },
    };
    migrateLegacyRuntimeConfig(config);
    expect(config.cloud).toBeUndefined();
  });
});
