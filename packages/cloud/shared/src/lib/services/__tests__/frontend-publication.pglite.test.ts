/** Real deployment SQL and serving with controlled object-store/SQL acknowledgements. */
import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { eq, sql } from "drizzle-orm";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";

const { dbWrite, closeDatabaseConnectionsForTests } = await import("../../../db/client");
const { appFrontendDeployments } = await import("../../../db/schemas/app-frontend-deployments");
const { appFrontendDeploymentsRepository: repository } = await import(
  "../../../db/repositories/app-frontend-deployments"
);
const { appFrontendHostingService: hosting } = await import("../app-frontend-hosting");
const { setRuntimeR2Bucket } = await import("../../storage/r2-runtime-binding");
const app = { id: randomUUID(), organization_id: randomUUID() };
const files = [
  { path: "index.html", content: "<html><body>complete published site</body></html>" },
  { path: "asset.txt", content: "complete retained asset" },
];
const objects = new Map<string, Uint8Array>();
const deleted: string[] = [];
let beforeDelete: (() => Promise<void>) | undefined;
const spies: Array<{ mockRestore(): void }> = [];

beforeAll(async () => {
  await dbWrite.execute(
    "CREATE TABLE apps(id uuid PRIMARY KEY, organization_id uuid NOT NULL, deletion_job_id uuid)",
  );
  await dbWrite.execute(
    sql`INSERT INTO apps(id, organization_id) VALUES (${app.id}, ${app.organization_id})`,
  );
  for (const statement of await generateMigration(
    generateDrizzleJson({}),
    generateDrizzleJson({ appFrontendDeployments }),
  )) {
    if (statement.startsWith("ALTER TABLE") && statement.includes("FOREIGN KEY")) continue;
    await dbWrite.execute(statement);
  }
}, 120_000);
beforeEach(async () => {
  await dbWrite.delete(appFrontendDeployments);
  objects.clear();
  deleted.length = 0;
  beforeDelete = undefined;
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
      await beforeDelete?.();
      deleted.push(key);
      objects.delete(key);
    },
  });
});
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});
afterAll(async () => {
  setRuntimeR2Bucket(null);
  await closeDatabaseConnectionsForTests();
});

async function onlyRow() {
  const rows = await dbWrite.select().from(appFrontendDeployments);
  expect(rows).toHaveLength(1);
  if (!rows[0]) throw new Error("Missing deployment");
  return rows[0];
}
async function assertArtifacts() {
  const row = await onlyRow();
  expect(row.manifest?.files).toHaveLength(2);
  for (const file of row.manifest?.files ?? []) {
    const bytes = objects.get(`${row.r2_prefix}${file.hash}`);
    expect(bytes).toBeDefined();
    expect(new TextDecoder().decode(bytes)).toBe(
      files.find((source) => source.path === file.path)?.content,
    );
  }
  expect(deleted).toEqual([]);
  return row;
}

test("complete frontend publication retains every manifest object and serves it", async () => {
  const row = await hosting.deployBundle({ app, files, activate: false });
  expect(row.status).toBe("ready");
  await assertArtifacts();
  const response = await hosting.renderFrontendResponse({
    app: { ...app, name: "Site", description: null, logo_url: null },
    deployment: row,
    requestPath: "asset.txt",
  });
  expect(response.status).toBe(200);
  expect(new TextDecoder().decode(response.body as ArrayBuffer)).toBe(files[1]?.content);
});

test("a foreign organization cannot activate a published deployment", async () => {
  const live = await hosting.deployBundle({ app, files });
  const ready = await hosting.deployBundle({ app, files, activate: false });

  const foreignApp = { ...app, organization_id: randomUUID() };
  await expect(hosting.activate(foreignApp, ready.id)).resolves.toBeUndefined();
  expect((await repository.getActive(app.id))?.id).toBe(live.id);
  expect((await repository.getById(ready.id))?.status).toBe("ready");

  expect((await hosting.activate(app, ready.id))?.id).toBe(ready.id);
});

test("a foreign organization cannot create an upload or write its objects", async () => {
  await expect(
    hosting.deployBundle({
      app: { ...app, organization_id: randomUUID() },
      files,
      activate: false,
    }),
  ).rejects.toThrow();
  expect(await dbWrite.select().from(appFrontendDeployments)).toHaveLength(0);
  expect(objects.size).toBe(0);
});

test("upload and quiescence guards bind both the parent app and organization", async () => {
  const generation = randomUUID();
  const row = await repository.create({
    appId: app.id,
    organizationId: app.organization_id,
    r2Prefix: "owned/",
    uploadGeneration: generation,
  });
  const other = { id: randomUUID(), organization_id: app.organization_id };
  await dbWrite.execute(
    sql`INSERT INTO apps(id, organization_id) VALUES (${other.id}, ${other.organization_id})`,
  );
  const refused = [{ ...app, organization_id: randomUUID() }, other];
  try {
    for (const owner of refused)
      expect(await repository.beginUpload(owner, row.id, generation)).toBeUndefined();
    expect((await repository.getById(row.id))?.status).toBe("pending");
    expect((await repository.beginUpload(app, row.id, generation))?.status).toBe("uploading");
    for (const owner of refused) {
      await expect(repository.assertUploadAuthority(owner, row.id, generation)).rejects.toThrow();
      expect(await repository.quiesceUpload(owner, row.id, generation)).toBeUndefined();
    }
    expect((await repository.getById(row.id))?.upload_quiesced_at).toBeNull();
    await repository.assertUploadAuthority(app, row.id, generation);
    expect(
      (await repository.quiesceUpload(app, row.id, generation))?.upload_quiesced_at,
    ).not.toBeNull();
  } finally {
    await dbWrite.execute(sql`DELETE FROM apps WHERE id = ${other.id}`);
  }
});

