/**
 * Route-level contract for POST /api/auth/sso-bridge/{mint,exchange} through
 * the REAL route module: real HS256 Steward JWTs (jose) verified by the real
 * `verifyStewardTokenCached`, the real hashed single-use code store on the
 * process-global MOCK_REDIS cache, and the real logout-marker service. Covers
 * the strict per-role origin allowlists (no `.elizacloud.ai` suffix
 * acceptance), Bearer-only mint (a planted parent-domain cookie must NOT
 * authenticate), single-use/replay/expiry semantics of the code, and the
 * logout marker blocking both legs for pre-logout tokens while a fresh
 * post-logout login bridges again.
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

process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

// The beforeAll dynamic import pulls the whole cloud-shared auth/cache chain;
// on a loaded CI host that alone can exceed bun's 5s default.
setDefaultTimeout(30_000);

const SECRET = "sso-bridge-test-secret-0123456789";

type RouteApp = typeof import("../auth/sso-bridge/route").default;
type StewardClientModule = typeof import("@/lib/auth/steward-client");
let app: RouteApp;
let markSsoBridgeLogout: (stewardUserId: string) => Promise<void>;
let mintStewardTokenFromClaims: StewardClientModule["mintStewardTokenFromClaims"];

const ENV = {
  NODE_ENV: "test",
  ENVIRONMENT: "test",
  STEWARD_SESSION_SECRET: SECRET,
  // Non-production honors the multiplier; keeps the STRICT limiter out of the
  // way so the suite exercises the handshake, not the throttle.
  RATE_LIMIT_MULTIPLIER: "100",
};

let ipCounter = 0;

/**
 * Real HS256 Steward token via the production mint helper. `iat` is steered
 * with setSystemTime (the helper stamps "now"), so logout-marker ordering is
 * exercised with genuine claims, not hand-rolled ones.
 */
async function mintToken(
  userId: string,
  opts: { iatOffsetSec?: number; expOffsetSec?: number } = {},
): Promise<string> {
  const iatOffset = opts.iatOffsetSec ?? 0;
  const ttl = (opts.expOffsetSec ?? 3600) - iatOffset;
  const realNow = Date.now();
  try {
    if (iatOffset !== 0) setSystemTime(new Date(realNow + iatOffset * 1000));
    const minted = await mintStewardTokenFromClaims(
      ENV,
      { userId, expiration: 0, issuedAt: 0 },
      ttl,
    );
    if (!minted) throw new Error("test token mint failed");
    return minted.token;
  } finally {
    setSystemTime();
  }
}

interface CallOpts {
  origin?: string;
  bearer?: string;
  cookie?: string;
  body?: unknown;
}

async function call(path: string, opts: CallOpts): Promise<Response> {
  ipCounter += 1;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    // Distinct client IP per request so the per-IP limiter never aliases
    // unrelated test cases together.
    "x-forwarded-for": `10.0.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`,
  };
  if (opts.origin) headers.origin = opts.origin;
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  if (opts.cookie) headers.cookie = opts.cookie;
  return app.request(
    path,
    {
      method: "POST",
      headers,
      body: JSON.stringify(opts.body ?? {}),
    },
    ENV,
  );
}

