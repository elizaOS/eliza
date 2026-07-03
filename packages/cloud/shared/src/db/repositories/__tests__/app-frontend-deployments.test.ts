/**
 * AppFrontendDeploymentsRepository + AppFrontendHostingService — real Drizzle
 * schema in-process PGlite + in-memory R2 shim.
 *
 * Harness mirrors apps.test.ts: `pushSchema` (drizzle-kit/api) generates DDL
 * from the real schema objects and applies it to the same `dbWrite` PGlite
 * connection, so every assertion exercises the real SQL — including the
 * partial-unique "one active deployment per app" index and the (app_id,
 * version) uniqueness. `deployBundle` writes artifacts to the R2 shim.
 *
 * Run:
 *   bun test packages/cloud/shared/src/db/repositories/__tests__/app-frontend-deployments.test.ts
 *
 * Self-skips LOUDLY if PGlite/pushSchema can't apply here (never silently passes).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { pushSchema } from "drizzle-kit/api";
import { and, eq } from "drizzle-orm";
import { type RuntimeR2Bucket, setRuntimeR2Bucket } from "../../../lib/storage/r2-runtime-binding";
import { closeDatabaseConnectionsForTests, dbWrite } from "../../client";
import { appFrontendDeployments } from "../../schemas/app-frontend-deployments";
import {
  appDeploymentStatusEnum,
  appReviewStatusEnum,
  apps,
  userDatabaseStatusEnum,
} from "../../schemas/apps";
import { organizations } from "../../schemas/organizations";
import { users } from "../../schemas/users";
import { appFrontendDeploymentsRepository } from "../app-frontend-deployments";

const PGLITE_TIMEOUT = 60_000;
let pgliteReady = true;
let service: typeof import("../../../lib/services/app-frontend-hosting").appFrontendHostingService;

let seq = 0;
function uniq(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

function memoryBucket(objects: Map<string, Uint8Array>): RuntimeR2Bucket {
  return {
    async get(key) {
      const value = objects.get(key);
      if (value === undefined) return null;
      return {
        async text() {
          return new TextDecoder().decode(value);
        },
        async arrayBuffer() {
          return new Uint8Array(value).buffer;
        },
      };
    },
    async put(key, value) {
      let bytes: Uint8Array;
      if (typeof value === "string") bytes = new TextEncoder().encode(value);
      else if (value instanceof Uint8Array) bytes = value;
      else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
      else bytes = new Uint8Array(0);
      objects.set(key, bytes);
      return {};
    },
    async delete(key) {
      objects.delete(key);
      return {};
    },
  };
}

async function seedApp(): Promise<{ appId: string; organizationId: string; userId: string }> {
  const [org] = await dbWrite
    .insert(organizations)
    .values({ name: "Test Org", slug: uniq("org") })
    .returning();
  const [user] = await dbWrite
    .insert(users)
    .values({ steward_user_id: uniq("steward"), organization_id: org.id })
    .returning();
  const [app] = await dbWrite
    .insert(apps)
    .values({
      name: "Test App",
      slug: uniq("app"),
      organization_id: org.id,
      created_by_user_id: user.id,
      app_url: "https://placeholder.invalid",
    })
    .returning();
  return { appId: app.id, organizationId: org.id, userId: user.id };
}

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    pgliteReady = false;
    console.warn(
      "[app-frontend-deployments.test] DATABASE_URL is a non-PGlite Postgres; this in-process-PGlite isolation suite self-skips.",
    );
    return;
  }
  try {
    ({ appFrontendHostingService: service } = await import(
      "../../../lib/services/app-frontend-hosting"
    ));
    const schema = {
      organizations,
      users,
      apps,
      appFrontendDeployments,
      appDeploymentStatusEnum,
      appReviewStatusEnum,
      userDatabaseStatusEnum,
    };
    const { apply } = await pushSchema(schema as never, dbWrite as never);
    await apply();
  } catch (error) {
    pgliteReady = false;
    console.error(
      "[app-frontend-deployments.test] PGlite/pushSchema unavailable — cannot drive the repo against a real DB. Skipping.",
      error,
    );
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  setRuntimeR2Bucket(null);
  await closeDatabaseConnectionsForTests();
});

describe("AppFrontendDeploymentsRepository", () => {
  test("assigns monotonic versions per app", async () => {
    if (!pgliteReady) return;
    const { appId } = await seedApp();
    const d1 = await appFrontendDeploymentsRepository.create({ appId, r2Prefix: "" });
    const d2 = await appFrontendDeploymentsRepository.create({ appId, r2Prefix: "" });
    expect(d1.version).toBe(1);
    expect(d2.version).toBe(2);
    expect(await appFrontendDeploymentsRepository.getActive(appId)).toBeUndefined();
  });

  test("activate enforces a single active deployment (and enables rollback)", async () => {
    if (!pgliteReady) return;
    const { appId } = await seedApp();
    const d1 = await appFrontendDeploymentsRepository.create({ appId, r2Prefix: "p1/" });
    const d2 = await appFrontendDeploymentsRepository.create({ appId, r2Prefix: "p2/" });
    // mark ready (activate only promotes ready/superseded/active in the service,
    // but the repo activate is unconditional — drive it directly here).
    await appFrontendDeploymentsRepository.markStatus(d1.id, "ready");
    await appFrontendDeploymentsRepository.markStatus(d2.id, "ready");

    await appFrontendDeploymentsRepository.activate(appId, d1.id);
    expect((await appFrontendDeploymentsRepository.getActive(appId))?.id).toBe(d1.id);

    await appFrontendDeploymentsRepository.activate(appId, d2.id);
    const active = await appFrontendDeploymentsRepository.getActive(appId);
    expect(active?.id).toBe(d2.id);
    // d1 demoted to superseded — exactly one active.
    expect((await appFrontendDeploymentsRepository.getById(d1.id))?.status).toBe("superseded");

    // Rollback: re-activate d1.
    await appFrontendDeploymentsRepository.activate(appId, d1.id);
    expect((await appFrontendDeploymentsRepository.getActive(appId))?.id).toBe(d1.id);
    expect((await appFrontendDeploymentsRepository.getById(d2.id))?.status).toBe("superseded");
  });
});

describe("AppFrontendHostingService.deployBundle", () => {
  test("publishes a bundle to R2, finalizes a manifest, and activates it", async () => {
    if (!pgliteReady) return;
    const objects = new Map<string, Uint8Array>();
    setRuntimeR2Bucket(memoryBucket(objects));
    const { appId, organizationId } = await seedApp();

    const dep = await service.deployBundle({
      app: { id: appId, organization_id: organizationId },
      files: [
        { path: "index.html", content: "<html><head></head><body>Hi</body></html>" },
        { path: "assets/app.js", content: "console.log(1)" },
      ],
      buildMeta: { source: "agent" },
    });

    expect(dep.status).toBe("active");
    expect(dep.version).toBe(1);
    expect(dep.file_count).toBe(2);
    expect(dep.content_hash).toHaveLength(64);
    expect(dep.manifest?.files).toHaveLength(2);
    expect(dep.manifest?.entrypoint).toBe("index.html");
    // Both artifacts are stored under the deployment's prefix.
    expect(objects.size).toBe(2);
    for (const key of objects.keys()) {
      expect(key.startsWith(dep.r2_prefix)).toBe(true);
    }

    // It is the active deployment and serves the entrypoint.
    const active = await appFrontendDeploymentsRepository.getActive(appId);
    expect(active?.id).toBe(dep.id);
    const res = await service.renderFrontendResponse({
      app: { id: appId, name: "Test App", description: null, logo_url: null },
      deployment: dep,
      requestPath: "/",
    });
    expect(res.status).toBe(200);
    expect(String(res.body)).toContain("Hi");
  });

  test("rejects a bundle missing its entrypoint and marks it failed", async () => {
    if (!pgliteReady) return;
    setRuntimeR2Bucket(memoryBucket(new Map()));
    const { appId, organizationId } = await seedApp();
    await expect(
      service.deployBundle({
        app: { id: appId, organization_id: organizationId },
        files: [{ path: "only.js", content: "x" }],
      }),
    ).rejects.toThrow(/entrypoint/i);
    const all = await appFrontendDeploymentsRepository.listByApp(appId);
    expect(all[0]?.status).toBe("failed");
  });

  test("second deploy supersedes the first; rollback re-activates the first", async () => {
    if (!pgliteReady) return;
    setRuntimeR2Bucket(memoryBucket(new Map()));
    const { appId, organizationId } = await seedApp();
    const app = { id: appId, organization_id: organizationId };

    const v1 = await service.deployBundle({
      app,
      files: [{ path: "index.html", content: "<html><head></head><body>v1</body></html>" }],
    });
    const v2 = await service.deployBundle({
      app,
      files: [{ path: "index.html", content: "<html><head></head><body>v2</body></html>" }],
    });
    expect((await appFrontendDeploymentsRepository.getActive(appId))?.id).toBe(v2.id);
    expect((await appFrontendDeploymentsRepository.getById(v1.id))?.status).toBe("superseded");

    const rolled = await service.activate(appId, v1.id);
    expect(rolled?.id).toBe(v1.id);
    expect((await appFrontendDeploymentsRepository.getActive(appId))?.id).toBe(v1.id);
  });
});

describe("AppFrontendHosting — DB invariants + GC + failure cleanup (#10690 review)", () => {
  test("pglite applied (loud, never a silent no-op pass)", () => {
    expect(pgliteReady).toBe(true);
  });

  test("the partial-unique index rejects a second ACTIVE deployment for an app", async () => {
    if (!pgliteReady) return;
    const { appId } = await seedApp();
    await dbWrite
      .insert(appFrontendDeployments)
      .values({ app_id: appId, version: 1, status: "active", r2_prefix: "p1/" });
    // A second active row for the same app must violate the partial-unique index.
    // (Explicit try/catch — drizzle's insert builder is a lazy thenable that
    // expect().rejects does not reliably await.)
    let threw = false;
    try {
      await dbWrite
        .insert(appFrontendDeployments)
        .values({ app_id: appId, version: 2, status: "active", r2_prefix: "p2/" });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    // Exactly one active row remains. Query dbWrite directly (not the repo) so
    // this DB-invariant assertion is immune to a leaked cross-file repo mock.
    const activeRows = await dbWrite
      .select({ version: appFrontendDeployments.version })
      .from(appFrontendDeployments)
      .where(
        and(eq(appFrontendDeployments.app_id, appId), eq(appFrontendDeployments.status, "active")),
      );
    expect(activeRows).toHaveLength(1);
    expect(activeRows[0]?.version).toBe(1);
  });

  test("a failed deploy cleans up the partial R2 objects it wrote (no orphans)", async () => {
    if (!pgliteReady) return;
    const objects = new Map<string, Uint8Array>();
    setRuntimeR2Bucket(memoryBucket(objects));
    const { appId, organizationId } = await seedApp();
    // A bundle whose second file is over the per-file cap fails mid-upload after
    // the first file is already in R2; deployBundle must delete what it wrote.
    process.env.ELIZA_FRONTEND_MAX_FILE_BYTES = "8";
    try {
      await expect(
        service.deployBundle({
          app: { id: appId, organization_id: organizationId },
          files: [
            { path: "index.html", content: "abc" },
            { path: "big.js", content: "0123456789" },
          ],
        }),
      ).rejects.toThrow(/too large/i);
    } finally {
      delete process.env.ELIZA_FRONTEND_MAX_FILE_BYTES;
    }
    expect(objects.size).toBe(0); // the first file's object was cleaned up
  });

  test("activating prunes superseded deployments beyond keep-N + deletes their R2 bytes", async () => {
    if (!pgliteReady) return;
    const objects = new Map<string, Uint8Array>();
    setRuntimeR2Bucket(memoryBucket(objects));
    const { appId, organizationId } = await seedApp();
    const app = { id: appId, organization_id: organizationId };
    process.env.ELIZA_FRONTEND_KEEP_SUPERSEDED = "1";
    try {
      const v1 = await service.deployBundle({
        app,
        files: [{ path: "index.html", content: "<html><head></head><body>1</body></html>" }],
      });
      await service.deployBundle({
        app,
        files: [{ path: "index.html", content: "<html><head></head><body>2</body></html>" }],
      });
      await service.deployBundle({
        app,
        files: [{ path: "index.html", content: "<html><head></head><body>3</body></html>" }],
      });
      // v1 is the oldest superseded; with keep=1 it is pruned (row + R2 gone).
      expect(await appFrontendDeploymentsRepository.getById(v1.id)).toBeUndefined();
      for (const key of objects.keys()) {
        expect(key.startsWith(v1.r2_prefix)).toBe(false);
      }
    } finally {
      delete process.env.ELIZA_FRONTEND_KEEP_SUPERSEDED;
    }
  });

  test("a duplicate normalized path is rejected", async () => {
    if (!pgliteReady) return;
    setRuntimeR2Bucket(memoryBucket(new Map()));
    const { appId, organizationId } = await seedApp();
    await expect(
      service.deployBundle({
        app: { id: appId, organization_id: organizationId },
        files: [
          { path: "index.html", content: "<html></html>" },
          { path: "/index.html", content: "<html></html>" },
        ],
      }),
    ).rejects.toThrow(/duplicate/i);
  });
});
