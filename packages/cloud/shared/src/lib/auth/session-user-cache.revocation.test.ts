/**
 * The cookie session cache (`session:user:<token hash>`, 5 min) must not keep
 * serving a user after a member removal, role change or deactivation.
 * `usersService.invalidateCache` cannot address the token-hash key, so a hit
 * is confirmed against the Steward-id lookup that it does evict.
 */
import { afterEach, beforeAll, expect, spyOn, test } from "bun:test";

process.env.MOCK_REDIS = "1";
process.env.STEWARD_JWT_SECRET = "session-user-cache-test-secret-0123456789";

const { cache } = await import("../cache/client");
const { CacheKeys } = await import("../cache/keys");
const { getCurrentUserFromRequest } = await import("../auth");
const { usersService } = await import("../services/users");
const { hashSessionToken, primeVerifiedUserSessionCache } = await import("./session-user-cache");
const { stewardSessionKeyFingerprint } = await import("./steward-client");
const { LEGACY_STEWARD_COOKIES } = await import("./steward-cookies");

type SessionUser = NonNullable<Awaited<ReturnType<typeof getCurrentUserFromRequest>>>;

const TOKEN = "opaque-session-token";
const member = {
  id: "user-b",
  steward_user_id: "steward-b",
  organization_id: "org-a",
  role: "member",
  is_active: true,
  organization: { id: "org-a", is_active: true },
} as unknown as SessionUser;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function currentFingerprint(): string {
  const fingerprint = stewardSessionKeyFingerprint({
    STEWARD_JWT_SECRET: process.env.STEWARD_JWT_SECRET,
  });
  if (!fingerprint) throw new Error("test signing key missing");
  return fingerprint;
}

async function primeMember(): Promise<void> {
  await primeVerifiedUserSessionCache(TOKEN, member, {
    expiration: nowSeconds() + 3600,
    signingKeyFingerprint: currentFingerprint(),
  });
}

const spies: ReturnType<typeof spyOn>[] = [];
beforeAll(primeMember);
afterEach(async () => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  await primeMember();
});

function lookupReturns(user: SessionUser | undefined): void {
  spies.push(spyOn(usersService, "getByStewardId").mockResolvedValue(user));
}

function cookieRequest(): Request {
  return new Request("https://cloud.test/api/compat/agents", {
    headers: { cookie: `${LEGACY_STEWARD_COOKIES.token}=${TOKEN}` },
  });
}

test("an unchanged member is still served from the session cache", async () => {
  lookupReturns(member);
  const user = await getCurrentUserFromRequest(cookieRequest());
  expect(user?.organization_id).toBe("org-a");
});

test("a member moved out of the org is not served the old org", async () => {
  lookupReturns({ ...member, organization_id: "personal-b" } as SessionUser);
  const user = await getCurrentUserFromRequest(cookieRequest());
  expect(user?.organization_id).not.toBe("org-a");
});

test("a deactivated user is not served from the session cache", async () => {
  lookupReturns({ ...member, is_active: false } as SessionUser);
  const user = await getCurrentUserFromRequest(cookieRequest());
  expect(user?.is_active ?? false).toBe(false);
});

test("a cached session is not served after its token expires", async () => {
  lookupReturns(member);
  await cache.set(
    CacheKeys.session.user(hashSessionToken(TOKEN)),
    {
      ...member,
      session_binding: {
        expiration: nowSeconds() - 1,
        signingKeyFingerprint: currentFingerprint(),
      },
    },
    300,
  );
  expect(await getCurrentUserFromRequest(cookieRequest())).toBeNull();
});

test("rotating the signing key drops cached sessions", async () => {
  lookupReturns(member);
  const previous = process.env.STEWARD_JWT_SECRET;
  process.env.STEWARD_JWT_SECRET = "session-user-cache-rotated-secret-0123456789";
  try {
    expect(await getCurrentUserFromRequest(cookieRequest())).toBeNull();
  } finally {
    process.env.STEWARD_JWT_SECRET = previous;
  }
});

test("a session primed after its token expired is not cached", async () => {
  await cache.del(CacheKeys.session.user(hashSessionToken(TOKEN)));
  await primeVerifiedUserSessionCache(TOKEN, member, {
    expiration: nowSeconds() - 1,
    signingKeyFingerprint: currentFingerprint(),
  });
  expect(await cache.get(CacheKeys.session.user(hashSessionToken(TOKEN)))).toBeNull();
});
