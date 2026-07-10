/**
 * Regression proof for #15826 — container-delete recovery must never remove a
 * live app container that merely shares the reused `app-<slug>` name with a
 * stuck `deleting` row. Runs the REAL delete executor and the REAL
 * ContainerRepoAppContainerStore SQL against PGlite; only the docker side
 * (AppContainerProvider) is a recording seam.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { AppContainerProvider } from "../app-container-provider";
import {
  type AppContainerStoreRepository,
  ContainerRepoAppContainerStore,
} from "../app-container-store";
import { findActiveContainerIdsSharingName } from "../app-container-store-queries";
import { executeContainerDelete } from "../container-job-executors";

const USER_ID = "00000000-0000-0000-0000-0000000000b1";
// One organization per scenario so each org-only legacy job fans out to exactly
// that scenario's stuck rows (findDeletingByOrganization is org-wide).
const ORG_A = "00000000-0000-0000-0000-0000000000a1";
const ORG_B = "00000000-0000-0000-0000-0000000000a2";
const ORG_C = "00000000-0000-0000-0000-0000000000a3";

const STUCK_A = "00000000-0000-0000-0000-0000000000d1";
const LIVE_A = "00000000-0000-0000-0000-0000000000d2";
const STUCK_B = "00000000-0000-0000-0000-0000000000e1";
const LIVE_B = "00000000-0000-0000-0000-0000000000e2";
const LONE_C = "00000000-0000-0000-0000-0000000000f1";

let client: PGlite;
let database: ReturnType<typeof drizzle>;
let store: ContainerRepoAppContainerStore;

async function insertContainer(row: {
  id: string;
  name: string;
  organizationId: string;
  status: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await client.query(
    `INSERT INTO containers
       (id, name, project_name, image_tag, port, organization_id, user_id, metadata, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      row.id,
      row.name,
      `project-${row.name}`,
      "image:1",
      3000,
      row.organizationId,
      USER_ID,
      JSON.stringify(row.metadata ?? {}),
      row.status,
    ],
  );
}

async function statusOf(id: string): Promise<string> {
  const result = await client.query<{ status: string }>(
    "SELECT status FROM containers WHERE id = $1",
    [id],
  );
  const status = result.rows[0]?.status;
  if (!status) throw new Error(`container ${id} not found`);
  return status;
}

function recordingProvider() {
  const dockerCalls: Array<{ op: string; arg: string }> = [];
  const provider = {
    async delete(name: string) {
      dockerCalls.push({ op: "rm-by-name", arg: name });
    },
    async removeByHostContainerId(hostContainerId: string) {
      dockerCalls.push({ op: "rm-by-id", arg: hostContainerId });
    },
    async removeDbAmbassador(name: string) {
      dockerCalls.push({ op: "rm-ambassador", arg: name });
    },
  } as unknown as AppContainerProvider;
  return { dockerCalls, provider };
}

beforeAll(async () => {
  client = new PGlite();
  database = drizzle(client);
  await client.exec(`
    CREATE TABLE containers (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      project_name text NOT NULL,
      image_tag text,
      port integer NOT NULL,
      organization_id uuid NOT NULL,
      user_id uuid NOT NULL,
      environment_vars jsonb NOT NULL DEFAULT '{}',
      metadata jsonb NOT NULL DEFAULT '{}',
      node_id text,
      status text NOT NULL,
      error_message text,
      updated_at timestamp NOT NULL DEFAULT now()
    )
  `);
  // markDeleted writes through writeDatabase directly; the repository seam only
  // carries lifecycle side effects (none fire here: no node_id, no markError).
  const repository: AppContainerStoreRepository = {
    updateStatus: async (id, status) => {
      throw new Error(`updateStatus must not run during a delete: ${id} -> ${status}`);
    },
    update: async (id) => {
      throw new Error(`update must not run during a delete: ${id}`);
    },
    tryReleaseNodeSlot: async (id) => {
      throw new Error(`tryReleaseNodeSlot must not run for node-less rows: ${id}`);
    },
  };
  store = new ContainerRepoAppContainerStore({
    readDatabase: database,
    writeDatabase: database,
    repository,
    errorFactory: (message, options) => {
      const error = new Error(message);
      error.name = options.code;
      return error;
    },
  });
});

afterAll(async () => {
  await client.close();
});

describe("executeContainerDelete + real store SQL — live-name guard (#15826)", () => {
  test("stuck deleting row + newer running row sharing the name: the live container survives", async () => {
    // The stuck row predates markRunning metadata (no hostContainerId); after a
    // redeploy its name resolves to the app's CURRENT live container.
    await insertContainer({
      id: STUCK_A,
      name: "app-aaa",
      organizationId: ORG_A,
      status: "deleting",
    });
    await insertContainer({
      id: LIVE_A,
      name: "app-aaa",
      organizationId: ORG_A,
      status: "running",
      metadata: { hostContainerId: "docker-live-a" },
    });

    const { dockerCalls, provider } = recordingProvider();
    await executeContainerDelete(
      { id: "legacy-job-a", data: { organizationId: ORG_A } },
      { provider, store },
    );

    // No docker removal of any kind — no rm-by-name that would kill the live
    // container, and no ambassador teardown the live app still depends on.
    expect(dockerCalls).toEqual([]);
    // The stuck row still reaches its terminal state; the live row is untouched.
    expect(await statusOf(STUCK_A)).toBe("deleted");
    expect(await statusOf(LIVE_A)).toBe("running");
  });

  test("stuck row with a recorded hostContainerId: recovery removes exactly that id", async () => {
    await insertContainer({
      id: STUCK_B,
      name: "app-bbb",
      organizationId: ORG_B,
      status: "deleting",
      metadata: { hostContainerId: "docker-old-b" },
    });
    await insertContainer({
      id: LIVE_B,
      name: "app-bbb",
      organizationId: ORG_B,
      status: "running",
      metadata: { hostContainerId: "docker-live-b" },
    });

    const { dockerCalls, provider } = recordingProvider();
    await executeContainerDelete(
      { id: "legacy-job-b", data: { organizationId: ORG_B } },
      { provider, store },
    );

    expect(dockerCalls).toEqual([{ op: "rm-by-id", arg: "docker-old-b" }]);
    expect(await statusOf(STUCK_B)).toBe("deleted");
    expect(await statusOf(LIVE_B)).toBe("running");
  });

  test("name-only stuck row with no conflicting row: name-based removal is allowed", async () => {
    await insertContainer({
      id: LONE_C,
      name: "app-ccc",
      organizationId: ORG_C,
      status: "deleting",
    });

    const { dockerCalls, provider } = recordingProvider();
    await executeContainerDelete(
      { id: "legacy-job-c", data: { organizationId: ORG_C } },
      { provider, store },
    );

    // provider.delete tears down the container AND its ambassador on this path.
    expect(dockerCalls).toEqual([{ op: "rm-by-name", arg: "app-ccc" }]);
    expect(await statusOf(LONE_C)).toBe("deleted");
  });
});

describe("findActiveContainerIdsSharingName — real SQL status filter (#15826)", () => {
  test("returns only rows that still expect a live container, excluding the target row", async () => {
    const SELF = "00000000-0000-0000-0000-0000000000c0";
    const byStatus: Record<string, string> = {
      pending: "00000000-0000-0000-0000-0000000000c1",
      building: "00000000-0000-0000-0000-0000000000c2",
      deploying: "00000000-0000-0000-0000-0000000000c3",
      running: "00000000-0000-0000-0000-0000000000c4",
      stopped: "00000000-0000-0000-0000-0000000000c5",
      failed: "00000000-0000-0000-0000-0000000000c6",
      deleting: "00000000-0000-0000-0000-0000000000c7",
      deleted: "00000000-0000-0000-0000-0000000000c8",
    };
    const ORG_D = "00000000-0000-0000-0000-0000000000a4";
    await insertContainer({ id: SELF, name: "app-ddd", organizationId: ORG_D, status: "deleting" });
    for (const [status, id] of Object.entries(byStatus)) {
      await insertContainer({ id, name: "app-ddd", organizationId: ORG_D, status });
    }
    // A same-status row under a DIFFERENT name never matters.
    await insertContainer({
      id: "00000000-0000-0000-0000-0000000000c9",
      name: "app-other",
      organizationId: ORG_D,
      status: "running",
    });

    const ids = await findActiveContainerIdsSharingName(database, "app-ddd", SELF);

    expect([...ids].sort()).toEqual(
      [byStatus.pending, byStatus.building, byStatus.deploying, byStatus.running].sort(),
    );
  });
});
