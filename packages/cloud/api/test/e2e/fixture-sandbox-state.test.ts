/**
 * Proves the real E2E preload writes inert fixture sandboxes to Postgres and
 * the live backup-cron route does not enqueue them as reachable agents.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { agentSandboxesRepository } from "@elizaos/cloud-shared/db/repositories/agent-sandboxes";
import { Client } from "pg";
import { api, cronHeaders } from "./_helpers/api";
import { ensureFixtureSandbox } from "./fixture-sandbox";

const FIXTURE_SANDBOX_IDS = [
  "playwright-e2e-org-sandbox",
  "playwright-e2e-member-org-sandbox",
  "playwright-e2e-affiliate-org-sandbox",
];

const client = new Client({
  connectionString: process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL,
});

beforeAll(async () => {
  await client.connect();
});

afterAll(async () => {
  await client.end();
});

describe("E2E fixture sandbox lifecycle", () => {
  test("the preload stores fixtures as stopped with no runtime endpoint", async () => {
    const result = await client.query<{
      sandbox_id: string;
      status: string;
      bridge_url: string | null;
      health_url: string | null;
    }>(
      `SELECT sandbox_id, status, bridge_url, health_url
       FROM agent_sandboxes
       WHERE sandbox_id = ANY($1::text[])
       ORDER BY sandbox_id`,
      [FIXTURE_SANDBOX_IDS],
    );

    expect(result.rows).toHaveLength(FIXTURE_SANDBOX_IDS.length);
    expect(result.rows).toEqual(
      result.rows.map((row) => ({
        sandbox_id: row.sandbox_id,
        status: "stopped",
        bridge_url: null,
        health_url: null,
      })),
    );
  });

  test("a repeated preload repairs an existing running sentinel through the real repository", async () => {
    const poisoned = await client.query<{
      organization_id: string;
      user_id: string;
    }>(
      `UPDATE agent_sandboxes
       SET status = 'running',
           bridge_url = 'http://127.0.0.1:65535',
           health_url = 'http://127.0.0.1:65535/health'
       WHERE sandbox_id = 'playwright-e2e-org-sandbox'
       RETURNING organization_id, user_id`,
    );
    const fixtureOwner = poisoned.rows[0];
    if (!fixtureOwner) {
      throw new Error("Expected the owner fixture sandbox to exist");
    }

    const sandboxes = await agentSandboxesRepository.listByOrganization(
      fixtureOwner.organization_id,
    );
    await ensureFixtureSandbox({
      slug: "playwright-e2e-org",
      organizationId: fixtureOwner.organization_id,
      userId: fixtureOwner.user_id,
      sandboxes,
      repository: agentSandboxesRepository,
    });

    const repaired = await client.query<{
      status: string;
      bridge_url: string | null;
      health_url: string | null;
    }>(
      `SELECT status, bridge_url, health_url
       FROM agent_sandboxes
       WHERE sandbox_id = 'playwright-e2e-org-sandbox'`,
    );
    expect(repaired.rows).toEqual([
      { status: "stopped", bridge_url: null, health_url: null },
    ]);
  });

  test("the real backup cron scans zero fixture agents", async () => {
    const response = await api.post(
      "/api/v1/cron/agent-backups?intervalMs=1",
      {},
      { headers: cronHeaders() },
    );
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toMatchObject({
      success: true,
      scanned: 0,
      enqueued: 0,
    });
  });
});
