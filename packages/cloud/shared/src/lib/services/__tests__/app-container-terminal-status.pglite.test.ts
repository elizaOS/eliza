/**
 * Drives the REAL `ContainerRepoAppContainerStore` and `containersRepository`
 * against in-process PGlite to pin the hard-terminal container-status
 * compare-and-set.
 *
 * `markRunning` reads the row at one awaited round-trip and writes its status at
 * another, with no enclosing transaction. During a deploy overlap two live
 * workers can hold a `CONTAINER_PROVISION` and a `CONTAINER_DELETE` for the same
 * container at once (`claimPendingJobs` locks JOB rows by
 * type/status/scheduled_for with `FOR UPDATE SKIP LOCKED`; nothing keys the
 * claim by `containerId`), so a completed delete can land inside that window.
 *
 * The interleave here is made deterministic by gating ONLY the resolution of the
 * store's read round-trip — every statement executed is the production SQL, run
 * by the production repository against a real Postgres engine.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000002";
const TIMEOUT = 60_000;

type StoreModule = typeof import("../app-container-store");
type ContainersRepoModule = typeof import("../../../db/repositories/containers");
type ContainersSchemaModule = typeof import("../../../db/schemas/containers");

let dbWrite: typeof import("../../../db/client").dbWrite;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests | undefined;
let ContainerRepoAppContainerStore: StoreModule["ContainerRepoAppContainerStore"];
let containersRepository: ContainersRepoModule["containersRepository"];
let containers: ContainersSchemaModule["containers"];
let TERMINAL_CONTAINER_STATUS: ContainersSchemaModule["TERMINAL_CONTAINER_STATUS"];
let ready = true;

const CONTAINERS_DDL = `CREATE TABLE containers (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  project_name text NOT NULL,
  description text,
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL,
  api_key_id uuid,
  character_id uuid,
  load_balancer_url text,
  public_hostname text,
  status text NOT NULL DEFAULT 'pending',
  image_tag text,
  environment_vars jsonb NOT NULL DEFAULT '{}',
  desired_count integer NOT NULL DEFAULT 1,
  cpu integer NOT NULL DEFAULT 1792,
  memory integer NOT NULL DEFAULT 1792,
  port integer NOT NULL DEFAULT 3000,
  health_check_path text DEFAULT '/health',
  node_id text,
  volume_path text,
  volume_size_gb integer,
  hcloud_volume_id integer,
  volume_location text,
  last_deployed_at timestamp,
  last_health_check timestamp,
  deployment_log text,
  deployment_log_storage text NOT NULL DEFAULT 'inline',
  deployment_log_key text,
  error_message text,
  metadata jsonb NOT NULL DEFAULT '{}',
  last_billed_at timestamp,
  next_billing_at timestamp,
  billing_status text NOT NULL DEFAULT 'active',
  shutdown_warning_sent_at timestamp,
  scheduled_shutdown_at timestamp,
  total_billed numeric(10,2) NOT NULL DEFAULT 0,
  lifecycle_revision integer NOT NULL DEFAULT 0,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
)`;

beforeAll(async () => {
  try {
    ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../../db/client"));
    ({ containersRepository } = await import("../../../db/repositories/containers"));
    ({ containers, TERMINAL_CONTAINER_STATUS } = await import("../../../db/schemas/containers"));
    ({ ContainerRepoAppContainerStore } = await import("../app-container-store"));
    await dbWrite.execute(CONTAINERS_DDL);
    await dbWrite.execute(JOBS_DDL);
    await dbWrite.execute(`CREATE TABLE docker_nodes (
      node_id text PRIMARY KEY, allocated_count integer NOT NULL DEFAULT 0,
      capacity integer NOT NULL, enabled boolean NOT NULL DEFAULT true,
      placement_state text NOT NULL DEFAULT 'open', updated_at timestamp NOT NULL DEFAULT now()
    )`);
    await dbWrite.execute(
      "INSERT INTO docker_nodes (node_id, capacity) VALUES ('publication-node',10)",
    );
    // markStoppedForBilling settles accrued compute against the organization;
    // this fixture has no organization rows, so the settlement is a no-op.
    await dbWrite.execute(
      "CREATE TABLE organizations (id uuid PRIMARY KEY, pay_as_you_go_from_earnings boolean)",
    );
  } catch (error) {
    ready = false;
    console.error("[app-container-terminal-status] PGlite setup failed", error);
  }
}, TIMEOUT);

afterAll(async () => {
  if (closeDb) await closeDb();
});

let seq = 0;
function nextId(): string {
  seq += 1;
  return `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
}

async function seedContainer(status: string): Promise<string> {
  const id = nextId();
  await dbWrite.execute(
    `INSERT INTO containers (id, name, project_name, organization_id, user_id, image_tag, status)
     VALUES ('${id}', 'app-${id.slice(-6)}', '${ORG_ID}', '${ORG_ID}', '${USER_ID}',
             'ghcr.io/elizaos/eliza:stable', '${status}')`,
  );
  return id;
}

async function statusOf(id: string): Promise<string> {
  const result = await dbWrite.execute(`SELECT status FROM containers WHERE id = '${id}'`);
  return String((result.rows[0] as { status: string }).status);
}

/**
 * The pre-fix `containersRepository.updateStatus` write, extracted verbatim from
 * `git show origin/develop:packages/cloud/shared/src/db/repositories/containers.ts`
 * (id-only WHERE, no status predicate). Kept as a local re-implementation so the
 * over-rejection corpus can compare the patched repository against the exact
 * statement that ships today, on the same engine and the same rows.
 */
