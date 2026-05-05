import type http from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import { type CloudRouteState, handleCloudRoute } from "../../routes/cloud-routes";

const testCloudRouteServices: CloudRouteState["services"] = {
  applyCanonicalOnboardingConfig: (
    config: Record<string, unknown>,
    patch: Record<string, unknown>
  ) => {
    Object.assign(config, patch);
  },
  saveElizaConfig: () => {},
};

function jsonRequest(body: unknown): http.IncomingMessage {
  return Readable.from([JSON.stringify(body)]) as http.IncomingMessage;
}

function jsonResponse(): http.ServerResponse & {
  body: string;
  headers: Record<string, string>;
} {
  const response = {
    body: "",
    headers: {} as Record<string, string>,
    headersSent: false,
    statusCode: 200,
    end(chunk?: unknown) {
      this.body = typeof chunk === "string" ? chunk : String(chunk ?? "");
      this.headersSent = true;
      return this;
    },
    setHeader(name: string, value: number | string | readonly string[]) {
      this.headers[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
      return this;
    },
  };
  return response as http.ServerResponse & {
    body: string;
    headers: Record<string, string>;
  };
}

describe("cloud-routes", () => {
  it("replaces stale in-memory cloud auth when persisting a newly linked account", async () => {
    const calls: string[] = [];
    const cloudAuth = {
      clearAuth: () => {
        calls.push("clear-auth");
      },
      authenticateWithApiKey: (input: {
        apiKey: string;
        organizationId?: string;
        userId?: string;
      }) => {
        calls.push(`auth:${input.apiKey}:${input.userId}:${input.organizationId}`);
      },
    };
    const cloudRelay = {
      startRelayLoopIfReady: () => {
        calls.push("relay-start");
        return true;
      },
    };
    const runtime = {
      agentId: "agent-1",
      character: {
        secrets: {
          ELIZAOS_CLOUD_API_KEY: "old-key",
          ELIZA_CLOUD_ORGANIZATION_ID: "old-org",
          ELIZA_CLOUD_USER_ID: "old-user",
        },
      },
      getService: (name: string) => {
        if (name === "CLOUD_AUTH") return cloudAuth;
        if (name === "CLOUD_MANAGED_GATEWAY_RELAY") return cloudRelay;
        return null;
      },
      setSetting: (key: string, value: string | null) => {
        calls.push(`setting:${key}:${value ?? ""}`);
      },
      updateAgent: async (
        _agentId: string,
        update: { secrets: Record<string, string | number | boolean> }
      ) => {
        calls.push(`db:${update.secrets.ELIZAOS_CLOUD_API_KEY}`);
      },
    };
    const state: CloudRouteState = {
      cloudManager: {
        getClient: () => ({}) as never,
        init: async () => {
          calls.push("init");
        },
        replaceApiKey: async (apiKey: string) => {
          calls.push(`replace-manager:${apiKey}`);
        },
      } as unknown as CloudRouteState["cloudManager"],
      config: {
        cloud: { apiKey: "old-key" },
        serviceRouting: {
          llmText: { backend: "elizacloud", transport: "cloud-proxy" },
        },
      } as CloudRouteState["config"],
      runtime: runtime as unknown as CloudRouteState["runtime"],
      services: testCloudRouteServices,
    };
    const req = jsonRequest({
      apiKey: "new-key",
      organizationId: "new-org",
      userId: "new-user",
    });
    const res = jsonResponse();

    const handled = await handleCloudRoute(req, res, "/api/cloud/login/persist", "POST", state);

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    expect(state.config.cloud?.apiKey).toBe("new-key");
    expect(runtime.character.secrets).toMatchObject({
      ELIZAOS_CLOUD_API_KEY: "new-key",
      ELIZA_CLOUD_ORGANIZATION_ID: "new-org",
      ELIZA_CLOUD_USER_ID: "new-user",
      ELIZAOS_CLOUD_ORG_ID: "new-org",
      ELIZAOS_CLOUD_USER_ID: "new-user",
    });
    expect(calls).toContain("clear-auth");
    expect(calls).toContain("replace-manager:new-key");
    expect(calls).toContain("auth:new-key:new-user:new-org");
    expect(calls).toContain("relay-start");
    expect(calls).not.toContain("init");
  });

  it("reports Cloud gateway relay status from the runtime service", async () => {
    const state: CloudRouteState = {
      cloudManager: null,
      config: {} as CloudRouteState["config"],
      runtime: {
        getService: (name: string) =>
          name === "CLOUD_MANAGED_GATEWAY_RELAY"
            ? {
                getSessionInfo: () => ({
                  sessionId: "relay-session-1",
                  organizationId: "org-1",
                  userId: "user-1",
                  agentName: "Local Eliza",
                  platform: "local-runtime",
                  lastSeenAt: "2026-04-29T00:00:00.000Z",
                  status: "registered",
                }),
              }
            : null,
      } as CloudRouteState["runtime"],
    };
    const res = jsonResponse();

    const handled = await handleCloudRoute(
      Readable.from([]) as http.IncomingMessage,
      res,
      "/api/cloud/relay-status",
      "GET",
      state
    );

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      available: true,
      sessionId: "relay-session-1",
      organizationId: "org-1",
      userId: "user-1",
      agentName: "Local Eliza",
      platform: "local-runtime",
      lastSeenAt: "2026-04-29T00:00:00.000Z",
      status: "registered",
    });
  });
});
