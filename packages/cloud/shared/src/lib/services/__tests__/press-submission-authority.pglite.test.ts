import { afterAll, beforeAll, expect, test } from "bun:test";
import { pressReleaseDistributions } from "../../../db/schemas/press-releases";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.DISABLE_LOCAL_PGLITE_FALLBACK = "1";

const { closeDatabaseConnectionsForTests, dbWrite, getPgliteClientForTests } = await import(
  "../../../db/client"
);
const { pressReleasesRepository } = await import("../../../db/repositories/press-releases");
const { pressReleaseService } = await import("../press-releases");

const ORG = "10000000-0000-4000-8000-000000000001";
const OTHER_ORG = "10000000-0000-4000-8000-000000000002";
const USER = "20000000-0000-4000-8000-000000000001";

beforeAll(async () => {
  const db = getPgliteClientForTests();
  await db.exec(`
    CREATE TABLE organizations (id uuid PRIMARY KEY);
    CREATE TABLE users (id uuid PRIMARY KEY);
    INSERT INTO organizations (id) VALUES ('${ORG}'), ('${OTHER_ORG}');
    INSERT INTO users (id) VALUES ('${USER}');
  `);
  const migration = await Bun.file(
    new URL("../../../db/migrations/0171_press_release_domain.sql", import.meta.url),
  ).text();
  await db.exec(migration);
}, 30_000);

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

async function readyRelease(title = "Fixture announcement") {
  const created = await pressReleaseService.createRelease({
    organizationId: ORG,
    userId: USER,
    title,
    body: "Synthetic release used to test local persistence.",
  });
  if (!created.release) throw new Error("Fixture release was not created");
  const id = created.release.id;
  expect(await pressReleaseService.markReady(id, ORG)).toMatchObject({
    ok: true,
    release: { status: "ready" },
  });
  return id;
}

function submission(releaseId: string, idempotencyKey?: string) {
  return {
    releaseId,
    organizationId: ORG,
    provider: "fixture",
    idempotencyKey,
    externalDistributionId: "fixture-receipt",
    providerResponse: { fixture: true },
  };
}

test("concurrent cancellation and submission leave one consistent durable outcome", async () => {
  const releaseId = await readyRelease();
  const [cancel, submit] = await Promise.all([
    pressReleaseService.cancelRelease(releaseId, ORG),
    pressReleaseService.recordSubmission(submission(releaseId)),
  ]);
  expect(Number(cancel.ok) + Number(submit.ok)).toBe(1);

  const release = await pressReleaseService.getRelease(releaseId, ORG);
  const receipts = await pressReleasesRepository.listDistributionsForRelease(releaseId, ORG);
  if (cancel.ok) {
    expect(release?.status).toBe("cancelled");
    expect(receipts).toEqual([]);
  } else {
    expect(release?.status).toBe("submitted");
    expect(receipts).toEqual([expect.objectContaining({ id: submit.distribution?.id })]);
  }
});

test("a submission key cannot acknowledge a different release", async () => {
  const releaseId = await readyRelease();
  const otherId = await readyRelease();
  const key = crypto.randomUUID();
  const first = await pressReleaseService.recordSubmission(submission(releaseId, key));
  expect(first).toMatchObject({ ok: true, release: { id: releaseId, status: "submitted" } });
  const conflict = await pressReleaseService.recordSubmission(submission(otherId, key));
  expect(conflict).toEqual({ ok: false, error: "Idempotency key already used" });
  expect(
    await pressReleaseService.recordSubmission({
      ...submission(releaseId, key),
      provider: "other",
    }),
  ).toEqual({ ok: false, error: "Idempotency key already used" });
  expect(
    await pressReleaseService.recordSubmission({
      ...submission(releaseId, key),
      organizationId: OTHER_ORG,
    }),
  ).toEqual({ ok: false, error: "Press release not found" });
  expect((await pressReleaseService.getRelease(otherId, ORG))?.status).toBe("ready");
  expect(await pressReleasesRepository.listDistributionsForRelease(otherId, ORG)).toEqual([]);
});

test("concurrent exact submissions replay one durable receipt", async () => {
  const releaseId = await readyRelease();
  const input = submission(releaseId, crypto.randomUUID());
  const [first, second] = await Promise.all([
    pressReleaseService.recordSubmission(input),
    pressReleaseService.recordSubmission(input),
  ]);
  expect(first).toMatchObject({ ok: true, release: { status: "submitted" } });
  expect(second).toMatchObject({ ok: true, distribution: { id: first.distribution?.id } });
  expect(
    await pressReleaseService.recordSubmission({
      ...input,
      externalDistributionId: "different-reply",
      providerResponse: { replacement: true },
    }),
  ).toMatchObject({ ok: true, distribution: first.distribution });
  expect(await pressReleaseService.cancelRelease(releaseId, ORG)).toMatchObject({ ok: false });
  const receipts = await pressReleasesRepository.listDistributionsForRelease(releaseId, ORG);
  expect(receipts).toEqual([
    expect.objectContaining({
      id: first.distribution?.id,
      external_distribution_id: "fixture-receipt",
      provider_response: { fixture: true },
    }),
  ]);
});

test("a rejected release transition rolls back its submission receipt", async () => {
  const db = getPgliteClientForTests();
  const releaseId = await readyRelease("Rollback fixture");
  const input = submission(releaseId, crypto.randomUUID());
  await db.exec(`
    ALTER TABLE press_releases ADD CONSTRAINT fixture_reject_submission
    CHECK (title <> 'Rollback fixture' OR status <> 'submitted');
  `);
  try {
    await expect(pressReleaseService.recordSubmission(input)).rejects.toThrow();
    expect((await pressReleaseService.getRelease(releaseId, ORG))?.status).toBe("ready");
    expect(await pressReleasesRepository.listDistributionsForRelease(releaseId, ORG)).toEqual([]);
  } finally {
    await db.exec("ALTER TABLE press_releases DROP CONSTRAINT fixture_reject_submission");
  }
  expect(await pressReleaseService.recordSubmission(input)).toMatchObject({
    ok: true,
    release: { status: "submitted" },
  });
});

test("a cancelled release cannot acknowledge a historical orphan receipt", async () => {
  const releaseId = await readyRelease();
  const key = crypto.randomUUID();
  expect(await pressReleaseService.cancelRelease(releaseId, ORG)).toMatchObject({
    ok: true,
    release: { status: "cancelled" },
  });
  // Represent a row retained by the former split write after cancel won.
  const [orphan] = await dbWrite
    .insert(pressReleaseDistributions)
    .values({
      organization_id: ORG,
      press_release_id: releaseId,
      provider: "fixture",
      idempotency_key: key,
      status: "submitted",
    })
    .returning({ id: pressReleaseDistributions.id });

  expect(await pressReleaseService.recordSubmission(submission(releaseId, key))).toEqual({
    ok: false,
    error: "Press release is not ready for submission",
  });
  expect((await pressReleaseService.getRelease(releaseId, ORG))?.status).toBe("cancelled");
  expect(await pressReleasesRepository.listDistributionsForRelease(releaseId, ORG)).toEqual([
    expect.objectContaining({ id: orphan.id }),
  ]);
});