async function originUpdateStatusWrite(
  id: string,
  status: string,
  errorMessage?: string,
): Promise<boolean> {
  const [updated] = await dbWrite
    .update(containers)
    .set({
      status,
      error_message: errorMessage || null,
      updated_at: new Date(),
    })
    .where(eq(containers.id, id))
    .returning();
  return Boolean(updated);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * The production read database, with the resolution of `markRunning`'s SELECT
 * held open until the test releases it. The SELECT itself is issued and executed
 * unchanged against PGlite; only the continuation is scheduled.
 */
function readDatabaseGatedAfterSelect(gate: Promise<void>, captured?: () => void) {
  return {
    select: (selection: Record<string, unknown>) => {
      const builder = dbWrite.select(selection as never);
      return {
        from: (table: unknown) => {
          const fromBuilder = builder.from(table as never);
          return {
            where: (predicate: unknown) => {
              const whereBuilder = fromBuilder.where(predicate as never);
              return {
                limit: async (count: number) => {
                  const rows = await whereBuilder.limit(count);
                  captured?.();
                  await gate;
                  return rows;
                },
              };
            },
          };
        },
      };
    },
  };
}

function buildStore(readDatabase: unknown) {
  return new ContainerRepoAppContainerStore({
    readDatabase: readDatabase as never,
    writeDatabase: {
      select: (readDatabase as typeof dbWrite).select.bind(readDatabase),
      update: dbWrite.update.bind(dbWrite),
      transaction: dbWrite.transaction.bind(dbWrite),
    } as never,
    repository: containersRepository,
    errorFactory: (message, options) => Object.assign(new Error(message), options),
  });
}

async function publicationAuthorityFor(id: string) {
  const [row] = await dbWrite
    .select({
      metadata: containers.metadata,
      createdAtSnapshot: sql<string>`to_char(${containers.created_at}, 'YYYY-MM-DD HH24:MI:SS.US')`,
    })
    .from(containers)
    .where(eq(containers.id, id))
    .limit(1);
  return {
    organizationId: ORG_ID,
    deploymentGeneration:
      typeof row?.metadata?.deploymentGeneration === "string"
        ? row.metadata.deploymentGeneration
        : null,
    createdAtSnapshot: row?.createdAtSnapshot ?? "missing",
  };
}

const PROVISION_RESULT = {
  hostContainerId: "docker-immutable-1",
  hostPort: 21000,
  network: "app-net-x",
};

describe("app container terminal-status compare-and-set (real PGlite)", () => {
  test(
    "a delete that completes inside markRunning's read/write window cannot resurrect the row",
    async () => {
      expect(ready).toBe(true);
      const id = await seedContainer("deploying");
      const gate = deferred();
      const store = buildStore(readDatabaseGatedAfterSelect(gate.promise));

      // Worker A: CONTAINER_PROVISION. Issues the real SELECT, then parks.
      const running = store.markRunning(id, PROVISION_RESULT, await publicationAuthorityFor(id));
      // Worker B: CONTAINER_DELETE for the SAME container, claimed independently.
      await store.markDeleted(id, ORG_ID);
      expect(await statusOf(id)).toBe(TERMINAL_CONTAINER_STATUS);
      // Worker A's write now lands, after the terminal transition committed.
      gate.resolve();

      await expect(running).rejects.toThrow(/retired or changed generation/);
      expect(await statusOf(id)).toBe(TERMINAL_CONTAINER_STATUS);

      // The terminal row must also keep the placement metadata write off it.
      const [row] = await dbWrite
        .select({ metadata: containers.metadata, last_deployed_at: containers.last_deployed_at })
        .from(containers)
        .where(eq(containers.id, id))
        .limit(1);
      expect(row?.metadata).toEqual({});
      expect(row?.last_deployed_at).toBeNull();
    },
    TIMEOUT,
  );

  test(
    "the same interleave on the pre-fix statement resurrects the row to running",
    async () => {
      expect(ready).toBe(true);
      const id = await seedContainer("deploying");
      const store = buildStore(dbWrite);
      await store.markDeleted(id, ORG_ID);
      expect(await statusOf(id)).toBe(TERMINAL_CONTAINER_STATUS);

      expect(await originUpdateStatusWrite(id, "running")).toBe(true);
      expect(await statusOf(id)).toBe("running");

      // Restore the invariant for the rest of the suite.
      await dbWrite
        .update(containers)
        .set({ status: TERMINAL_CONTAINER_STATUS })
        .where(eq(containers.id, id));
    },
    TIMEOUT,
  );

  /**
   * Negative control. One daemon processes its claimed batch strictly
   * sequentially, so it cannot race itself; a fully-awaited `markRunning`
   * followed by a `markDeleted` must reach `deleted` and stay there. This case
   * passes on the pre-fix statement too, and that is the point: it shows the
   * corruption above needs the delete to land INSIDE the read/write window, not
   * merely for both operations to run. The window is the cause, not the harness.
   */
  test(
    "sequential execution — one worker, one batch — is never corrupted",
    async () => {
      expect(ready).toBe(true);
      const id = await seedContainer("deploying");
      const store = buildStore(dbWrite);
      await store.markRunning(id, PROVISION_RESULT, await publicationAuthorityFor(id));
      expect(await statusOf(id)).toBe("running");
      await store.markDeleted(id, ORG_ID);
      expect(await statusOf(id)).toBe(TERMINAL_CONTAINER_STATUS);
    },
    TIMEOUT,
  );

  test(
    "markError cannot flip a completed delete back to failed",
    async () => {
      expect(ready).toBe(true);
      const id = await seedContainer("deploying");
      const store = buildStore(dbWrite);
      await store.markDeleted(id, ORG_ID);
      await store.markError(id, "provider provision failed");
      expect(await statusOf(id)).toBe(TERMINAL_CONTAINER_STATUS);
      const [row] = await dbWrite
        .select({ error_message: containers.error_message })
        .from(containers)
        .where(eq(containers.id, id))
        .limit(1);
      expect(row?.error_message).toBeNull();
    },
    TIMEOUT,
  );

  test(
    "markCleanupRequired cannot pin node capacity on a completed delete",
    async () => {
      expect(ready).toBe(true);
      const id = await seedContainer("deploying");
      const store = buildStore(dbWrite);
      await store.markDeleted(id, ORG_ID);
      await store.markCleanupRequired(id, "Docker absence unproven");
      expect(await statusOf(id)).toBe(TERMINAL_CONTAINER_STATUS);
    },
    TIMEOUT,
  );

  test(
    "markDeleted stays idempotent and stays organization-scoped",
    async () => {
      expect(ready).toBe(true);
      const id = await seedContainer("deleting");
      const store = buildStore(dbWrite);
      await store.markDeleted(id, ORG_ID);
      await store.markDeleted(id, ORG_ID);
      expect(await statusOf(id)).toBe(TERMINAL_CONTAINER_STATUS);

      const other = await seedContainer("running");
      await store.markDeleted(other, "00000000-0000-4000-8000-0000000000ff");
      expect(await statusOf(other)).toBe("running");
    },
    TIMEOUT,
  );
});

/**
 * Over-rejection corpus. Every ordered (from, to) pair over the full
 * `containers.status` domain is driven through BOTH the patched repository and
 * the pre-fix statement on identical rows in the same engine, and the two
 * outcomes are compared. They must agree on every pair whose source status is
 * not the hard-terminal one — that set is the whole live path.
 */
const STATUS_DOMAIN = [
  "pending",
  "building",
  "deploying",
  "running",
  "stopped",
  "failed",
  "deleting",
  "deleted",
  "cleanup_required",
] as const;

describe("app container status CAS does not over-reject", () => {
  test(
    "patched and pre-fix statements agree on every transition out of a non-terminal status",
    async () => {
      expect(ready).toBe(true);
      const divergences: string[] = [];
      let compared = 0;
      let intentionallyBlocked = 0;

      for (const from of STATUS_DOMAIN) {
        for (const to of STATUS_DOMAIN) {
          if (to === "cleanup_required") continue; // not a ContainerStatus; covered above
          const patchedId = await seedContainer(from);
          const originId = await seedContainer(from);

          const patchedRow = await containersRepository.updateStatus(
            patchedId,
            to as never,
            `${from}->${to}`,
          );
          await originUpdateStatusWrite(originId, to, `${from}->${to}`);

          const patchedStatus = await statusOf(patchedId);
          const originStatus = await statusOf(originId);
          compared += 1;

          if (from === "deleted" && to !== "deleted") {
            // The only intended divergence.
            if (patchedStatus !== "deleted" || patchedRow !== null || originStatus !== to) {
              divergences.push(`guard misbehaved for ${from}->${to}`);
            } else {
              intentionallyBlocked += 1;
            }
            continue;
          }
          if (patchedStatus !== originStatus || patchedRow === null) {
            divergences.push(
              `${from}->${to}: patched=${patchedStatus}/${patchedRow === null ? "null" : "row"} origin=${originStatus}`,
            );
          }
        }
      }

      console.log(
        `[over-rejection corpus] compared=${compared} divergences=${divergences.length} intentionally-blocked=${intentionallyBlocked}`,
      );
      expect(divergences).toEqual([]);
      expect(compared).toBe(72);
      expect(intentionallyBlocked).toBe(7);
    },
    TIMEOUT,
  );

  test(
    "a status update on an absent row still returns null (unchanged)",
    async () => {
      expect(ready).toBe(true);
      const absent = nextId();
      expect(await containersRepository.updateStatus(absent, "failed", "gone")).toBeNull();
      expect(await originUpdateStatusWrite(absent, "failed", "gone")).toBe(false);
    },
    TIMEOUT,
  );

  test(
    "org-scoped writes are untouched by the status CAS",
    async () => {
      expect(ready).toBe(true);
      const id = await seedContainer("running");
      await containersRepository.markStoppedForBilling(id, ORG_ID);
      expect(await statusOf(id)).toBe("stopped");
      const restarted = await containersRepository.update(id, ORG_ID, { status: "deploying" });
      expect(restarted?.status).toBe("deploying");
    },
    TIMEOUT,
  );
});

const JOBS_DDL = `CREATE TABLE IF NOT EXISTS jobs (
        id uuid PRIMARY KEY,
        type text NOT NULL,
        status text NOT NULL DEFAULT 'pending',
        data jsonb NOT NULL,
        data_storage text NOT NULL DEFAULT 'inline',
        data_key text,
        agent_id text,
        character_id text,
        result jsonb,
        result_storage text NOT NULL DEFAULT 'inline',
        result_key text,
        error text,
        error_storage text NOT NULL DEFAULT 'inline',
        error_key text,
        attempts integer NOT NULL DEFAULT 0,
        max_attempts integer NOT NULL DEFAULT 3,
        execution_interruptions integer NOT NULL DEFAULT 0,
        retryable_requeues integer NOT NULL DEFAULT 0,
        organization_id uuid NOT NULL,
        user_id uuid,
        api_key_id uuid,
        generation_id uuid,
        webhook_url text,
        webhook_status text,
        estimated_completion_at timestamp,
        scheduled_for timestamp NOT NULL DEFAULT now(),
        started_at timestamp,
        execution_generation uuid,
        execution_quiesced_at timestamp,
        completed_at timestamp,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now(),
        CONSTRAINT reject_test_delete CHECK (
          type <> 'container_delete'
          OR data->>'containerId' <> '00000000-0000-4000-8000-000000515951'
        )
      );`;

test(
  "pending retirement wins against a captured app publication snapshot",
  async () => {
    const id = await seedContainer("deploying");
    const authority = await publicationAuthorityFor(id);
    const captured = deferred();
    const release = deferred();
    const store = buildStore(readDatabaseGatedAfterSelect(release.promise, captured.resolve));
    const publishing = store.markRunning(id, PROVISION_RESULT, authority);
    await captured.promise;
    const { retireContainerWithDeleteJob } = await import("../container-retirement");
    const retirement = await retireContainerWithDeleteJob(id, ORG_ID);
    expect(retirement.outcome).toBe("retired");
    release.resolve();
    await expect(publishing).rejects.toMatchObject({ code: "APP_CONTAINER_PUBLICATION_STALE" });
    await store.markError(id, "late provider failure", authority);
    await store.markCleanupRequired(id, "late cleanup failure", authority);
    const [after] = await dbWrite.select().from(containers).where(eq(containers.id, id));
    expect(after!.status).toBe("deleting");
    expect(after!.metadata.retirement).toMatchObject({ deleteJobId: retirement.jobId });
    expect(after!.metadata.hostContainerId).toBeUndefined();
    expect(after!.last_deployed_at).toBeNull();
  },
  TIMEOUT,
);

test(
  "retirement after the atomic publication preserves its newer ownership metadata",
  async () => {
    const id = await seedContainer("deploying");
    const authority = await publicationAuthorityFor(id);
    const committed = deferred();
    const release = deferred();
    const store = new ContainerRepoAppContainerStore({
      readDatabase: dbWrite as never,
      writeDatabase: dbWrite as never,
      repository: {
        tryReleaseNodeSlot: containersRepository.tryReleaseNodeSlot.bind(containersRepository),
        updateStatus: containersRepository.updateStatus.bind(containersRepository),
        async update(...args: Parameters<typeof containersRepository.update>) {
          const result = await containersRepository.update(...args);
          committed.resolve();
          await release.promise;
          return result;
        },
      },
      errorFactory: (message, options) => Object.assign(new Error(message), options),
    });
    const publishing = store.markRunning(id, PROVISION_RESULT, authority);
    await committed.promise;
    const { retireContainerWithDeleteJob } = await import("../container-retirement");
    const retirement = await retireContainerWithDeleteJob(id, ORG_ID);
    release.resolve();
    await publishing;
    const [after] = await dbWrite.select().from(containers).where(eq(containers.id, id));
    expect(after!.status).toBe("deleting");
    expect(after!.metadata.retirement).toMatchObject({ deleteJobId: retirement.jobId });
    expect(after!.metadata.hostContainerId).toBe(PROVISION_RESULT.hostContainerId);
  },
  TIMEOUT,
);

test(
  "original generation and microsecond row identity fence late provider publication",
  async () => {
    const store = buildStore(dbWrite);
    const id = await seedContainer("deploying");
    const firstGeneration = "00000000-0000-4000-8000-0000000000a1";
    const secondGeneration = "00000000-0000-4000-8000-0000000000a2";
    await containersRepository.update(id, ORG_ID, {
      metadata: { deploymentGeneration: firstGeneration },
    });
    const authority = await publicationAuthorityFor(id);
    await containersRepository.update(id, ORG_ID, {
      metadata: { deploymentGeneration: secondGeneration },
    });
    await expect(store.markRunning(id, PROVISION_RESULT, authority)).rejects.toMatchObject({
      code: "APP_CONTAINER_PUBLICATION_STALE",
    });
    const [generation] = await dbWrite.select().from(containers).where(eq(containers.id, id));
    expect(generation!.metadata.deploymentGeneration).toBe(secondGeneration);
    expect(generation!.status).toBe("deploying");
    await expect(
      store.markRunning(id, PROVISION_RESULT, {
        ...authority,
        organizationId: "00000000-0000-4000-8000-000000000099",
      }),
    ).rejects.toMatchObject({ code: "APP_CONTAINER_ROW_MISSING" });

    const reused = await seedContainer("deploying");
    await dbWrite.execute(
      `UPDATE containers SET created_at = timestamp '2026-11-07 00:00:00.123001' WHERE id='${reused}'`,
    );
    const original = await publicationAuthorityFor(reused);
    await dbWrite.execute(`DELETE FROM containers WHERE id='${reused}'`);
    await dbWrite.execute(`INSERT INTO containers (id,name,project_name,organization_id,user_id,status,created_at)
    VALUES ('${reused}','replacement','replacement','${ORG_ID}','${USER_ID}','deploying',timestamp '2026-11-07 00:00:00.123999')`);
    await expect(store.markRunning(reused, PROVISION_RESULT, original)).rejects.toMatchObject({
      code: "APP_CONTAINER_PUBLICATION_STALE",
    });
    expect(await statusOf(reused)).toBe("deploying");
  },
  TIMEOUT,
);

test(
  "a superseded provision deletes only its returned Docker id and preserves retirement",
  async () => {
    const id = await seedContainer("deploying");
    const store = buildStore(dbWrite);
    const { executeContainerProvision } = await import("../container-job-executors");
    const { retireContainerWithDeleteJob } = await import("../container-retirement");
    const removed: string[] = [];
    await dbWrite.execute(
      "UPDATE docker_nodes SET allocated_count=1 WHERE node_id='publication-node'",
    );
    await executeContainerProvision(
      { id: "late-provision", data: { containerId: id, organizationId: ORG_ID, userId: USER_ID } },
      {
        store,
        provider: {
          targetNodeId: "publication-node",
          async provision() {
            await retireContainerWithDeleteJob(id, ORG_ID);
            return { containerId: "original-docker-id", hostPort: 21000, network: "app-network" };
          },
          async deletePrimaryById(id: string) {
            removed.push(id);
          },
          async delete() {
            throw new Error("name-based deletion must not run");
          },
        } as never,
      },
    );
    expect(removed).toEqual(["original-docker-id"]);
    const [after] = await dbWrite.select().from(containers).where(eq(containers.id, id));
    expect(after!.status).toBe("deleting");
    expect(after!.metadata.retirement).toBeTruthy();
    expect(after!.metadata.hostContainerId).toBeUndefined();
    const count = await dbWrite.execute(
      "SELECT allocated_count FROM docker_nodes WHERE node_id='publication-node'",
    );
    expect(count.rows[0]?.allocated_count).toBe(1);
    expect(after!.metadata.slotReleasedAt).toBeTruthy();
    await store.markDeleted(id, ORG_ID, "publication-node");
    const afterDelete = await dbWrite.execute(
      "SELECT allocated_count FROM docker_nodes WHERE node_id='publication-node'",
    );
    expect(afterDelete.rows[0]?.allocated_count).toBe(1);
  },
  TIMEOUT,
);
