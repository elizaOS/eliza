/**
 * An API key acts as the user it belongs to. A member may not revoke, disable
 * or regenerate another user's key: regenerating returned a working plaintext
 * key for that user, so a member could act as the organization owner.
 */
import { afterAll, beforeEach, expect, mock, spyOn, test } from "bun:test";

const ORG = "11111111-1111-4111-8111-111111111111";
const OWNER = "22222222-2222-4222-8222-222222222222";
const MEMBER = "33333333-3333-4333-8333-333333333333";
const OWNER_KEY = "44444444-4444-4444-8444-444444444444";

let caller = { id: MEMBER, organization_id: ORG, role: "member" };
const realAuth = { ...(await import("@elizaos/cloud-shared/auth")) };
mock.module("@elizaos/cloud-shared/auth", () => ({
  ...realAuth,
  requireUserWithOrg: async () => caller,
}));
const realMembership = {
  ...(await import("@/api-app/middleware/org-membership")),
};
mock.module("@/api-app/middleware/org-membership", () => ({
  ...realMembership,
  assertOrgMembership: async () => undefined,
}));

const { apiKeysService } = await import(
  "@elizaos/cloud-shared/lib/services/api-keys"
);
const { Hono } = await import("hono");
const { default: keyRoute } = await import("../[id]/route");
const { default: regenerateRoute } = await import("../[id]/regenerate/route");

const app = new Hono()
  .route("/api/v1/api-keys/:id/regenerate", regenerateRoute)
  .route("/api/v1/api-keys/:id", keyRoute);
const env = { RATE_LIMIT_DISABLED: "true", NODE_ENV: "test" };

const ownerKey = {
  id: OWNER_KEY,
  organization_id: ORG,
  user_id: OWNER,
  name: "owner integration",
  is_active: true,
};
const spies = [
  spyOn(apiKeysService, "getManageableById").mockResolvedValue(
    ownerKey as never,
  ),
  spyOn(apiKeysService, "regenerate").mockResolvedValue({
    apiKey: { ...ownerKey, id: "55555555-5555-4555-8555-555555555555" },
    plainKey: "eliza_new_plaintext",
  } as never),
  spyOn(apiKeysService, "delete").mockResolvedValue(undefined as never),
];
const [, regenerate, revoke] = spies;

beforeEach(() => {
  regenerate.mockClear();
  revoke.mockClear();
});
afterAll(() => {
  for (const spy of spies) spy.mockRestore();
  mock.restore();
});

test("a member cannot regenerate, revoke or disable the owner's key", async () => {
  caller = { id: MEMBER, organization_id: ORG, role: "member" };

  const regen = await app.request(
    `/api/v1/api-keys/${OWNER_KEY}/regenerate`,
    { method: "POST" },
    env,
  );
  expect(regen.status).toBe(403);
  expect(await regen.text()).not.toContain("eliza_new_plaintext");
  expect(regenerate).not.toHaveBeenCalled();

  const del = await app.request(
    `/api/v1/api-keys/${OWNER_KEY}`,
    { method: "DELETE" },
    env,
  );
  expect(del.status).toBe(403);
  expect(revoke).not.toHaveBeenCalled();

  const patch = await app.request(
    `/api/v1/api-keys/${OWNER_KEY}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ is_active: false }),
    },
    env,
  );
  expect(patch.status).toBe(403);
});

test("an admin may revoke another user's key but not take its plaintext", async () => {
  caller = { id: MEMBER, organization_id: ORG, role: "admin" };

  const regen = await app.request(
    `/api/v1/api-keys/${OWNER_KEY}/regenerate`,
    { method: "POST" },
    env,
  );
  expect(regen.status).toBe(403);
  expect(regenerate).not.toHaveBeenCalled();

  const del = await app.request(
    `/api/v1/api-keys/${OWNER_KEY}`,
    { method: "DELETE" },
    env,
  );
  expect(del.status).toBe(200);
  expect(revoke).toHaveBeenCalledTimes(1);
});

test("the key's own user can regenerate it", async () => {
  caller = { id: OWNER, organization_id: ORG, role: "owner" };
  const regen = await app.request(
    `/api/v1/api-keys/${OWNER_KEY}/regenerate`,
    { method: "POST" },
    env,
  );
  expect(regen.status).toBe(200);
  expect(regenerate).toHaveBeenCalledTimes(1);
});
