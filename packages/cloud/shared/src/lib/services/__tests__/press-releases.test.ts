/**
 * PR / press distribution domain model (#11818) — real Drizzle schema, in-process PGlite.
 *
 * This exercises the Cloud-owned lifecycle before any external newswire provider
 * exists: draft persistence, idempotent creates/submissions, tenant scoping,
 * embargo/asset validation, submission/distribution/failure transitions, media
 * contacts, and coverage upsert artifacts.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { pushSchema } from "drizzle-kit/api";
import { eq } from "drizzle-orm";
import { closeDatabaseConnectionsForTests, dbWrite } from "../../../db/client";
import { organizations } from "../../../db/schemas/organizations";
import {
  pressCoverage,
  pressMediaContacts,
  pressReleaseDistributions,
  pressReleases,
} from "../../../db/schemas/press-releases";
import { users } from "../../../db/schemas/users";

const PGLITE_TIMEOUT = 60_000;
let pgliteReady = true;
let service: typeof import("../press-releases").pressReleaseService;

let seq = 0;
const uniq = (prefix: string) =>
  `${prefix}-${(seq += 1)}-${Math.random().toString(36).slice(2, 8)}`;

async function seedOrgUser() {
  const [org] = await dbWrite
    .insert(organizations)
    .values({ name: "PR Org", slug: uniq("pr-org") })
    .returning();
  const [user] = await dbWrite
    .insert(users)
    .values({ steward_user_id: uniq("pr-user"), organization_id: org.id })
    .returning();
  return { orgId: org.id, userId: user.id };
}

async function seedReadyRelease() {
  const actor = await seedOrgUser();
  const created = await service.createRelease({
    organizationId: actor.orgId,
    userId: actor.userId,
    title: "Eliza Cloud launches press distribution",
    body: "Eliza Cloud now supports a press release domain workflow.",
    summary: "Launch summary",
    targetRegions: ["US", "US", "EU"],
    assets: [{ url: "https://example.com/press-kit.png", mimeType: "image/png" }],
  });
  expect(created.ok).toBe(true);
  const ready = await service.markReady(created.release!.id, actor.orgId);
  expect(ready.ok).toBe(true);
  return { ...actor, releaseId: created.release!.id };
}

beforeAll(async () => {
  try {
    ({ pressReleaseService: service } = await import("../press-releases"));
    const { apply } = await pushSchema(
      {
        organizations,
        users,
        pressReleases,
        pressReleaseDistributions,
        pressMediaContacts,
        pressCoverage,
      } as never,
      dbWrite as never,
    );
    await apply();
  } catch (error) {
    pgliteReady = false;
    console.error("[press-releases.test] PGlite/pushSchema unavailable.", error);
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("press release domain service (#11818)", () => {
  test("pglite applied (loud)", () => {
    expect(pgliteReady).toBe(true);
  });

  test("creates, lists, and marks a release ready with normalized target regions", async () => {
    if (!pgliteReady) return;
    const actor = await seedOrgUser();
    const created = await service.createRelease({
      organizationId: actor.orgId,
      userId: actor.userId,
      title: "  Product Hunt launch  ",
      body: "  We launched an agent-first cloud.  ",
      targetRegions: ["US", "EU", "US", ""],
      idempotencyKey: uniq("release-key"),
    });

    expect(created.ok).toBe(true);
    expect(created.release?.title).toBe("Product Hunt launch");
    expect(created.release?.target_regions).toEqual(["US", "EU"]);
    expect(created.release?.status).toBe("draft");

    const ready = await service.markReady(created.release!.id, actor.orgId);
    expect(ready.ok).toBe(true);
    expect(ready.release?.status).toBe("ready");

    const listed = await service.listReleases(actor.orgId);
    expect(listed.map((release) => release.id)).toContain(created.release!.id);
  });

  test("create idempotency returns the same release and blocks cross-org key reuse", async () => {
    if (!pgliteReady) return;
    const owner = await seedOrgUser();
    const other = await seedOrgUser();
    const key = uniq("release-key");

    const first = await service.createRelease({
      organizationId: owner.orgId,
      userId: owner.userId,
      title: "Same key",
      body: "The same client key should resume this row.",
      idempotencyKey: key,
    });
    const retry = await service.createRelease({
      organizationId: owner.orgId,
      userId: owner.userId,
      title: "Different title ignored",
      body: "Different body ignored",
      idempotencyKey: key,
    });
    const stolen = await service.createRelease({
      organizationId: other.orgId,
      userId: other.userId,
      title: "Cross org",
      body: "This must fail.",
      idempotencyKey: key,
    });

    expect(first.ok).toBe(true);
    expect(retry.ok).toBe(true);
    expect(retry.release?.id).toBe(first.release?.id);
    expect(stolen.ok).toBe(false);
    expect(stolen.error).toBe("Idempotency key already used");
  });

  test("rejects empty content, past embargoes, and unsafe asset URLs", async () => {
    if (!pgliteReady) return;
    const actor = await seedOrgUser();

    expect(
      await service.createRelease({
        organizationId: actor.orgId,
        userId: actor.userId,
        title: "",
        body: "Body",
      }),
    ).toMatchObject({ ok: false, error: "Title is required" });

    expect(
      await service.createRelease({
        organizationId: actor.orgId,
        userId: actor.userId,
        title: "Past embargo",
        body: "Body",
        embargoAt: new Date(Date.now() - 60_000),
      }),
    ).toMatchObject({ ok: false, error: "Embargo must be in the future" });

    expect(
      await service.createRelease({
        organizationId: actor.orgId,
        userId: actor.userId,
        title: "Bad asset",
        body: "Body",
        assets: [{ url: "file:///tmp/kit.png" }],
      }),
    ).toMatchObject({ ok: false, error: "Asset URL must be HTTP(S)" });
  });

  test("draft updates are tenant-scoped and freeze after ready", async () => {
    if (!pgliteReady) return;
    const owner = await seedOrgUser();
    const other = await seedOrgUser();
    const created = await service.createRelease({
      organizationId: owner.orgId,
      userId: owner.userId,
      title: "Editable",
      body: "Before edit",
    });

    const denied = await service.updateDraft(created.release!.id, other.orgId, {
      title: "Cross org edit",
    });
    expect(denied.ok).toBe(false);

    const edited = await service.updateDraft(created.release!.id, owner.orgId, {
      body: "After edit",
    });
    expect(edited.ok).toBe(true);
    expect(edited.release?.body).toBe("After edit");

    await service.markReady(created.release!.id, owner.orgId);
    const frozen = await service.updateDraft(created.release!.id, owner.orgId, {
      body: "Too late",
    });
    expect(frozen.ok).toBe(false);
  });

  test("submission is idempotent and drives submitted → distributed with coverage artifacts", async () => {
    if (!pgliteReady) return;
    const seeded = await seedReadyRelease();
    const key = uniq("distribution-key");

    const submitted = await service.recordSubmission({
      releaseId: seeded.releaseId,
      organizationId: seeded.orgId,
      provider: "sandbox-newswire",
      requestPayload: { channels: ["tech"] },
      externalDistributionId: "dist-123",
      providerResponse: { status: "accepted" },
      idempotencyKey: key,
    });
    expect(submitted.ok).toBe(true);
    expect(submitted.release?.status).toBe("submitted");
    expect(submitted.distribution?.status).toBe("submitted");

    const retry = await service.recordSubmission({
      releaseId: seeded.releaseId,
      organizationId: seeded.orgId,
      provider: "sandbox-newswire",
      idempotencyKey: key,
    });
    expect(retry.ok).toBe(true);
    expect(retry.distribution?.id).toBe(submitted.distribution?.id);

    const distributed = await service.markDistributed({
      distributionId: submitted.distribution!.id,
      organizationId: seeded.orgId,
      providerResponse: { status: "distributed" },
    });
    expect(distributed.ok).toBe(true);
    expect(distributed.release?.status).toBe("distributed");

    const coverage = await service.recordCoverage({
      organizationId: seeded.orgId,
      releaseId: seeded.releaseId,
      distributionId: submitted.distribution!.id,
      url: "https://example-news.test/eliza-cloud",
      title: "Eliza Cloud adds PR workflow",
      outlet: "Example News",
      publishedAt: new Date("2026-07-03T12:00:00.000Z"),
    });
    expect(coverage.outlet).toBe("Example News");

    const updatedCoverage = await service.recordCoverage({
      organizationId: seeded.orgId,
      releaseId: seeded.releaseId,
      distributionId: submitted.distribution!.id,
      url: "https://example-news.test/eliza-cloud",
      title: "Updated headline",
      outlet: "Example News",
    });
    expect(updatedCoverage.id).toBe(coverage.id);
    expect(updatedCoverage.title).toBe("Updated headline");
  });

  test("failed distribution records provider error and prevents cancellation after submit", async () => {
    if (!pgliteReady) return;
    const seeded = await seedReadyRelease();
    const submitted = await service.recordSubmission({
      releaseId: seeded.releaseId,
      organizationId: seeded.orgId,
      provider: "sandbox-newswire",
    });

    const cancelled = await service.cancelRelease(seeded.releaseId, seeded.orgId);
    expect(cancelled.ok).toBe(false);

    const failed = await service.markFailed({
      distributionId: submitted.distribution!.id,
      organizationId: seeded.orgId,
      error: "Provider rejected embargo",
    });
    expect(failed.ok).toBe(true);
    expect(failed.release?.status).toBe("failed");
    expect(failed.distribution?.error_message).toBe("Provider rejected embargo");
  });

  test("media contacts persist by organization", async () => {
    if (!pgliteReady) return;
    const owner = await seedOrgUser();
    const other = await seedOrgUser();

    await service.createContact({
      organizationId: owner.orgId,
      userId: owner.userId,
      name: "A Reporter",
      outlet: "Example News",
      email: "reporter@example.test",
      beat: "AI",
      region: "US",
    });
    await service.createContact({
      organizationId: other.orgId,
      userId: other.userId,
      name: "Other Reporter",
      outlet: "Other News",
    });

    const ownerContacts = await service.listContacts(owner.orgId);
    expect(ownerContacts).toHaveLength(1);
    expect(ownerContacts[0].outlet).toBe("Example News");
  });

  test("real DB rows are available for reviewer-verifiable evidence", async () => {
    if (!pgliteReady) return;
    const seeded = await seedReadyRelease();
    const [releaseRow] = await dbWrite
      .select()
      .from(pressReleases)
      .where(eq(pressReleases.id, seeded.releaseId));

    expect(releaseRow.organization_id).toBe(seeded.orgId);
    expect(releaseRow.status).toBe("ready");
    expect(releaseRow.body).toContain("press release domain workflow");
  });
});
