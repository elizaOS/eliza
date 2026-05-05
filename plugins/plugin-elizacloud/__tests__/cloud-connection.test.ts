import { describe, expect, it } from "vitest";

import {
  resolveCloudApiKey,
  resolveCloudConnectionSnapshot,
} from "./cloud-connection";

describe("cloud-connection", () => {
  const cloudInferenceConfig = {
    serviceRouting: {
      llmText: {
        transport: "cloud-proxy" as const,
        backend: "elizacloud",
      },
    },
  };
  const cloudRpcConfig = {
    serviceRouting: {
      rpc: {
        transport: "cloud-proxy" as const,
        backend: "elizacloud",
      },
    },
    linkedAccounts: {
      elizacloud: {
        status: "unlinked" as const,
      },
    },
  };

  it("resolves the cloud api key from runtime settings", () => {
    const runtime = {
      getSetting: (key: string) =>
        key === "ELIZAOS_CLOUD_API_KEY" ? "runtime-setting-key" : undefined,
    };

    expect(resolveCloudApiKey(cloudInferenceConfig, runtime)).toBe(
      "runtime-setting-key",
    );
  });

  it("marks hasApiKey when the runtime exposes a saved cloud api key", () => {
    const runtime = {
      getSetting: (key: string) =>
        key === "ELIZAOS_CLOUD_API_KEY" ? "runtime-setting-key" : undefined,
      getService: () => null,
    };

    expect(
      resolveCloudConnectionSnapshot(cloudInferenceConfig, runtime as never),
    ).toMatchObject({
      connected: true,
      hasApiKey: true,
      authConnected: false,
    });
  });

  it("does not revive runtime credentials when only rpc cloud routing is selected", () => {
    const runtime = {
      getSetting: (key: string) =>
        key === "ELIZAOS_CLOUD_API_KEY" ? "runtime-setting-key" : undefined,
    };

    expect(resolveCloudApiKey(cloudRpcConfig, runtime)).toBeUndefined();
  });
});
