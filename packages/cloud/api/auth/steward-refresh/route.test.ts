/**
 * Bearer refresh re-mints a Steward token. It must honour an explicit logout,
 * stop renewing a chain after the absolute session cap, and carry the signed
 * sign-in time (auth_time) and session start (sst) so a re-mint never looks
 * like a fresh authentication.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";

process.env.MOCK_REDIS = "1";

const { SignJWT } = await import("jose");
const { ssoBridgeRepository } = await import(
  "../../../shared/src/db/repositories/sso-bridge"
);
const { isRecentDestructiveAuth } = await import(
  "../../../shared/src/lib/auth/recent-auth"
);
const { verifyStewardTokenCached } = await import(
  "@elizaos/cloud-shared/lib/auth/steward-client"
);
const { default: app, STEWARD_BEARER_SESSION_MAX_SECONDS } = await import(
  "./route"
);

const env = {
  NODE_ENV: "test",
  STEWARD_JWT_SECRET: "steward-refresh-route-test-secret-0123456789abcdef",
};
const USER = "steward-user-refresh";

const spies: ReturnType<typeof spyOn>[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function logoutMarkerAt(seconds: number | null): void {
  spies.push(
    spyOn(ssoBridgeRepository, "getLogoutMarkerForWrite").mockResolvedValue(
      seconds === null
        ? undefined
        : ({
            steward_user_id: USER,
            logged_out_at: new Date(seconds * 1000),
          } as Awaited<
            ReturnType<typeof ssoBridgeRepository.getLogoutMarkerForWrite>
          >),
    ),
  );
}

/** A Steward-issued access token as the login service signs it. */
async function stewardToken(input: {
  issuedAt: number;
  authTime?: number;
  sessionStartedAt?: number;
}): Promise<string> {
  return new SignJWT({
    userId: USER,
    authMethod: "email",
    ...(input.authTime !== undefined ? { auth_time: input.authTime } : {}),
    ...(input.sessionStartedAt !== undefined
      ? { sst: input.sessionStartedAt }
      : {}),
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(USER)
    .setIssuedAt(input.issuedAt)
    .setExpirationTime(input.issuedAt + 3600)
    .sign(new TextEncoder().encode(env.STEWARD_JWT_SECRET));
}

async function refresh(token: string): Promise<Response> {
  return app.request(
    "https://api.example.test/",
    { method: "POST", headers: { Authorization: `Bearer ${token}` } },
    env,
  );
}

describe("POST /api/auth/steward-refresh (bearer)", () => {
  test("a token issued before an explicit logout is not renewed", async () => {
    const issuedAt = nowSeconds() - 60;
    logoutMarkerAt(issuedAt + 30);
    const response = await refresh(await stewardToken({ issuedAt }));
    expect(response.status).toBe(401);
    expect(((await response.json()) as { code: string }).code).toBe(
      "session_ended",
    );
  });

  test("a new login after the logout is renewed", async () => {
    const issuedAt = nowSeconds() - 60;
    logoutMarkerAt(issuedAt - 30);
    const response = await refresh(await stewardToken({ issuedAt }));
    expect(response.status).toBe(200);
    expect(((await response.json()) as { token?: string }).token).toBeString();
  });

  test("an unreadable logout store is an outage, not a sign-out", async () => {
    spies.push(
      spyOn(ssoBridgeRepository, "getLogoutMarkerForWrite").mockRejectedValue(
        new Error("connection refused"),
      ),
    );
    const response = await refresh(
      await stewardToken({ issuedAt: nowSeconds() - 60 }),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBeTruthy();
    expect(((await response.json()) as { code: string }).code).toBe(
      "sso_unavailable",
    );
  });

  test("a chain older than the session cap is not renewed", async () => {
    logoutMarkerAt(null);
    const now = nowSeconds();
    const response = await refresh(
      await stewardToken({
        issuedAt: now - 60,
        sessionStartedAt: now - STEWARD_BEARER_SESSION_MAX_SECONDS - 60,
      }),
    );
    expect(response.status).toBe(401);
    expect(((await response.json()) as { code: string }).code).toBe(
      "session_ended",
    );
  });

  test("a re-minted token keeps auth_time and sst", async () => {
    logoutMarkerAt(null);
    const now = nowSeconds();
    const authTime = now - 2 * 24 * 3600;
    const sessionStartedAt = now - 3 * 24 * 3600;
    const response = await refresh(
      await stewardToken({ issuedAt: now - 60, authTime, sessionStartedAt }),
    );
    expect(response.status).toBe(200);
    const { token } = (await response.json()) as { token: string };
    const claims = await verifyStewardTokenCached(env, token);
    expect(claims?.authTime).toBe(authTime);
    expect(claims?.sessionStartedAt).toBe(sessionStartedAt);
    expect(claims?.issuedAt).toBeGreaterThanOrEqual(now);
  });

  test("a token without auth_time or sst is pinned at its own iat", async () => {
    logoutMarkerAt(null);
    const issuedAt = nowSeconds() - 600;
    const response = await refresh(await stewardToken({ issuedAt }));
    expect(response.status).toBe(200);
    const { token } = (await response.json()) as { token: string };
    const claims = await verifyStewardTokenCached(env, token);
    expect(claims?.authTime).toBe(issuedAt);
    expect(claims?.sessionStartedAt).toBe(issuedAt);
  });

  test("a re-minted 10-minute-old session still needs re-authentication", async () => {
    logoutMarkerAt(null);
    const now = nowSeconds();
    const response = await refresh(
      await stewardToken({ issuedAt: now - 600, authTime: now - 600 }),
    );
    const { token } = (await response.json()) as { token: string };
    const claims = await verifyStewardTokenCached(env, token);
    expect(claims?.issuedAt).toBeGreaterThanOrEqual(now);
    expect(
      isRecentDestructiveAuth({
        claims,
        expectedStewardUserId: USER,
        nowSeconds: nowSeconds(),
        maxAgeSeconds: 5 * 60,
        allowStagingSession: false,
      }),
    ).toBe(false);
  });

  test("a second re-mint cannot move auth_time forward", async () => {
    logoutMarkerAt(null);
    const authTime = nowSeconds() - 600;
    const first = await refresh(
      await stewardToken({ issuedAt: authTime, authTime }),
    );
    const { token } = (await first.json()) as { token: string };
    const second = await refresh(token);
    const renewed = await verifyStewardTokenCached(
      env,
      ((await second.json()) as { token: string }).token,
    );
    expect(second.status).toBe(200);
    expect(renewed?.authTime).toBe(authTime);
  });
});
