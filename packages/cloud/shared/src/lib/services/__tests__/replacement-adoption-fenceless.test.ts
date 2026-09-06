/**
 * Proves that replacement adoption accepts preserved Docker handles without a
 * durable replacement fence while rejecting handles that do not match the primary row.
 * The service and repository run against the real Drizzle schema in isolated PGlite.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL;
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === undefined || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { pushSchema } from "drizzle-kit/api";
import { sql } from "drizzle-orm";
import { agentSandboxes } from "../../../db/schemas/agent-sandboxes";
import { organizations } from "../../../db/schemas/organizations";
import { userCharacters } from "../../../db/schemas/user-characters";
import { users } from "../../../db/schemas/users";

const PGLITE_TIMEOUT = 60_000;

let dbWrite: typeof import("../../../db/client").dbWrite;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests | undefined;
let ElizaSandboxService: typeof import("../eliza-sandbox").ElizaSandboxService;

type AdoptionInternals = {
  transferReplacementToPrimary: (
    agentId: string,
    orgId: string,
    handle: {
      sandboxId: string;
      bridgeUrl: string;
      healthUrl: string;
      metadata?: Record<string, unknown>;
    },
    expectedEnvironmentRevision: number,
    updateData: Record<string, unknown>,
  ) => Promise<{ id: string; status: string }>;
};

let seq = 0;
function uniq(p: string): string {
  seq += 1;
  return `${p}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

async function seedProvisioningAgent(params: {
  sandboxId: string | null;
  nodeId: string | null;
  containerName: string | null;
}): Promise<{ id: string; orgId: string }> {
  const [org] = await dbWrite
    .insert(organizations)
    .values({ name: "Org", slug: uniq("org"), credit_balance: "1.000000" })
    .returning();
  const [user] = await dbWrite
    .insert(users)
    .values({ steward_user_id: uniq("steward"), organization_id: org.id })
    .returning();
  const [rec] = await dbWrite
    .insert(agentSandboxes)
    .values({
      organization_id: org.id,
      user_id: user.id,
      agent_name: uniq("adopt"),
      status: "provisioning",
      execution_tier: "dedicated-always",
      environment_revision: 0,
      sandbox_id: params.sandboxId,
      node_id: params.nodeId,
      container_name: params.containerName,
    })
    .returning();
  return { id: rec.id, orgId: org.id };
}

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    throw new Error("Replacement-adoption tests require an isolated PGlite database");
  }
  ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../../db/client"));
  ({ ElizaSandboxService } = await import("../eliza-sandbox"));
  const schema = { organizations, users, userCharacters, agentSandboxes };
  const { apply } = await pushSchema(schema as never, dbWrite as never);
  await apply();
}, PGLITE_TIMEOUT);

afterAll(async () => {
  if (closeDb) await closeDb();
});

describe("fence-less replacement adoption (#17253 §4)", () => {
  test(
    "publication retains provider identity while clearing its temporary fence",
    async () => {
      const { id, orgId } = await seedProvisioningAgent({
        sandboxId: null,
        nodeId: null,
        containerName: null,
      });
      const containerName = `agent-${id}`;
      const attemptId = crypto.randomUUID();
      const nodeRecordId = crypto.randomUUID();
      const registeredAt = "2026-09-06T00:00:00.000Z";
      await dbWrite.execute(sql`UPDATE agent_sandboxes SET
      replacement_cleanup_sandbox_id = ${containerName}, replacement_cleanup_node_id = 'node-1',
      replacement_cleanup_container_name = ${containerName}, replacement_cleanup_attempt_id = ${attemptId},
      replacement_cleanup_container_id = ${"a".repeat(64)}, replacement_cleanup_vpn_node_id = '42',
      replacement_cleanup_vpn_node_name = ${containerName}, replacement_cleanup_vpn_registration_started_at = ${registeredAt},
      replacement_cleanup_allocation_counted = true, replacement_cleanup_created_at = now()
      WHERE id = ${id}`);
      const svc = new ElizaSandboxService() as unknown as AdoptionInternals;
      await svc.transferReplacementToPrimary(
        id,
        orgId,
        {
          sandboxId: containerName,
          bridgeUrl: "https://runtime.example",
          healthUrl: "https://runtime.example/health",
          metadata: {
            provider: "docker",
            agentId: id,
            nodeId: "node-1",
            hostname: "captured.example",
            containerName,
            volumePath: `/data/agents/${id}`,
            dockerImage: "fixture:latest",
            imageDigest: null,
            bridgePort: 19000,
            webUiPort: 21000,
            replacementAttemptId: attemptId,
            containerId: "a".repeat(64),
            vpnNodeId: "42",
            vpnNodeName: containerName,
            vpnRegistrationStartedAt: registeredAt,
            allocationCounted: true,
            nodeRecordId,
            nodeSshPort: 2222,
            nodeSshUser: "operator",
            nodeHostKeyFingerprint: "SHA256:captured",
            replacementSecretCleanupVersion: 1,
          },
        },
        0,
        {
          status: "running",
          sandbox_id: containerName,
          node_id: "node-1",
          container_name: containerName,
        },
      );
      const row = await dbWrite.query.agentSandboxes.findFirst({
        where: sql`${agentSandboxes.id} = ${id}`,
      });
      expect(row?.replacement_cleanup_sandbox_id).toBeNull();
      expect(row?.replacement_cleanup_vpn_node_id).toBeNull();
      expect(row?.serving_placement).toMatchObject({
        version: 1,
        volumePath: `/data/agents/${id}`,
        locator: {
          sandboxId: containerName,
          containerId: "a".repeat(64),
          replacementAttemptId: attemptId,
          nodeRecordId,
          nodeHostname: "captured.example",
          nodeSshPort: 2222,
          nodeSshUser: "operator",
          nodeHostKeyFingerprint: "SHA256:captured",
          vpnNodeId: "42",
          vpnRegistrationStartedAt: registeredAt,
          replacementSecretCleanupVersion: 1,
        },
      });
      await dbWrite.execute(
        sql`UPDATE agent_sandboxes SET status = 'provisioning' WHERE id = ${id}`,
      );
      await svc.transferReplacementToPrimary(
        id,
        orgId,
        {
          sandboxId: containerName,
          bridgeUrl: "https://runtime.example",
          healthUrl: "https://runtime.example/health",
          metadata: {
            provider: "docker",
            nodeId: "node-1",
            hostname: "captured.example",
            containerName,
          },
        },
        0,
        { status: "running" },
      );
      const retried = await dbWrite.query.agentSandboxes.findFirst({
        where: sql`${agentSandboxes.id} = ${id}`,
      });
      expect(retried?.serving_placement).toEqual(row?.serving_placement);
      await dbWrite.execute(
        sql`UPDATE agent_sandboxes SET status = 'provisioning', node_id = 'node-retargeted' WHERE id = ${id}`,
      );
      await expect(
        svc.transferReplacementToPrimary(
          id,
          orgId,
          {
            sandboxId: containerName,
            bridgeUrl: "https://runtime.example",
            healthUrl: "https://runtime.example/health",
            metadata: {
              provider: "docker",
              nodeId: "node-retargeted",
              hostname: "replacement.example",
              containerName,
            },
          },
          0,
          { status: "running" },
        ),
      ).rejects.toThrow("Preserved handle conflicts with its serving placement receipt");
      const rejected = await dbWrite.query.agentSandboxes.findFirst({
        where: sql`${agentSandboxes.id} = ${id}`,
      });
      expect(rejected?.status).toBe("provisioning");
      expect(rejected?.serving_placement).toEqual(row?.serving_placement);
      await dbWrite.execute(sql`UPDATE agent_sandboxes SET node_id = 'node-1' WHERE id = ${id}`);
      await expect(
        svc.transferReplacementToPrimary(
          id,
          orgId,
          {
            sandboxId: containerName,
            bridgeUrl: "https://runtime.example",
            healthUrl: "https://runtime.example/health",
            metadata: {
              provider: "docker",
              nodeId: "node-1",
              hostname: "captured.example",
              containerName,
              containerId: "b".repeat(64),
            },
          },
          0,
          { status: "running" },
        ),
      ).rejects.toThrow("Preserved handle conflicts with its serving placement receipt");
      const wrongContainer = await dbWrite.query.agentSandboxes.findFirst({
        where: sql`${agentSandboxes.id} = ${id}`,
      });
      expect(wrongContainer?.status).toBe("provisioning");
      expect(wrongContainer?.serving_placement).toEqual(row?.serving_placement);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "an ADOPTED handle (no replacement metadata) completes the transfer",
    async () => {
      const { id, orgId } = await seedProvisioningAgent({
        sandboxId: "agent-preserved",
        nodeId: "node-1",
        containerName: "agent-preserved",
      });
      const svc = new ElizaSandboxService() as unknown as AdoptionInternals;

      // Preserved retry handles intentionally omit replacement metadata because
      // their identity is already recorded on the primary row.
      const adopted = await svc.transferReplacementToPrimary(
        id,
        orgId,
        {
          sandboxId: "agent-preserved",
          bridgeUrl: "https://runtime.example",
          healthUrl: "https://runtime.example/health",
          metadata: {
            provider: "docker",
            nodeId: "node-1",
            hostname: "node-1.example",
            containerName: "agent-preserved",
          },
        },
        0,
        { status: "running" },
      );

      expect(adopted.status).toBe("running");
      const row = await dbWrite.query.agentSandboxes.findFirst({
        where: sql`${agentSandboxes.id} = ${id}`,
      });
      expect(row?.status).toBe("running");
    },
    PGLITE_TIMEOUT,
  );

  test(
    "a fence-less docker handle whose sandboxId does NOT match is still refused",
    async () => {
      const { id, orgId } = await seedProvisioningAgent({
        sandboxId: "agent-original",
        nodeId: "node-1",
        containerName: "agent-original",
      });
      const svc = new ElizaSandboxService() as unknown as AdoptionInternals;

      await expect(
        svc.transferReplacementToPrimary(
          id,
          orgId,
          {
            sandboxId: "agent-imposter",
            bridgeUrl: "https://runtime.example",
            healthUrl: "https://runtime.example/health",
            metadata: {
              provider: "docker",
              nodeId: "node-1",
              hostname: "node-1.example",
              containerName: "agent-original",
            },
          },
          0,
          { status: "running" },
        ),
      ).rejects.toThrow("Docker replacement has no durable cleanup ownership");
    },
    PGLITE_TIMEOUT,
  );

  test(
    "a fence-less docker handle on a different node is refused",
    async () => {
      const { id, orgId } = await seedProvisioningAgent({
        sandboxId: "agent-preserved",
        nodeId: "node-1",
        containerName: "agent-preserved",
      });
      const svc = new ElizaSandboxService() as unknown as AdoptionInternals;

      await expect(
        svc.transferReplacementToPrimary(
          id,
          orgId,
          {
            sandboxId: "agent-preserved",
            bridgeUrl: "https://runtime.example",
            healthUrl: "https://runtime.example/health",
            metadata: {
              provider: "docker",
              nodeId: "node-2",
              hostname: "node-2.example",
              containerName: "agent-preserved",
            },
          },
          0,
          { status: "running" },
        ),
      ).rejects.toThrow("Docker replacement has no durable cleanup ownership");
    },
    PGLITE_TIMEOUT,
  );

  test(
    "a fence-less docker handle with incomplete placement metadata is refused",
    async () => {
      const { id, orgId } = await seedProvisioningAgent({
        sandboxId: "agent-preserved",
        nodeId: "node-1",
        containerName: "agent-preserved",
      });
      const svc = new ElizaSandboxService() as unknown as AdoptionInternals;

      await expect(
        svc.transferReplacementToPrimary(
          id,
          orgId,
          {
            sandboxId: "agent-preserved",
            bridgeUrl: "https://runtime.example",
            healthUrl: "https://runtime.example/health",
            metadata: {
              provider: "docker",
              nodeId: "node-1",
              containerName: "agent-preserved",
            },
          },
          0,
          { status: "running" },
        ),
      ).rejects.toThrow("Docker replacement has no durable cleanup ownership");
    },
    PGLITE_TIMEOUT,
  );

  test(
    "a fence-less docker handle with a different container name is refused",
    async () => {
      const { id, orgId } = await seedProvisioningAgent({
        sandboxId: "agent-preserved",
        nodeId: "node-1",
        containerName: "agent-preserved",
      });
      const svc = new ElizaSandboxService() as unknown as AdoptionInternals;

      await expect(
        svc.transferReplacementToPrimary(
          id,
          orgId,
          {
            sandboxId: "agent-preserved",
            bridgeUrl: "https://runtime.example",
            healthUrl: "https://runtime.example/health",
            metadata: {
              provider: "docker",
              nodeId: "node-1",
              hostname: "node-1.example",
              containerName: "agent-imposter",
            },
          },
          0,
          { status: "running" },
        ),
      ).rejects.toThrow("Docker replacement has no durable cleanup ownership");
    },
    PGLITE_TIMEOUT,
  );
});
