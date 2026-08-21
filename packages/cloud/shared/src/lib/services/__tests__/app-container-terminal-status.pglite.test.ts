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
import { eq } from "drizzle-orm";

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
function readDatabaseGatedAfterSelect(gate: Promise<void>) {
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
    writeDatabase: dbWrite as never,
    repository: containersRepository,
    errorFactory: (message, options) => Object.assign(new Error(message), options),
  });
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
      const running = store.markRunning(id, PROVISION_RESULT);
      // Worker B: CONTAINER_DELETE for the SAME container, claimed independently.
      await store.markDeleted(id, ORG_ID);
      expect(await statusOf(id)).toBe(TERMINAL_CONTAINER_STATUS);
      // Worker A's write now lands, after the terminal transition committed.
      gate.resolve();

      await expect(running).rejects.toThrow(/terminal state before it became running/);
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
