/**
 * Route-level contract for POST /api/auth/sso-bridge/{mint,exchange} through
 * the REAL route module: real HS256 Steward JWTs (jose) verified by the real
 * `verifyStewardTokenCached`, and the real POSTGRES-backed single-use code
 * store + logout-marker service on PGlite — the same atomic
 * `DELETE … RETURNING` claim the deployed Worker runs against its Postgres.
 * Covers the strict per-role Origin-only allowlists (no related-domain
 * suffix, no Referer fallback), Bearer-only mint (a planted parent-domain
 * cookie must NOT authenticate), the PKCE challenge/verifier binding,
 * single-use/replay/expiry semantics INCLUDING a concurrent double-exchange
 * race, the burn-a-bare-code path, the logout marker blocking both legs, and
 * — critically — that none of it depends on the cache: a sabotage block turns
 * the cache client's single-use primitives into loud failures (the deployed
 * cache is Cloudflare KV, whose getdel/NX are non-atomic) and the bridge must
 * keep its guarantees regardless.
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

// The beforeAll dynamic import pulls the whole cloud-shared auth/db chain and
// pushes DDL into PGlite; on a loaded CI host that can exceed bun's default.
setDefaultTimeout(90_000);

const SECRET = "sso-bridge-test-secret-0123456789";

type RouteApp = typeof import("../auth/sso-bridge/route").default;
type StewardClientModule = typeof import("@/lib/auth/steward-client");
type CacheModule = typeof import("@/lib/cache/client");
let app: RouteApp;
let markSsoBridgeLogout: (stewardUserId: string) => Promise<void>;
let mintStewardTokenFromClaims: StewardClientModule["mintStewardTokenFromClaims"];
let verifyStewardTokenCached: StewardClientModule["verifyStewardTokenCached"];
let cache: CacheModule["cache"];

const ENV = {
  NODE_ENV: "test",
  ENVIRONMENT: "test",
  STEWARD_SESSION_SECRET: SECRET,
  // Non-production honors the multiplier; keeps the STRICT limiter out of the
  // way so the suite exercises the handshake, not the throttle.
  RATE_LIMIT_MULTIPLIER: "100",
};

let ipCounter = 0;

/** 64-hex verifier/challenge pair matching the client's PKCE shape. */
async function makeVerifierPair(): Promise<{
  verifier: string;
  challenge: string;
}> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const verifier = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  const challenge = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return { verifier, challenge };
}

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
  // Keep the signed issued lifetime at the production one-hour contract: the
  // verifier caps exp-iat, so the clock shift may not inflate the TTL.
  const ttl = opts.expOffsetSec ?? 3600;
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
  referer?: string;
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
  if (opts.referer) headers.referer = opts.referer;
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

