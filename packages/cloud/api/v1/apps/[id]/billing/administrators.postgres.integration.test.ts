/** Exercises purchaser-authenticated administrator transfers over real HTTP handlers, signed sessions and PostgreSQL transactions. */
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { CloudApiClient } from "@elizaos/cloud-sdk";
import { AppBillingClient } from "@elizaos/cloud-sdk/app-billing";
import {
  buyer,
  closeRecordsTest,
  db,
  env,
  member,
  org,
  postgresUrl,
  routes,
  sdk,
  setupRecordsTest,
  trial,
} from "./records-test-harness";

setDefaultTimeout(120_000);
const request = (
  userId: string,
  action: "grant" | "revoke" | "transfer",
  expectedRevision = "0",
) => ({ userId, action, expectedRevision, idempotencyKey: randomUUID() });

describe.skipIf(!postgresUrl)("purchaser billing administrators", () => {
  beforeAll(setupRecordsTest);
  afterAll(closeRecordsTest);

  test("transfer survives a lost response, preserves live authority and does not renew the trial", async () => {
    const { identity, client, scopeId } = await trial();
    const userId = await member(identity);
    const before = await db.query(
      "SELECT row_to_json(s) AS row FROM billing_subscriptions s WHERE billing_scope_id=$1",
      [scopeId],
    );
    const seat = await client.assignSeat(identity.billingAccountId, "main", {
      subject: userId,
      idempotencyKey: randomUUID(),
    });
    const input = request(userId, "transfer");
    const applied = await client.changeAdministrator(
      identity.billingAccountId,
      input,
    );
    expect(applied.data.administrators).toEqual([userId]);
    expect(applied.data.revision).toBe("1");
    expect(
      (await client.changeAdministrator(identity.billingAccountId, input)).data,
    ).toEqual(applied.data);
    await expect(
      client.changeAdministrator(identity.billingAccountId, {
        ...input,
        idempotencyKey: randomUUID(),
        expectedRevision: "1",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    const live = await sdk(identity, true);
    expect(
      (await live.listAdministrators(identity.billingAccountId)).data
        .administrators,
    ).toEqual([identity.actorUserId]);
    expect(
      (
        await db.query(
          "SELECT row_to_json(s) AS row FROM billing_subscriptions s WHERE billing_scope_id=$1",
          [scopeId],
        )
      ).rows,
    ).toEqual(before.rows);
    expect(
      (
        await db.query(
          "SELECT eligibility_principal_id FROM app_billing_accounts WHERE id=$1",
          [identity.billingAccountId],
        )
      ).rows[0].eligibility_principal_id,
    ).toBe(identity.actorUserId);
    expect(
      (
        await db.query("SELECT revoked_at FROM app_billing_seats WHERE id=$1", [
          seat.data.id,
        ])
      ).rows[0].revoked_at,
    ).toBeNull();
    const successor = await sdk({ ...identity, actorUserId: userId });
    await expect(
      successor.changeAdministrator(
        identity.billingAccountId,
        request(userId, "revoke", "1"),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(
      (await successor.listAdministrators(identity.billingAccountId)).data
        .revision,
    ).toBe("1");
  });

  test("grant is available before purchase and stale changes leave no receipt", async () => {
    const { identity } = await buyer();
    const userId = await member(identity);
    const client = await sdk(identity);
    const grant = await client.changeAdministrator(
      identity.billingAccountId,
      request(userId, "grant"),
    );
    expect(grant.data.administrators).toEqual(
      [identity.actorUserId, userId].sort(),
    );
    const stale = request(userId, "revoke");
    await expect(
      client.changeAdministrator(identity.billingAccountId, stale),
    ).rejects.toMatchObject({
      statusCode: 409,
      errorBody: { code: "APP_BILLING_MEMBERSHIP_REVISION_CONFLICT" },
    });
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS total FROM app_billing_membership_operations WHERE billing_account_id=$1 AND idempotency_key=$2",
          [identity.billingAccountId, stale.idempotencyKey],
        )
      ).rows[0].total,
    ).toBe(0);
    const result = await client.changeAdministrator(identity.billingAccountId, {
      ...stale,
      expectedRevision: "1",
    });
    expect(result.data.administrators).toEqual([identity.actorUserId]);
  });

  test("concurrent cross-revokes cannot remove the last administrator", async () => {
    const { identity } = await buyer();
    const userId = await member(identity, "test", "administrator");
    const first = await sdk(identity);
    const second = await sdk({ ...identity, actorUserId: userId });
    const results = await Promise.allSettled([
      first.changeAdministrator(
        identity.billingAccountId,
        request(userId, "revoke"),
      ),
      second.changeAdministrator(
        identity.billingAccountId,
        request(identity.actorUserId, "revoke"),
      ),
    ]);
    expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(1);
    const current = (await first.listAdministrators(identity.billingAccountId))
      .data;
    expect(current.administrators).toHaveLength(1);
    expect(current.revision).toBe("1");
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS total FROM app_billing_membership_operations WHERE billing_account_id=$1",
          [identity.billingAccountId],
        )
      ).rows[0].total,
    ).toBe(1);
  });

  test("identity, app, environment, CSRF and immutable request checks reject broadened authority", async () => {
    const { identity } = await buyer();
    const userId = await member(identity);
    const foreign = await buyer();
    const client = await sdk(identity);
    const ordinary = await sdk({ ...identity, actorUserId: userId });
    await expect(
      ordinary.changeAdministrator(
        identity.billingAccountId,
        request(userId, "grant"),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      client.changeAdministrator(
        foreign.identity.billingAccountId,
        request(userId, "grant"),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    const live = await sdk(identity, true);
    await expect(
      live.changeAdministrator(
        identity.billingAccountId,
        request(userId, "grant"),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    const noCsrf = await sdk(identity, false, { omitCsrfMarker: true });
    await expect(
      noCsrf.changeAdministrator(
        identity.billingAccountId,
        request(userId, "grant"),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    const input = request(userId, "grant");
    const applied = await client.changeAdministrator(
      identity.billingAccountId,
      input,
    );
    await expect(
      client.changeAdministrator(identity.billingAccountId, {
        ...input,
        action: "transfer",
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      errorBody: { code: "APP_BILLING_AUTHORITY_CONFLICT" },
    });
    await expect(
      ordinary.changeAdministrator(identity.billingAccountId, input),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(
      (await client.changeAdministrator(identity.billingAccountId, input)).data,
    ).toEqual(applied.data);
    const unauthenticated = await routes.request(
      `https://cloud.eliza.app/api/v1/apps/${identity.appId}/billing/accounts/${identity.billingAccountId}/administrators`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
      env,
    );
    expect(unauthenticated.status).toBe(401);
  });

  test("a scoped purchaser delegation transfers authority while a revoked grant cannot replay it", async () => {
    const { identity } = await buyer();
    const userId = await member(identity);
    const clientId = randomUUID();
    const consentId = randomUUID();
    const secret = "controlled-administrator-client-secret";
    const token = `ead_${randomBytes(32).toString("base64url")}`;
    const digest = (value: string) =>
      createHash("sha256").update(value).digest("hex");
    await db.query(
      "CREATE TABLE IF NOT EXISTS app_users(id uuid PRIMARY KEY,app_id uuid NOT NULL REFERENCES apps(id),user_id uuid NOT NULL REFERENCES users(id))",
    );
    await db.query(
      "INSERT INTO app_users(id,app_id,user_id) VALUES($1,$2,$3)",
      [consentId, identity.appId, identity.actorUserId],
    );
    await db.query(
      `INSERT INTO app_client_registrations(id,app_id,owner_organization_id,billing_environment,secret_hashes,redirect_uris,allowed_scopes) VALUES($1,$2,$3,'test',$4,'["https://app.example.test/callback"]','["identity","billing:read","billing:write"]')`,
      [clientId, identity.appId, org, JSON.stringify([digest(secret)])],
    );
    await db.query(
      `INSERT INTO app_delegations(token_hash,authorization_code_hash,client_id,app_id,user_id,consent_id,organization_id,registration_revision,scopes,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,1,'["billing:read","billing:write"]',now()+interval '1 hour')`,
      [
        digest(token),
        digest(randomUUID()),
        clientId,
        identity.appId,
        identity.actorUserId,
        consentId,
        org,
      ],
    );
    const fetchImpl = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) =>
        routes.request(input, init, env),
      { preconnect: fetch.preconnect },
    );
    const client = new AppBillingClient(
      new CloudApiClient("https://cloud.eliza.app/api/v1", undefined, {
        fetchImpl,
        defaultHeaders: {
          Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`,
          "X-App-Delegation": token,
        },
      }),
      identity.appId,
    );
    const input = request(userId, "transfer");
    const applied = await client.changeAdministrator(
      identity.billingAccountId,
      input,
    );
    expect(applied.data.administrators).toEqual([userId]);
    expect(
      (await client.changeAdministrator(identity.billingAccountId, input)).data,
    ).toEqual(applied.data);
    await db.query(
      "UPDATE app_delegations SET revoked_at=now() WHERE token_hash=$1",
      [digest(token)],
    );
    await expect(
      client.changeAdministrator(identity.billingAccountId, input),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  test("inactive or anonymous members cannot receive authority or count as the remaining administrator", async () => {
    const { identity } = await buyer();
    const client = await sdk(identity);
    const anonymous = await member(identity);
    const inactive = await member(identity, "test", "administrator");
    await db.query("UPDATE users SET is_anonymous=true WHERE id=$1", [
      anonymous,
    ]);
    await db.query("UPDATE users SET is_active=false WHERE id=$1", [inactive]);
    const expired = await member(identity, "test", "administrator");
    const fenced = await member(identity, "test", "administrator");
    await db.query(
      "UPDATE users SET expires_at=now()-interval '1 second' WHERE id=$1",
      [expired],
    );
    await db.query("UPDATE users SET auth_fenced_at=now() WHERE id=$1", [
      fenced,
    ]);
    for (const userId of [anonymous, inactive, expired, fenced, randomUUID()])
      await expect(
        client.changeAdministrator(
          identity.billingAccountId,
          request(userId, "grant"),
        ),
      ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      client.changeAdministrator(
        identity.billingAccountId,
        request(identity.actorUserId, "revoke"),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(
      (await client.listAdministrators(identity.billingAccountId)).data,
    ).toMatchObject({ revision: "0", administrators: [identity.actorUserId] });
  });
});
