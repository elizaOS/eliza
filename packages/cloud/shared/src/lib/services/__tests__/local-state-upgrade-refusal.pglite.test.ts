/** Drives the real fleet-upgrade entrypoint on PGlite to prove a local-state agent is never cut over to a fresh replacement volume (#31334). */

import { afterAll, beforeAll, expect, test } from "bun:test";

const ambientDatabaseUrl = process.env.DATABASE_URL ?? "";
if (ambientDatabaseUrl && !ambientDatabaseUrl.startsWith("pglite")) {
  throw new Error(
    "local-state-upgrade-refusal.pglite.test requires an isolated PGlite DATABASE_URL",
  );
}
process.env.DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

import { pushSchema } from "drizzle-kit/api";
import { eq, sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { agentSandboxes } from "../../../db/schemas/agent-sandboxes";
import { dockerNodes } from "../../../db/schemas/docker-nodes";
import { organizations } from "../../../db/schemas/organizations";
import { userCharacters } from "../../../db/schemas/user-characters";
import { users } from "../../../db/schemas/users";

const TEST_TIMEOUT = 120_000;
const FROM_DIGEST = `sha256:${"a".repeat(64)}`;
const TO_DIGEST = `sha256:${"b".repeat(64)}`;
const FLEET_IMAGE = "ghcr.io/elizaos/eliza:sha-candidate";

let dbWrite: typeof import("../../../db/client").dbWrite;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests;
let ElizaSandboxService: typeof import("../eliza-sandbox").ElizaSandboxService;

let sequence = 0;
function unique(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}-${Math.random().toString(36).slice(2, 8)}`;
}

beforeAll(async () => {
  ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../../db/client"));
  ({ ElizaSandboxService } = await import("../eliza-sandbox"));
  const { apply } = await pushSchema(
    { organizations, users, userCharacters, agentSandboxes } as never,
    dbWrite as never,
  );
  await apply();
  // Placement is only read here; its incarnation-history foreign keys are out of scope.
  await dbWrite.execute(
    sql.raw(
      `CREATE TABLE docker_nodes (${getTableConfig(dockerNodes)
        .columns.map((c) => `"${c.name}" ${c.getSQLType()}`)
        .join(",")})`,
    ),
  );
}, TEST_TIMEOUT);

afterAll(async () => {
  await closeDb();
});

async function seedRunningAgent(environmentVars: Record<string, string>) {
  const [organization] = await dbWrite
    .insert(organizations)
    .values({ name: "Org", slug: unique("org") })
    .returning();
  const [user] = await dbWrite
    .insert(users)
    .values({ steward_user_id: unique("steward"), organization_id: organization.id })
    .returning();
  const [agent] = await dbWrite
    .insert(agentSandboxes)
    .values({
      organization_id: organization.id,
      user_id: user.id,
      agent_name: unique("agent"),
      status: "running",
      execution_tier: "dedicated-always",
      sandbox_id: unique("sandbox"),
      node_id: unique("node"),
      container_name: unique("container"),
      docker_image: `ghcr.io/elizaos/eliza@${FROM_DIGEST}`,
      image_digest: FROM_DIGEST,
      environment_vars: environmentVars,
    })
    .returning();
  return agent;
}

test(
  "a local-state agent upgrade is refused before any placement or container work",
  async () => {
    const agent = await seedRunningAgent({
      ELIZA_AGENT_LOCAL_STATE: "1",
      PGLITE_DATA_DIR: "/root/.eliza/.pgdata",
    });
    const service = new ElizaSandboxService();

    const result = await service.executeUpgrade(
      agent.id,
      agent.organization_id,
      TO_DIGEST,
      FLEET_IMAGE,
      FROM_DIGEST,
    );

    expect(result).toEqual({
      success: false,
      rolledBack: true,
      error:
        "Local-state agent upgrades require a fenced state transfer; refusing blue/green cutover",
    });
    const [after] = await dbWrite
      .select()
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, agent.id));
    expect(after.status).toBe("running");
    expect(after.node_id).toBe(agent.node_id);
    expect(after.container_name).toBe(agent.container_name);
    expect(after.image_digest).toBe(FROM_DIGEST);
    expect(after.replacement_cleanup_sandbox_id).toBeNull();
  },
  TEST_TIMEOUT,
);

test(
  "an agent whose state lives in its own external database proceeds past the local-state gate",
  async () => {
    const agent = await seedRunningAgent({
      ELIZA_AGENT_LOCAL_STATE: "1",
      DATABASE_URL: "postgres://tenant-owned.example/agent",
    });
    const service = new ElizaSandboxService();

    const result = await service.executeUpgrade(
      agent.id,
      agent.organization_id,
      TO_DIGEST,
      FLEET_IMAGE,
      FROM_DIGEST,
    );

    // The next gate resolves the serving node; the unregistered fixture node
    // proves the local-state refusal did not fire for externally stored state.
    expect(result.success).toBe(false);
    expect(result.rolledBack).toBe(true);
    expect(result.error).toBe(`Old node ${agent.node_id} not registered in docker_nodes`);
  },
  TEST_TIMEOUT,
);
