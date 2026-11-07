/**
 * The cookie session cache (`session:user:<token hash>`, 5 min) must not keep
 * serving a user after a member removal, role change or deactivation.
 * `usersService.invalidateCache` cannot address the token-hash key, so a hit
 * is confirmed against the Steward-id lookup that it does evict.
 */
import { afterEach, beforeAll, expect, spyOn, test } from "bun:test";

process.env.MOCK_REDIS = "1";

const { cache } = await import("../cache/client");
const { CacheKeys, CacheTTL } = await import("../cache/keys");
const { getCurrentUserFromRequest } = await import("../auth");
const { usersService } = await import("../services/users");
const { hashSessionToken } = await import("./session-user-cache");
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

const spies: ReturnType<typeof spyOn>[] = [];
beforeAll(async () => {
  await cache.set(CacheKeys.session.user(hashSessionToken(TOKEN)), member, CacheTTL.session.user);
});
afterEach(async () => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  await cache.set(CacheKeys.session.user(hashSessionToken(TOKEN)), member, CacheTTL.session.user);
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
