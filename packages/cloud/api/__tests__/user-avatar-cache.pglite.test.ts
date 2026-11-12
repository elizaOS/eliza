/**
 * POST /api/v1/user/avatar must evict the cached user so GET /api/v1/user
 * serves the uploaded avatar, and replacing or clearing an avatar must delete
 * the old object and release its bytes. Real primary SQL (PGlite, schema
 * pushed from the drizzle definitions), real usersService cache (MOCK_REDIS
 * in-memory store), real Hono routes. Authentication, quota accounting and R2
 * are stubbed.
 */
import { afterAll, beforeAll, expect, mock, spyOn, test } from "bun:test";
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

// In-memory BLOB bucket and quota ledger the stubs below write through.
const objects = new Map<string, number>();
const deletedKeys: string[] = [];
const releases: bigint[] = [];
const blob = {
  async head(key: string) {
    const size = objects.get(key);
    return size === undefined ? null : { size, etag: key };
  },
  async delete(key: string) {
    deletedKeys.push(key);
    objects.delete(key);
  },
};

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
    releaseBytes: async (_org: string, bytes: bigint) => {
      releases.push(bytes);
    },
  },
}));
mock.module("@elizaos/cloud-shared/lib/storage/r2-public-object", () => ({
  ...realR2,
  putPublicObject: async (
    _env: unknown,
    options: { key: string; body: ArrayBuffer },
  ) => {
    objects.set(options.key, options.body.byteLength);
    return { key: options.key, url: `${R2_HOST}/${options.key}` };
  },
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
const { runWithCloudBindingsAsync } = await import(
  "@elizaos/cloud-shared/lib/runtime/cloud-bindings"
);
const { logger } = await import("@elizaos/cloud-shared/lib/utils/logger");
const { default: userRoute } = await import("../v1/user/route");
const { default: avatarRoute } = await import("../v1/user/avatar/route");

const app = new Hono();
app.route("/api/v1/user/avatar", avatarRoute);
app.route("/api/v1/user", userRoute);
const workerEnv = {
  NODE_ENV: "test",
  RATE_LIMIT_DISABLED: "true",
  R2_PUBLIC_HOST: new URL(R2_HOST).host,
  BLOB: blob,
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

async function uploadAvatar(): Promise<string> {
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
  return ((await res.json()) as { avatarUrl: string }).avatarUrl;
}

function keyOf(url: string): string {
  return new URL(url).pathname.slice(1);
}

test("replacing an avatar deletes the previous object and releases its bytes once", async () => {
  expect(schemaFailure).toBe("");
  const first = await uploadAvatar();
  deletedKeys.length = 0;
  releases.length = 0;

  const second = await uploadAvatar();
  expect(second).not.toBe(first);
  expect(deletedKeys).toEqual([keyOf(first)]);
  expect(releases).toEqual([BigInt(PNG_BYTES.byteLength)]);
  expect(objects.has(keyOf(first))).toBe(false);
  expect(objects.has(keyOf(second))).toBe(true);

  // Pointing the avatar back at the removed object and replacing it again
  // finds nothing left to release.
  const patch = await app.request(
    "/api/v1/user",
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ avatar: first }),
    },
    workerEnv,
  );
  expect(patch.status).toBe(200);
  expect(deletedKeys).toEqual([keyOf(first), keyOf(second)]);
  expect(releases).toHaveLength(2);
  await uploadAvatar();
  expect(deletedKeys).toEqual([keyOf(first), keyOf(second)]);
  expect(releases).toHaveLength(2);
});

test("clearing the avatar deletes the uploaded object; external URLs are left alone", async () => {
  expect(schemaFailure).toBe("");
  const uploaded = await uploadAvatar();
  deletedKeys.length = 0;
  releases.length = 0;

  const clear = await app.request(
    "/api/v1/user",
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ avatar: "" }),
    },
    workerEnv,
  );
  expect(clear.status).toBe(200);
  expect(deletedKeys).toEqual([keyOf(uploaded)]);
  expect(releases).toEqual([BigInt(PNG_BYTES.byteLength)]);
  expect(await getCurrentAvatar()).toBeNull();

  const external = await app.request(
    "/api/v1/user",
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ avatar: OLD_AVATAR }),
    },
    workerEnv,
  );
  expect(external.status).toBe(200);
  await uploadAvatar();
  expect(deletedKeys).toEqual([keyOf(uploaded)]);
  expect(releases).toHaveLength(1);
});

for (const host of ["", "r2.example.test:99999"]) {
  for (const background of [false, true]) {
    test(`avatar replacement preserves committed state when cleanup config is ${host || "missing"} (${background ? "waitUntil" : "inline"})`, async () => {
      expect(schemaFailure).toBe("");
      const previous = await uploadAvatar();
      expect(await getCurrentAvatar()).toBe(previous);
      deletedKeys.length = 0;
      releases.length = 0;
      const warning = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        const requestApp = new Hono();
        requestApp.use("*", (c, next) =>
          runWithCloudBindingsAsync(c.env, next),
        );
        requestApp.route("/api/v1/user", userRoute);
        const target = background ? OLD_AVATAR : "";
        const settled: Promise<{ fulfilled: boolean }>[] = [];
        const executionCtx = {
          waitUntil(promise: Promise<unknown>) {
            settled.push(
              promise.then(
                () => ({ fulfilled: true }),
                () => ({ fulfilled: false }),
              ),
            );
          },
          passThroughOnException() {},
          props: {},
        };
        const response = await requestApp.request(
          "/api/v1/user",
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ avatar: target }),
          },
          {
            ...workerEnv,
            CLOUD_DEPLOYMENT_ID: "example-product",
            R2_PUBLIC_HOST: host,
          },
          background ? executionCtx : undefined,
        );
        expect(response.status).toBe(200);
        expect(await Promise.all(settled)).toEqual(
          background ? [{ fulfilled: true }] : [],
        );
        const [row] = await dbWrite
          .select({ avatar: users.avatar })
          .from(users);
        expect(row?.avatar).toBe(target || null);
        expect(await getCurrentAvatar()).toBe(target || null);
        expect(objects.has(keyOf(previous))).toBe(true);
        expect(deletedKeys).toEqual([]);
        expect(releases).toEqual([]);
        expect(warning).toHaveBeenCalledWith(
          "[User Avatar] Failed to remove replaced avatar",
          {
            organizationId: expect.any(String),
            userId: expect.any(String),
            errorType: "CloudDeploymentConfigError",
          },
        );
      } finally {
        warning.mockRestore();
      }
    });
  }
}
