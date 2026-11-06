/** Real PostgreSQL credential flows with enrolled policy guards and test-only KMS. */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
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
const organizationId = randomUUID();
const userId = randomUUID();
const appId = randomUUID();
const otherOrganizationId = randomUUID();
const otherUserId = randomUUID();
let begins: string[];
let commits: string[];
let beforePermit: (() => Promise<void>) | undefined;
let rejectPermit = false;

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
        // Use all real Drizzle columns; unrelated constraints are outside this fixture.
        await setup.query(
          `CREATE TABLE ${quote(config.name)} (${config.columns.map((column) => `${quote(column.name)} ${column.getSQLType()}${column.primary ? " PRIMARY KEY" : ""}`).join(",")})`,
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
