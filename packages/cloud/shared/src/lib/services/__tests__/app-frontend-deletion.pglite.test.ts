/** Local controlled SQL/R2 proof; no provider requests or production writes. */
import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";

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
const { jobsRepository } = await import("../../../db/repositories/jobs");
const { executeAppDeletion } = await import("../app-deletion");
const lifecycleSchema = {
  ...(await import("../../../db/schemas/jobs")),
  ...(await import("../../../db/schemas/job-execution-leases")),
  ...(await import("../../../db/schemas/app-databases")),
  ...(await import("../../../db/schemas/tenant-db-clusters")),
  ...(await import("../../../db/schemas/containers")),
  ...(await import("../../../db/schemas/secrets")),
};
const { appFrontendHostingService: hosting } = await import("../app-frontend-hosting");
const { setRuntimeR2Bucket } = await import("../../storage/r2-runtime-binding");
const { default: serve } = await import(
  "../../../../../api/v1/hosted-frontend/serve/[[...path]]/route"
);
const objects = new Map<string, Uint8Array>();
const spies: Array<{ mockRestore(): void }> = [];
let beforeObjectDelete: (() => Promise<void>) | undefined;
let lastAuthority: import("../job-execution-authority").JobExecutionAuthority;
let identity: { id: string; organization_id: string; slug: string };

