/**
 * A deploy whose container started but never passed the reachability gate
 * exhausts its CONTAINER_PROVISION job. The permanent-failure writeback marks
 * the app failed; the container it left `running` (which the daily container
 * billing charges) is retired with it in the same transaction.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";

const TIMEOUT = 300_000;
let dbWrite: typeof import("../../../db/client").dbWrite;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests;

beforeAll(async () => {
  ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../../db/client"));
  const { getTableConfig } = await import("drizzle-orm/pg-core");
  const { organizations } = await import("../../../db/schemas/organizations");
  const { users } = await import("../../../db/schemas/users");
  const { apps } = await import("../../../db/schemas/apps");
  const { containers } = await import("../../../db/schemas/containers");
  const { jobs } = await import("../../../db/schemas/jobs");
  // The real column sets of the tables the writeback reads and writes, without
  // foreign keys to the rest of the Cloud schema.
  const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
  const seenEnums = new Set<string>();
  for (const table of [organizations, users, apps, containers, jobs]) {
    const config = getTableConfig(table as never);
    for (const column of config.columns) {
      const definition = (
        column as unknown as { enum?: { enumName: string; enumValues: string[] } }
      ).enum;
      if (definition && !seenEnums.has(definition.enumName)) {
        await dbWrite.execute(
          `CREATE TYPE ${quote(definition.enumName)} AS ENUM (${definition.enumValues
            .map((value) => `'${value.replaceAll("'", "''")}'`)
            .join(",")})`,
        );
        seenEnums.add(definition.enumName);
      }
    }
    const literal = (value: unknown): string | null => {
      if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
      if (typeof value === "number" || typeof value === "boolean") return String(value);
      if (value && typeof value === "object" && !("queryChunks" in value))
        return `'${JSON.stringify(value).replaceAll("'", "''")}'`;
      return null;
    };
    const columns = config.columns.map((column) => {
      const fallback = column.getSQLType().startsWith("timestamp") ? "now()" : null;
      const value =
        column.name === "id"
          ? "gen_random_uuid()"
          : (literal((column as unknown as { default?: unknown }).default) ??
            (column.hasDefault ? fallback : null));
      const key = column.name === "id" ? " PRIMARY KEY" : "";
      return `${quote(column.name)} ${column.getSQLType()}${key}${value ? ` DEFAULT ${value}` : ""}`;
    });
    await dbWrite.execute(`CREATE TABLE ${quote(config.name)} (${columns.join(",")})`);
  }
}, TIMEOUT);

afterAll(async () => {
  await closeDb();
});

test(
  "a failed deploy retires the container it left running",
  async () => {
    const { organizations } = await import("../../../db/schemas/organizations");
    const { users } = await import("../../../db/schemas/users");
    const { apps } = await import("../../../db/schemas/apps");
    const { containers } = await import("../../../db/schemas/containers");
    const { jobs } = await import("../../../db/schemas/jobs");
    const { provisioningJobService } = await import("../../../node/provisioning-worker");
    const { JOB_TYPES } = await import("../provisioning-job-types");

    const generation = randomUUID();
    const [organization] = await dbWrite
      .insert(organizations)
      .values({ name: "Deployer", slug: `org-${generation.slice(0, 8)}` })
      .returning();
    const [user] = await dbWrite
      .insert(users)
      .values({ steward_user_id: `deployer-${generation}`, organization_id: organization.id })
      .returning();
    const [app] = await dbWrite
      .insert(apps)
      .values({
        name: "Unreachable app",
        slug: `app-${generation.slice(0, 8)}`,
        organization_id: organization.id,
        created_by_user_id: user.id,
        app_url: "https://unreachable.example.test",
        deployment_status: "deploying",
        metadata: { deploymentGeneration: generation },
      } as never)
      .returning();
    // markRunning happened, then the public URL never answered.
    const [container] = await dbWrite
      .insert(containers)
      .values({
        name: `app-${generation.slice(0, 8)}`,
        project_name: app.id,
        organization_id: organization.id,
        user_id: user.id,
        image_tag: "ghcr.io/example/app:latest",
        status: "running",
        billing_status: "active",
        metadata: { deploymentGeneration: generation },
      } as never)
      .returning();

    const failedJob = {
      id: randomUUID(),
      type: JOB_TYPES.CONTAINER_PROVISION,
      organization_id: organization.id,
      user_id: user.id,
      data: {
        containerId: container.id,
        organizationId: organization.id,
        userId: user.id,
        deploymentGeneration: generation,
      },
    };
    const writeback = (
      provisioningJobService as unknown as {
        buildPermanentFailureWriteback(
          job: unknown,
          errorMsg: string,
        ): ((tx: unknown, job: unknown) => Promise<void>) | undefined;
      }
    ).buildPermanentFailureWriteback(failedJob, "public URL is not HTTP-reachable");
    if (!writeback) throw new Error("CONTAINER_PROVISION has no failure writeback");
    await dbWrite.transaction((tx) => writeback(tx, failedJob));

    const [failedApp] = await dbWrite
      .select({ status: apps.deployment_status })
      .from(apps)
      .where(eq(apps.id, app.id));
    expect(failedApp?.status).toBe("failed");
    // The container leaves the billed `running` state and owns a delete job.
    const [retired] = await dbWrite
      .select({ status: containers.status })
      .from(containers)
      .where(eq(containers.id, container.id));
    expect(retired?.status).toBe("deleting");
    const deleteJobs = await dbWrite
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(eq(jobs.type, JOB_TYPES.CONTAINER_DELETE), eq(jobs.organization_id, organization.id)),
      );
    expect(deleteJobs).toHaveLength(1);
  },
  TIMEOUT,
);