async function mintCode(token: string): Promise<string> {
  const res = await call("/mint", {
    origin: "https://elizacloud.ai",
    bearer: token,
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { code: string };
  expect(body.code).toMatch(/^esso_[0-9a-f]{64}$/);
  return body.code;
}

beforeAll(async () => {
  // Dynamic import AFTER MOCK_REDIS is set: the shared cache client is a
  // module singleton that picks its backend at first use.
  app = (await import("../auth/sso-bridge/route")).default;
  ({ markSsoBridgeLogout } = await import("@/lib/services/sso-bridge-codes"));
  ({ mintStewardTokenFromClaims } = await import("@/lib/auth/steward-client"));
});

afterAll(() => {
  setSystemTime();
});

describe("origin gating", () => {
  test("mint requires a dashboard origin — exact hosts only", async () => {
    const token = await mintToken("user-origin");
    for (const origin of [
      undefined,
      "https://evil.elizacloud.ai",
      "https://abc12345.apps.elizacloud.ai",
      "https://blob.elizacloud.ai",
      "https://app.elizacloud.ai", // the app host mints nothing
      "https://elizacloud.ai.evil.com",
    ]) {
      const res = await call("/mint", { origin, bearer: token });
      expect(res.status).toBe(403);
    }
  });

  test("exchange requires an app-host origin — the dashboard cannot exchange", async () => {
    for (const origin of [
      undefined,
      "https://elizacloud.ai",
      "https://evil.elizacloud.ai",
      "https://sandbox-1.elizacloud.ai",
    ]) {
      const res = await call("/exchange", {
        origin,
        body: { code: `esso_${"0".repeat(64)}` },
      });
      expect(res.status).toBe(403);
    }
  });
});

describe("mint authentication", () => {
  test("no credentials → 401", async () => {
    const res = await call("/mint", { origin: "https://elizacloud.ai" });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe("missing_token");
  });

  test("a steward COOKIE alone never mints — Bearer only (planted parent-domain cookies must not authenticate)", async () => {
    const token = await mintToken("user-cookie");
    const res = await call("/mint", {
      origin: "https://elizacloud.ai",
      cookie: `steward-token=${token}`,
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe("missing_token");
  });

  test("a garbage Bearer token → 401 invalid_token", async () => {
    const res = await call("/mint", {
      origin: "https://elizacloud.ai",
      bearer: "not-a-jwt",
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_token");
  });
});

describe("code lifecycle", () => {
  test("mint → exchange returns the same verified token exactly once; replay fails", async () => {
    const token = await mintToken("user-lifecycle");
    const code = await mintCode(token);

    const first = await call("/exchange", {
      origin: "https://app.elizacloud.ai",
      body: { code },
    });
    expect(first.status).toBe(200);
    expect(((await first.json()) as { token: string }).token).toBe(token);

    // Consumed atomically: the second presentation of the same code loses.
    const replay = await call("/exchange", {
      origin: "https://app.elizacloud.ai",
      body: { code },
    });
    expect(replay.status).toBe(401);
    expect(((await replay.json()) as { code: string }).code).toBe(
      "invalid_code",
    );
  });

  test("an expired code fails", async () => {
    const token = await mintToken("user-expiry", { expOffsetSec: 7200 });
    const code = await mintCode(token);
    const realNow = Date.now();
    try {
      setSystemTime(new Date(realNow + 61_000));
      const res = await call("/exchange", {
        origin: "https://app.elizacloud.ai",
        body: { code },
      });
      expect(res.status).toBe(401);
      expect(((await res.json()) as { code: string }).code).toBe(
        "invalid_code",
      );
    } finally {
      setSystemTime();
    }
  });

  test("malformed / missing codes are rejected before any store lookup", async () => {
    for (const code of [undefined, "", "short", `eac_${"0".repeat(64)}`, 42]) {
      const res = await call("/exchange", {
        origin: "https://app.elizacloud.ai",
        body: { code },
      });
      expect(res.status).toBe(400);
    }
  });

  test("an unknown (never-minted) code fails without an oracle", async () => {
    const res = await call("/exchange", {
      origin: "https://app.elizacloud.ai",
      body: { code: `esso_${"f".repeat(64)}` },
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_code");
  });
});

describe("logout stays logged out (cross-host)", () => {
  test("after an explicit logout, pre-logout tokens can neither mint nor exchange; a fresh login bridges again", async () => {
    const userId = "user-logout";
    const preLogoutToken = await mintToken(userId, { iatOffsetSec: -10 });
    const pendingCode = await mintCode(preLogoutToken);

    // The logout route stamps this marker (see auth/logout/route.ts).
    await markSsoBridgeLogout(userId);

    // Mint refuses: bridging now would silently undo the logout.
    const mintRes = await call("/mint", {
      origin: "https://elizacloud.ai",
      bearer: preLogoutToken,
    });
    expect(mintRes.status).toBe(401);
    expect(((await mintRes.json()) as { code: string }).code).toBe(
      "session_ended",
    );

    // A code minted BEFORE the logout dies with it, even inside its TTL.
    const exchangeRes = await call("/exchange", {
      origin: "https://app.elizacloud.ai",
      body: { code: pendingCode },
    });
    expect(exchangeRes.status).toBe(401);
    expect(((await exchangeRes.json()) as { code: string }).code).toBe(
      "session_ended",
    );

    // A NEW login (token issued after the marker) is a fresh consent: the
    // bridge works again without waiting for the marker to age out.
    const postLogoutToken = await mintToken(userId, { iatOffsetSec: 5 });
    const newCode = await mintCode(postLogoutToken);
    const fresh = await call("/exchange", {
      origin: "https://app.elizacloud.ai",
      body: { code: newCode },
    });
    expect(fresh.status).toBe(200);
    expect(((await fresh.json()) as { token: string }).token).toBe(
      postLogoutToken,
    );
  });
});

describe("session validity is re-checked at exchange time", () => {
  test("a token that expired inside the code window is not handed out", async () => {
    const token = await mintToken("user-shortlived", { expOffsetSec: 20 });
    const code = await mintCode(token);
    const realNow = Date.now();
    try {
      // 30s later the CODE is still live (60s TTL) but the token is dead.
      setSystemTime(new Date(realNow + 30_000));
      const res = await call("/exchange", {
        origin: "https://app.elizacloud.ai",
        body: { code },
      });
      expect(res.status).toBe(401);
    } finally {
      setSystemTime();
    }
  });
});
