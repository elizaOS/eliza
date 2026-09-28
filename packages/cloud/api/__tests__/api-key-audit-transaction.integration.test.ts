/**
 * Proves API-key mutations and their durable `auth_events` audit row commit or
 * roll back together on real PGlite: a required audit write failure leaves no
 * unaudited key change behind.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { sql } from "drizzle-orm";

process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";

const ORG_ID = "00000000-0000-4000-8000-0000000000a1";
const USER_ID = "00000000-0000-4000-8000-0000000000b1";
const APP_ID = "00000000-0000-4000-8000-0000000000d1";
const PGLITE_TIMEOUT_MS = 60_000;

const revocationActual = await import(
  "@/lib/services/inference-credential-revocation"
);
mock.module("@/lib/services/inference-credential-revocation", () => ({
  ...revocationActual,
  revokeInferenceApiKey: async () => {},
}));

let dbWrite: typeof import("@/db/helpers").dbWrite;
let closeDatabaseConnectionsForTests: typeof import("@/db/client").closeDatabaseConnectionsForTests;
let apiKeysService: typeof import("@/lib/services/api-keys").apiKeysService;
let createTransactionalAudit: typeof import("../src/services/audit-transactional").createTransactionalAudit;
let auditEventsSink: typeof import("../src/services/audit-events").auditEventsSink;

beforeAll(async () => {
  ({ dbWrite } = await import("@/db/helpers"));
  ({ closeDatabaseConnectionsForTests } = await import("@/db/client"));
  ({ apiKeysService } = await import("@/lib/services/api-keys"));
  ({ createTransactionalAudit } = await import(
    "../src/services/audit-transactional"
  ));
  ({ auditEventsSink } = await import("../src/services/audit-events"));
  const { initAuditDispatcher } = await import(
    "../src/services/audit-dispatcher-singleton"
  );
  initAuditDispatcher([auditEventsSink]);

  await dbWrite.execute(sql`
    CREATE TABLE IF NOT EXISTS api_keys (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      description text,
      key_hash text NOT NULL UNIQUE,
      key_prefix text NOT NULL,
      key_ciphertext text, key_nonce text, key_auth_tag text,
      key_kms_key_id text, key_kms_key_version integer,
      organization_id uuid NOT NULL,
      user_id uuid NOT NULL,
      source_app_id uuid,
      rate_limit integer NOT NULL DEFAULT 1000,
      is_active boolean NOT NULL DEFAULT true,
      usage_count integer NOT NULL DEFAULT 0,
      expires_at timestamp,
      last_used_at timestamp,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now(),
      user_created boolean NOT NULL DEFAULT false,
      deleted_at timestamp
    )
  `);
  await dbWrite.execute(sql`
    CREATE TABLE IF NOT EXISTS auth_events (
      event_id uuid PRIMARY KEY, ts timestamptz NOT NULL DEFAULT now(),
      actor_type text NOT NULL, actor_id text NOT NULL, action text NOT NULL,
      result text NOT NULL, resource_type text, resource_id text, ip text,
      ua text, request_id text, org_id text, metadata jsonb,
      expires_at timestamptz NOT NULL DEFAULT now() + interval '7 years'
    )
  `);
}, PGLITE_TIMEOUT_MS);

afterEach(async () => {
  mock.restore();
  await dbWrite.execute(sql`DELETE FROM api_keys`);
  await dbWrite.execute(sql`DELETE FROM auth_events`);
});

afterAll(async () => {
  await dbWrite.execute(sql`DROP TABLE IF EXISTS api_keys`);
  await dbWrite.execute(sql`DROP TABLE IF EXISTS auth_events`);
  await closeDatabaseConnectionsForTests();
}, PGLITE_TIMEOUT_MS);

async function count(table: "api_keys" | "auth_events"): Promise<number> {
  const result = (await dbWrite.execute(
    sql.raw(`SELECT count(*)::int AS n FROM ${table}`),
  )) as { rows: Array<{ n: number }> };
  return result.rows[0].n;
}

async function auditActions(): Promise<string[]> {
  const result = (await dbWrite.execute(
    sql`SELECT action FROM auth_events ORDER BY ts`,
  )) as { rows: Array<{ action: string }> };
  return result.rows.map((row) => row.action);
}

function createKey(audit: ReturnType<typeof createTransactionalAudit>) {
  return apiKeysService.create(
    {
      name: "audited",
      organization_id: ORG_ID,
      user_id: USER_ID,
      is_active: true,
    },
    undefined,
    async (tx, created) => {
      await audit.write(tx, {
        actor: { type: "user", id: USER_ID },
        action: "api_key.create",
        result: "success",
        resource: { type: "api_key", id: created.id },
        org_id: ORG_ID,
        metadata: { key_id: created.id, name: created.name },
      });
    },
  );
}

function failAuditWrites() {
  spyOn(auditEventsSink, "emitInTransaction").mockImplementation(async () => {
    throw new Error("auth_events unavailable");
  });
}

describe("transactional API-key audit", () => {
  test(
    "create commits the key and its audit row together",
    async () => {
      const audit = createTransactionalAudit();
      await createKey(audit);
      await audit.publish();
      expect(await count("api_keys")).toBe(1);
      expect(await auditActions()).toEqual(["api_key.create"]);
    },
    PGLITE_TIMEOUT_MS,
  );

  test(
    "a failed audit write rolls the created key back",
    async () => {
      failAuditWrites();
      const error = await createKey(createTransactionalAudit()).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect((error as Error).message).toBe("auth_events unavailable");
      expect(await count("api_keys")).toBe(0);
      expect(await count("auth_events")).toBe(0);
    },
    PGLITE_TIMEOUT_MS,
  );

  test(
    "a failed audit write rolls back delete and regenerate",
    async () => {
      const { apiKey } = await createKey(createTransactionalAudit());
      failAuditWrites();
      const audit = createTransactionalAudit();
      const writeRevoke = async (
        tx: Parameters<typeof audit.write>[0],
      ): Promise<void> => {
        await audit.write(tx, {
          actor: { type: "user", id: USER_ID },
          action: "api_key.revoke",
          result: "success",
          resource: { type: "api_key", id: apiKey.id },
        });
      };
      await expect(
        apiKeysService.delete(apiKey.id, writeRevoke),
      ).rejects.toThrow("auth_events unavailable");
      await expect(
        apiKeysService.regenerate(apiKey.id, (tx) => writeRevoke(tx)),
      ).rejects.toThrow("auth_events unavailable");
      const rows = (await dbWrite.execute(sql`SELECT id FROM api_keys`)) as {
        rows: Array<{ id: string }>;
      };
      expect(rows.rows.map((row) => row.id)).toEqual([apiKey.id]);
    },
    PGLITE_TIMEOUT_MS,
  );

  test(
    "account mobile revoke keeps the credential active when the audit write fails",
    async () => {
      const inserted = (await dbWrite.execute(sql`
        INSERT INTO api_keys (name, key_hash, key_prefix, organization_id, user_id, source_app_id)
        VALUES ('mobile', 'hash-mobile', 'eliza_m', ${ORG_ID}, ${USER_ID}, ${APP_ID})
        RETURNING id
      `)) as { rows: Array<{ id: string }> };
      const credentialId = inserted.rows[0].id;
      const audit = createTransactionalAudit();
      const write = async (tx: Parameters<typeof audit.write>[0]) => {
        await audit.write(tx, {
          actor: { type: "user", id: USER_ID },
          action: "api_key.revoke",
          result: "success",
          resource: { type: "api_key", id: credentialId },
        });
      };

      failAuditWrites();
      await expect(
        apiKeysService.revokeMobileCredentialForAccount(
          credentialId,
          USER_ID,
          ORG_ID,
          write,
        ),
      ).rejects.toThrow("auth_events unavailable");
      const active = (await dbWrite.execute(
        sql`SELECT is_active FROM api_keys WHERE id = ${credentialId}`,
      )) as { rows: Array<{ is_active: boolean }> };
      expect(active.rows[0].is_active).toBe(true);

      mock.restore();
      const result = await apiKeysService.revokeMobileCredentialForAccount(
        credentialId,
        USER_ID,
        ORG_ID,
        write,
      );
      expect(result?.revokedNow).toBe(true);
      expect(await auditActions()).toEqual(["api_key.revoke"]);
    },
    PGLITE_TIMEOUT_MS,
  );
});
