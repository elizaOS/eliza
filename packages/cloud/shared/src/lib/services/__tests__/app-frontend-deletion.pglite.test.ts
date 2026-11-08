/** Local controlled SQL/R2 proof; no provider requests or production writes. */
import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { eq } from "drizzle-orm";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
process.env.MOCK_REDIS = "1";
process.env.ELIZA_FRONTEND_HOST_SUFFIX = "frontend.example";

const { dbWrite, closeDatabaseConnectionsForTests, getPgliteClientForTests } = await import(
  "../../../db/client"
);
const appSchema = await import("../../../db/schemas/apps");
const { apps } = appSchema;
const domainSchema = await import("../../../db/schemas/managed-domains");
const { apiKeys } = await import("../../../db/schemas/api-keys");
const { mobileAppAuthGrants } = await import("../../../db/schemas/mobile-app-auth-grants");
const { appFrontendDeployments } = await import("../../../db/schemas/app-frontend-deployments");
const { appsRepository } = await import("../../../db/repositories/apps");
const { appsService } = await import("../apps");
const { userDatabaseService } = await import("../user-database");
const { appFrontendHostingService: hosting } = await import("../app-frontend-hosting");
const { setRuntimeR2Bucket } = await import("../../storage/r2-runtime-binding");
const { default: serve } = await import(
  "../../../../../api/v1/hosted-frontend/serve/[[...path]]/route"
);
const objects = new Map<string, Uint8Array>();
const spies: Array<{ mockRestore(): void }> = [];
let beforeObjectDelete: (() => Promise<void>) | undefined;
let identity: { id: string; organization_id: string; slug: string };

beforeAll(async () => {
  for (const statement of await generateMigration(
    generateDrizzleJson({}),
    generateDrizzleJson({
      ...appSchema,
      ...domainSchema,
      apiKeys,
      mobileAppAuthGrants,
      appFrontendDeployments,
    }),
  )) {
    if (statement.startsWith("ALTER TABLE") && statement.includes("FOREIGN KEY")) continue;
    await dbWrite.execute(statement);
  }
  await getPgliteClientForTests().exec(
    "ALTER TABLE app_frontend_deployments ADD CONSTRAINT frontend_test_app_fk FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE",
  );
}, 120_000);
beforeEach(async () => {
  await dbWrite.delete(appFrontendDeployments);
  await dbWrite.delete(apps);
  objects.clear();
  beforeObjectDelete = undefined;
  identity = { id: randomUUID(), organization_id: randomUUID(), slug: `site-${randomUUID()}` };
  await dbWrite.insert(apps).values({
    ...identity,
    name: "Deletion fixture",
    app_url: "https://original.example",
    is_active: true,
    is_approved: true,
  });
  setRuntimeR2Bucket({
    put: async (key, body) => {
      const bytes = new Uint8Array(await new Response(body as BodyInit).arrayBuffer());
      objects.set(key, bytes);
      return { etag: key, size: bytes.byteLength };
    },
    get: async (key) => {
      const bytes = objects.get(key);
      return bytes
        ? {
            text: async () => new TextDecoder().decode(bytes),
            arrayBuffer: async () => Uint8Array.from(bytes).buffer,
          }
        : null;
    },
    delete: async (key) => {
      await beforeObjectDelete?.();
      objects.delete(key);
    },
  });
  spies.push(spyOn(userDatabaseService, "cleanupDatabase").mockResolvedValue(undefined));
  await hosting.deployBundle({
    app: identity,
    files: [
      { path: "index.html", content: "<html>home</html>" },
      { path: "asset.txt", content: "retained active content" },
    ],
  });
});
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});
afterAll(async () => {
  setRuntimeR2Bucket(null);
  await closeDatabaseConnectionsForTests();
});

async function readAsset() {
  return serve.request(
    `https://${identity.slug}.frontend.example/api/v1/hosted-frontend/serve/asset.txt`,
  );
}

