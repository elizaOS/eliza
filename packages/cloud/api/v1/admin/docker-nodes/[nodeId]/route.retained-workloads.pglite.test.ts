import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { agentSandboxes } from "@elizaos/cloud-shared/db/schemas/agent-sandboxes";
import { containers } from "@elizaos/cloud-shared/db/schemas/containers";
import { dockerNodes } from "@elizaos/cloud-shared/db/schemas/docker-nodes";
import * as realAuth from "@elizaos/cloud-shared/lib/auth";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

mock.module("@elizaos/cloud-shared/lib/auth", () => ({
  ...realAuth,
  requireAdmin: async () => ({ user: { id: "admin" }, role: "super_admin" }),
}));

const { closeDatabaseConnectionsForTests, dbWrite } = await import(
  "@elizaos/cloud-shared/db/client"
);
const { default: nodeRoute }: { default: Hono<AppEnv> } = await import(
  "./route"
);

const app = new Hono<AppEnv>();
app.route("/api/v1/admin/docker-nodes/:nodeId", nodeRoute);

const NODE_ID = "retained-delete-node";

async function deleteNode(): Promise<{ status: number; body: unknown }> {
  const response = await app.request(`/api/v1/admin/docker-nodes/${NODE_ID}`, {
    method: "DELETE",
  });
  return { status: response.status, body: await response.json() };
}

async function nodeRowCount(): Promise<number> {
  const result = await dbWrite.execute(
    sql.raw(
      `SELECT count(*)::int AS n FROM docker_nodes WHERE node_id = '${NODE_ID}'`,
    ),
  );
  return (result.rows[0] as { n: number }).n;
}

beforeAll(async () => {
  for (const table of [dockerNodes, containers, agentSandboxes]) {
    const config = getTableConfig(table);
    await dbWrite.execute(
      sql.raw(
        `CREATE TABLE ${config.name} (${config.columns
          .map((column) => `"${column.name}" ${column.getSQLType()}`)
          .join(",")})`,
      ),
    );
  }
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

beforeEach(async () => {
  await dbWrite.execute(
    sql.raw("TRUNCATE TABLE docker_nodes, containers, agent_sandboxes"),
  );
  await dbWrite.execute(
    sql.raw(
      `INSERT INTO docker_nodes (id, node_id, hostname)
       VALUES ('00000000-0000-4000-8000-000000000001', '${NODE_ID}', '10.0.0.5')`,
    ),
  );
});

describe("DELETE /api/v1/admin/docker-nodes/:nodeId", () => {
  test("refuses to remove a node that still hosts an app container", async () => {
    await dbWrite.execute(
      sql.raw(
        `INSERT INTO containers (id, name, project_name, node_id, status)
         VALUES ('00000000-0000-4000-8000-000000000002', 'app', 'app', '${NODE_ID}', 'running')`,
      ),
    );

    const { status, body } = await deleteNode();

    expect(status).toBe(409);
    expect(body).toEqual({
      success: false,
      error: `Cannot remove node '${NODE_ID}': 1 retained workload(s) still hold state on it. Stop, migrate, or delete them first.`,
    });
    expect(await nodeRowCount()).toBe(1);
  });

  test("refuses to remove a node holding a stopped agent's retained runtime", async () => {
    await dbWrite.execute(
      sql.raw(
        `INSERT INTO agent_sandboxes (id, node_id, status, retained_runtime)
         VALUES ('00000000-0000-4000-8000-000000000003', '${NODE_ID}', 'stopped',
           '{"runtime":{"nodeId":"${NODE_ID}","containerName":"agent-x"}}'::jsonb)`,
      ),
    );

    const { status, body } = await deleteNode();

    expect(status).toBe(409);
    expect(body).toEqual({
      success: false,
      error: `Cannot remove node '${NODE_ID}': 1 retained workload(s) still hold state on it. Stop, migrate, or delete them first.`,
    });
    expect(await nodeRowCount()).toBe(1);
  });

  test("removes a node whose only rows are deleted containers and plain stopped agents", async () => {
    await dbWrite.execute(
      sql.raw(
        `INSERT INTO containers (id, name, project_name, node_id, status)
         VALUES ('00000000-0000-4000-8000-000000000004', 'gone', 'gone', '${NODE_ID}', 'deleted')`,
      ),
    );
    await dbWrite.execute(
      sql.raw(
        `INSERT INTO agent_sandboxes (id, node_id, status)
         VALUES ('00000000-0000-4000-8000-000000000005', '${NODE_ID}', 'stopped')`,
      ),
    );

    const { status, body } = await deleteNode();

    expect(status).toBe(200);
    expect(body).toEqual({
      success: true,
      data: { nodeId: NODE_ID, deleted: true },
    });
    expect(await nodeRowCount()).toBe(0);
  });
});
