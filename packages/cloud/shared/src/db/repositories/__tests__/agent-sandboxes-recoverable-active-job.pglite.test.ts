/**
 * `listRecoverable` feeds the disconnected-agent recovery pass. A row whose
 * reprovision job is still pending already has an owner driving it back to
 * health; selecting it lets the recovery probe race that job and, under the
 * batch cap, lets queued rows crowd out agents that no job is fixing yet.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

import { closeDatabaseConnectionsForTests, getPgliteClientForTests } from "../../client";
import { agentSandboxesRepository } from "../agent-sandboxes";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000002";
const WITH_PENDING_JOB = "00000000-0000-4000-8000-0000000000a1";
const WITH_COMPLETED_JOB = "00000000-0000-4000-8000-0000000000a2";
const NO_JOB = "00000000-0000-4000-8000-0000000000a3";

async function installSchema(): Promise<void> {
  const client = getPgliteClientForTests();
  await client.exec(`
    CREATE TABLE agent_sandboxes (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL,
      user_id uuid NOT NULL,
      agent_name text,
      bridge_url text,
      lifecycle_revision integer NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL DEFAULT now(),
      status text NOT NULL DEFAULT 'pending',
      execution_tier text NOT NULL DEFAULT 'shared',
      previous_image_digest text,
      error_message text,
      deleted_at timestamptz
    );
    CREATE TABLE jobs (
      id uuid PRIMARY KEY,
      type text NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      agent_id text,
      organization_id uuid NOT NULL,
      execution_generation uuid,
      execution_quiesced_at timestamptz
    );
  `);
}

async function insertSandbox(id: string, status: string): Promise<void> {
  await getPgliteClientForTests().exec(`
    INSERT INTO agent_sandboxes
      (id, organization_id, user_id, agent_name, bridge_url, status, execution_tier)
    VALUES
      ('${id}', '${ORG_ID}', '${USER_ID}', 'agent-${id.slice(-2)}',
       'https://bridge-${id.slice(-2)}.example.test', '${status}', 'dedicated-always');
  `);
}

async function insertJob(id: string, status: string, agentId: string): Promise<void> {
  await getPgliteClientForTests().exec(`
    INSERT INTO jobs (id, type, status, agent_id, organization_id)
    VALUES ('${id}', 'agent_provision', '${status}', '${agentId}', '${ORG_ID}');
  `);
}

beforeAll(async () => {
  await installSchema();
}, 120_000);

beforeEach(async () => {
  const client = getPgliteClientForTests();
  await client.exec("DELETE FROM jobs; DELETE FROM agent_sandboxes;");
  await insertSandbox(WITH_PENDING_JOB, "disconnected");
  await insertSandbox(WITH_COMPLETED_JOB, "disconnected");
  await insertSandbox(NO_JOB, "disconnected");
  await insertJob("00000000-0000-4000-8000-0000000000b1", "pending", WITH_PENDING_JOB);
  await insertJob("00000000-0000-4000-8000-0000000000b2", "completed", WITH_COMPLETED_JOB);
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("listRecoverable", () => {
  test("skips disconnected rows whose reprovision job is still pending", async () => {
    const rows = await agentSandboxesRepository.listRecoverable(10);
    const ids = rows.map((row) => row.id).sort();
    expect(ids).toEqual([WITH_COMPLETED_JOB, NO_JOB].sort());
  });

  test("keeps rows with no active provisioning owner", async () => {
    const rows = await agentSandboxesRepository.listRecoverable(10);
    expect(rows.some((row) => row.id === WITH_COMPLETED_JOB)).toBe(true);
    expect(rows.some((row) => row.id === NO_JOB)).toBe(true);
  });
});
