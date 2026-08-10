/** Exercises the public browser and authenticated native Cloud pairing contracts. */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { AuthenticationError } from "@/lib/api/errors";
import type { AppEnv } from "@/types/cloud-worker-env";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_USER_ID = "22222222-2222-4222-8222-222222222222";
const ORG_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_ORG_ID = "44444444-4444-4444-8444-444444444444";
const AGENT_ID = "55555555-5555-4555-8555-555555555555";
const TOKEN = "A".repeat(43);
const EXPECTED_ORIGIN = `https://${AGENT_ID}.elizacloud.ai`;

let authenticatedUser = {
  id: USER_ID,
  organization_id: ORG_ID,
};
let authMethod: "session" | "api_key" = "session";
let authFailure: Error | null = null;

const requireAuthOrApiKeyWithOrg = mock(async () => {
  if (authFailure) throw authFailure;
  return {
    user: authenticatedUser,
    authMethod,
  };
});
const findByIdAndOrg = mock();
const validateToken = mock();
const claimAuthenticatedNativeToken = mock();
const loggerError = mock(() => undefined);

mock.module("@/lib/auth", () => ({
  requireAuthOrApiKeyWithOrg,
}));

mock.module("@/db/repositories/agent-sandboxes", () => ({
  agentSandboxesRepository: {
    findByIdAndOrg,
  },
}));

mock.module("@/lib/services/pairing-token", () => ({
  getPairingTokenService: () => ({
    validateToken,
    claimAuthenticatedNativeToken,
  }),
}));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STRICT: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    error: loggerError,
  },
}));

const { default: pairRoute } = await import("./route");

let observedUser: unknown;
let observedAuthMethod: unknown;
const app = new Hono<AppEnv>();
app.use("*", async (c, next) => {
  await next();
  observedUser = c.get("user");
  observedAuthMethod = c.get("authMethod");
});
app.route("/api/auth/pair", pairRoute);

const sandbox = {
  id: AGENT_ID,
  organization_id: ORG_ID,
  user_id: USER_ID,
  agent_name: "Native agent",
  environment_vars: { ELIZA_API_TOKEN: "agent-api-token" },
};

const pairingToken = {
  userId: USER_ID,
  orgId: ORG_ID,
  agentId: AGENT_ID,
  instanceUrl: EXPECTED_ORIGIN,
  expectedOrigin: EXPECTED_ORIGIN,
  expiresAt: Date.now() + 60_000,
  createdAt: Date.now(),
};

