/**
 * POST /api/auth/steward-session × the cross-host SSO logout marker, through
 * the REAL route module with real HS256 Steward JWTs and the real
 * Postgres-backed marker store on PGlite. After an explicit logout, the
 * paired origin's surviving BRIDGE-ISSUED token (stamped `bridged` by the
 * sso-bridge exchange re-mint) re-POSTs here on its sync cadence — without
 * this gate that re-plants the domain-wide steward cookies the logout just
 * deleted. The gate must 401 with the DISTINCT `session_ended` code (the
 * client treats it as a real revocation and clears its stored session) and
 * set no cookies; stamped tokens issued AFTER the logout must pass. Ordinary
 * (unstamped) tokens are deliberately OUTSIDE the gate: their sync path keeps
 * its pre-bridge no-datastore posture, so the marker never blocks them.
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  setSystemTime,
  test,
} from "bun:test";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

setDefaultTimeout(90_000);

const SECRET = "steward-session-gate-test-secret-01";

type RouteApp = typeof import("../auth/steward-session/route").default;
type StewardClientModule = typeof import("@/lib/auth/steward-client");
let app: RouteApp;
let markSsoBridgeLogout: (stewardUserId: string) => Promise<void>;
let mintStewardTokenFromClaims: StewardClientModule["mintStewardTokenFromClaims"];

const ENV = {
  NODE_ENV: "test",
  ENVIRONMENT: "test",
  STEWARD_SESSION_SECRET: SECRET,
  RATE_LIMIT_MULTIPLIER: "100",
};

let ipCounter = 0;

async function mintToken(
  userId: string,
  iatOffsetSec: number,
  opts: { bridged?: boolean } = {},
): Promise<string> {
  const realNow = Date.now();
  try {
    if (iatOffsetSec !== 0) {
      setSystemTime(new Date(realNow + iatOffsetSec * 1000));
    }
    const minted = await mintStewardTokenFromClaims(
      ENV,
      // The gate only applies to bridge-issued tokens, so gate cases mint with
      // the same `bridged` stamp the sso-bridge exchange re-mint applies.
      { userId, expiration: 0, issuedAt: 0, bridged: opts.bridged === true },
      // Keep the signed issued lifetime at the production one-hour contract.
      // The clock shift exists only to order the token around the logout mark.
      3600,
    );
    if (!minted) throw new Error("test token mint failed");
    return minted.token;
  } finally {
    setSystemTime();
  }
}

async function postSession(token: string): Promise<Response> {
  ipCounter += 1;
  return app.request(
    "/",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://elizacloud.ai",
        "x-forwarded-for": `10.9.0.${ipCounter}`,
      },
      body: JSON.stringify({ token }),
    },
    ENV,
  );
}

beforeAll(async () => {
  expect(CAN_USE_ISOLATED_PGLITE).toBe(true);

  const { pushSchema } = await import("@/db/push-schema-for-tests");
  const { dbWrite } = await import("@/db/client");
  const { ssoBridgeCodes, ssoBridgeLogoutMarkers } = await import(
    "@/db/schemas/sso-bridge"
  );
  const { apply } = await pushSchema(
    { ssoBridgeCodes, ssoBridgeLogoutMarkers } as never,
    dbWrite as never,
  );
  await apply();

  app = (await import("../auth/steward-session/route")).default;
  ({ markSsoBridgeLogout } = await import("@/lib/services/sso-bridge-codes"));
  ({ mintStewardTokenFromClaims } = await import("@/lib/auth/steward-client"));
});

afterAll(async () => {
  setSystemTime();
  const { closeDatabaseConnectionsForTests } = await import("@/db/client");
  await closeDatabaseConnectionsForTests();
});

describe("logout marker gates the cookie-planting session sync", () => {
  test("a pre-logout BRIDGE token gets 401 session_ended and NO cookies — the paired origin cannot re-plant a signed-out session", async () => {
    const userId = "gate-user-blocked";
    const preLogoutToken = await mintToken(userId, -10, { bridged: true });

    await markSsoBridgeLogout(userId);

    const res = await postSession(preLogoutToken);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe("session_ended");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  test("a bridge token issued AFTER the logout passes the gate (fresh consent)", async () => {
    const userId = "gate-user-fresh";
    const preLogoutToken = await mintToken(userId, -10, { bridged: true });
    await markSsoBridgeLogout(userId);

    const blocked = await postSession(preLogoutToken);
    expect(((await blocked.json()) as { code: string }).code).toBe(
      "session_ended",
    );

    // The fresh token must NOT be refused as session_ended. (Later stages of
    // the login pipeline — user sync — have their own dependencies and their
    // own suites; this contract is only that the gate discriminates on iat.)
    const fresh = await postSession(
      await mintToken(userId, 5, { bridged: true }),
    );
    const freshBody = (await fresh.json()) as { code?: string };
    expect(freshBody.code).not.toBe("session_ended");
  });

  test("a bridge-token user with no marker is never blocked by the gate", async () => {
    const res = await postSession(
      await mintToken("gate-user-unmarked", -10, { bridged: true }),
    );
    const body = (await res.json()) as { code?: string };
    expect(body.code).not.toBe("session_ended");
  });

  test("an ORDINARY (unstamped) token is outside the gate — even a stamped logout marker does not block it", async () => {
    // Scoping contract: a token that never crossed the bridge keeps its
    // pre-bridge behavior (the reviewer-mandated availability posture). Only
    // the bridge stamp opts a token into the marker read.
    const userId = "gate-user-ordinary";
    const preLogoutToken = await mintToken(userId, -10);
    await markSsoBridgeLogout(userId);

    const res = await postSession(preLogoutToken);
    const body = (await res.json()) as { code?: string };
    expect(body.code).not.toBe("session_ended");
  });
});
