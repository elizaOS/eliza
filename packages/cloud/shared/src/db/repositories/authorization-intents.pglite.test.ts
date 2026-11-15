import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { ApprovalRequestsRepository } from "./approval-requests";
import { OAuthIntentsRepository } from "./oauth-intents";

const org = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const now = new Date("2026-11-07T00:00:00Z");
const later = new Date(now.getTime() + 60_000);
let pg: PGlite;
let oauth: OAuthIntentsRepository;
let approvals: ApprovalRequestsRepository;

beforeEach(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE oauth_intents (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL,
      agent_id uuid, provider text NOT NULL, scopes jsonb NOT NULL DEFAULT '[]',
      expected_identity_id text, status text NOT NULL DEFAULT 'pending',
      state_token_hash text NOT NULL UNIQUE, pkce_verifier_hash text, hosted_url text,
      callback_url text, expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      metadata jsonb NOT NULL DEFAULT '{}'
    );
    CREATE TABLE oauth_intent_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      oauth_intent_id uuid NOT NULL REFERENCES oauth_intents(id), event_name text NOT NULL,
      redacted_payload jsonb NOT NULL DEFAULT '{}', occurred_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE cloud_approval_requests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL,
      agent_id uuid, user_id uuid, challenge_kind text NOT NULL,
      challenge_payload jsonb NOT NULL DEFAULT '{}', expected_signer_identity_id text,
      status text NOT NULL DEFAULT 'pending', signature_text text, signed_at timestamptz,
      expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(), metadata jsonb NOT NULL DEFAULT '{}'
    );
    CREATE TABLE cloud_approval_request_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      approval_request_id uuid NOT NULL REFERENCES cloud_approval_requests(id),
      event_name text NOT NULL, redacted_payload jsonb NOT NULL DEFAULT '{}',
      occurred_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  const db = drizzle(pg);
  oauth = new OAuthIntentsRepository(db as never);
  approvals = new ApprovalRequestsRepository(db as never);
});
afterEach(async () => {
  await pg.close();
});

async function makeOAuth(expiresAt = later) {
  return oauth.createOAuthIntent({
    organizationId: org,
    provider: "google",
    scopes: ["read"],
    stateTokenHash: crypto.randomUUID(),
    expiresAt,
  });
}
async function makeApproval(expiresAt = later) {
  return approvals.createApprovalRequest({
    organizationId: org,
    challengeKind: "signature",
    challengePayload: { message: "test", signerKind: "ed25519", publicKey: "fixture" },
    expiresAt,
  });
}

describe("authorization intent transaction regression", () => {
  test("production decisions compare expiry with database time", async () => {
    const expired = new Date(Date.now() - 1000);
    const a = await makeOAuth(expired);
    const b = await makeApproval(expired);
    expect(await oauth.transitionOAuthIntent(a.id, "bound")).toBeNull();
    expect(await approvals.transitionApprovalRequest(b.id, "approved")).toBeNull();
  });
  test("competing OAuth decisions cannot replace the winning outcome or duplicate its receipt", async () => {
    const row = await makeOAuth();
    const result = await Promise.all([
      oauth.transitionOAuthIntent(row.id, "bound", { now }),
      oauth.transitionOAuthIntent(row.id, "canceled", { now, organizationId: org }),
    ]);
    expect(result.filter(Boolean)).toHaveLength(1);
    expect((await oauth.getOAuthIntent(row.id))?.status).toBe(result.find(Boolean)?.status);
    const events = await pg.query(
      "SELECT event_name FROM oauth_intent_events WHERE oauth_intent_id = $1",
      [row.id],
    );
    expect(events.rows).toHaveLength(2);
  });

  test("approval delivery cannot overwrite a completed decision", async () => {
    const row = await makeApproval();
    expect((await approvals.transitionApprovalRequest(row.id, "approved", { now }))?.status).toBe(
      "approved",
    );
    expect(await approvals.transitionApprovalRequest(row.id, "delivered", { now })).toBeNull();
    expect((await approvals.getApprovalRequest(row.id))?.status).toBe("approved");
  });

  test("decisions at or beyond expiry fail before a sweeper runs", async () => {
    const a = await makeOAuth(now);
    const b = await makeApproval(now);
    expect(await oauth.transitionOAuthIntent(a.id, "bound", { now })).toBeNull();
    expect(await approvals.transitionApprovalRequest(b.id, "approved", { now })).toBeNull();
    expect((await oauth.getOAuthIntent(a.id))?.status).toBe("pending");
    expect((await approvals.getApprovalRequest(b.id))?.status).toBe("pending");
  });

  test("cancellation compares the tenant on the committing write", async () => {
    const a = await makeOAuth();
    const b = await makeApproval();
    expect(
      await oauth.transitionOAuthIntent(a.id, "canceled", { now, organizationId: other }),
    ).toBeNull();
    expect(
      await approvals.transitionApprovalRequest(b.id, "canceled", { now, organizationId: other }),
    ).toBeNull();
  });

  test("receipt failure rolls back the OAuth decision", async () => {
    const row = await makeOAuth();
    await pg.exec(
      "ALTER TABLE oauth_intent_events ADD CONSTRAINT fail_bound CHECK(event_name <> 'oauth.bound')",
    );
    await expect(oauth.transitionOAuthIntent(row.id, "bound", { now })).rejects.toThrow();
    expect((await oauth.getOAuthIntent(row.id))?.status).toBe("pending");
    expect((await pg.query("SELECT * FROM oauth_intent_events")).rows).toHaveLength(1);
  });

  test("receipt failure rolls back the signed approval", async () => {
    const row = await makeApproval();
    await pg.exec(
      "ALTER TABLE cloud_approval_request_events ADD CONSTRAINT fail_approved CHECK(event_name <> 'approval.approved')",
    );
    await expect(
      approvals.transitionApprovalRequest(row.id, "approved", {
        now,
        patch: { signatureText: "signature", signedAt: now },
      }),
    ).rejects.toThrow();
    const state = await approvals.getApprovalRequest(row.id);
    expect(state?.status).toBe("pending");
    expect(state?.signatureText).toBeNull();
  });

  test("creation does not leave an unreceipted intent", async () => {
    await pg.exec(
      "ALTER TABLE oauth_intent_events ADD CONSTRAINT fail_created CHECK(event_name <> 'oauth.created')",
    );
    await expect(makeOAuth()).rejects.toThrow();
    expect((await pg.query("SELECT * FROM oauth_intents")).rows).toHaveLength(0);
  });

  test("expiry uses an inclusive boundary and writes receipts in the same transaction", async () => {
    const a = await makeOAuth(now);
    const b = await makeApproval(now);
    expect(await oauth.expirePastOAuthIntents(now)).toEqual([a.id]);
    expect(await approvals.expirePastApprovalRequests(now)).toEqual([b.id]);
    expect(await oauth.expirePastOAuthIntents(now)).toEqual([]);
    expect(await approvals.expirePastApprovalRequests(now)).toEqual([]);
    expect((await pg.query("SELECT * FROM oauth_intent_events")).rows).toHaveLength(2);
    expect((await pg.query("SELECT * FROM cloud_approval_request_events")).rows).toHaveLength(2);
  });
});