async function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.fetch(
    new Request(`https://api.elizacloud.ai${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  );
}

function postNative(
  body: unknown = {
    token: TOKEN,
    agentId: AGENT_ID,
    expectedOrigin: EXPECTED_ORIGIN,
  },
  headers: Record<string, string> = {},
): Promise<Response> {
  return post("/api/auth/pair/native", body, {
    Authorization: "Bearer steward.jwt.token",
    ...headers,
  });
}

describe("Cloud pairing route", () => {
  beforeEach(() => {
    authenticatedUser = {
      id: USER_ID,
      organization_id: ORG_ID,
    };
    authMethod = "session";
    authFailure = null;
    observedUser = undefined;
    observedAuthMethod = undefined;
    requireAuthOrApiKeyWithOrg.mockClear();
    loggerError.mockClear();
    findByIdAndOrg.mockReset();
    findByIdAndOrg.mockResolvedValue(sandbox);
    validateToken.mockReset();
    validateToken.mockResolvedValue(pairingToken);
    claimAuthenticatedNativeToken.mockReset();
    claimAuthenticatedNativeToken.mockResolvedValue({
      status: "claimed",
      pairingToken,
      apiKey: "agent-api-token",
      agentName: "Native agent",
    });
  });

  test("keeps the public browser exchange Origin-bound and compatible", async () => {
    const missingOrigin = await post("/api/auth/pair", { token: TOKEN });
    expect(missingOrigin.status).toBe(400);
    expect(validateToken).not.toHaveBeenCalled();

    const response = await post(
      "/api/auth/pair",
      { token: TOKEN },
      { Origin: EXPECTED_ORIGIN },
    );

    expect(response.status).toBe(200);
    expect(validateToken).toHaveBeenCalledWith(TOKEN, EXPECTED_ORIGIN);
    expect(claimAuthenticatedNativeToken).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      message: "Paired successfully",
      apiKey: "agent-api-token",
      agentName: "Native agent",
      agentId: AGENT_ID,
    });
  });

  test("keeps a wrong browser Origin on the public validation path", async () => {
    validateToken.mockResolvedValueOnce(null);

    const response = await post(
      "/api/auth/pair",
      { token: TOKEN },
      { Origin: "https://wrong-agent.elizacloud.ai" },
    );

    expect(response.status).toBe(401);
    expect(validateToken).toHaveBeenCalledWith(
      TOKEN,
      "https://wrong-agent.elizacloud.ai",
    );
    expect(claimAuthenticatedNativeToken).not.toHaveBeenCalled();
  });

  test("requires an explicit Cloud bearer for the native exchange", async () => {
    const response = await post("/api/auth/pair/native", {
      token: TOKEN,
      agentId: AGENT_ID,
      expectedOrigin: EXPECTED_ORIGIN,
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      code: "cloud_auth_required",
    });
    expect(requireAuthOrApiKeyWithOrg).not.toHaveBeenCalled();
    expect(claimAuthenticatedNativeToken).not.toHaveBeenCalled();
  });

  test("returns 401 for an invalid bearer", async () => {
    authFailure = new AuthenticationError("Invalid or expired token");

    const response = await postNative();

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      code: "cloud_auth_required",
    });
    expect(claimAuthenticatedNativeToken).not.toHaveBeenCalled();
  });

  test("accepts the bearer API key returned by native device-code login", async () => {
    authMethod = "api_key";

    const response = await postNative();

    expect(response.status).toBe(200);
    expect(claimAuthenticatedNativeToken).toHaveBeenCalledTimes(1);
    expect(observedUser).toBe(authenticatedUser);
    expect(observedAuthMethod).toBe("api_key");
  });

  test("rejects competing X-API-Key or wallet auth inputs", async () => {
    const competingHeaders: Record<string, string>[] = [
      { "X-API-Key": "eliza_other_credential" },
      {
        "X-Wallet-Address": "0x123",
        "X-Wallet-Signature": "signature",
        "X-Timestamp": "123",
      },
    ];
    for (const headers of competingHeaders) {
      const response = await postNative(undefined, headers);
      expect(response.status).toBe(401);
    }

    expect(requireAuthOrApiKeyWithOrg).not.toHaveBeenCalled();
    expect(claimAuthenticatedNativeToken).not.toHaveBeenCalled();
  });

  test("pairs natively without an Origin header using all bearer bindings", async () => {
    const response = await postNative();

    expect(response.status).toBe(200);
    expect(observedUser).toBe(authenticatedUser);
    expect(observedAuthMethod).toBe("session");
    expect(claimAuthenticatedNativeToken).toHaveBeenCalledWith(TOKEN, {
      userId: USER_ID,
      orgId: ORG_ID,
      agentId: AGENT_ID,
      expectedOrigin: EXPECTED_ORIGIN,
    });
    await expect(response.json()).resolves.toEqual({
      message: "Paired successfully",
      apiKey: "agent-api-token",
      agentName: "Native agent",
    });
  });

  test("does not consume a one-time token when the sandbox API key is missing", async () => {
    claimAuthenticatedNativeToken.mockResolvedValueOnce({
      status: "sandbox-credential-unavailable",
    });

    const response = await postNative();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Pairing failed",
      code: "sandbox_credential_unavailable",
    });
    expect(loggerError).toHaveBeenCalledWith(
      "[auth/pair/native] sandbox API token unavailable",
      {
        agentId: AGENT_ID,
        organizationId: ORG_ID,
      },
    );
  });

  test("does not consume a one-time token when the sandbox API key is blank", async () => {
    claimAuthenticatedNativeToken.mockResolvedValueOnce({
      status: "sandbox-credential-unavailable",
    });

    const response = await postNative();

    expect(response.status).toBe(503);
  });

  test("ignores a Capacitor Origin header and still enforces the minted origin", async () => {
    const response = await postNative(undefined, {
      Origin: "capacitor://localhost",
    });

    expect(response.status).toBe(200);
    expect(claimAuthenticatedNativeToken).toHaveBeenCalledWith(TOKEN, {
      userId: USER_ID,
      orgId: ORG_ID,
      agentId: AGENT_ID,
      expectedOrigin: EXPECTED_ORIGIN,
    });
  });

  test("rejects malformed native inputs before ownership or consumption", async () => {
    const invalidBodies: unknown[] = [
      null,
      {},
      { token: "short", agentId: AGENT_ID, expectedOrigin: EXPECTED_ORIGIN },
      {
        token: TOKEN,
        agentId: "not-an-agent",
        expectedOrigin: EXPECTED_ORIGIN,
      },
      {
        token: TOKEN,
        agentId: AGENT_ID,
        expectedOrigin: "javascript:alert(1)",
      },
    ];

    for (const body of invalidBodies) {
      const response = await postNative(body);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        success: false,
        code: "invalid_native_pairing_request",
      });
    }

    expect(claimAuthenticatedNativeToken).not.toHaveBeenCalled();
  });

  test("checks current organization ownership before consuming the token", async () => {
    authenticatedUser = {
      id: USER_ID,
      organization_id: OTHER_ORG_ID,
    };
    claimAuthenticatedNativeToken.mockResolvedValueOnce({
      status: "invalid",
    });

    const response = await postNative();

    expect(response.status).toBe(410);
    expect(claimAuthenticatedNativeToken).toHaveBeenCalledWith(TOKEN, {
      userId: USER_ID,
      orgId: OTHER_ORG_ID,
      agentId: AGENT_ID,
      expectedOrigin: EXPECTED_ORIGIN,
    });
  });

  test("returns one generic failure for a wrong user or origin binding", async () => {
    authenticatedUser = {
      id: OTHER_USER_ID,
      organization_id: ORG_ID,
    };
    claimAuthenticatedNativeToken.mockResolvedValue({
      status: "invalid",
    });

    const response = await postNative({
      token: TOKEN,
      agentId: AGENT_ID,
      expectedOrigin: "https://wrong-agent.elizacloud.ai",
    });

    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Invalid or expired pairing code",
      code: "pairing_token_invalid",
    });
    expect(claimAuthenticatedNativeToken).toHaveBeenCalledWith(TOKEN, {
      userId: OTHER_USER_ID,
      orgId: ORG_ID,
      agentId: AGENT_ID,
      expectedOrigin: "https://wrong-agent.elizacloud.ai",
    });
  });
});
