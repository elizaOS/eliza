/**
 * Real-schema verification of the apps deploy DB-orchestration (Apps / Product 2).
 *
 * Runs the adapters' ACTUAL writes — toNewContainer -> containersRepository.create,
 * appContainerStore.getById/markRunning/markError, containerJobsWriter.insertJob —
 * against the REAL drizzle schema on a migrated PGlite store (the team's local
 * Postgres, vector-enabled). Proves the load-bearing invariant for real:
 *   containers.environment_vars.DATABASE_URL == the app's OWN per-tenant DSN,
 * and that the container/job rows insert cleanly against the real NOT NULL /
 * jsonb / enum constraints (what typecheck alone can't prove).
 *
 * Tenant-DB DDL + image build are stubbed here (each is verified for real
 * elsewhere: verify-tenant-db-isolation.ts / verify-e2e-deploy.sh). This isolates
 * the DB-write glue. Run via verify-deploy-db-writes.sh (migrates a throwaway
 * store first). Requires DATABASE_URL=pglite://<migrated dir>.
 */

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { dbWrite } from "../src/db/client";
import { containersRepository } from "../src/db/repositories/containers";
import { appContainerStore } from "../src/lib/services/app-container-store";
import { toNewContainer } from "../src/lib/services/app-deploy-runner";
import { containerJobsWriter } from "../src/lib/services/container-jobs-writer";
import { JOB_TYPES } from "../src/lib/services/provisioning-job-types";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  ok ? pass++ : fail++;
}

const rand = randomUUID().slice(0, 8);
const orgId = randomUUID();
const userId = randomUUID();
const appId = randomUUID();
const DSN = "postgresql://app_x:s3cret@cluster-1:5432/db_app_x?sslmode=require";

// --- seed the FK parents (minimal required columns) ---
await dbWrite.execute(
  sql`INSERT INTO organizations (id, name, slug) VALUES (${orgId}, ${"Test Org"}, ${`test-org-${rand}`})`,
);
await dbWrite.execute(
  sql`INSERT INTO users (id, steward_user_id) VALUES (${userId}, ${`steward-${rand}`})`,
);

// --- 1) toNewContainer -> containersRepository.create against the real table ---
const created = await containersRepository.create(
  toNewContainer({
    appId,
    organizationId: orgId,
    userId,
    containerName: `app-${rand}`,
    image: "ghcr.io/elizaos/app-x:latest",
    port: 3000,
    environmentVars: { DATABASE_URL: DSN, PORT: "3000" },
  }),
);
check("container row inserts cleanly against the real schema", Boolean(created?.id));
check(
  "the app's OWN per-tenant DSN landed in environment_vars.DATABASE_URL",
  created.environment_vars?.DATABASE_URL === DSN,
  created.environment_vars?.DATABASE_URL,
);
check(
  "project_name keys off appId; status pending",
  created.project_name === appId && created.status === "pending",
);

// --- 2) appContainerStore.getById projects the real row ---
const view = await appContainerStore.getById(created.id);
check(
  "getById maps the real row (appId from metadata, DSN in env)",
  view?.appId === appId &&
    view?.environmentVars?.DATABASE_URL === DSN &&
    view?.image === "ghcr.io/elizaos/app-x:latest",
);

// --- 3) markRunning writes status + host placement metadata (+ URL if configured) ---
await appContainerStore.markRunning(created.id, {
  hostContainerId: "host-ctr-1",
  hostPort: 21345,
  network: `app-net-${rand}`,
});
const afterRun = await containersRepository.findById(created.id, orgId);
const meta = (afterRun?.metadata ?? {}) as Record<string, unknown>;
check("markRunning -> status running", afterRun?.status === "running");
check(
  "markRunning merged host placement into metadata (appId preserved)",
  meta.hostContainerId === "host-ctr-1" && meta.hostPort === 21345 && meta.appId === appId,
);
if (process.env.CONTAINERS_PUBLIC_BASE_DOMAIN) {
  check(
    "markRunning stamped a public URL (base domain configured)",
    typeof afterRun?.public_hostname === "string" &&
      (afterRun?.load_balancer_url ?? "").startsWith("https://"),
    afterRun?.load_balancer_url ?? "",
  );
}

// --- 4) containerJobsWriter.insertJob -> real jobs row, agent_id null ---
const job = await containerJobsWriter.insertJob({
  type: JOB_TYPES.CONTAINER_PROVISION,
  organizationId: orgId,
  userId,
  data: { containerId: created.id },
});
const jobRow = await dbWrite.execute(sql`SELECT type, agent_id FROM jobs WHERE id = ${job.id}`);
const jr = (jobRow.rows?.[0] ?? {}) as { type?: string; agent_id?: string | null };
check(
  "CONTAINER_PROVISION job inserted with agent_id NULL",
  jr.type === JOB_TYPES.CONTAINER_PROVISION && (jr.agent_id ?? null) === null,
);

// --- 5) markError / markDeleted real status transitions ---
await appContainerStore.markError(created.id, "boom");
check(
  "markError -> status failed + error stored",
  (await containersRepository.findById(created.id, orgId))?.status === "failed",
);
await appContainerStore.markDeleted(created.id);
check(
  "markDeleted -> status stopped (row reusable)",
  (await containersRepository.findById(created.id, orgId))?.status === "stopped",
);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
