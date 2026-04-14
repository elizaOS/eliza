import { Readable } from "node:stream";
import type http from "node:http";

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  clearCloudSecretsMock,
  saveElizaConfigMock,
  scrubCloudSecretsFromEnvMock,
} = vi.hoisted(() => ({
  clearCloudSecretsMock: vi.fn(),
  saveElizaConfigMock: vi.fn(),
  scrubCloudSecretsFromEnvMock: vi.fn(),
}));

vi.mock("@elizaos/agent/api/cloud-routes", () => ({
  handleCloudRoute: vi.fn(async () => false),
}));

vi.mock("@elizaos/agent/config/config", () => ({
  saveElizaConfig: saveElizaConfigMock,
}));

vi.mock("./cloud-connection", () => ({
  disconnectUnifiedCloudConnection: vi.fn(async () => undefined),
}));

vi.mock("./cloud-secrets", () => ({
  clearCloudSecrets: clearCloudSecretsMock,
  scrubCloudSecretsFromEnv: scrubCloudSecretsFromEnvMock,
}));

import { handleCloudRoute } from "./cloud-routes";

function makeJsonRequest(url: string, body: unknown): http.IncomingMessage {
  const req = Readable.from([JSON.stringify(body)]) as http.IncomingMessage;
  req.method = "POST";
  req.url = url;
  req.headers = { host: "localhost:31337" };
  return req;
}

function makeResponse() {
  let body = "";
  const res = {
    headersSent: false,
    statusCode: 200,
    setHeader() {},
    end(chunk?: string) {
      body = chunk ?? "";
      this.headersSent = true;
    },
  } as unknown as http.ServerResponse & { headersSent: boolean };

  return {
    res,
    readBody: () => (body ? (JSON.parse(body) as Record<string, unknown>) : {}),
  };
}

describe("handleCloudRoute /api/cloud/login/persist", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ELIZAOS_CLOUD_API_KEY;
    delete process.env.ELIZAOS_CLOUD_ENABLED;
  });

  it("persists the cloud api key to config, env, and runtime secrets", async () => {
    const { res, readBody } = makeResponse();
    const config = {
      cloud: { baseUrl: "https://www.elizacloud.ai" },
      serviceRouting: {
        llmText: {
          transport: "cloud-proxy" as const,
          backend: "elizacloud",
        },
      },
    } as never;
    const runtime = {
      agentId: "agent-123",
      character: { secrets: {} },
      updateAgent: vi.fn(async () => undefined),
    } as never;

    const handled = await handleCloudRoute(
      makeJsonRequest("/api/cloud/login/persist", {
        apiKey: "cloud-api-key",
      }),
      res,
      "/api/cloud/login/persist",
      "POST",
      {
        config,
        runtime,
        cloudManager: null,
      },
    );

    expect(handled).toBe(true);
    expect(readBody()).toEqual({ ok: true });
    expect(config.cloud?.apiKey).toBe("cloud-api-key");
    expect(saveElizaConfigMock).toHaveBeenCalledWith(config);
    expect(clearCloudSecretsMock).toHaveBeenCalledTimes(1);
    expect(scrubCloudSecretsFromEnvMock).toHaveBeenCalledTimes(1);
    expect(process.env.ELIZAOS_CLOUD_API_KEY).toBe("cloud-api-key");
    expect(process.env.ELIZAOS_CLOUD_ENABLED).toBe("true");
    expect(runtime.character.secrets).toMatchObject({
      ELIZAOS_CLOUD_API_KEY: "cloud-api-key",
      ELIZAOS_CLOUD_ENABLED: "true",
    });
    expect(runtime.updateAgent).toHaveBeenCalledWith("agent-123", {
      secrets: expect.objectContaining({
        ELIZAOS_CLOUD_API_KEY: "cloud-api-key",
        ELIZAOS_CLOUD_ENABLED: "true",
      }),
    });
  });
});
