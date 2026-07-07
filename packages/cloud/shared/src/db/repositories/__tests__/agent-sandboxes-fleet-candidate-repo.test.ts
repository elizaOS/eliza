/**
 * Fleet upgrade/rollback candidate selection matches the default image by REPO,
 * not by full ref (#15101), against the REAL Drizzle schema on in-process PGlite.
 *
 * The reconciler passes the current default ref (e.g. `…/eliza-agent:prod`).
 * A fleet-managed agent may be running on any tag or digest of the same repo
 * (`…:sha-abc`, `…@sha256:…`); comparing the full ref skipped those rows, so
 * sha-pinned default agents never drifted back to the current default. These
 * cases prove `imageRepoSql` normalization inside the candidate queries returns
 * same-repo rows and still excludes a genuinely different (custom) repo.
 *
 * Harness mirrors `__tests__/agent-billing-reactivation.test.ts`: drizzle-kit
 * `pushSchema` applies the exact DDL from the real schema objects to the same
 * PGlite connection the repository queries through. Self-skips LOUDLY (never
 * silently passes) when a shared non-PGlite Postgres is the ambient DATABASE_URL.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { pushSchema } from "drizzle-kit/api";
import { closeDatabaseConnectionsForTests, dbWrite } from "../../client";
import { sqlRows } from "../../execute-helpers";
import { agentSandboxes } from "../../schemas/agent-sandboxes";
import { organizations } from "../../schemas/organizations";
import { userCharacters } from "../../schemas/user-characters";
import { users } from "../../schemas/users";
import { AgentSandboxesRepository } from "../agent-sandboxes";

const PGLITE_TIMEOUT = 60_000;
let pgliteReady = true;

const DEFAULT_REPO = "ghcr.io/elizaos/eliza-agent";
const DEFAULT_IMAGE = `${DEFAULT_REPO}:prod`;
const CUSTOM_IMAGE = "ghcr.io/acme/custom-agent:prod";

let seq = 0;
function uniq(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

const repo = new AgentSandboxesRepository();

async function seedOrgAndUser(): Promise<{ organizationId: string; userId: string }> {
  const [org] = await dbWrite
    .insert(organizations)
    .values({ name: "Fleet Org", slug: uniq("org") })
    .returning();
  const [user] = await dbWrite
    .insert(users)
    .values({ steward_user_id: uniq("steward"), organization_id: org.id })
    .returning();
  return { organizationId: org.id, userId: user.id };
}

/**
 * Seed a running, fleet-container agent (node_id + container_name set, no pool)
 * on a specific docker_image/image_digest so the candidate queries can select it.
 */
async function seedFleetAgent(
  organizationId: string,
  userId: string,
  fields: {
    dockerImage: string | null;
    imageDigest: string | null;
    previousImageDigest?: string | null;
  },
): Promise<string> {
  const [row] = await dbWrite
    .insert(agentSandboxes)
    .values({
      organization_id: organizationId,
      user_id: userId,
      agent_name: uniq("agent"),
      status: "running",
      execution_tier: "dedicated-always",
      node_id: uniq("node"),
      container_name: uniq("container"),
      docker_image: fields.dockerImage,
      image_digest: fields.imageDigest,
      previous_image_digest: fields.previousImageDigest ?? null,
    })
    .returning();
  return row.id;
}

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    pgliteReady = false;
    console.warn(
      "[agent-sandboxes-fleet-candidate-repo.test] DATABASE_URL is a non-PGlite Postgres (shared CI DB); this in-process-PGlite isolation suite self-skips — drizzle-kit pushSchema against a shared connection crashes the bun runner and would mutate the shared schema.",
    );
    return;
  }
  try {
    const schema = { organizations, users, userCharacters, agentSandboxes };
    const { apply } = await pushSchema(schema as never, dbWrite as never);
    await apply();
  } catch (error) {
    pgliteReady = false;
    console.error(
      "[agent-sandboxes-fleet-candidate-repo.test] PGlite/pushSchema unavailable — cannot drive AgentSandboxesRepository against a real DB. Skipping all cases.",
      error,
    );
  }
}, PGLITE_TIMEOUT);