beforeAll(async () => {
  for (let statement of await generateMigration(
    generateDrizzleJson({}),
    generateDrizzleJson({
      ...appSchema,
      ...lifecycleSchema,
      ...domainSchema,
      apiKeys,
      mobileAppAuthGrants,
      appFrontendDeployments,
    }),
  )) {
    if (statement.startsWith("ALTER TABLE") && statement.includes("FOREIGN KEY")) continue;
    if (statement.startsWith('CREATE TABLE "apps"'))
      statement = statement.replace(/\n\s*"deletion_job_id" uuid,/, "");
    await dbWrite.execute(statement);
  }
  for (const statement of readFileSync(
    new URL("../../../db/migrations/0566_app_deletion_authority.sql", import.meta.url),
    "utf8",
  ).split("--> statement-breakpoint"))
    if (statement.trim()) await getPgliteClientForTests().exec(statement);
  for (const statement of readFileSync(
    new URL("../../../db/migrations/0568_app_cleanup_manifest.sql", import.meta.url),
    "utf8",
  ).split("--> statement-breakpoint"))
    if (statement.trim()) await getPgliteClientForTests().exec(statement);
  await getPgliteClientForTests().exec(
    "ALTER TABLE app_frontend_deployments ADD CONSTRAINT frontend_test_app_fk FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE",
  );
}, 120_000);
beforeEach(async () => {
  await getPgliteClientForTests().exec(
    "TRUNCATE apps CASCADE; TRUNCATE jobs CASCADE; TRUNCATE job_execution_leases CASCADE;",
  );
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

async function executeOriginalDeletion(continueBatches = true) {
  await appsService.requestDeletion({
    appId: identity.id,
    organizationId: identity.organization_id,
    deleteGitHubRepo: false,
  });
  const owner = randomUUID();
  const [job] = await jobsRepository.claimPendingJobs({
    type: "app_delete",
    limit: 1,
    executionOwnerId: owner,
    executionLeaseMs: 60_000,
  });
  if (!job?.execution_generation) throw new Error("Deletion was not claimed");
  lastAuthority = {
    jobId: job.id,
    organizationId: identity.organization_id,
    executionGeneration: job.execution_generation,
    executionOwnerId: owner,
  };
  for (;;) {
    try {
      return await executeAppDeletion(lastAuthority);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "Original artifact cleanup has more work")
        throw error;
    }
  }
}

test("failed app deletion retains frontend content behind the permanent deletion fence", async () => {
  expect((await readAsset()).status).toBe(200);
  await getPgliteClientForTests().exec(`CREATE FUNCTION reject_fixture_app_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'controlled rejected final deletion'; END $$;
    CREATE TRIGGER reject_fixture_app_delete BEFORE DELETE ON apps FOR EACH ROW EXECUTE FUNCTION reject_fixture_app_delete();`);
  try {
    await expect(executeOriginalDeletion()).rejects.toMatchObject({
      cause: { code: "P0001" },
    });
  } finally {
    await getPgliteClientForTests().exec(
      "DROP TRIGGER reject_fixture_app_delete ON apps; DROP FUNCTION reject_fixture_app_delete();",
    );
  }
  expect((await appsRepository.findById(identity.id))?.is_active).toBe(false);
  expect((await readAsset()).status).toBe(404);
  await expect(appsService.update(identity.id, { is_active: true })).rejects.toMatchObject({
    code: "APP_DELETION_IN_PROGRESS",
  });
  expect((await dbWrite.select().from(appFrontendDeployments))[0]?.status).toBe("active");
  expect(objects.size).toBe(2);
});

test("a concurrent reactivation is rejected before original-job final deletion", async () => {
  await appsService.requestDeletion({
    appId: identity.id,
    organizationId: identity.organization_id,
    deleteGitHubRepo: false,
  });
  await expect(appsService.update(identity.id, { is_active: true })).rejects.toMatchObject({
    code: "APP_DELETION_IN_PROGRESS",
  });
  expect(objects.size).toBe(2);
  await executeOriginalDeletion();
  expect(objects.size).toBe(0);
});

test("acknowledged app deletion removes frontend rows before their exact objects", async () => {
  beforeObjectDelete = async () => {
    expect(await appsRepository.findById(identity.id)).toBeUndefined();
    expect(await dbWrite.select().from(appFrontendDeployments)).toHaveLength(0);
  };
  await executeOriginalDeletion();
  expect(objects.size).toBe(0);
  expect((await readAsset()).status).toBe(404);
});

test("a lost committed app deletion reply retains objects without fabricating cleanup authority", async () => {
  const original = appsRepository.finalizeDelete.bind(appsRepository);
  spies.push(
    spyOn(appsRepository, "finalizeDelete").mockImplementation(async (id, authority) => {
      await original(id, authority);
      throw new Error("controlled lost deletion acknowledgement");
    }),
  );
  await expect(executeOriginalDeletion()).rejects.toThrow(
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
  await executeOriginalDeletion();
  expect(objects.size).toBe(0);
  expect(await dbWrite.select().from(appFrontendDeployments)).toHaveLength(0);
}, 60_000);

test("the final app deletion snapshot includes frontends published before the permanent fence", async () => {
  await hosting.deployBundle({
    app: identity,
    files: [{ path: "index.html", content: "later publication" }],
    activate: false,
  });
  await executeOriginalDeletion();
  expect(objects.size).toBe(0);
  expect(await appsRepository.findById(identity.id)).toBeUndefined();
});

test("failed artifact deletion retains the complete original cleanup plan and resumes after cascade", async () => {
  beforeObjectDelete = async () => {
    throw new Error("controlled storage outage");
  };
  await expect(executeOriginalDeletion()).rejects.toMatchObject({
    code: "APP_DELETION_RECOVERY_PENDING",
  });
  expect(await appsRepository.findById(identity.id)).toBeUndefined();
  expect(objects.size).toBe(2);
  const root = await jobsRepository.findByIdForWrite(lastAuthority.jobId);
  expect(root?.data.frontendCleanupPlan).toBeDefined();
  expect(root?.result?.cleanupConfirmed).toBe(false);
  beforeObjectDelete = undefined;
  await executeAppDeletion(lastAuthority);
  expect(objects.size).toBe(0);
  expect(
    (await jobsRepository.findByIdForWrite(lastAuthority.jobId))?.result?.cleanupConfirmed,
  ).toBe(true);
});

test("lost final SQL acknowledgement recovers exact original artifacts from the retained job", async () => {
  const original = appsRepository.finalizeDelete.bind(appsRepository);
  const lost = spyOn(appsRepository, "finalizeDelete").mockImplementation(async (id, authority) => {
    await original(id, authority);
    throw new Error("controlled lost final acknowledgement");
  });
  await expect(executeOriginalDeletion()).rejects.toThrow("controlled lost final acknowledgement");
  lost.mockRestore();
  expect(objects.size).toBe(2);
  await executeAppDeletion(lastAuthority);
  expect(objects.size).toBe(0);
});

test("an acknowledged object prefix is not deleted again after a later object fails", async () => {
  const calls: string[] = [];
  let fail = true;
  const bucket = (await import("../../storage/r2-runtime-binding")).getRuntimeR2Bucket()!;
  const remove = bucket.delete.bind(bucket);
  bucket.delete = async (key) => {
    if (Array.isArray(key)) throw new Error("Expected exact key");
    calls.push(key);
    if (fail && calls.length === 2) throw new Error("second object unavailable");
    return remove(key);
  };
  await expect(executeOriginalDeletion()).rejects.toMatchObject({
    code: "APP_DELETION_RECOVERY_PENDING",
  });
  expect((await jobsRepository.findByIdForWrite(lastAuthority.jobId))?.result?.cleanupCursor).toBe(
    1,
  );
  fail = false;
  await executeAppDeletion(lastAuthority);
  expect(calls).toEqual([calls[0], calls[1], calls[1]]);
  expect(objects.size).toBe(0);
});

test("unconfirmed marked cleanup blocks job removal and account provider completion after app cascade", async () => {
  beforeObjectDelete = async () => {
    throw new Error("storage unavailable");
  };
  await expect(executeOriginalDeletion()).rejects.toMatchObject({
    code: "APP_DELETION_RECOVERY_PENDING",
  });
  const { createAccountDeletionProviderAdapters } = await import(
    "../account-deletion-provider-adapters"
  );
  const adapter = createAccountDeletionProviderAdapters().github_repositories;
  const context = {
    requestId: randomUUID(),
    requestDigest: "a".repeat(64),
    userId: randomUUID(),
    organizationId: identity.organization_id,
    stewardUserId: randomUUID(),
    lifecycleRevision: 1,
    phaseReceiptId: randomUUID(),
    phaseGeneration: 1,
    blob: (await import("../../storage/r2-runtime-binding")).getRuntimeR2Bucket()!,
  };
  expect(await adapter.inspect(context)).toEqual({ state: "needs_execution" });
  await expect(adapter.execute(context, "unused")).rejects.toMatchObject({
    code: "ACCOUNT_DELETION_APP_CLEANUP_PENDING",
  });
  await expect(dbWrite.delete(lifecycleSchema.jobs).then(() => undefined)).rejects.toMatchObject({
    cause: { code: "23514" },
  });
  beforeObjectDelete = undefined;
  await executeAppDeletion(lastAuthority);
  expect((await adapter.inspect(context)).state).toBe("complete");
  await dbWrite.delete(lifecycleSchema.jobs);
}, 30_000);

test("historical version-one jobs without cleanup manifests do not become permanent account blockers", async () => {
  await getPgliteClientForTests().exec("TRUNCATE apps CASCADE");
  await dbWrite.insert(lifecycleSchema.jobs).values({
    organization_id: identity.organization_id,
    type: "app_delete",
    status: "completed",
    data: { version: 1, appId: identity.id },
    result: { appDeleted: true },
  });
  const { hasUnconfirmedAppCleanup } = await import(
    "../../../db/repositories/app-deletion-cleanup"
  );
  expect(await hasUnconfirmedAppCleanup(identity.organization_id)).toBe(false);
  await dbWrite.delete(lifecycleSchema.jobs);
});

test("suppressed object acknowledgement keeps the cursor unchanged and retries only its original key", async () => {
  await getPgliteClientForTests().exec(`CREATE FUNCTION reject_cleanup_ack() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF (NEW.result->>'cleanupCursor')::integer > 0 THEN RETURN NULL; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_cleanup_ack BEFORE UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION reject_cleanup_ack();`);
  try {
    await expect(executeOriginalDeletion()).rejects.toMatchObject({
      code: "APP_DELETION_CLEANUP_ACK_UNCONFIRMED",
    });
  } finally {
    await getPgliteClientForTests().exec(
      "DROP TRIGGER reject_cleanup_ack ON jobs; DROP FUNCTION reject_cleanup_ack()",
    );
  }
  expect((await jobsRepository.findByIdForWrite(lastAuthority.jobId))?.result?.cleanupCursor).toBe(
    0,
  );
  expect(objects.size).toBe(1);
  await executeAppDeletion(lastAuthority);
  expect(objects.size).toBe(0);
});

test("the complete manifest remains inline above the ordinary object-offload ceiling", async () => {
  const count = 12_000;
  const files = Array.from({ length: count }, (_, i) => ({
    path: `asset/${i}`,
    hash: i.toString(16).padStart(64, "0"),
    contentType: "text/plain",
    size: 1,
  }));
  await dbWrite.insert(appFrontendDeployments).values({
    app_id: identity.id,
    version: 2,
    status: "ready",
    r2_prefix: `private/${identity.id}/`,
    manifest: { files, entrypoint: "asset/0", spaFallback: false },
  });
  beforeObjectDelete = async () => {
    throw new Error("pause complete plan");
  };
  await expect(executeOriginalDeletion()).rejects.toMatchObject({
    code: "APP_DELETION_RECOVERY_PENDING",
  });
  const root = await jobsRepository.findByIdForWrite(lastAuthority.jobId);
  if (!root) throw new Error("Missing retained cleanup root");
  expect(root.data_storage).toBe("inline");
  expect(root?.data_key).toBeNull();
  expect(JSON.stringify(root.data.frontendCleanupPlan).length).toBeGreaterThan(1_048_576);
  expect((root.data.frontendCleanupPlan as { objectCount: number }).objectCount).toBe(count + 2);
  expect(JSON.stringify(root?.result).length).toBeLessThan(2048);
});

test("the immutable cleanup plan and confirmed receipt cannot be replaced or rewound", async () => {
  await executeOriginalDeletion();
  const { eq } = await import("drizzle-orm");
  const root = await jobsRepository.findByIdForWrite(lastAuthority.jobId);
  await expect(
    dbWrite
      .update(lifecycleSchema.jobs)
      .set({ data: { ...root!.data, frontendCleanupPlan: { version: 1, deployments: [] } } })
      .where(eq(lifecycleSchema.jobs.id, lastAuthority.jobId))
      .then(() => undefined),
  ).rejects.toMatchObject({ cause: { code: "23514" } });
  await expect(
    dbWrite
      .update(lifecycleSchema.jobs)
      .set({ result: { ...root!.result, cleanupCursor: 0, cleanupConfirmed: false } })
      .where(eq(lifecycleSchema.jobs.id, lastAuthority.jobId))
      .then(() => undefined),
  ).rejects.toMatchObject({ cause: { code: "23514" } });
});

test("a bounded cleanup invocation retains pending status and resets retry budget only after durable progress", async () => {
  const { eq } = await import("drizzle-orm");
  const files = Array.from({ length: 65 }, (_, i) => ({
    path: `batch/${i}`,
    hash: i.toString(16).padStart(64, "0"),
    contentType: "text/plain",
    size: 1,
  }));
  await dbWrite.insert(appFrontendDeployments).values({
    app_id: identity.id,
    version: 2,
    status: "ready",
    r2_prefix: `batch/${identity.id}/`,
    manifest: { files, entrypoint: "batch/0", spaFallback: false },
  });
  let attempted = false;
  beforeObjectDelete = async () => {
    if (!attempted) {
      attempted = true;
      await dbWrite
        .update(lifecycleSchema.jobs)
        .set({ retryable_requeues: 119 })
        .where(eq(lifecycleSchema.jobs.id, lastAuthority.jobId));
      throw new Error("no acknowledged progress");
    }
  };
  await expect(executeOriginalDeletion(false)).rejects.toMatchObject({
    code: "APP_DELETION_RECOVERY_PENDING",
  });
  expect((await jobsRepository.findByIdForWrite(lastAuthority.jobId))?.retryable_requeues).toBe(
    119,
  );
  beforeObjectDelete = undefined;
  await expect(executeAppDeletion(lastAuthority)).rejects.toMatchObject({
    code: "APP_DELETION_RECOVERY_PENDING",
  });
  const partial = await jobsRepository.findByIdForWrite(lastAuthority.jobId);
  expect(partial?.result?.cleanupCursor).toBe(64);
  expect(partial?.result?.cleanupConfirmed).toBe(false);
  expect(partial?.retryable_requeues).toBe(0);
  await executeAppDeletion(lastAuthority);
  expect(
    (await jobsRepository.findByIdForWrite(lastAuthority.jobId))?.result?.cleanupConfirmed,
  ).toBe(true);
});

test("a locked pending empty draft retires without inventing any uploaded artifacts", async () => {
  await dbWrite
    .insert(appFrontendDeployments)
    .values({ app_id: identity.id, version: 2, status: "pending", r2_prefix: "", manifest: null });
  await executeOriginalDeletion();
  expect(objects.size).toBe(0);
  expect(await appsRepository.findById(identity.id)).toBeUndefined();
});

test("an ambiguous legacy failed empty draft remains explicitly recovery-required", async () => {
  await dbWrite
    .insert(appFrontendDeployments)
    .values({ app_id: identity.id, version: 2, status: "failed", r2_prefix: "", manifest: null });
  await expect(executeOriginalDeletion()).rejects.toMatchObject({
    code: "APP_DELETION_RECOVERY_PENDING",
  });
  expect(await appsRepository.findById(identity.id)).toBeDefined();
  expect(objects.size).toBe(2);
});

test("deletion waits for the original paused uploader and then cleans its complete planned keys", async () => {
  const bucket = (await import("../../storage/r2-runtime-binding")).getRuntimeR2Bucket()!;
  const put = bucket.put.bind(bucket);
  let started!: () => void, release!: () => void;
  const seen = new Promise<void>((resolve) => {
    started = resolve;
  });
  const resume = new Promise<void>((resolve) => {
    release = resolve;
  });
  let once = false;
  bucket.put = async (...args) => {
    const result = await put(...args);
    if (!once) {
      once = true;
      started();
      await resume;
    }
    return result;
  };
  const upload = hosting.deployBundle({
    app: identity,
    files: [
      { path: "index.html", content: "late page" },
      { path: "late.txt", content: "late asset" },
    ],
  });
  void upload.catch(() => {});
  await seen;
  const rows = await dbWrite.select().from(appFrontendDeployments);
  const uploading = rows.find((row) => row.status === "uploading");
  expect(uploading?.upload_plan?.files).toHaveLength(2);
  expect(uploading?.upload_quiesced_at).toBeNull();
  if (!uploading) throw new Error("Missing original upload");
  expect(await hosting.deleteDeployment(uploading)).toBe(false);
  const { eq } = await import("drizzle-orm");
  await expect(
    dbWrite
      .delete(appFrontendDeployments)
      .where(eq(appFrontendDeployments.id, uploading.id))
      .then(() => undefined),
  ).rejects.toMatchObject({ cause: { code: "23514" } });
  await expect(
    dbWrite
      .update(appFrontendDeployments)
      .set({ upload_plan: { files: [], entrypoint: "other", spaFallback: false } })
      .where(eq(appFrontendDeployments.id, uploading.id))
      .then(() => undefined),
  ).rejects.toMatchObject({ cause: { code: "23514" } });
  try {
    await expect(executeOriginalDeletion()).rejects.toMatchObject({
      code: "APP_DELETION_RECOVERY_PENDING",
    });
    expect(await appsRepository.findById(identity.id)).toBeDefined();
  } finally {
    release();
  }
  await expect(upload).rejects.toMatchObject({ code: "FRONTEND_UPLOAD_AUTHORITY_LOST" });
  const stopped = (await dbWrite.select().from(appFrontendDeployments)).find(
    (row) => row.id === uploading?.id,
  );
  expect(stopped?.upload_quiesced_at).toBeInstanceOf(Date);
  await executeAppDeletion(lastAuthority);
  expect(objects.size).toBe(0);
  expect(await appsRepository.findById(identity.id)).toBeUndefined();
}, 30000);

test("an unknown PUT outcome retains upload authority and prevents a false cleanup receipt", async () => {
  const bucket = (await import("../../storage/r2-runtime-binding")).getRuntimeR2Bucket()!;
  const put = bucket.put.bind(bucket);
  bucket.put = async (...args) => {
    await put(...args);
    throw new Error("controlled lost PUT reply");
  };
  await expect(
    hosting.deployBundle({
      app: identity,
      files: [{ path: "index.html", content: "unknown upload" }],
    }),
  ).rejects.toThrow("controlled lost PUT reply");
  const failed = (await dbWrite.select().from(appFrontendDeployments)).find(
    (row) => row.status === "failed",
  );
  expect(failed?.upload_plan?.files).toHaveLength(1);
  expect(failed?.upload_quiesced_at).toBeNull();
  expect(objects.size).toBe(3);
  await expect(executeOriginalDeletion()).rejects.toMatchObject({
    code: "APP_DELETION_RECOVERY_PENDING",
  });
  expect(await appsRepository.findById(identity.id)).toBeDefined();
  expect(objects.size).toBe(3);
});

test("invalid bundle validation performs no partial upload or orphan draft creation", async () => {
  await expect(
    hosting.deployBundle({
      app: identity,
      files: [
        { path: "index.html", content: "valid first" },
        { path: "../invalid", content: "bad" },
      ],
    }),
  ).rejects.toThrow("Invalid file path");
  expect(await dbWrite.select().from(appFrontendDeployments)).toHaveLength(1);
  expect(objects.size).toBe(2);
});

test("cleanup authority rejects missing or non-typed digest count and confirmation fields", async () => {
  const progress = await appsService.requestDeletion({
    appId: identity.id,
    organizationId: identity.organization_id,
    deleteGitHubRepo: false,
  });
  const root = await jobsRepository.findByIdForWrite(progress.jobId);
  if (!root) throw new Error("No root");
  const { buildAppDeletionCleanupPlan } = await import("../app-deletion-cleanup-plan");
  const plan = buildAppDeletionCleanupPlan([]);
  const { eq } = await import("drizzle-orm");
  const good = {
    appDeleted: true,
    appId: identity.id,
    deletionJobId: root.id,
    cleanupManifestDigest: plan.digest,
    cleanupObjectCount: 0,
    cleanupCursor: 0,
    cleanupConfirmed: true,
  };
  for (const [field, value] of [
    ["cleanupManifestDigest", undefined],
    ["cleanupObjectCount", undefined],
    ["cleanupConfirmed", undefined],
    ["cleanupConfirmed", "true"],
    ["cleanupCursor", "0"],
  ] as const) {
    const result = { ...good, [field]: value };
    await expect(
      dbWrite
        .update(lifecycleSchema.jobs)
        .set({ data: { ...root.data, frontendCleanupPlan: plan }, result })
        .where(eq(lifecycleSchema.jobs.id, root.id))
        .then(() => undefined),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
  }
  expect(await appsRepository.findById(identity.id)).toBeDefined();
});

test("suppressed writer quiescence cannot publish or authorize app cleanup", async () => {
  await getPgliteClientForTests().exec(`CREATE FUNCTION suppress_upload_quiescence() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.upload_quiesced_at IS NOT NULL THEN RETURN NULL; END IF; RETURN NEW; END $$;
    CREATE TRIGGER suppress_upload_quiescence BEFORE UPDATE ON app_frontend_deployments FOR EACH ROW EXECUTE FUNCTION suppress_upload_quiescence();`);
  try {
    await expect(
      hosting.deployBundle({
        app: identity,
        files: [{ path: "index.html", content: "unconfirmed writer" }],
      }),
    ).rejects.toMatchObject({ code: "FRONTEND_UPLOAD_QUIESCENCE_UNCONFIRMED" });
  } finally {
    await getPgliteClientForTests().exec(
      "DROP TRIGGER suppress_upload_quiescence ON app_frontend_deployments; DROP FUNCTION suppress_upload_quiescence()",
    );
  }
  expect(objects.size).toBe(3);
  await expect(executeOriginalDeletion()).rejects.toMatchObject({
    code: "APP_DELETION_RECOVERY_PENDING",
  });
  expect(await appsRepository.findById(identity.id)).toBeDefined();
});

test("started and failed upload rows cannot regain unstarted deletion authority", async () => {
  const { eq } = await import("drizzle-orm");
  for (const [index, owned, status] of [
    [0, true, "uploading"],
    [1, true, "failed"],
    [2, false, "uploading"],
    [3, false, "failed"],
  ] as const) {
    const [row] = await dbWrite
      .insert(appFrontendDeployments)
      .values({
        app_id: identity.id,
        version: 10 + index,
        status,
        r2_prefix: "original/",
        upload_generation: owned ? randomUUID() : null,
        upload_plan: owned ? { entrypoint: "index.html", spaFallback: false, files: [] } : null,
      })
      .returning();
    if (!row) throw new Error("Missing upload");
    await expect(
      dbWrite
        .update(appFrontendDeployments)
        .set({ status: "pending" })
        .where(eq(appFrontendDeployments.id, row.id))
        .then(() => undefined),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
  }
});