async function mintCode(token: string, challenge: string): Promise<string> {
  const res = await call("/mint", {
    origin: "https://eliza.app",
    bearer: token,
    body: { codeChallenge: challenge },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { code: string };
  expect(body.code).toMatch(/^esso_[0-9a-f]{64}$/);
  return body.code;
}

function exchange(code: string, verifier?: string): Promise<Response> {
  return call("/exchange", {
    origin: "https://cloud.eliza.app",
    body: verifier === undefined ? { code } : { code, codeVerifier: verifier },
  });
}

/** Assert a 200 exchange body carries a REAL re-minted token for `userId`,
 * accepted by the production verifier. */
async function expectUsableToken(
  res: Response,
  userId: string,
): Promise<string> {
  expect(res.status).toBe(200);
  const body = (await res.json()) as { token: string };
  const claims = await verifyStewardTokenCached(ENV, body.token);
  expect(claims?.userId).toBe(userId);
  return body.token;
}

beforeAll(async () => {
  expect(CAN_USE_ISOLATED_PGLITE).toBe(true);

  // Dynamic import AFTER the env is pinned: the shared db + cache clients are
  // module singletons that pick their backend at first use.
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

  app = (await import("../auth/sso-bridge/route")).default;
  ({ markSsoBridgeLogout } = await import("@/lib/services/sso-bridge-codes"));
  ({ mintStewardTokenFromClaims, verifyStewardTokenCached } = await import(
    "@/lib/auth/steward-client"
  ));
  ({ cache } = await import("@/lib/cache/client"));
});

afterAll(async () => {
  setSystemTime();
  const { closeDatabaseConnectionsForTests } = await import("@/db/client");
  await closeDatabaseConnectionsForTests();
});

describe("origin gating", () => {
  test("mint requires a dashboard origin — exact hosts only", async () => {
    const token = await mintToken("user-origin");
    const { challenge } = await makeVerifierPair();
    for (const origin of [
      undefined,
      "https://evil.elizacloud.ai",
      "https://abc12345.apps.elizacloud.ai",
      "https://blob.elizacloud.ai",
      "https://app.elizacloud.ai", // the app host mints nothing
      "https://elizacloud.ai.evil.com",
    ]) {
      const res = await call("/mint", {
        origin,
        bearer: token,
        body: { codeChallenge: challenge },
      });
      expect(res.status).toBe(403);
    }
  });

  test("a Referer alone never satisfies the gate — Origin only (browsers always send Origin on POST; everything else forges both)", async () => {
    const token = await mintToken("user-referer");
    const { challenge } = await makeVerifierPair();
    const res = await call("/mint", {
      referer: "https://eliza.app/auth/bridge",
      bearer: token,
      body: { codeChallenge: challenge },
    });
    expect(res.status).toBe(403);
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
    const { challenge } = await makeVerifierPair();
    const res = await call("/mint", {
      origin: "https://eliza.app",
      body: { codeChallenge: challenge },
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe("missing_token");
  });

  test("a steward COOKIE alone never mints — Bearer only (planted parent-domain cookies must not authenticate)", async () => {
    const token = await mintToken("user-cookie");
    const { challenge } = await makeVerifierPair();
    const res = await call("/mint", {
      origin: "https://eliza.app",
      cookie: `steward-token=${token}`,
      body: { codeChallenge: challenge },
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe("missing_token");
  });

  test("a garbage Bearer token → 401 invalid_token", async () => {
    const { challenge } = await makeVerifierPair();
    const res = await call("/mint", {
      origin: "https://eliza.app",
      bearer: "not-a-jwt",
      body: { codeChallenge: challenge },
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_token");
  });

  test("no unbound codes: a mint without a well-formed codeChallenge → 400", async () => {
    const token = await mintToken("user-no-challenge");
    for (const codeChallenge of [
      undefined,
      "",
      "short",
      "Z".repeat(64),
      42,
      `${"a".repeat(63)}G`,
    ]) {
      const res = await call("/mint", {
        origin: "https://eliza.app",
        bearer: token,
        body: { codeChallenge },
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe(
        "missing_challenge",
      );
    }
  });
});

describe("code lifecycle", () => {
  test("mint → exchange re-mints a usable token exactly once; replay fails", async () => {
    const userId = "user-lifecycle";
    const token = await mintToken(userId);
    const { verifier, challenge } = await makeVerifierPair();
    const code = await mintCode(token, challenge);

    // Advance past the original token's iat second so a re-mint is textually
    // distinguishable from the original (identical claims + same-second iat
    // would produce the identical JWT).
    const realNow = Date.now();
    let exchanged: string;
    try {
      setSystemTime(new Date(realNow + 2_000));
      const first = await exchange(code, verifier);
      exchanged = await expectUsableToken(first, userId);
    } finally {
      setSystemTime();
    }
    // The stored dashboard token is never handed back — the store holds
    // claims, not a session credential, so the response is a fresh mint.
    expect(exchanged).not.toBe(token);
    // The re-mint is capped to the ORIGINAL token's expiry (never extends it).
    const origClaims = await verifyStewardTokenCached(ENV, token);
    const newClaims = await verifyStewardTokenCached(ENV, exchanged);
    expect(
      Math.abs((newClaims?.expiration ?? 0) - (origClaims?.expiration ?? 0)),
    ).toBeLessThanOrEqual(1);
    // The re-mint is stamped bridge-issued — the session-sync endpoint scopes
    // its fail-closed logout-marker read to exactly these tokens. The original
    // (per-origin login) token carries no stamp.
    expect(newClaims?.bridged).toBe(true);
    expect(origClaims?.bridged).toBeUndefined();

    // Consumed atomically: the second presentation of the same code loses.
    const replay = await exchange(code, verifier);
    expect(replay.status).toBe(401);
    expect(((await replay.json()) as { code: string }).code).toBe(
      "invalid_code",
    );
  });

  test("RACE: two concurrent exchanges of one code yield exactly one session", async () => {
    const userId = "user-race";
    const token = await mintToken(userId);
    const { verifier, challenge } = await makeVerifierPair();
    const code = await mintCode(token, challenge);

    const [a, b] = await Promise.all([
      exchange(code, verifier),
      exchange(code, verifier),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 401]);
    const winner = a.status === 200 ? a : b;
    await expectUsableToken(winner, userId);
  });

  test("a wrong verifier consumes the code AND fails — the code is burned for everyone", async () => {
    const token = await mintToken("user-pkce");
    const { verifier, challenge } = await makeVerifierPair();
    const { verifier: wrongVerifier } = await makeVerifierPair();
    const code = await mintCode(token, challenge);

    const wrong = await exchange(code, wrongVerifier);
    expect(wrong.status).toBe(401);
    expect(((await wrong.json()) as { code: string }).code).toBe(
      "invalid_code",
    );

    // Claim-then-verify: even the RIGHT verifier now loses — a stolen code
    // presented first by an attacker without the verifier destroys the
    // handshake instead of leaving it live.
    const right = await exchange(code, verifier);
    expect(right.status).toBe(401);
  });

  test("a bare {code} POST burns the code (the client's abandoned-handshake path)", async () => {
    const token = await mintToken("user-burn");
    const { verifier, challenge } = await makeVerifierPair();
    const code = await mintCode(token, challenge);

    const burn = await exchange(code);
    expect(burn.status).toBe(401);

    const after = await exchange(code, verifier);
    expect(after.status).toBe(401);
  });

  test("an expired code fails", async () => {
    // The standard one-hour token outlives the 61s clock jump below; a longer
    // issued lifetime would no longer verify at /mint.
    const token = await mintToken("user-expiry");
    const { verifier, challenge } = await makeVerifierPair();
    const code = await mintCode(token, challenge);
    const realNow = Date.now();
    try {
      setSystemTime(new Date(realNow + 61_000));
      const res = await exchange(code, verifier);
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
        origin: "https://cloud.eliza.app",
        body: { code },
      });
      expect(res.status).toBe(400);
    }
  });

  test("an unknown (never-minted) code fails without an oracle", async () => {
    const res = await exchange(`esso_${"f".repeat(64)}`);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_code");
  });
});

describe("cache independence — the guarantees may not depend on atomic cache ops", () => {
  test("the full handshake (mint, exchange, replay, logout marker) survives a cache whose single-use primitives fail loudly and whose reads are blind", async () => {
    // The deployed Worker cache is Cloudflare KV: `getdel` is a non-atomic
    // read-then-delete and `set NX` a non-atomic probe, on an eventually
    // consistent store. If ANY bridge path still leaned on those primitives,
    // the throwing stubs would 503 the route; if the logout marker still
    // lived in the cache, the blind get/set stubs would make it invisible.
    const cacheRecord = cache as unknown as Record<string, unknown>;
    const sabotage = {
      getAndDelete: () => {
        throw new Error("SSO bridge must not use cache.getAndDelete");
      },
      setIfNotExists: () => {
        throw new Error("SSO bridge must not use cache.setIfNotExists");
      },
      get: async () => null,
      getWithOutcome: async () => ({ kind: "miss", backend: "memory" }),
      set: async () => undefined,
      setWithOutcome: async () => ({ kind: "written", backend: "memory" }),
    };
    const saved = new Map<string, unknown>();
    for (const [name, fn] of Object.entries(sabotage)) {
      saved.set(name, cacheRecord[name]);
      cacheRecord[name] = fn;
    }
    try {
      const userId = "user-cacheless";
      const preLogout = await mintToken(userId, { iatOffsetSec: -10 });
      const { verifier, challenge } = await makeVerifierPair();
      const pendingCode = await mintCode(preLogout, challenge);

      await markSsoBridgeLogout(userId);
      const blocked = await exchange(pendingCode, verifier);
      expect(blocked.status).toBe(401);
      expect(((await blocked.json()) as { code: string }).code).toBe(
        "session_ended",
      );

      const postLogout = await mintToken(userId, { iatOffsetSec: 5 });
      const pair2 = await makeVerifierPair();
      const code2 = await mintCode(postLogout, pair2.challenge);
      const ok = await exchange(code2, pair2.verifier);
      await expectUsableToken(ok, userId);

      const replay = await exchange(code2, pair2.verifier);
      expect(replay.status).toBe(401);
    } finally {
      for (const [name, fn] of saved) {
        cacheRecord[name] = fn;
      }
    }
  });
});

describe("logout stays logged out (cross-host)", () => {
  test("after an explicit logout, pre-logout tokens can neither mint nor exchange; a fresh login bridges again", async () => {
    const userId = "user-logout";
    const preLogoutToken = await mintToken(userId, { iatOffsetSec: -10 });
    const { verifier, challenge } = await makeVerifierPair();
    const pendingCode = await mintCode(preLogoutToken, challenge);

    // The logout route stamps this marker (see auth/logout/route.ts).
    await markSsoBridgeLogout(userId);

    // Mint refuses: bridging now would silently undo the logout.
    const mintRes = await call("/mint", {
      origin: "https://eliza.app",
      bearer: preLogoutToken,
      body: { codeChallenge: challenge },
    });
    expect(mintRes.status).toBe(401);
    expect(((await mintRes.json()) as { code: string }).code).toBe(
      "session_ended",
    );

    // A code minted BEFORE the logout dies with it, even inside its TTL and
    // even with the correct verifier.
    const exchangeRes = await exchange(pendingCode, verifier);
    expect(exchangeRes.status).toBe(401);
    expect(((await exchangeRes.json()) as { code: string }).code).toBe(
      "session_ended",
    );

    // A NEW login (token issued after the marker) is a fresh consent: the
    // bridge works again without waiting for the marker to age out.
    const postLogoutToken = await mintToken(userId, { iatOffsetSec: 5 });
    const pair2 = await makeVerifierPair();
    const newCode = await mintCode(postLogoutToken, pair2.challenge);
    const fresh = await exchange(newCode, pair2.verifier);
    await expectUsableToken(fresh, userId);
  });
});

describe("session validity is re-checked at exchange time", () => {
  test("a token that expired inside the code window is not handed out", async () => {
    const token = await mintToken("user-shortlived", { expOffsetSec: 20 });
    const { verifier, challenge } = await makeVerifierPair();
    const code = await mintCode(token, challenge);
    const realNow = Date.now();
    try {
      // 30s later the CODE is still live (60s TTL) but the token is dead.
      setSystemTime(new Date(realNow + 30_000));
      const res = await exchange(code, verifier);
      expect(res.status).toBe(401);
    } finally {
      setSystemTime();
    }
  });
});
