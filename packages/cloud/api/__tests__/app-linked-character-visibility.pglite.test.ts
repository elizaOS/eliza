/**
 * A character linked to an app while it was public is no longer listed by
 * GET /api/v1/apps/:id/characters once its owner (another organization)
 * makes it private, even while a character cache still holds the public
 * record. Real route, PGlite database, caller authenticated as the app's
 * organization.
 */
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { pushSchema } from "drizzle-kit/api";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const USER_A = "22222222-2222-4222-8222-222222222222";
const ORG_B = "33333333-3333-4333-8333-333333333333";
const USER_B = "44444444-4444-4444-8444-444444444444";
const CHAR = "55555555-5555-4555-8555-555555555555";
const APP = "66666666-6666-4666-8666-666666666666";

const realAuth = { ...(await import("@elizaos/cloud-shared/lib/auth")) };
const userB = {
  id: USER_B,
  organization_id: ORG_B,
  organization: { id: ORG_B, name: "Org B", is_active: true },
  is_active: true,
  role: "owner",
};
mock.module("@elizaos/cloud-shared/lib/auth", () => ({
  ...realAuth,
  requireAuthOrApiKeyWithOrg: async () => ({ user: userB, apiKey: undefined }),
}));

const { dbWrite, closeDatabaseConnectionsForTests } = await import(
  "@elizaos/cloud-shared/db/client"
);
const { organizations } = await import(
  "@elizaos/cloud-shared/db/schemas/organizations"
);
const { users } = await import("@elizaos/cloud-shared/db/schemas/users");
const { userCharacters } = await import(
  "@elizaos/cloud-shared/db/schemas/user-characters"
);
const { apps, appDeploymentStatusEnum, appReviewStatusEnum } = await import(
  "@elizaos/cloud-shared/db/schemas/apps"
);
const { charactersService } = await import(
  "@elizaos/cloud-shared/lib/services/characters"
);
const { eq } = await import("drizzle-orm");
const { Hono } = await import("hono");
const { default: appCharactersRoute } = await import(
  "../v1/apps/[id]/characters/route.ts"
);

const app = new Hono();
app.route("/api/v1/apps/:id/characters", appCharactersRoute);
const workerEnv = { NODE_ENV: "test", RATE_LIMIT_DISABLED: "true" };

beforeAll(async () => {
  const { apply } = await pushSchema(
    {
      appDeploymentStatusEnum,
      appReviewStatusEnum,
      organizations,
      users,
      userCharacters,
      apps,
    } as never,
    dbWrite as never,
  );
  await apply();
  await dbWrite.insert(organizations).values([
    { id: ORG_A, name: "Org A", slug: "org-a" },
    { id: ORG_B, name: "Org B", slug: "org-b" },
  ]);
  await dbWrite.insert(users).values([
    {
      id: USER_A,
      organization_id: ORG_A,
      steward_user_id: "steward-a",
      email: "a@example.test",
    },
    {
      id: USER_B,
      organization_id: ORG_B,
      steward_user_id: "steward-b",
      email: "b@example.test",
    },
  ]);
  await dbWrite.insert(userCharacters).values({
    id: CHAR,
    organization_id: ORG_A,
    user_id: USER_A,
    name: "Org A private persona",
    username: "org-a-persona",
    bio: ["internal persona of org A"],
    settings: { avatar: "https://cdn.example.test/org-a-avatar.png" },
    character_data: { name: "Org A private persona" },
    is_public: true,
  });
  await dbWrite.insert(apps).values({
    id: APP,
    name: "Org B app",
    slug: "org-b-app",
    organization_id: ORG_B,
    created_by_user_id: USER_B,
    app_url: "https://app-b.example.test",
  });
}, 120_000);

afterAll(async () => {
  await closeDatabaseConnectionsForTests?.();
  mock.restore();
});

test("a linked character leaves the app list when its owner makes it private", async () => {
  // 1. While public, the link is legitimately accepted.
  const link = await app.request(
    `/api/v1/apps/${APP}/characters`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ character_ids: [CHAR] }),
    },
    workerEnv,
  );
  expect(link.status).toBe(200);

  // 2. Owner A withdraws the character from the public catalog. This
  // isolate's character cache still holds the public record, as the cache of
  // any isolate that did not serve A's edit does.
  expect((await charactersService.getById(CHAR))?.is_public).toBe(true);
  await dbWrite
    .update(userCharacters)
    .set({ is_public: false })
    .where(eq(userCharacters.id, CHAR));
  expect((await charactersService.getById(CHAR))?.is_public).toBe(true);

  // B has no legitimate read path to the character any more.
  expect(
    await charactersService.getByIdForUser(CHAR, {
      id: USER_B,
      organization_id: ORG_B,
    }),
  ).toBeNull();
  const relink = await app.request(
    `/api/v1/apps/${APP}/characters`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ character_ids: [CHAR] }),
    },
    workerEnv,
  );
  expect(relink.status).toBe(403);

  // 3. The app list follows the character's current visibility.
  const read = await app.request(
    `/api/v1/apps/${APP}/characters`,
    { method: "GET" },
    workerEnv,
  );
  expect(read.status).toBe(200);
  expect((await read.json()) as unknown).toEqual({
    success: true,
    characters: [],
  });

  // 4. Public again: the link is listed again without relinking.
  await dbWrite
    .update(userCharacters)
    .set({ is_public: true })
    .where(eq(userCharacters.id, CHAR));
  const listed = (await (
    await app.request(
      `/api/v1/apps/${APP}/characters`,
      { method: "GET" },
      workerEnv,
    )
  ).json()) as { characters: Array<{ id: string; is_public: boolean }> };
  expect(listed.characters).toEqual([
    expect.objectContaining({ id: CHAR, is_public: true }),
  ]);
});

test("the app list returns the linked character's avatar", async () => {
  await dbWrite
    .update(userCharacters)
    .set({ avatar_url: "https://cdn.example.test/persona.png" })
    .where(eq(userCharacters.id, CHAR));
  const listed = (await (
    await app.request(
      `/api/v1/apps/${APP}/characters`,
      { method: "GET" },
      workerEnv,
    )
  ).json()) as { characters: Array<{ id: string; avatar_url: string | null }> };
  expect(listed.characters).toEqual([
    expect.objectContaining({
      id: CHAR,
      avatar_url: "https://cdn.example.test/persona.png",
    }),
  ]);
});