test("failed app deletion must preserve frontend content when the retained app is reactivated", async () => {
  expect((await readAsset()).status).toBe(200);
  await getPgliteClientForTests().exec(`CREATE FUNCTION reject_fixture_app_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'controlled rejected final deletion'; END $$;
    CREATE TRIGGER reject_fixture_app_delete BEFORE DELETE ON apps FOR EACH ROW EXECUTE FUNCTION reject_fixture_app_delete();`);
  try {
    await expect(appsService.delete(identity.id)).rejects.toMatchObject({
      cause: { code: "P0001" },
    });
  } finally {
    await getPgliteClientForTests().exec(
      "DROP TRIGGER reject_fixture_app_delete ON apps; DROP FUNCTION reject_fixture_app_delete();",
    );
  }
  expect((await appsRepository.findById(identity.id))?.is_active).toBe(false);
  expect((await readAsset()).status).toBe(404);
  // Ordinary same-owner update is intentionally supported by the API's UpdateAppSchema.
  await appsService.update(identity.id, { is_active: true });
  expect((await appsRepository.findById(identity.id))?.is_active).toBe(true);
  expect(
    (
      await dbWrite
        .select()
        .from(appFrontendDeployments)
        .where(eq(appFrontendDeployments.app_id, identity.id))
    )[0]?.status,
  ).toBe("active");
  expect((await readAsset()).status).toBe(200);
});

test("a concurrent reactivation must not lose content before final deletion rejects the active app", async () => {
  expect((await readAsset()).status).toBe(200);
  spies.push(
    spyOn(userDatabaseService, "cleanupDatabase").mockImplementation(async () => {
      // The external teardown await is a real gap after prepareDelete committed.
      await appsService.update(identity.id, { is_active: true });
    }),
  );
  await expect(appsService.delete(identity.id)).rejects.toMatchObject({
    code: "APP_DELETE_MOBILE_AUTH_REVOCATION_INCOMPLETE",
  });
  expect((await appsRepository.findById(identity.id))?.is_active).toBe(true);
  expect((await readAsset()).status).toBe(200);
});

test("acknowledged app deletion removes frontend rows before their exact objects", async () => {
  beforeObjectDelete = async () => {
    expect(await appsRepository.findById(identity.id)).toBeUndefined();
    expect(await dbWrite.select().from(appFrontendDeployments)).toHaveLength(0);
  };
  await appsService.delete(identity.id);
  expect(objects.size).toBe(0);
  expect((await readAsset()).status).toBe(404);
});

test("a lost committed app deletion reply retains objects without fabricating cleanup authority", async () => {
  const original = appsRepository.finalizeDelete.bind(appsRepository);
  spies.push(
    spyOn(appsRepository, "finalizeDelete").mockImplementation(async (id) => {
      await original(id);
      throw new Error("controlled lost deletion acknowledgement");
    }),
  );
  await expect(appsService.delete(identity.id)).rejects.toThrow(
    "controlled lost deletion acknowledgement",
  );
  expect(await appsRepository.findById(identity.id)).toBeUndefined();
  expect(await dbWrite.select().from(appFrontendDeployments)).toHaveLength(0);
  expect(objects.size).toBe(2);
});

test("app deletion retains every manifest beyond the former thousand-row listing limit", async () => {
  const hash = "c".repeat(64);
  await dbWrite.insert(appFrontendDeployments).values(
    Array.from({ length: 1_001 }, (_, index) => {
      const prefix = `fixture/${index}/`;
      objects.set(`${prefix}${hash}`, new TextEncoder().encode("retained"));
      return {
        app_id: identity.id,
        version: index + 2,
        status: "ready" as const,
        r2_prefix: prefix,
        manifest: {
          entrypoint: "index.html",
          spaFallback: false,
          files: [{ path: "index.html", hash, contentType: "text/html", size: 8 }],
        },
      };
    }),
  );
  expect(objects.size).toBe(1_003);
  await appsService.delete(identity.id);
  expect(objects.size).toBe(0);
  expect(await dbWrite.select().from(appFrontendDeployments)).toHaveLength(0);
});

test("the final app deletion snapshot includes frontends published after deactivation", async () => {
  spies.push(
    spyOn(userDatabaseService, "cleanupDatabase").mockImplementation(async () => {
      await hosting.deployBundle({
        app: identity,
        files: [{ path: "index.html", content: "later publication" }],
        activate: false,
      });
    }),
  );
  await appsService.delete(identity.id);
  expect(objects.size).toBe(0);
  expect(await appsRepository.findById(identity.id)).toBeUndefined();
});
