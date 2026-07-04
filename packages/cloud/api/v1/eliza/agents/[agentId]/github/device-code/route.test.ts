// Exercises cloud API v1 eliza agents agentid github device code route.test behavior with deterministic Worker route fixtures.
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const requireAuthOrApiKeyWithOrg = mock(async (..._args: unknown[]) => ({
  user: { id: "user-1", organization_id: "org-1" },
}));
type TestAgent = { id: string } | null;

const getAgent = mock(
  async (..._args: unknown[]): Promise<TestAgent> => ({ id: "agent-1" }),
);
const getStatus = mock(async (..._args: unknown[]) => ({
  configured: true,
  connected: false,
  mode: null,
  connectionId: null,
  connectionRole: null,
  githubUserId: null,
  githubUsername: null,
  githubDisplayName: null,
  githubAvatarUrl: null,
  githubEmail: null,
  scopes: [],
  source: null,
  adminElizaUserId: null,
  connectedAt: null,
}));
const githubProvider = {
  id: "github",
  defaultScopes: ["read:user", "user:email", "repo"],
};
const getProvider = mock((..._args: unknown[]) => githubProvider);
const isProviderConfigured = mock((..._args: unknown[]) => true);
const initiateOAuth2 = mock(async (..._args: unknown[]) => ({
  authUrl:
    "https://github.com/login/oauth/authorize?client_id=gh-client&state=abc",
  state: "abc",
}));

mock.module("@/lib/auth", () => ({
  requireAuthOrApiKeyWithOrg,
}));

mock.module("@/lib/services/agent-managed-github", () => ({
  managedAgentGithubService: {
    getStatus,
  },
}));

mock.module("@/lib/services/eliza-sandbox", () => ({
  elizaSandboxService: {
    getAgent,
  },
}));

mock.module("@/lib/services/oauth/provider-registry", () => ({
  getProvider,
  isProviderConfigured,
}));

mock.module("@/lib/services/oauth/providers", () => ({
  initiateOAuth2,
}));

mock.module("@/lib/services/proxy/cors", () => ({
  applyCorsHeaders: (response: Response) => response,
  handleCorsOptions: () => new Response(null, { status: 204 }),
}));

const { default: deviceCodeRoute } = await import("./route");

const app = new Hono();
app.route("/api/v1/eliza/agents/:agentId/github/device-code", deviceCodeRoute);

function postDeviceCode(body: unknown = {}) {
  return app.fetch(
    new Request(
      "https://api.example.test/api/v1/eliza/agents/agent-1/github/device-code",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
  );
}

describe("eliza managed GitHub device-code route", () => {
  beforeEach(() => {
    requireAuthOrApiKeyWithOrg.mockClear();
    getAgent.mockReset();
    getAgent.mockResolvedValue({ id: "agent-1" });
    getStatus.mockClear();
    getProvider.mockReset();
    getProvider.mockReturnValue(githubProvider);
    isProviderConfigured.mockReset();
    isProviderConfigured.mockReturnValue(true);
    initiateOAuth2.mockClear();
  });

  test("starts a QR-friendly GitHub OAuth flow and returns the poll contract", async () => {
    const response = await postDeviceCode({
      scopes: ["repo"],
      postMessage: true,
      returnUrl: "agent:settings",
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;

    expect(body).toMatchObject({
      success: true,
      data: {
        flow: "browser_oauth_qr",
        provider: "github",
        agentId: "agent-1",
        authorizeUrl:
          "https://github.com/login/oauth/authorize?client_id=gh-client&state=abc",
        verificationUri:
          "https://github.com/login/oauth/authorize?client_id=gh-client&state=abc",
        verificationUriComplete:
          "https://github.com/login/oauth/authorize?client_id=gh-client&state=abc",
        verification_uri:
          "https://github.com/login/oauth/authorize?client_id=gh-client&state=abc",
        verification_uri_complete:
          "https://github.com/login/oauth/authorize?client_id=gh-client&state=abc",
        qr: "https://github.com/login/oauth/authorize?client_id=gh-client&state=abc",
        qrPayload:
          "https://github.com/login/oauth/authorize?client_id=gh-client&state=abc",
        expiresIn: 600,
        expires_in: 600,
        interval: 2,
        pollUrl: "/api/v1/eliza/agents/agent-1/github",
        poll_url: "/api/v1/eliza/agents/agent-1/github",
        poll: {
          method: "GET",
          url: "/api/v1/eliza/agents/agent-1/github",
          interval: 2,
        },
        status: {
          configured: true,
          connected: false,
        },
      },
    });
    expect(getAgent).toHaveBeenCalledWith("agent-1", "org-1");
    expect(initiateOAuth2).toHaveBeenCalledTimes(1);
    const initiateArgs = initiateOAuth2.mock.calls[0]?.[1] as unknown;
    expect(initiateArgs).toEqual({
      organizationId: "org-1",
      userId: "user-1",
      redirectUrl:
        "/api/v1/eliza/github-oauth-complete?agent_id=agent-1&org_id=org-1&user_id=user-1&post_message=1&return_url=agent%3Asettings",
      scopes: ["repo"],
      connectionRole: "agent",
    });
  });

  test("uses provider default scopes when the caller does not override them", async () => {
    await postDeviceCode();

    const initiateArgs = initiateOAuth2.mock.calls[0]?.[1] as unknown;
    expect(initiateArgs).toMatchObject({
      scopes: ["read:user", "user:email", "repo"],
    });
  });

  test("returns 503 when GitHub OAuth is not configured", async () => {
    isProviderConfigured.mockReturnValue(false);

    const response = await postDeviceCode();

    expect(response.status).toBe(503);
    const body = (await response.json()) as unknown;
    expect(body).toEqual({
      success: false,
      error: "GitHub OAuth is not configured",
    });
    expect(getAgent).not.toHaveBeenCalled();
    expect(initiateOAuth2).not.toHaveBeenCalled();
  });

  test("returns 404 when the agent is outside the caller organization", async () => {
    getAgent.mockImplementation(async () => null);

    const response = await postDeviceCode();

    expect(response.status).toBe(404);
    const body = (await response.json()) as unknown;
    expect(body).toEqual({
      success: false,
      error: "Agent not found",
    });
    expect(initiateOAuth2).not.toHaveBeenCalled();
  });

  test("rejects invalid request bodies before creating OAuth state", async () => {
    const response = await postDeviceCode({
      returnUrl: "x".repeat(2049),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as unknown;
    expect(body).toMatchObject({
      success: false,
      error: "Invalid request",
    });
    expect(initiateOAuth2).not.toHaveBeenCalled();
  });
});
