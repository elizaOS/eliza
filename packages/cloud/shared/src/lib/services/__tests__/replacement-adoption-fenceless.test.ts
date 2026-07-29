/**
 * Regression proof for #17253 §4: the preserve-and-adopt mechanism was dead
 * code. `transferReplacementToPrimary` built the handle's replacement locator
 * BEFORE checking whether a durable fence exists — and
 * `replacementLocatorFromHandle` THROWS on any handle without replacement
 * metadata, which is every ADOPTED handle (a preserved container from a
 * provision retry, #15310 §6). Every adoption therefore died on "no durable
 * Docker placement metadata", the healthy container was torn down, and the
 * agent hard-failed — the exact SSH-blip scenario the mechanism was built for.
 *
 * Drives the REAL private method against in-process PGlite (real Drizzle
 * schema via pushSchema; the established private-access cast). Fails LOUDLY
 * if PGlite/pushSchema is unavailable (never silently passes).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
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

let pgliteReady = true;
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
    })
    .returning();
  return { id: rec.id, orgId: org.id };
}

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    pgliteReady = false;
    console.warn("[replacement-adoption-fenceless.test] non-PGlite DATABASE_URL; failing.");
    return;
  }
  try {
    ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../../db/client"));
    ({ ElizaSandboxService } = await import("../eliza-sandbox"));
    const schema = { organizations, users, userCharacters, agentSandboxes };
    const { apply } = await pushSchema(schema as never, dbWrite as never);
    await apply();
  } catch (error) {
    pgliteReady = false;
    console.error(
      "[replacement-adoption-fenceless.test] PGlite/pushSchema unavailable — failing.",
      error,
    );
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  if (closeDb) await closeDb();
});

describe("fence-less replacement adoption (#17253 §4)", () => {
  test(
    "an ADOPTED handle (no replacement metadata) completes the transfer",
    async () => {
      expect(pgliteReady).toBe(true);
      const { id, orgId } = await seedProvisioningAgent({ sandboxId: "agent-preserved" });
      const svc = new ElizaSandboxService() as unknown as AdoptionInternals;

      // The preserved container's handle: docker-backed, same sandboxId the
      // row already owns, and — by construction of adoption — NO replacement
      // metadata for replacementLocatorFromHandle to read.
      const adopted = await svc.transferReplacementToPrimary(
        id,
        orgId,
        {
          sandboxId: "agent-preserved",
          bridgeUrl: "https://runtime.example",
          healthUrl: "https://runtime.example/health",
          metadata: { provider: "docker", nodeId: "node-1", containerName: "agent-preserved" },
        },
        0,
        { status: "running" },
      );

      // Pre-fix this threw "no durable Docker placement metadata" before the
      // fence-less branch could run, and the healthy container was torn down.
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
      expect(pgliteReady).toBe(true);
      const { id, orgId } = await seedProvisioningAgent({ sandboxId: "agent-original" });
      const svc = new ElizaSandboxService() as unknown as AdoptionInternals;

      await expect(
        svc.transferReplacementToPrimary(
          id,
          orgId,
          {
            sandboxId: "agent-imposter",
            bridgeUrl: "https://runtime.example",
            healthUrl: "https://runtime.example/health",
            metadata: { provider: "docker", nodeId: "node-1", containerName: "agent-imposter" },
          },
          0,
          { status: "running" },
        ),
      ).rejects.toThrow("Docker replacement has no durable cleanup ownership");
    },
    PGLITE_TIMEOUT,
  );
});