test("a lost finalization acknowledgement preserves the published row and all objects", async () => {
  const original = repository.finalize.bind(repository);
  spies.push(
    spyOn(repository, "finalize").mockImplementation(async (...args) => {
      await original(...args);
      throw new Error("lost finalization acknowledgement");
    }),
  );
  await expect(hosting.deployBundle({ app, files, activate: false })).rejects.toThrow(
    "lost finalization acknowledgement",
  );
  expect((await assertArtifacts()).status).toBe("ready");
});

test("activation before a lost finalization reply cannot be undone by upload cleanup", async () => {
  const original = repository.finalize.bind(repository);
  spies.push(
    spyOn(repository, "finalize").mockImplementation(async (...args) => {
      await original(...args);
      await repository.activate(app, args[0]);
      throw new Error("reply lost after another client activated");
    }),
  );
  await expect(hosting.deployBundle({ app, files })).rejects.toThrow(
    "reply lost after another client activated",
  );
  expect((await assertArtifacts()).status).toBe("active");
});

test("a proven unpublished failure retires the row before removing its objects", async () => {
  spies.push(
    spyOn(repository, "finalize").mockRejectedValue(new Error("database rejected publication")),
  );
  beforeDelete = async () => {
    expect((await onlyRow()).status).toBe("failed");
  };
  await expect(hosting.deployBundle({ app, files, activate: false })).rejects.toThrow(
    "database rejected publication",
  );
  expect((await onlyRow()).status).toBe("failed");
  expect(objects.size).toBe(0);
  expect(deleted).toHaveLength(2);
});

test("a lost failure receipt retains objects instead of assuming retirement committed", async () => {
  spies.push(spyOn(repository, "finalize").mockRejectedValue(new Error("publication rejected")));
  const original = repository.markFailed.bind(repository);
  spies.push(
    spyOn(repository, "markFailed").mockImplementation(async (...args) => {
      await original(...args);
      throw new Error("retirement acknowledgement lost");
    }),
  );
  await expect(hosting.deployBundle({ app, files, activate: false })).rejects.toThrow(
    "publication rejected",
  );
  expect((await onlyRow()).status).toBe("failed");
  expect(objects.size).toBe(2);
  expect(deleted).toEqual([]);
});

test("deletion before finalization cannot report a successful deployment", async () => {
  const original = repository.finalize.bind(repository);
  spies.push(
    spyOn(repository, "finalize").mockImplementation(async (...args) => {
      await dbWrite.delete(appFrontendDeployments).where(eq(appFrontendDeployments.id, args[0]));
      return original(...args);
    }),
  );
  await expect(hosting.deployBundle({ app, files, activate: false })).rejects.toMatchObject({
    code: "FRONTEND_DEPLOYMENT_PUBLICATION_NOT_PERSISTED",
  });
  expect(await dbWrite.select().from(appFrontendDeployments)).toEqual([]);
  expect(deleted).toEqual([]);
});

test("a repeated finalization cannot replace an active deployment manifest", async () => {
  const row = await hosting.deployBundle({ app, files });
  expect(row.status).toBe("active");
  const replacement = await repository.finalize(row.id, {
    r2Prefix: "foreign/replacement/",
    manifest: { entrypoint: "other.html", spaFallback: false, files: [] },
    contentHash: "replacement",
    fileCount: 0,
    totalBytes: 0,
  });
  expect(replacement).toBeUndefined();
  expect((await assertArtifacts()).status).toBe("active");
  expect((await onlyRow()).content_hash).toBe(row.content_hash);
});

test("failed publication cleanup never changes a ready deployment to failed", async () => {
  const row = await hosting.deployBundle({ app, files, activate: false });
  expect(await repository.markFailed(row.id, "late error")).toBeUndefined();
  expect((await assertArtifacts()).status).toBe("ready");
});

test("deletion after publication cannot fall back to the original pending row", async () => {
  const original = repository.getById.bind(repository);
  spies.push(
    spyOn(repository, "getById").mockImplementation(async (id) => {
      await dbWrite.delete(appFrontendDeployments).where(eq(appFrontendDeployments.id, id));
      return original(id);
    }),
  );
  await expect(hosting.deployBundle({ app, files, activate: false })).rejects.toMatchObject({
    code: "FRONTEND_DEPLOYMENT_NOT_FOUND",
  });
  expect(deleted).toEqual([]);
});

test("a lost activation reply recovers the active deployment from primary SQL", async () => {
  const original = repository.activate.bind(repository);
  spies.push(
    spyOn(repository, "activate").mockImplementation(async (...args) => {
      await original(...args);
      throw new Error("activation reply lost");
    }),
  );
  const row = await hosting.deployBundle({ app, files });
  expect(row.status).toBe("active");
  await assertArtifacts();
});
