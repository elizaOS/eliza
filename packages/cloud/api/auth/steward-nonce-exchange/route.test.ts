/** Local Hono boundary regression: synthetic upstream/session doubles, never a live sign-in proof. */
import { afterAll, beforeEach, expect, mock, spyOn, test } from "bun:test";

const verify = mock(async () => ({
  userId: "fixture-user",
  expiration: Math.floor(Date.now() / 1000) + 900,
}));
const sync = mock(async () => ({ id: "fixture-cloud-user" }));
mock.module("@elizaos/cloud-shared/lib/auth/steward-client", () => ({
  STEWARD_AUTH_UPSTREAM_TIMEOUT_MS: 5000,
  verifyStewardTokenCached: verify,
}));
mock.module("@elizaos/cloud-shared/lib/steward-sync", () => ({
  syncUserFromSteward: sync,
  describeSyncError: () => "fixture sync error",
}));
const { default: app } = await import("./route");
let purpose: "email-login" | undefined;
const forwarded: Array<Record<string, unknown>> = [];
const originalFetch = globalThis.fetch;
const upstreamFetch = Object.assign(
  async (
    _url: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    forwarded.push(JSON.parse(String(init?.body)));
    return Response.json({
      ok: true,
      token: "fixture-access-token",
      refreshToken: "fixture-refresh-token",
      ...(purpose ? { purpose } : {}),
    });
  },
  { preconnect: originalFetch.preconnect },
);
const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(upstreamFetch);
const env = {
  NODE_ENV: "test",
  ENVIRONMENT: "staging",
  STEWARD_SESSION_SECRET: "fixture-secret",
  STEWARD_API_URL: "https://steward.example.test",
  STEWARD_TENANT_ID: "fixture-tenant",
};
function exchange(extra: Record<string, unknown> = {}) {
  return app.request(
    "http://localhost/",
    {
      method: "POST",
      headers: {
        Origin: "http://localhost",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        code: "fixture-single-use-code",
        redirectUri: "http://localhost/login",
        tenantId: "fixture-tenant",
        codeVerifier: "v".repeat(64),
        ...extra,
      }),
    },
    env as never,
  );
}
beforeEach(() => {
  purpose = undefined;
  forwarded.length = 0;
  verify.mockClear();
  sync.mockClear();
  fetchSpy.mockClear();
});
afterAll(() => {
  fetchSpy.mockRestore();
  mock.restore();
});

test("forwards email purpose and PKCE then publishes cookies only for trusted matching purpose", async () => {
  purpose = "email-login";
  const response = await exchange({ purpose: "email-login" });
  expect(response.status).toBe(200);
  expect(forwarded).toHaveLength(1);
  expect(forwarded[0]).toMatchObject({
    purpose: "email-login",
    code_verifier: "v".repeat(64),
    tenant_id: "fixture-tenant",
    redirect_uri: "http://localhost/login",
  });
  expect(verify).toHaveBeenCalledTimes(1);
  expect(sync).toHaveBeenCalledTimes(1);
  expect(response.headers.get("set-cookie")).toBeTruthy();
});

test.each(["missing-email-purpose", "email-in-oauth-flow"])(
  "refuses trusted purpose mismatch %s before verification or cookie publication",
  async (scenario) => {
    const emailRequest = scenario === "missing-email-purpose";
    purpose = emailRequest ? undefined : "email-login";
    const response = await exchange(
      emailRequest ? { purpose: "email-login" } : {},
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "code_invalid" });
    expect(verify).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
    expect(response.headers.get("set-cookie")).toBeNull();
  },
);

test("preserves ordinary purpose-less OAuth exchange", async () => {
  const response = await exchange();
  expect(response.status).toBe(200);
  expect(forwarded[0]).not.toHaveProperty("purpose");
  expect(verify).toHaveBeenCalledTimes(1);
});

test("rejects unknown purpose and email exchange without PKCE before upstream calls", async () => {
  const invalid = await exchange({ purpose: "email" });
  expect(invalid.status).toBe(400);
  const missing = await exchange({ purpose: "email-login", codeVerifier: "" });
  expect(missing.status).toBe(400);
  expect(await missing.json()).toMatchObject({ code: "missing_code_verifier" });
  expect(fetchSpy).not.toHaveBeenCalled();
});
