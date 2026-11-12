/** Real PostgreSQL credential flows with enrolled policy guards and test-only KMS. */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { eq, is, SQL } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { Client } from "pg";
import type { MobileAppAuthGrantBinding } from "../../db/repositories/mobile-app-auth-grants";
import type { NewApiKey } from "../../db/schemas/api-keys";

const url = process.env.INFERENCE_POLICY_TEST_POSTGRES_URL;
const schema = `auth_credential_policy_${randomUUID().replaceAll("-", "_")}`;
let setup: Client;
let observer: Client;
let scopedUrl: string;
let database: typeof import("../../db/client");
let bindings: typeof import("../runtime/cloud-bindings");
let mobile: typeof import("../../db/repositories/mobile-app-auth-grants");
let cli: typeof import("./cli-auth-session-completion");
let tables: typeof import("../../db/schemas");
let provenance: typeof import("../../db/mobile-app-auth-credential-policy");
let decrypt: typeof import("../../db/crypto/api-keys");
let service: typeof import("./mobile-app-auth");
const organizationId = randomUUID();
const userId = randomUUID();
const appId = randomUUID();
const otherOrganizationId = randomUUID();
const otherUserId = randomUUID();
let begins: string[];
let commits: string[];
let beforePermit: (() => Promise<void>) | undefined;
let rejectPermit = false;

function fixtureDefault(value: unknown, type: string): string {
  if (value === undefined) return "";
  if (is(value, SQL)) {
    const query = new PgDialect().sqlToQuery(value);
    if (query.params.length) throw new Error("Fixture defaults require literal production DDL");
    return ` DEFAULT ${query.sql}`;
  }
  if (value === null) return " DEFAULT NULL";
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean")
    return ` DEFAULT ${String(value)}`;
  if (typeof value === "string") return ` DEFAULT '${value.replaceAll("'", "''")}'`;
  if (type === "jsonb" || type === "json")
    return ` DEFAULT '${JSON.stringify(value).replaceAll("'", "''")}'::${type}`;
  throw new Error(`Unsupported fixture default for ${type}`);
}

const gate = {
  getByName(organization: string) {
    return {
      async fetch(request: Request) {
        const body = (await request.json()) as { mutationId: string };
        if (new URL(request.url).pathname === "/policy-mutation/begin") {
          if (rejectPermit) return new Response("Unavailable", { status: 503 });
          const owner = organization === organizationId ? userId : otherUserId;
          // The actual shared user lock must precede the permit request.
          const lock = await observer.query(
            "SELECT pg_try_advisory_xact_lock(hashtextextended('inference-user-policy:' || $1::uuid::text,0)) AS acquired",
            [owner],
          );
          expect(lock.rows[0].acquired).toBe(false);
          await beforePermit?.();
          begins.push(organization);
          return Response.json({
            blocked: true,
            mutationId: body.mutationId,
            fenceToken: "isolated-test-permit",
            validUntil: Date.now() + 30_000,
          });
        }
        // Publication must observe the committed SQL mutation, never a savepoint.
        const receipt = await observer.query(
          "SELECT phase FROM inference_policy_mutations WHERE organization_id=$1 AND mutation_id=$2",
          [organization, body.mutationId],
        );
        expect(receipt.rows[0]?.phase).toBe("applied");
        commits.push(organization);
        return Response.json({ committed: true });
      },
    };
  },
};

async function run<T>(operation: () => Promise<T>): Promise<T> {
  return bindings.runWithCloudBindingsAsync(
    {
      DATABASE_URL: scopedUrl,
      TEST_DATABASE_URL: scopedUrl,
      NODE_ENV: "test",
      ENVIRONMENT: "local",
      ELIZA_KMS_BACKEND: "memory",
      INFERENCE_RATE_POLICY_ADMISSION: "true",
      INFERENCE_ADMISSION_GATES: gate,
    },
    operation,
  );
}

