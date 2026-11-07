/**
 * An app's API key acts as the app's creator. Regenerating it returns the new
 * plaintext, so a member who is not the creator must not regenerate it: the
 * key would act as the creator (often the owner) and survive the member's
 * removal, because it is not tied to the member.
 */
import { afterAll, beforeEach, expect, mock, spyOn, test } from "bun:test";

const ORG = "11111111-1111-4111-8111-111111111111";
const OWNER = "22222222-2222-4222-8222-222222222222";
const MEMBER = "33333333-3333-4333-8333-333333333333";
const APP = "66666666-6666-4666-8666-666666666666";

let caller = { id: MEMBER, organization_id: ORG, role: "member" };
const realAuth = { ...(await import("@elizaos/cloud-shared/lib/auth")) };
mock.module("@elizaos/cloud-shared/lib/auth", () => ({
  ...realAuth,
  requireAuthOrApiKeyWithOrg: async () => ({ user: caller, apiKey: undefined }),
}));

const { appsService } = await import("@elizaos/cloud-shared/lib/services/apps");
const { Hono } = await import("hono");
const { default: regenerateRoute } = await import("./route");

const app = new Hono().route(
  "/api/v1/apps/:id/regenerate-api-key",
  regenerateRoute,
);
const env = { RATE_LIMIT_DISABLED: "true", NODE_ENV: "test" };

const spies = [
  spyOn(appsService, "getById").mockResolvedValue({
    id: APP,
    organization_id: ORG,
    created_by_user_id: OWNER,
  } as never),
  spyOn(appsService, "regenerateApiKey").mockResolvedValue(
    "eliza_app_plaintext",
  ),
];
const [, regenerate] = spies;

beforeEach(() => regenerate.mockClear());
afterAll(() => {
  for (const spy of spies) spy.mockRestore();
  mock.restore();
});

async function regen() {
  return app.request(
    `/api/v1/apps/${APP}/regenerate-api-key`,
    { method: "POST" },
    env,
  );
}

test.each(["member", "admin"])(
  "an organization %s who did not create the app cannot take its key",
  async (role) => {
    caller = { id: MEMBER, organization_id: ORG, role };
    const response = await regen();
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("eliza_app_plaintext");
    expect(regenerate).not.toHaveBeenCalled();
  },
);

test("the app's creator can regenerate its key", async () => {
  caller = { id: OWNER, organization_id: ORG, role: "owner" };
  const response = await regen();
  expect(response.status).toBe(200);
  expect(regenerate).toHaveBeenCalledTimes(1);
});
