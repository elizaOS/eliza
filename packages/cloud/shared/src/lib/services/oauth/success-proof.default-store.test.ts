/**
 * Proves the production OAuth success-proof store against the committed
 * migration and an isolated PGlite database. The tests exercise the real
 * Postgres insert and atomic `DELETE … RETURNING` path, including contention.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";

const MIGRATION = join(
  import.meta.dir,
  "../../../db/migrations/0196_oauth_success_proof_tickets.sql",
);

let closeDatabaseConnectionsForTests: () => Promise<void>;
let dbWrite: typeof import("../../../db/client").dbWrite;
let oauthSuccessProofTickets: typeof import("../../../db/schemas/oauth-success-proof-tickets").oauthSuccessProofTickets;
let mintOAuthSuccessProof: typeof import("./success-proof").mintOAuthSuccessProof;
let consumeOAuthSuccessProof: typeof import("./success-proof").consumeOAuthSuccessProof;
let __setOAuthSuccessProofTicketStoreForTests: typeof import("./success-proof").__setOAuthSuccessProofTicketStoreForTests;

const BINDING = { organizationId: "org-1", userId: "user-1" };

beforeAll(async () => {
  expect(CAN_USE_ISOLATED_PGLITE).toBe(true);
  ({ closeDatabaseConnectionsForTests, dbWrite } = await import("../../../db/client"));
  ({ oauthSuccessProofTickets } = await import("../../../db/schemas/oauth-success-proof-tickets"));
  const { sql } = await import("drizzle-orm");
  for (const statement of readFileSync(MIGRATION, "utf8").split("--> statement-breakpoint")) {
    const trimmed = statement.trim();
    if (trimmed) await dbWrite.execute(sql.raw(trimmed));
  }
  ({ mintOAuthSuccessProof, consumeOAuthSuccessProof, __setOAuthSuccessProofTicketStoreForTests } =
    await import("./success-proof"));
});

beforeEach(async () => {
  process.env.OAUTH_SUCCESS_PROOF_SECRET = "test-oauth-success-proof-secret-32b";
  __setOAuthSuccessProofTicketStoreForTests(null);
  await dbWrite.delete(oauthSuccessProofTickets);
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("OAuth success proof production ticket store", () => {
  test("mints and consumes through the migrated Postgres table", async () => {
    const proof = await mintOAuthSuccessProof({
      platform: "twitter",
      connectionId: "connection-1",
      ...BINDING,
    });
    expect(proof).toBeTruthy();
    expect(await dbWrite.select().from(oauthSuccessProofTickets)).toHaveLength(1);

    const first = await consumeOAuthSuccessProof(proof, BINDING);
    expect(first.ok).toBe(true);
    expect(await consumeOAuthSuccessProof(proof, BINDING)).toEqual({
      ok: false,
      reason: "already_used",
    });
  });

  test("sixteen concurrent verifies produce exactly one winner", async () => {
    const proof = await mintOAuthSuccessProof({ platform: "discord", ...BINDING });
    expect(proof).toBeTruthy();

    const results = await Promise.all(
      Array.from({ length: 16 }, () => consumeOAuthSuccessProof(proof, BINDING)),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.reason === "already_used")).toHaveLength(
      15,
    );
  });

  test("a database write failure cannot mint a proof", async () => {
    const { sql } = await import("drizzle-orm");
    await dbWrite.execute(sql`DROP TABLE "oauth_success_proof_tickets"`);
    try {
      const proof = await mintOAuthSuccessProof({ platform: "github", ...BINDING });
      expect(proof).toBeNull();
    } finally {
      for (const statement of readFileSync(MIGRATION, "utf8").split("--> statement-breakpoint")) {
        const trimmed = statement.trim();
        if (trimmed) await dbWrite.execute(sql.raw(trimmed));
      }
    }
  });

  test("an expired row cannot be claimed and is removed opportunistically", async () => {
    const { createHash } = await import("node:crypto");
    const nonce = "expired-nonce";
    await dbWrite.insert(oauthSuccessProofTickets).values({
      nonce_hash: createHash("sha256").update(nonce).digest("hex"),
      platform: "github",
      organization_id: BINDING.organizationId,
      user_id: BINDING.userId,
      expires_at: new Date(Date.now() - 1_000),
    });
    const { oauthSuccessProofTicketsRepository } = await import(
      "../../../db/repositories/oauth-success-proof-tickets"
    );
    expect(
      await oauthSuccessProofTicketsRepository.claim(
        createHash("sha256").update(nonce).digest("hex"),
      ),
    ).toBeUndefined();
    expect(await oauthSuccessProofTicketsRepository.purgeExpired()).toBe(1);
  });
});