async function seedGrant(input: { owner?: string; organization?: string; expiresAt?: Date } = {}) {
  const now = new Date();
  const id = randomUUID();
  const owner = input.owner ?? userId;
  const organization = input.organization ?? organizationId;
  const binding: MobileAppAuthGrantBinding = {
    codeHash: randomUUID(),
    appId,
    clientId: "isolated-native-client",
    environment: "staging",
    redirectUri: "ai.eliza.test:/callback",
    stateHash: randomUUID(),
    codeChallenge: randomUUID(),
  };
  await setup.query(
    `INSERT INTO mobile_app_auth_grants(id,code_hash,app_id,client_id,user_id,organization_id,environment,redirect_uri,state_hash,code_challenge,code_challenge_method,scopes,status,expires_at,created_at,updated_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'S256','["inference"]','pending',$11,$12,$12)`,
    [
      id,
      binding.codeHash,
      appId,
      binding.clientId,
      owner,
      organization,
      binding.environment,
      binding.redirectUri,
      binding.stateHash,
      binding.codeChallenge,
      input.expiresAt ?? new Date(now.getTime() + 60_000),
      now,
    ],
  );
  const attribution = provenance.buildMobileAppAuthCredentialProvenance({
    grantId: id,
    environment: binding.environment,
    deviceName: null,
    clientId: binding.clientId,
    scopes: ["inference"],
  });
  const credential: NewApiKey = {
    id: randomUUID(),
    name: attribution.name,
    description: attribution.description,
    organization_id: organization,
    user_id: owner,
    source_app_id: appId,
    key_hash: randomUUID(),
    key_prefix: "test-only",
    is_active: false,
    expires_at: new Date(now.getTime() + 3_600_000),
    rate_limit: 1000,
    key_ciphertext: "isolated-test-ciphertext",
    key_nonce: "isolated-test-nonce",
    key_auth_tag: "isolated-test-tag",
    key_kms_key_id: "isolated-test-key",
    key_kms_key_version: 1,
  };
  return { id, binding, credential, now };
}

async function exchange(input: Awaited<ReturnType<typeof seedGrant>>) {
  const result = await run(() =>
    mobile.mobileAppAuthGrantsRepository.exchange(input.binding, input.credential, input.now),
  );
  expect(result.kind).toBe("created");
  return result;
}

async function acknowledge(input: Awaited<ReturnType<typeof seedGrant>>) {
  return run(() =>
    mobile.mobileAppAuthGrantsRepository.acknowledge({
      binding: input.binding,
      credentialId: input.credential.id!,
      credentialHash: input.credential.key_hash,
      now: input.now,
    }),
  );
}

// A grant whose code, state, verifier and secret are real, so the service's
// own `acknowledgeMobileAppAuthCredential` can check the proof.
async function seedProvableGrant() {
  const seeded = await seedGrant();
  const hex = () => randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
  const proof = {
    code: `emac_${hex()}`,
    codeVerifier: `verifier-${hex()}`,
    state: `state-${hex()}`,
    credentialId: seeded.credential.id!,
    secret: `eliza_mobile_${hex()}`,
  };
  const binding: MobileAppAuthGrantBinding = {
    ...seeded.binding,
    codeHash: service.sha256Hex(proof.code),
    stateHash: service.sha256Hex(proof.state),
    codeChallenge: service.deriveMobileAppAuthS256Challenge(proof.codeVerifier),
  };
  await setup.query(
    "UPDATE mobile_app_auth_grants SET code_hash=$2,state_hash=$3,code_challenge=$4 WHERE id=$1",
    [seeded.id, binding.codeHash, binding.stateHash, binding.codeChallenge],
  );
  const credential = { ...seeded.credential, key_hash: service.sha256Hex(proof.secret) };
  const ack = (now: Date) =>
    run(() =>
      service.acknowledgeMobileAppAuthCredential({
        registration: {
          appId,
          clientId: binding.clientId,
          environment: binding.environment,
          redirectUri: binding.redirectUri,
          scopes: service.MOBILE_APP_AUTH_SCOPES,
          credentialTtlSeconds: 3600,
        },
        binding: {
          clientId: binding.clientId,
          environment: binding.environment,
          redirectUri: binding.redirectUri,
          state: proof.state,
        },
        code: proof.code,
        codeVerifier: proof.codeVerifier,
        credentialId: proof.credentialId,
        secret: proof.secret,
        now,
      }),
    );
  return { ...seeded, binding, credential, proof, ack };
}

async function prepareMobileReveal() {
  const input = await seedProvableGrant();
  const exchangeInput = {
    registration: {
      appId,
      clientId: input.binding.clientId,
      environment: input.binding.environment,
      redirectUri: input.binding.redirectUri,
      scopes: service.MOBILE_APP_AUTH_SCOPES,
      credentialTtlSeconds: 3600,
    },
    binding: {
      clientId: input.binding.clientId,
      environment: input.binding.environment,
      redirectUri: input.binding.redirectUri,
      state: input.proof.state,
    },
    code: input.proof.code,
    codeVerifier: input.proof.codeVerifier,
  };
  const reveal = () => run(() => service.exchangeMobileAppAuthCode(exchangeInput));
  return { ...input, exchangeInput, reveal, response: await reveal() };
}

