/**
 * POST /api/v1/user/avatar must evict the cached user so GET /api/v1/user
 * serves the uploaded avatar. Real primary SQL (PGlite, schema pushed from the
 * drizzle definitions), real usersService cache (MOCK_REDIS in-memory store),
 * real Hono routes. Authentication, quota accounting and R2 are stubbed.
 */
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { pushSchema } from "drizzle-kit/api";

const PGLITE_DATABASE_URL = "pglite://memory";
const ORIGINAL_ENV = {
  DATABASE_URL: process.env.DATABASE_URL,
  TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
  NODE_ENV: process.env.NODE_ENV,
  MOCK_REDIS: process.env.MOCK_REDIS,
  SKIP_AGENT_SANDBOX_ENSURE: process.env.SKIP_AGENT_SANDBOX_ENSURE,
};
process.env.DATABASE_URL = PGLITE_DATABASE_URL;
process.env.TEST_DATABASE_URL = PGLITE_DATABASE_URL;
process.env.NODE_ENV = "test";
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const OLD_AVATAR = "https://cdn.example.test/avatars/old.png";
const R2_HOST = "https://r2.example.test";

const realAuth = { ...(await import("@elizaos/cloud-shared/auth")) };
const realQuota = {
  ...(await import("@elizaos/cloud-shared/db/repositories/org-storage-quota")),
};
const realR2 = {
  ...(await import("@elizaos/cloud-shared/lib/storage/r2-public-object")),
};

const authedUser = {
  id: USER,
  organization_id: ORG,
  organization: { id: ORG, name: "Avatar org", is_active: true },
  is_active: true,
};
mock.module("@elizaos/cloud-shared/auth", () => ({
  ...realAuth,
  requireUserOrApiKey: async () => authedUser,
  requireUserOrApiKeyWithOrg: async () => authedUser,
}));
mock.module("@elizaos/cloud-shared/db/repositories/org-storage-quota", () => ({
  ...realQuota,
  orgStorageQuotaRepository: {
    tryReserveBytes: async (_org: string, bytes: bigint) => bytes,
    releaseBytes: async () => undefined,
  },
}));
mock.module("@elizaos/cloud-shared/lib/storage/r2-public-object", () => ({
  ...realR2,
  putPublicObject: async (_env: unknown, options: { key: string }) => ({
    key: options.key,
    url: `${R2_HOST}/${options.key}`,
  }),
}));

const { dbWrite, closeDatabaseConnectionsForTests } = await import(
  "@elizaos/cloud-shared/db/client"
);
const { organizations } = await import(
  "@elizaos/cloud-shared/db/schemas/organizations"
);
const { users } = await import("@elizaos/cloud-shared/db/schemas/users");
const { usersService } = await import(
  "@elizaos/cloud-shared/lib/services/users"
);
const { Hono } = await import("hono");
const { default: userRoute } = await import("../v1/user/route");
const { default: avatarRoute } = await import("../v1/user/avatar/route");

const app = new Hono();
app.route("/api/v1/user/avatar", avatarRoute);
app.route("/api/v1/user", userRoute);
const workerEnv = {
  NODE_ENV: "test",
  RATE_LIMIT_DISABLED: "true",
  R2_PUBLIC_HOST: R2_HOST,
};

// 1x1 transparent PNG.
const PNG_BYTES = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  ),
  (ch) => ch.charCodeAt(0),
);

let schemaFailure = "";
beforeAll(async () => {
  try {
    const { apply } = await pushSchema(
      { organizations, users } as never,
      dbWrite as never,
    );
    await apply();
    await dbWrite
      .insert(organizations)
      .values({ id: ORG, name: "Avatar org", slug: "avatar-org" });
    await dbWrite.insert(users).values({
      id: USER,
      organization_id: ORG,
      steward_user_id: "avatar-steward-user",
      email: "avatar-user@example.test",
      avatar: OLD_AVATAR,
    });
  } catch (error) {
    schemaFailure = error instanceof Error ? error.message : String(error);
  }
}, 120_000);

afterAll(async () => {
  await closeDatabaseConnectionsForTests?.();
  mock.restore();
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function getCurrentAvatar(): Promise<string | null> {
  const res = await app.request("/api/v1/user", {}, workerEnv);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { avatar: string | null };
  return body.avatar;
}

test("avatar upload is visible to the cached GET /api/v1/user reader", async () => {
  expect(schemaFailure).toBe("");

  // Warm user:with-org:<id> through the real GET route.
  expect(await getCurrentAvatar()).toBe(OLD_AVATAR);
  // Warm user:id:<id>, read by the app-auth session route.
  expect((await usersService.getById(USER))?.avatar).toBe(OLD_AVATAR);

  const form = new FormData();
  form.append(
    "file",
    new File([PNG_BYTES], "avatar.png", { type: "image/png" }),
  );
  const res = await app.request(
    "/api/v1/user/avatar",
    { method: "POST", body: form },
    workerEnv,
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { success: boolean; avatarUrl: string };
  expect(body.success).toBe(true);
  expect(
    body.avatarUrl.startsWith(`${R2_HOST}/avatars/users/${ORG}/${USER}/`),
  ).toBe(true);

  const [row] = await dbWrite.select({ avatar: users.avatar }).from(users);
  expect(row?.avatar).toBe(body.avatarUrl);

  expect(await getCurrentAvatar()).toBe(body.avatarUrl);
  expect((await usersService.getWithOrganization(USER))?.avatar).toBe(
    body.avatarUrl,
  );
  expect((await usersService.getById(USER))?.avatar).toBe(body.avatarUrl);
});
