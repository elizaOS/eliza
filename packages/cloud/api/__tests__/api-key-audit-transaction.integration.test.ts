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
  "@elizaos/cloud-shared/lib/services/inference-credential-revocation"
);
mock.module(
  "@elizaos/cloud-shared/lib/services/inference-credential-revocation",
  () => ({
    ...revocationActual,
    revokeInferenceApiKey: async () => {},
  }),
);

let dbWrite: typeof import("@elizaos/cloud-shared/db/helpers").dbWrite;
let closeDatabaseConnectionsForTests: typeof import("@elizaos/cloud-shared/db/client").closeDatabaseConnectionsForTests;
let apiKeysService: typeof import("@elizaos/cloud-shared/lib/services/api-keys").apiKeysService;
let createTransactionalAudit: typeof import("../src/services/audit-transactional").createTransactionalAudit;
let auditEventsSink: typeof import("../src/services/audit-events").auditEventsSink;

beforeAll(async () => {
  ({ dbWrite } = await import("@elizaos/cloud-shared/db/helpers"));
  ({ closeDatabaseConnectionsForTests } = await import(
    "@elizaos/cloud-shared/db/client"
  ));
  ({ apiKeysService } = await import(
    "@elizaos/cloud-shared/lib/services/api-keys"
  ));
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
    "standard credential self-revocation retains an exact-secret retry receipt",
    async () => {
      const { apiKey, plainKey } = await createKey(createTransactionalAudit());
      const other = await createKey(createTransactionalAudit());
      const first =
        await apiKeysService.revokePresentedStandardCredential(plainKey);
      expect(first?.receipt.credentialId).toBe(apiKey.id);
      expect(first?.revokedNow).toBe(true);
      const retry =
        await apiKeysService.revokePresentedStandardCredential(plainKey);
      expect(retry?.receipt).toEqual(first?.receipt);
      expect(retry?.revokedNow).toBe(false);
      expect(
        await apiKeysService.revokePresentedStandardCredential(
          `eliza_${"0".repeat(64)}`,
        ),
      ).toBeNull();
      const { apiKeysRepository } = await import(
        "@elizaos/cloud-shared/db/repositories/api-keys"
      );
      const row = await apiKeysRepository.findByIdConsistent(apiKey.id);
      expect(row?.is_active).toBe(false);
      expect(row?.key_ciphertext).toBeNull();
      expect(
        (await apiKeysRepository.findByIdConsistent(other.apiKey.id))
          ?.is_active,
      ).toBe(true);
    },
    PGLITE_TIMEOUT_MS,
  );

  test(
    "standard credential self-revocation rolls back when durable audit fails",
    async () => {
      const { apiKey, plainKey } = await createKey(createTransactionalAudit());
      await expect(
        apiKeysService.revokePresentedStandardCredential(plainKey, async () => {
          throw new Error("audit unavailable");
        }),
      ).rejects.toThrow("audit unavailable");
      const { apiKeysRepository } = await import(
        "@elizaos/cloud-shared/db/repositories/api-keys"
      );
      expect(
        (await apiKeysRepository.findByIdConsistent(apiKey.id))?.is_active,
      ).toBe(true);
    },
    PGLITE_TIMEOUT_MS,
  );

  test(
    "two rotations that read the same key consume it only once",
    async () => {
      const { apiKey: original } = await createKey(createTransactionalAudit());
      const { apiKeysRepository } = await import(
        "@elizaos/cloud-shared/db/repositories/api-keys"
      );
      const read = apiKeysRepository.findByIdConsistent.bind(apiKeysRepository);
      let release!: () => void;
      const bothRead = new Promise<void>((resolve) => {
        release = resolve;
      });
      let readers = 0;
      spyOn(apiKeysRepository, "findByIdConsistent").mockImplementation(
        async (id) => {
          const row = await read(id);
          if (id === original.id) {
            readers += 1;
            if (readers === 2) release();
            await bothRead;
          }
          return row;
        },
      );
      const rotate = async () => {
        const audit = createTransactionalAudit();
        const result = await apiKeysService.regenerate(
          original.id,
          async (tx, created) => {
            await audit.write(tx, {
              actor: { type: "user", id: USER_ID },
              action: "api_key.rotate",
              result: "success",
              resource: { type: "api_key", id: original.id },
              org_id: ORG_ID,
              metadata: { key_id: created.id },
            });
          },
        );
        await audit.publish();
        return result;
      };
      const outcomes = await Promise.allSettled([rotate(), rotate()]);
      expect(readers).toBe(2);
      expect(
        outcomes.filter((outcome) => outcome.status === "fulfilled"),
      ).toHaveLength(1);
      const refused = outcomes.find((outcome) => outcome.status === "rejected");
      expect(refused?.status === "rejected" && refused.reason).toMatchObject({
        code: "API_KEY_NOT_FOUND",
      });
      expect(await count("api_keys")).toBe(1);
      const rows = (await dbWrite.execute(sql`SELECT id FROM api_keys`)) as {
        rows: Array<{ id: string }>;
      };
      expect(rows.rows[0].id).not.toBe(original.id);
      expect(await auditActions()).toEqual([
        "api_key.create",
        "api_key.rotate",
      ]);
    },
    PGLITE_TIMEOUT_MS,
  );

  test(
    "an inactive key cannot be rotated using an earlier active read",
    async () => {
      const { apiKey: original } = await createKey(createTransactionalAudit());
      const { apiKeysRepository } = await import(
        "@elizaos/cloud-shared/db/repositories/api-keys"
      );
      const read = apiKeysRepository.findByIdConsistent.bind(apiKeysRepository);
      spyOn(apiKeysRepository, "findByIdConsistent").mockImplementation(
        async (id) => {
          const row = await read(id);
          if (id === original.id)
            await dbWrite.execute(
              sql`UPDATE api_keys SET is_active = false WHERE id = ${id}`,
            );
          return row;
        },
      );
      await expect(
        apiKeysService.regenerate(original.id),
      ).rejects.toMatchObject({ code: "API_KEY_NOT_FOUND" });
      const rows = (await dbWrite.execute(
        sql`SELECT id, is_active FROM api_keys`,
      )) as { rows: Array<{ id: string; is_active: boolean }> };
      expect(rows.rows).toEqual([{ id: original.id, is_active: false }]);
      expect(await auditActions()).toEqual(["api_key.create"]);
    },
    PGLITE_TIMEOUT_MS,
  );

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