async function pauseMobileDecrypt() {
  const access = await import("../../db/crypto/kms-client");
  const kms = await run(async () => access.getKmsClient());
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  access.setKmsClient(
    new Proxy(kms, {
      get(target, property, receiver) {
        if (property === "decrypt") {
          return async (...args: Parameters<typeof kms.decrypt>) => {
            entered.resolve();
            await release.promise;
            return target.decrypt(...args);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  );
  return {
    entered: entered.promise,
    release: () => release.resolve(),
    restore: () => access.setKmsClient(kms),
  };
}

(url ? describe : describe.skip)(
  "canonical credential writers with enrolled inference policy",
  () => {
    beforeAll(async () => {
      const parsed = new URL(url!);
      if (
        !["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname) ||
        !parsed.username.startsWith("qa_")
      )
        throw Error("This suite requires an isolated loopback PostgreSQL QA role");
      setup = new Client({ connectionString: url });
      observer = new Client({ connectionString: url });
      await Promise.all([setup.connect(), observer.connect()]);
      await setup.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}`);
      await observer.query(`SET search_path TO ${schema}`);
      parsed.searchParams.set("options", `-c search_path=${schema},pg_catalog`);
      scopedUrl = parsed.toString();
      tables = await import("../../db/schemas");
      const names = new Set<string>();
      const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
      for (const table of [
        tables.organizations,
        tables.users,
        tables.userIdentities,
        tables.apiKeys,
        tables.apps,
        tables.mobileAppAuthGrants,
        tables.cliAuthSessions,
      ]) {
        const config = getTableConfig(table);
        for (const column of config.columns) {
          const enumeration = (
            column as unknown as { enum?: { enumName: string; enumValues: string[] } }
          ).enum;
          if (enumeration && !names.has(enumeration.enumName)) {
            await setup.query(
              `CREATE TYPE ${quote(enumeration.enumName)} AS ENUM (${enumeration.enumValues.map((value) => `'${value.replaceAll("'", "''")}'`).join(",")})`,
            );
            names.add(enumeration.enumName);
          }
        }
        // Include production defaults used by issuance. Unrelated constraints
        // remain outside this fixture so malformed recovery rows can be seeded.
        await setup.query(
          `CREATE TABLE ${quote(config.name)} (${config.columns.map((column) => `${quote(column.name)} ${column.getSQLType()}${column.primary ? " PRIMARY KEY" : ""}${fixtureDefault(column.default, column.getSQLType())}`).join(",")})`,
        );
      }
      for (const table of [
        "organization_subscription_authorities",
        "organization_entitlements",
        "billing_subscriptions",
        "billing_subscription_revisions",
        "subscription_grants",
        "org_rate_limit_overrides",
        "organization_config",
        "organization_payment_reversal_holds",
        "subscription_allowance_periods",
      ])
        await setup.query(`CREATE TABLE ${table}(organization_id uuid)`);
      await setup.query(
        "CREATE TABLE user_moderation_status(user_id uuid,status text,total_violations integer)",
      );
      for (const name of [
        "0545_inference_policy_mutation_fences.sql",
        "0552_inference_rate_policy_fences.sql",
        "0553_inference_policy_snapshot_fence.sql",
      ]) {
        const migration = await readFile(
          new URL(`../../db/migrations/${name}`, import.meta.url),
          "utf8",
        );
        for (const statement of migration.split("--> statement-breakpoint"))
          if (statement.trim()) await setup.query(statement);
      }
      database = await import("../../db/client");
      bindings = await import("../runtime/cloud-bindings");
      mobile = await import("../../db/repositories/mobile-app-auth-grants");
      cli = await import("./cli-auth-session-completion");
      provenance = await import("../../db/mobile-app-auth-credential-policy");
      decrypt = await import("../../db/crypto/api-keys");
      service = await import("./mobile-app-auth");
    }, 60_000);

    beforeEach(async () => {
      begins = [];
      commits = [];
      beforePermit = undefined;
      rejectPermit = false;
      await setup.query(
        "TRUNCATE inference_policy_mutations,inference_policy_authorities,mobile_app_auth_grants,cli_auth_sessions,api_keys,user_identities,apps,users,organizations CASCADE",
      );
      for (const [organization, owner] of [
        [organizationId, userId],
        [otherOrganizationId, otherUserId],
      ]) {
        await setup.query("INSERT INTO organizations(id,is_active) VALUES($1,true)", [
          organization,
        ]);
        await setup.query("INSERT INTO users(id,organization_id,is_active) VALUES($1,$2,true)", [
          owner,
          organization,
        ]);
        await setup.query("INSERT INTO inference_policy_authorities(organization_id) VALUES($1)", [
          organization,
        ]);
        await setup.query("BEGIN");
        await setup.query(
          "INSERT INTO inference_policy_mutations(organization_id,mutation_id,fence_token,permit_expires_at,applying_txid,phase) VALUES($1,'seed','local-seed',clock_timestamp()+interval '30 seconds',txid_current(),'applying')",
          [organization],
        );
        await setup.query(
          "UPDATE inference_policy_authorities SET rate_enabled=true,epoch=1 WHERE organization_id=$1",
          [organization],
        );
        await setup.query(
          "UPDATE inference_policy_mutations SET phase='complete',epoch=1 WHERE organization_id=$1",
          [organization],
        );
        await setup.query("COMMIT");
      }
      await setup.query("INSERT INTO apps(id,is_active,is_approved) VALUES($1,true,true)", [appId]);
    }, 30_000);

    afterAll(async () => {
      if (database) await database.closeDatabaseConnectionsForTests();
      if (observer) await observer.end();
      if (setup) {
        await setup.query(`DROP SCHEMA ${schema} CASCADE`);
        await setup.end();
      }
    }, 30_000);

    test("mobile exchange, acknowledgement and replay commit one credential with enrolled policy", async () => {
      const input = await seedGrant();
      await exchange(input);
      const activated = await acknowledge(input);
      expect(activated?.credential?.is_active).toBe(true);
      expect(activated?.credential?.key_ciphertext).toBeNull();
      expect((await acknowledge(input))?.credential?.id).toBe(input.credential.id);
      const keys = await setup.query("SELECT id,is_active FROM api_keys");
      expect(keys.rows).toEqual([{ id: input.credential.id, is_active: true }]);
      expect(begins).toHaveLength(3);
      expect(commits).toHaveLength(3);
    }, 30_000);

    test("mobile exchange returns the same encrypted credential on a valid retry", async () => {
      const input = await prepareMobileReveal();
      expect(await input.reveal()).toMatchObject({
        credentialId: input.response.credentialId,
        secret: input.response.secret,
        expiresAt: input.response.expiresAt,
        acknowledgeBy: input.response.acknowledgeBy,
        acknowledgementRequired: true,
      });
      const keys = await setup.query("SELECT id,is_active,key_ciphertext FROM api_keys");
      expect(keys.rows).toHaveLength(1);
      expect(keys.rows[0]).toMatchObject({ id: input.response.credentialId, is_active: false });
      expect(keys.rows[0].key_ciphertext).toBeTruthy();
      expect(keys.rows[0].key_ciphertext).not.toContain(input.response.secret);
    }, 30_000);

    test("mobile exchange rejects mismatched client, state and PKCE bindings", async () => {
      const input = await prepareMobileReveal();
      const rejected = async (patch: Partial<typeof input.exchangeInput>) =>
        run(() => service.exchangeMobileAppAuthCode({ ...input.exchangeInput, ...patch }));
      await expect(
        rejected({ binding: { ...input.exchangeInput.binding, clientId: "another-client" } }),
      ).rejects.toMatchObject({ protocolCode: "invalid_client" });
      await expect(
        rejected({ binding: { ...input.exchangeInput.binding, state: "x".repeat(64) } }),
      ).rejects.toMatchObject({ protocolCode: "binding_mismatch" });
      await expect(rejected({ codeVerifier: "x".repeat(64) })).rejects.toMatchObject({
        protocolCode: "invalid_code_verifier",
      });
      expect((await setup.query("SELECT id FROM api_keys")).rowCount).toBe(1);
    }, 30_000);

    test("mobile issuance, exchange and acknowledgement preserve one active-client grant", async () => {
      const registration = {
        appId,
        clientId: "isolated-native-client",
        environment: "staging" as const,
        redirectUri: "ai.eliza.test:/callback",
        scopes: service.MOBILE_APP_AUTH_SCOPES,
        credentialTtlSeconds: 3600,
      };
      const codeVerifier = "v".repeat(64);
      const binding = {
        clientId: registration.clientId,
        environment: registration.environment,
        redirectUri: registration.redirectUri,
        state: "s".repeat(64),
        codeChallenge: service.deriveMobileAppAuthS256Challenge(codeVerifier),
        codeChallengeMethod: "S256",
      };
      const issue = () =>
        run(() =>
          service.issueMobileAppAuthCode({ registration, userId, organizationId, binding }),
        );
      const issued = await issue();
      const request = { registration, binding, code: issued.code, codeVerifier };
      const revealed = await run(() => service.exchangeMobileAppAuthCode(request));
      expect((await setup.query("SELECT is_active FROM api_keys")).rows[0].is_active).toBe(false);
      await run(() =>
        service.acknowledgeMobileAppAuthCredential({
          ...request,
          credentialId: revealed.credentialId,
          secret: revealed.secret,
        }),
      );
      expect((await setup.query("SELECT status FROM mobile_app_auth_grants")).rows).toEqual([
        { status: "acknowledged" },
      ]);
      expect((await setup.query("SELECT is_active,key_ciphertext FROM api_keys")).rows).toEqual([
        { is_active: true, key_ciphertext: null },
      ]);
      await setup.query("UPDATE apps SET is_active=false WHERE id=$1", [appId]);
      await expect(issue()).rejects.toMatchObject({ protocolCode: "invalid_client" });
      expect((await setup.query("SELECT id FROM mobile_app_auth_grants")).rowCount).toBe(1);
    }, 30_000);

    test("mobile exchange refuses client deactivation during actual decryption", async () => {
      const input = await prepareMobileReveal();
      const pause = await pauseMobileDecrypt();
      try {
        const pending = input.reveal().then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        await pause.entered;
        await setup.query("UPDATE apps SET is_active=false WHERE id=$1", [appId]);
        pause.release();
        expect(await pending).toMatchObject({ error: { protocolCode: "invalid_client" } });
      } finally {
        pause.release();
        pause.restore();
      }
    }, 30_000);

    test("mobile exchange refuses expired authority after actual decryption", async () => {
      const input = await prepareMobileReveal();
      const pause = await pauseMobileDecrypt();
      try {
        const pending = input.reveal().then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        await pause.entered;
        await setup.query(
          "UPDATE mobile_app_auth_grants SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
          [input.id],
        );
        pause.release();
        expect(await pending).toMatchObject({
          error: { protocolCode: "authorization_code_expired" },
        });
      } finally {
        pause.release();
        pause.restore();
      }
    }, 30_000);

    test("mobile exchange refuses a replay when acknowledgement commits during decryption", async () => {
      const input = await prepareMobileReveal();
      const pause = await pauseMobileDecrypt();
      try {
        const pending = input.reveal().then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        await pause.entered;
        await run(() =>
          service.acknowledgeMobileAppAuthCredential({
            ...input.exchangeInput,
            credentialId: input.response.credentialId,
            secret: input.response.secret,
          }),
        );
        pause.release();
        expect(await pending).toMatchObject({ error: { protocolCode: "authorization_complete" } });
      } finally {
        pause.release();
        pause.restore();
      }
    }, 30_000);

    test("a landed acknowledgement replays after the code's acknowledgeBy; one that never landed is refused", async () => {
      // The host keeps `acknowledgeBy` (the code's expiry) with its receipt and
      // resends the same proof when an ack reply was lost.
      const landed = await seedProvableGrant();
      await exchange(landed);
      const acknowledgeBy = new Date(landed.now.getTime() + 60_000);
      const first = await landed.ack(landed.now);
      expect(first.status).toBe("acknowledged");
      const late = new Date(acknowledgeBy.getTime() + 1_000);
      const replay = await landed.ack(late);
      expect(replay).toEqual(first);

      const lost = await seedProvableGrant();
      await exchange(lost);
      const lostExpiry = (
        await setup.query("SELECT expires_at FROM mobile_app_auth_grants WHERE id=$1", [lost.id])
      ).rows[0].expires_at as Date;
      await expect(lost.ack(new Date(lostExpiry.getTime() + 1_000))).rejects.toMatchObject({
        protocolCode: "authorization_code_expired",
      });
      const keys = await setup.query("SELECT id,is_active,deleted_at FROM api_keys ORDER BY id");
      const byId = new Map(keys.rows.map((row) => [row.id, row]));
      expect(byId.get(landed.credential.id)).toMatchObject({ is_active: true, deleted_at: null });
      expect(byId.get(lost.credential.id)?.is_active).toBe(false);
    }, 30_000);

    test("expiry cleanup fences every organization before tombstoning inactive and acknowledged credentials", async () => {
      const inactive = await seedGrant();
      const active = await seedGrant({ owner: otherUserId, organization: otherOrganizationId });
      await exchange(inactive);
      await exchange(active);
      await acknowledge(active);
      begins = [];
      commits = [];
      const result = await run(() =>
        mobile.mobileAppAuthGrantsRepository.cleanupExpired(new Date(Date.now() + 7_200_000)),
      );
      expect(result.grantsDeleted).toBe(2);
      expect(result.inactiveCredentialsTombstoned).toBe(1);
      expect(result.acknowledgedCredentialsTombstoned).toBe(1);
      expect(result.integrityViolations).toBe(0);
      expect([...begins].sort()).toEqual([organizationId, otherOrganizationId].sort());
      expect(commits).toHaveLength(2);
      const keys = await setup.query("SELECT is_active,deleted_at,key_ciphertext FROM api_keys");
      expect(
        keys.rows.every(
          (key) =>
            key.is_active === false &&
            key.deleted_at instanceof Date &&
            key.key_ciphertext === null,
        ),
      ).toBe(true);
    }, 30_000);

    test("mobile cleanup preserves shared credential references", async () => {
      const first = await seedGrant();
      const second = await seedGrant();
      await exchange(first);
      await setup.query(
        "UPDATE mobile_app_auth_grants SET status='exchanged',credential_id=$2,exchanged_at=$3 WHERE id=$1",
        [second.id, first.credential.id, second.now],
      );
      const result = await run(() =>
        mobile.mobileAppAuthGrantsRepository.cleanupExpired(new Date(Date.now() + 7_200_000)),
      );
      expect(result.grantsDeleted).toBe(0);
      expect(result.integrityViolations).toBe(2);
      expect((await setup.query("SELECT id FROM mobile_app_auth_grants")).rowCount).toBe(2);
      expect((await setup.query("SELECT is_active,deleted_at FROM api_keys")).rows).toEqual([
        { is_active: false, deleted_at: null },
      ]);
    }, 30_000);

    test("mobile cleanup drains valid rows beside malformed pending grants", async () => {
      const malformed = await seedGrant();
      const valid = await seedGrant();
      await setup.query("UPDATE mobile_app_auth_grants SET exchanged_at=$2 WHERE id=$1", [
        malformed.id,
        malformed.now,
      ]);
      const result = await run(() =>
        mobile.mobileAppAuthGrantsRepository.cleanupExpired(new Date(Date.now() + 7_200_000)),
      );
      expect(result.grantsDeleted).toBe(1);
      expect(result.integrityViolations).toBe(1);
      expect((await setup.query("SELECT id FROM mobile_app_auth_grants")).rows).toEqual([
        { id: malformed.id },
      ]);
      expect(
        (await setup.query("SELECT id FROM mobile_app_auth_grants WHERE id=$1", [valid.id]))
          .rowCount,
      ).toBe(0);
    }, 30_000);

    test("bounded cleanup passes locked candidates and reaches later expired grants", async () => {
      const first = await seedGrant({ expiresAt: new Date(Date.now() - 10_000) });
      const second = await seedGrant({ expiresAt: new Date(Date.now() - 5_000) });
      const locker = new Client({ connectionString: scopedUrl });
      await locker.connect();
      await locker.query("BEGIN");
      try {
        await locker.query("SELECT id FROM mobile_app_auth_grants WHERE id=$1 FOR UPDATE", [
          first.id,
        ]);
        const service = await import("./mobile-app-auth");
        const result = await run(() =>
          service.cleanupExpiredMobileAppAuthGrants(new Date(), { batchSize: 1, maxBatches: 3 }),
        );
        expect(result.grantsDeleted).toBe(1);
        expect(result.remainingExpiredGrants).toBe(1);
        expect(result.remainingWork).toBe(true);
        const retained = await setup.query("SELECT id FROM mobile_app_auth_grants");
        expect(retained.rows).toEqual([{ id: first.id }]);
        expect(retained.rows.some((grant) => grant.id === second.id)).toBe(false);
      } finally {
        await locker.query("ROLLBACK");
        await locker.end();
      }
    }, 30_000);

    test("acknowledgement and an unmanaged Steward link on one user take locks in one order", async () => {
      const input = await seedGrant();
      await exchange(input);
      // An unmanaged users writer (UsersRepository.linkStewardId through the
      // group-consent revocation) locks the row first; the 0553 trigger then
      // takes the exclusive user lock. Acknowledgement must not hold the
      // shared user lock while it waits for that row.
      const linker = new Client({ connectionString: scopedUrl });
      await linker.connect();
      try {
        await linker.query("BEGIN");
        await linker.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [userId]);
        await linker.query(
          "INSERT INTO inference_policy_mutations(organization_id,mutation_id,fence_token,permit_expires_at,applying_txid,phase) VALUES($1,$2,'local-link',clock_timestamp()+interval '30 seconds',txid_current(),'applying')",
          [organizationId, randomUUID()],
        );
        const linkerPid = (await linker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        const acknowledged = acknowledge(input).then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        // Wait until acknowledgement is blocked behind the linker's row lock.
        let waiting = false;
        for (let attempt = 0; attempt < 200 && !waiting; attempt++) {
          const blocked = await observer.query(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND $1 = ANY(pg_blocking_pids(pid))",
            [linkerPid],
          );
          waiting = blocked.rows[0].n > 0;
          if (!waiting) await Bun.sleep(10);
        }
        expect(waiting).toBe(true);
        let linkError: unknown;
        try {
          await linker.query("UPDATE users SET steward_user_id=$1 WHERE id=$2", [
            `steward-${randomUUID()}`,
            userId,
          ]);
          await linker.query("COMMIT");
        } catch (error) {
          linkError = error;
          await linker.query("ROLLBACK");
        }
        const result = await acknowledged;
        // Opposite lock order surfaces as SQLSTATE 40P01 on one of the two.
        expect((linkError as { code?: string } | undefined)?.code).toBeUndefined();
        expect("error" in result ? String(result.error) : "").toBe("");
        expect("value" in result ? result.value : null).not.toBeNull();
        expect(
          (await setup.query("SELECT is_active FROM api_keys WHERE id=$1", [input.credential.id]))
            .rows[0].is_active,
        ).toBe(true);
      } finally {
        await linker.end();
      }
    }, 30_000);

    test("permit failure rolls back the mobile claim without minting a credential", async () => {
      const input = await seedGrant();
      rejectPermit = true;
      await expect(
        run(() =>
          mobile.mobileAppAuthGrantsRepository.exchange(input.binding, input.credential, input.now),
        ),
      ).rejects.toThrow("not acknowledged");
      expect(
        (
          await setup.query("SELECT status,credential_id FROM mobile_app_auth_grants WHERE id=$1", [
            input.id,
          ])
        ).rows[0],
      ).toEqual({ status: "pending", credential_id: null });
      expect((await setup.query("SELECT id FROM api_keys")).rowCount).toBe(0);
    }, 30_000);

    test("acknowledgement cannot activate a credential after the planned grant owner changes", async () => {
      const input = await seedGrant();
      await exchange(input);
      beforePermit = async () => {
        beforePermit = undefined;
        await observer.query(
          "UPDATE mobile_app_auth_grants SET user_id=$1,organization_id=$2 WHERE id=$3",
          [otherUserId, otherOrganizationId, input.id],
        );
      };
      expect(await acknowledge(input)).toBeNull();
      expect(
        (await setup.query("SELECT is_active FROM api_keys WHERE id=$1", [input.credential.id]))
          .rows[0].is_active,
      ).toBe(false);
    }, 30_000);

    test("cleanup retries instead of writing a grant whose planned owner changed", async () => {
      const input = await seedGrant();
      await exchange(input);
      beforePermit = async () => {
        beforePermit = undefined;
        await observer.query(
          "UPDATE mobile_app_auth_grants SET user_id=$1,organization_id=$2 WHERE id=$3",
          [otherUserId, otherOrganizationId, input.id],
        );
      };
      await expect(
        run(() =>
          mobile.mobileAppAuthGrantsRepository.cleanupExpired(new Date(Date.now() + 7_200_000)),
        ),
      ).rejects.toThrow("owner changed");
      const key = (
        await setup.query("SELECT is_active,deleted_at,key_ciphertext FROM api_keys WHERE id=$1", [
          input.credential.id,
        ])
      ).rows[0];
      expect(key.is_active).toBe(false);
      expect(key.deleted_at).toBeNull();
      expect(key.key_ciphertext).toBe(input.credential.key_ciphertext);
    }, 30_000);

    test("CLI consumed credentials survive cleanup after concurrent one-shot delivery", async () => {
      const sessionId = randomUUID();
      const now = new Date();
      await setup.query(
        "INSERT INTO cli_auth_sessions(id,session_id,status,expires_at,created_at,updated_at) VALUES($1,$2,'pending',$3,$4,$4)",
        [randomUUID(), sessionId, new Date(now.getTime() + 60_000), now],
      );
      const created = await run(() =>
        new cli.CliAuthSessionCompletionService().claimPending({
          sessionId,
          userId,
          organizationId,
        }),
      );
      expect(created.claimed).toBe(true);
      const { CliAuthSessionsService } = await import("./cli-auth-sessions");
      const { CliAuthSessionsRepository } = await import("../../db/repositories/cli-auth-sessions");
      const sessions = new CliAuthSessionsService();
      const locker = new Client({ connectionString: scopedUrl });
      await locker.connect();
      await locker.query("BEGIN");
      await locker.query("SELECT id FROM cli_auth_sessions WHERE session_id=$1 FOR UPDATE", [
        sessionId,
      ]);
      const polls = run(() =>
        Promise.all([sessions.getAndClearApiKey(sessionId), sessions.getAndClearApiKey(sessionId)]),
      );
      try {
        const deadline = Date.now() + 5_000;
        while (
          (
            await setup.query(
              "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'update \"cli_auth_sessions\"%'",
            )
          ).rowCount !== 2
        ) {
          if (Date.now() >= deadline)
            throw new Error("Both reveal contenders did not reach the row lock");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        await locker.query("COMMIT");
        const results = await polls;
        expect(results.filter((result) => result.status === "revealed")).toHaveLength(1);
        const reaped = await run(() =>
          new CliAuthSessionsRepository().reapExpiredSessions(new Date(now.getTime() + 120_000)),
        );
        expect(reaped.deletedSessions).toBe(1);
        expect(reaped.revokedOrphanKeys).toHaveLength(0);
        expect(
          (await setup.query("SELECT is_active FROM api_keys WHERE id=$1", [created.apiKey!.id]))
            .rows[0].is_active,
        ).toBe(true);
      } finally {
        await locker.query("ROLLBACK");
        await locker.end();
        await polls.catch(() => undefined);
      }
    }, 30_000);

    test("CLI cleanup cannot strand an active key from a completion admitted before expiry", async () => {
      const sessionId = randomUUID();
      const expiresAt = new Date(Date.now() + 4_000);
      await setup.query(
        "INSERT INTO cli_auth_sessions(id,session_id,status,expires_at,created_at,updated_at) VALUES($1,$2,'pending',$3,clock_timestamp(),clock_timestamp())",
        [randomUUID(), sessionId, expiresAt],
      );
      const blocker = new Client({ connectionString: scopedUrl });
      await blocker.connect();
      const lock = `${schema}:cli-cleanup-race`;
      await blocker.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [lock]);
      await setup.query(`CREATE FUNCTION hold_cli_cleanup() RETURNS trigger LANGUAGE plpgsql AS $body$
        BEGIN
          PERFORM pg_advisory_xact_lock(hashtextextended(TG_TABLE_SCHEMA || ':cli-cleanup-race',0));
          RETURN NULL;
        END $body$`);
      await setup.query(
        "CREATE TRIGGER hold_cli_cleanup AFTER UPDATE ON api_keys FOR EACH STATEMENT EXECUTE FUNCTION hold_cli_cleanup()",
      );
      let allowPermit!: () => void;
      let permitReached!: () => void;
      const permit = new Promise<void>((resolve) => {
        allowPermit = resolve;
      });
      const reached = new Promise<void>((resolve) => {
        permitReached = resolve;
      });
      beforePermit = async () => {
        permitReached();
        await permit;
      };
      let completionSettled = false;
      const completion = run(() =>
        new cli.CliAuthSessionCompletionService().claimPending({
          sessionId,
          userId,
          organizationId,
        }),
      ).then((value) => {
        completionSettled = true;
        return value;
      });
      let cleanup: Promise<unknown> | undefined;
      try {
        await reached;
        expect(Date.now()).toBeLessThan(expiresAt.getTime());
        await new Promise((resolve) => setTimeout(resolve, expiresAt.getTime() - Date.now() + 20));
        const { CliAuthSessionsRepository } = await import(
          "../../db/repositories/cli-auth-sessions"
        );
        cleanup = run(() => new CliAuthSessionsRepository().reapExpiredSessions());
        const waitFor = async (predicate: () => Promise<boolean>, message: string) => {
          const deadline = Date.now() + 5_000;
          while (!(await predicate())) {
            if (Date.now() >= deadline) throw new Error(message);
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        };
        await waitFor(
          async () =>
            (
              await setup.query(
                "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND query LIKE 'update \"api_keys\"%'",
              )
            ).rowCount !== 0,
          "Cleanup never reached its key-update barrier",
        );
        allowPermit();
        await waitFor(
          async () =>
            completionSettled ||
            (
              await setup.query(
                "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'update \"cli_auth_sessions\"%'",
              )
            ).rowCount !== 0,
          "Completion neither settled nor waited for cleanup's session lock",
        );
        await blocker.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [lock]);
        await Promise.all([completion, cleanup]);
        expect(
          (await setup.query("SELECT id FROM cli_auth_sessions WHERE session_id=$1", [sessionId]))
            .rowCount,
        ).toBe(0);
        expect((await setup.query("SELECT id FROM api_keys WHERE is_active=true")).rowCount).toBe(
          0,
        );
      } finally {
        allowPermit();
        await blocker.query("SELECT pg_advisory_unlock_all()");
        await Promise.allSettled([completion, ...(cleanup ? [cleanup] : [])]);
        await setup.query("DROP TRIGGER hold_cli_cleanup ON api_keys");
        await setup.query("DROP FUNCTION hold_cli_cleanup()");
        await blocker.end();
        beforePermit = undefined;
      }
    }, 30_000);

    test("CLI completion encrypts, commits and replays its single credential through enrolled policy", async () => {
      const sessionId = randomUUID();
      const now = new Date();
      await setup.query(
        "INSERT INTO cli_auth_sessions(id,session_id,status,expires_at,created_at,updated_at) VALUES($1,$2,'pending',$3,$4,$4)",
        [randomUUID(), sessionId, new Date(now.getTime() + 60_000), now],
      );
      const service = new cli.CliAuthSessionCompletionService();
      const first = await run(() => service.claimPending({ sessionId, userId, organizationId }));
      expect(first.claimed).toBe(true);
      const second = await run(() => service.claimPending({ sessionId, userId, organizationId }));
      expect(second.claimed).toBe(false);
      expect(second.apiKey?.id).toBe(first.apiKey?.id);
      expect((await setup.query("SELECT id FROM api_keys")).rowCount).toBe(1);
      const key = first.apiKey!;
      const secret = await run(() =>
        decrypt.decryptApiKey(key.id, {
          ciphertext: key.key_ciphertext!,
          nonce: key.key_nonce!,
          auth_tag: key.key_auth_tag!,
          kms_key_id: key.key_kms_key_id!,
          kms_key_version: key.key_kms_key_version!,
        }),
      );
      expect(secret.startsWith("eliza_")).toBe(true);
      expect(commits).toHaveLength(2);
      const state = await run(() =>
        database.dbWrite
          .select()
          .from(tables.cliAuthSessions)
          .where(eq(tables.cliAuthSessions.session_id, sessionId)),
      );
      expect(state[0]?.api_key_id).toBe(key.id);
    }, 30_000);
  },
);