beforeEach(async () => {
  if (!pgliteReady) return;
  await dbWrite.delete(agentSandboxes);
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("fleet candidate selection matches default image by repo (#15101)", () => {
  test("listRunningWithDigestOtherThan selects same-repo agents pinned to a different tag/digest", async () => {
    if (!pgliteReady) return;
    const { organizationId, userId } = await seedOrgAndUser();

    // Same repo, older tag — this is the row the pre-fix full-ref compare wrongly skipped.
    const olderTag = await seedFleetAgent(organizationId, userId, {
      dockerImage: `${DEFAULT_REPO}:sha-oldabc`,
      imageDigest: "sha256:stale-1",
    });
    // Same repo, digest-pinned ref — also a fleet agent.
    const digestPinned = await seedFleetAgent(organizationId, userId, {
      dockerImage: `${DEFAULT_REPO}@sha256:deadbeef`,
      imageDigest: "sha256:stale-2",
    });
    // Null docker_image — legacy fleet rows are still selected.
    const nullImage = await seedFleetAgent(organizationId, userId, {
      dockerImage: null,
      imageDigest: "sha256:stale-3",
    });
    // Genuinely custom repo — must NOT be selected.
    const custom = await seedFleetAgent(organizationId, userId, {
      dockerImage: CUSTOM_IMAGE,
      imageDigest: "sha256:stale-4",
    });
    // Already on the target digest — excluded by the digest predicate.
    const onTarget = await seedFleetAgent(organizationId, userId, {
      dockerImage: DEFAULT_IMAGE,
      imageDigest: "sha256:target",
    });

    const rows = await repo.listRunningWithDigestOtherThan("sha256:target", DEFAULT_IMAGE, 50);
    const ids = new Set(rows.map((r) => r.id));

    expect(ids.has(olderTag)).toBe(true);
    expect(ids.has(digestPinned)).toBe(true);
    expect(ids.has(nullImage)).toBe(true);
    expect(ids.has(custom)).toBe(false);
    expect(ids.has(onTarget)).toBe(false);
  });

  test("a registry port in the repo is not mistaken for a tag", async () => {
    if (!pgliteReady) return;
    const { organizationId, userId } = await seedOrgAndUser();
    const targetImage = "ghcr.io:443/elizaos/eliza-agent:prod";

    // Same host:port + repo, different tag → same repo, must be selected.
    const samePortRepo = await seedFleetAgent(organizationId, userId, {
      dockerImage: "ghcr.io:443/elizaos/eliza-agent:sha-old",
      imageDigest: "sha256:stale-a",
    });
    // A different registry PORT is a different repo → must NOT be selected.
    const otherPort = await seedFleetAgent(organizationId, userId, {
      dockerImage: "ghcr.io:8443/elizaos/eliza-agent:prod",
      imageDigest: "sha256:stale-b",
    });

    const rows = await repo.listRunningWithDigestOtherThan("sha256:target", targetImage, 50);
    const ids = new Set(rows.map((r) => r.id));

    expect(ids.has(samePortRepo)).toBe(true);
    expect(ids.has(otherPort)).toBe(false);
  });

  test("listRollbackEligibleForDigest matches same-repo agents by repo, excludes custom", async () => {
    if (!pgliteReady) return;
    const { organizationId, userId } = await seedOrgAndUser();

    // Rollback-eligible: on the current digest, has a previous digest, same repo
    // but a different tag than the target ref.
    const eligible = await seedFleetAgent(organizationId, userId, {
      dockerImage: `${DEFAULT_REPO}:sha-current`,
      imageDigest: "sha256:current",
      previousImageDigest: "sha256:prev",
    });
    // Same digest + previous, but a CUSTOM repo — must NOT roll back onto the fleet ref.
    const custom = await seedFleetAgent(organizationId, userId, {
      dockerImage: CUSTOM_IMAGE,
      imageDigest: "sha256:current",
      previousImageDigest: "sha256:prev",
    });
    // Same repo/digest but NO previous digest — nothing to roll back to.
    const noPrevious = await seedFleetAgent(organizationId, userId, {
      dockerImage: DEFAULT_IMAGE,
      imageDigest: "sha256:current",
      previousImageDigest: null,
    });

    const rows = await repo.listRollbackEligibleForDigest("sha256:current", DEFAULT_IMAGE, 50);
    const ids = new Set(rows.map((r) => r.id));

    expect(ids.has(eligible)).toBe(true);
    expect(ids.has(custom)).toBe(false);
    expect(ids.has(noPrevious)).toBe(false);
  });
});

describe("imageRepoSql matches imageRepo across ref shapes (#15101)", () => {
  test("SQL normalization agrees with the JS guard for every ref shape", async () => {
    if (!pgliteReady) return;
    const { imageRepo, imageRepoSql } = await import("../../utils/docker-image-ref");
    const cases = [
      "ghcr.io/elizaos/eliza-agent:prod",
      "ghcr.io/elizaos/eliza-agent:sha-old",
      "ghcr.io/elizaos/eliza-agent@sha256:deadbeef",
      "ghcr.io/elizaos/eliza-agent",
      "ghcr.io:443/elizaos/eliza-agent:prod",
      "ghcr.io:443/elizaos/eliza-agent",
      "localhost:5000/img:tag",
      "img:tag",
      "img",
    ];
    for (const ref of cases) {
      const [row] = await sqlRows<{ repo: string }>(
        dbWrite,
        sql`SELECT ${imageRepoSql(sql`${ref}`)} AS repo`,
      );
      expect(row.repo).toBe(imageRepo(ref));
    }
  });
});
