/**
 * PATCH /api/v1/eliza/agents/:agentId/environment changes only the variables
 * it names. A variable another writer stores while the request is in flight
 * (another patch, a managed-key rotation) must survive. Real route, real
 * sandbox service and real PGlite rows; authentication is stubbed, and the
 * other writer commits from inside the environment encryption step, which
 * every update passes before it takes the agent lock.
 */
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";
process.env.SECRETS_MASTER_KEY ||= "7".repeat(64);

import { organizationEncryptionKeys } from "@elizaos/cloud-shared/db/schemas";
import { agentSandboxes } from "@elizaos/cloud-shared/db/schemas/agent-sandboxes";
import * as realAuth from "@elizaos/cloud-shared/lib/auth";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const AGENT = "33333333-3333-4333-8333-333333333333";

mock.module("@elizaos/cloud-shared/lib/auth", () => ({
  ...realAuth,
  requireAuthOrApiKeyWithOrg: async () => ({
    user: { id: USER, organization_id: ORG },
    apiKey: null,
  }),
}));

let concurrentWrite: (() => Promise<unknown>) | null = null;
// The sandbox service imports this module by relative path; mock that file.
const cryptoPath = resolve(
  import.meta.dir,
  "../../../../../../shared/src/lib/services/agent-env-crypto.ts",
);
const realCrypto = { ...(await import(cryptoPath)) };
const realEncrypt = realCrypto.encryptAgentEnvVarsForStorage;
mock.module(cryptoPath, () => ({
  ...realCrypto,
  encryptAgentEnvVarsForStorage: async (
    organizationId: string,
    environmentVars: Record<string, string>,
  ) => {
    const write = concurrentWrite;
    concurrentWrite = null;
    if (write) await write();
    return realEncrypt(organizationId, environmentVars);
  },
}));

// The table is created below; the schema bootstrap (which also creates every
// table the full sandbox schema references) is not what this test exercises.
const schemaBootstrapPath = resolve(
  import.meta.dir,
  "../../../../../../shared/src/db/ensure-agent-sandbox-schema.ts",
);
const realSchemaBootstrap = { ...(await import(schemaBootstrapPath)) };
mock.module(schemaBootstrapPath, () => ({
  ...realSchemaBootstrap,
  ensureAgentSandboxSchema: async () => undefined,
}));

const { fieldEncryption } = await import(
  resolve(
    import.meta.dir,
    "../../../../../../shared/src/lib/services/field-encryption.ts",
  )
);
const { closeDatabaseConnectionsForTests, dbWrite } = await import(
  "@elizaos/cloud-shared/db/client"
);
const { default: environmentRoute }: { default: Hono<AppEnv> } = await import(
  "./route"
);

const app = new Hono<AppEnv>();
app.route("/api/v1/eliza/agents/:agentId/environment", environmentRoute);

async function storedEnvironment(): Promise<Record<string, string>> {
  const result = await dbWrite.execute(
    sql.raw(
      `SELECT environment_vars FROM agent_sandboxes WHERE id = '${AGENT}'`,
    ),
  );
  return (result.rows[0] as { environment_vars: Record<string, string> })
    .environment_vars;
}

beforeAll(async () => {
  // The sandbox row, and the per-organization key store field encryption uses.
  for (const table of [agentSandboxes, organizationEncryptionKeys]) {
    const config = getTableConfig(table);
    await dbWrite.execute(
      sql.raw(
        `CREATE TABLE ${config.name} (${config.columns
          .map(
            (column) =>
              `"${column.name}" ${column.getSQLType()}${column.name === "id" ? " PRIMARY KEY" : ""}${column.hasDefault && column.name === "id" ? " DEFAULT gen_random_uuid()" : ""}`,
          )
          .join(",")})`,
      ),
    );
  }
  await dbWrite.execute(
    sql.raw(`INSERT INTO agent_sandboxes
      (id, organization_id, user_id, agent_name, status, execution_tier, environment_vars, environment_revision, lifecycle_revision)
      VALUES ('${AGENT}', '${ORG}', '${USER}', 'Ops', 'stopped', 'shared', '{"A":"1"}'::jsonb, 1, 1)`),
  );
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

test("a variable stored by another writer during the request survives the patch", async () => {
  concurrentWrite = () =>
    dbWrite.execute(
      sql.raw(`UPDATE agent_sandboxes
        SET environment_vars = '{"A":"1","C":"3"}'::jsonb,
            environment_revision = environment_revision + 1
        WHERE id = '${AGENT}'`),
    );

  const response = await app.request(
    `/api/v1/eliza/agents/${AGENT}/environment`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ environmentVars: { B: "2", A: null } }),
    },
  );

  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    data: { updatedKeys: string[]; removedKeys: string[] };
  };
  expect(body.data.updatedKeys).toEqual(["B"]);
  expect(body.data.removedKeys).toEqual(["A"]);
  expect(await storedEnvironment()).toEqual({ B: "2", C: "3" });
});

test("a secret set by the patch is stored encrypted, and a removal and a concurrent variable are kept right", async () => {
  await dbWrite.execute(
    sql.raw(
      `UPDATE agent_sandboxes SET environment_vars = '{"OLD_FLAG":"on"}'::jsonb WHERE id = '${AGENT}'`,
    ),
  );
  concurrentWrite = () =>
    dbWrite.execute(
      sql.raw(`UPDATE agent_sandboxes
        SET environment_vars = environment_vars || '{"REGION":"eu"}'::jsonb,
            environment_revision = environment_revision + 1
        WHERE id = '${AGENT}'`),
    );

  const response = await app.request(
    `/api/v1/eliza/agents/${AGENT}/environment`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        environmentVars: { OPENAI_API_KEY: "sk-test-secret", OLD_FLAG: null },
      }),
    },
  );

  expect(response.status).toBe(200);
  const stored = await storedEnvironment();
  expect(Object.keys(stored).sort()).toEqual(["OPENAI_API_KEY", "REGION"]);
  expect(stored.REGION).toBe("eu");
  expect(stored.OPENAI_API_KEY).not.toBe("sk-test-secret");
  expect(fieldEncryption.isEncrypted(stored.OPENAI_API_KEY)).toBe(true);
  expect(await fieldEncryption.decrypt(stored.OPENAI_API_KEY)).toBe(
    "sk-test-secret",
  );
});
