import fs from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApiServer } from "../../src/api/server";
import { req } from "../helpers/http.ts";
import { useIsolatedConfigEnv } from "../helpers/isolated-config.ts";
import { createRealTestRuntime } from "../helpers/real-runtime.ts";

describe("Cloud login persist real route coverage", () => {
  let configEnv: ReturnType<typeof useIsolatedConfigEnv> | null = null;
  let runtimeResult: Awaited<ReturnType<typeof createRealTestRuntime>> | null =
    null;
  let server: Awaited<ReturnType<typeof startApiServer>> | null = null;
  const previousCloudApiKey = process.env.ELIZAOS_CLOUD_API_KEY;
  const previousCloudEnabled = process.env.ELIZAOS_CLOUD_ENABLED;

  beforeAll(async () => {
    configEnv = useIsolatedConfigEnv("cloud-login-persist-");
    delete process.env.ELIZAOS_CLOUD_API_KEY;
    delete process.env.ELIZAOS_CLOUD_ENABLED;
    const { elizaCloudRoutePlugin } = await import(
      "@elizaos/plugin-elizacloud"
    );
    runtimeResult = await createRealTestRuntime({
      characterName: "CloudLoginPersistLive",
      plugins: [elizaCloudRoutePlugin],
    });
    server = await startApiServer({
      port: 0,
      runtime: runtimeResult.runtime,
      skipDeferredStartupWork: true,
    });
  }, 120_000);

  afterAll(async () => {
    await server?.close().catch(() => undefined);
    await runtimeResult?.cleanup().catch(() => undefined);
    await configEnv?.restore().catch(() => undefined);

    if (previousCloudApiKey === undefined) {
      delete process.env.ELIZAOS_CLOUD_API_KEY;
    } else {
      process.env.ELIZAOS_CLOUD_API_KEY = previousCloudApiKey;
    }

    if (previousCloudEnabled === undefined) {
      delete process.env.ELIZAOS_CLOUD_ENABLED;
    } else {
      process.env.ELIZAOS_CLOUD_ENABLED = previousCloudEnabled;
    }
  });

  it("keeps the cloud api key after a subsequent settings config save", async () => {
    const response = await req(
      server?.port ?? 0,
      "POST",
      "/api/cloud/login/persist",
      { apiKey: "cloud-api-key-test" },
    );

    expect(response.status).toBe(200);
    expect(response.data).toEqual({ ok: true });

    const savedConfig = JSON.parse(
      await fs.readFile(configEnv?.configPath ?? "", "utf8"),
    ) as {
      cloud?: { apiKey?: string };
    };
    expect(savedConfig.cloud?.apiKey).toBe("cloud-api-key-test");
    expect(
      runtimeResult?.runtime.character.secrets?.ELIZAOS_CLOUD_API_KEY,
    ).toBe("cloud-api-key-test");

    const settingsSave = await req(server?.port ?? 0, "PUT", "/api/config", {
      ui: { theme: "dark" },
    });

    expect(settingsSave.status).toBe(200);

    const savedAfterSettingsRefresh = JSON.parse(
      await fs.readFile(configEnv?.configPath ?? "", "utf8"),
    ) as {
      cloud?: { apiKey?: string };
      linkedAccounts?: { elizacloud?: { status?: string } };
    };
    expect(savedAfterSettingsRefresh.cloud?.apiKey).toBe("cloud-api-key-test");
    expect(savedAfterSettingsRefresh.linkedAccounts?.elizacloud?.status).toBe(
      "linked",
    );
  });
});
