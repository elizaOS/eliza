/**
 * Proves API-key mutations and their durable `auth_events` audit row commit or
 * roll back together on real PGlite: a required audit write failure leaves no
 * unaudited key change behind.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";

process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";

const ORG_ID = "00000000-0000-4000-8000-0000000000a1";
const USER_ID = "00000000-0000-4000-8000-0000000000b1";
const APP_ID = "00000000-0000-4000-8000-0000000000d1";
const PGLITE_TIMEOUT_MS = 60_000;

const mobileEvents: string[] = [];
let revocationFailure: Error | undefined;
const revocationActual = await import(
  "@elizaos/cloud-shared/lib/services/inference-credential-revocation"
);
mock.module(
  "@elizaos/cloud-shared/lib/services/inference-credential-revocation",
  () => ({
    ...revocationActual,
    revokeInferenceApiKey: async (
      organizationId: string,
      credentialId: string,
    ) => {
      mobileEvents.push(`fence:${organizationId}:${credentialId}`);
      if (revocationFailure) throw revocationFailure;
    },
  }),
);

let cache: typeof import("@elizaos/cloud-shared/lib/cache/client").cache;
let apiKeysRepository: typeof import("@elizaos/cloud-shared/db/repositories/api-keys").apiKeysRepository;
let dbWrite: typeof import("@elizaos/cloud-shared/db/helpers").dbWrite;
let dbHelpers: typeof import("@elizaos/cloud-shared/db/helpers");
let closeDatabaseConnectionsForTests: typeof import("@elizaos/cloud-shared/db/client").closeDatabaseConnectionsForTests;
let apiKeysService: typeof import("@elizaos/cloud-shared/lib/services/api-keys").apiKeysService;
let createTransactionalAudit: typeof import("../src/services/audit-transactional").createTransactionalAudit;
let auditEventsSink: typeof import("../src/services/audit-events").auditEventsSink;

beforeAll(async () => {
  ({ cache } = await import("@elizaos/cloud-shared/lib/cache/client"));
  ({ apiKeysRepository } = await import(
    "@elizaos/cloud-shared/db/repositories/api-keys"
  ));
  dbHelpers = await import("@elizaos/cloud-shared/db/helpers");
  ({ dbWrite } = dbHelpers);
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
  revocationFailure = undefined;
  mobileEvents.length = 0;
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
      spyOn(cache, "delConfirmed").mockResolvedValue(true);
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

/** Real primary transactions; only DO transport and cache deletion are stubbed. */
describe("mobile revocation fences and retry recovery", () => {
  let rejectEviction = false;
  let targetCredentialId: string | undefined;

  beforeEach(() => {
    rejectEviction = false;
    targetCredentialId = undefined;
    spyOn(cache, "delConfirmed").mockImplementation(async (key) => {
      mobileEvents.push(`evict:${key}`);
      if (targetCredentialId) {
        const row =
          await apiKeysRepository.findByIdConsistent(targetCredentialId);
        expect(row?.is_active).toBe(false);
        expect(row?.deleted_at).not.toBeNull();
      }
      return !rejectEviction;
    });
  });

  async function seedMobile() {
    const secret = `eliza_mobile_${"a".repeat(64)}`;
    const keyHash = createHash("sha256").update(secret).digest("hex");
    const inserted = (await dbWrite.execute(sql`
      INSERT INTO api_keys (name, key_hash, key_prefix, organization_id, user_id, source_app_id)
      VALUES ('mobile-fence', ${keyHash}, 'eliza_mobile_', ${ORG_ID}, ${USER_ID}, ${APP_ID})
      RETURNING id
    `)) as { rows: Array<{ id: string }> };
    targetCredentialId = inserted.rows[0].id;
    return { id: targetCredentialId, keyHash, secret };
  }

  type Mobile = Awaited<ReturnType<typeof seedMobile>>;
  type Audit = Parameters<
    typeof apiKeysService.revokeMobileCredentialForAccount
  >[3];
  const variants = ["account", "secret", "exact"] as const;

  function revoke(
    kind: (typeof variants)[number],
    mobile: Mobile,
    audit?: Audit,
  ) {
    return kind === "account"
      ? apiKeysService.revokeMobileCredentialForAccount(
          mobile.id,
          USER_ID,
          ORG_ID,
          audit,
        )
      : kind === "secret"
        ? apiKeysService.revokePresentedMobileCredential(mobile.secret, audit)
        : apiKeysService.revokeExactMobileCredential(
            { id: mobile.id, key_hash: mobile.keyHash, source_app_id: APP_ID },
            audit,
          );
  }

  async function standing(id: string) {
    const row = await apiKeysRepository.findByIdConsistent(id);
    expect(row).toBeDefined();
    return row!;
  }

  function expectEviction(mobile: Mobile) {
    expect(mobileEvents).toContain(
      `evict:apikey:validation:${mobile.keyHash.substring(0, 16)}:v1`,
    );
    expect(mobileEvents).toContain(`evict:iac:auth:${mobile.keyHash}:v4`);
    expect(mobileEvents[0]).toBe(`fence:${ORG_ID}:${mobile.id}`);
  }

  for (const kind of variants) {
    test(
      `${kind}: unknown DO outcome prevents the primary tombstone`,
      async () => {
        const mobile = await seedMobile();
        revocationFailure = new Error("revocation acknowledgement unknown");
        await expect(revoke(kind, mobile)).rejects.toThrow(
          "revocation acknowledgement unknown",
        );
        expect((await standing(mobile.id)).is_active).toBe(true);
        expect((await standing(mobile.id)).deleted_at).toBeNull();
        expect(mobileEvents).toEqual([`fence:${ORG_ID}:${mobile.id}`]);
        expect(await count("auth_events")).toBe(0);
        revocationFailure = undefined;
        const retry = await revoke(kind, mobile);
        expect(retry?.revokedNow).toBe(true);
        expectEviction(mobile);
      },
      PGLITE_TIMEOUT_MS,
    );

    test(
      `${kind}: audit failure rolls back primary state after the denial fence`,
      async () => {
        const mobile = await seedMobile();
        const audit = createTransactionalAudit();
        failAuditWrites();
        await expect(
          revoke(kind, mobile, async (tx) => {
            mobileEvents.push("audit");
            await audit.write(tx, {
              actor: { type: "user", id: USER_ID },
              action: "api_key.revoke",
              result: "success",
              resource: { type: "api_key", id: mobile.id },
            });
          }),
        ).rejects.toThrow("auth_events unavailable");
        expect((await standing(mobile.id)).is_active).toBe(true);
        expect((await standing(mobile.id)).deleted_at).toBeNull();
        expect(mobileEvents).toEqual([`fence:${ORG_ID}:${mobile.id}`, "audit"]);
        expect(await count("auth_events")).toBe(0);
      },
      PGLITE_TIMEOUT_MS,
    );

    test(
      `${kind}: a lost commit reply retries the durable receipt and repairs eviction`,
      async () => {
        const mobile = await seedMobile();
        const audit = createTransactionalAudit();
        const write: Audit = async (tx) => {
          await audit.write(tx, {
            actor: { type: "user", id: USER_ID },
            action: "api_key.revoke",
            result: "success",
            resource: { type: "api_key", id: mobile.id },
          });
        };
        const commit = dbHelpers.writeTransaction;
        let loseReply = true;
        spyOn(dbHelpers, "writeTransaction").mockImplementation(
          async <T>(
            operation: (
              tx: import("@elizaos/cloud-shared/db/client").DbTransaction,
            ) => Promise<T>,
          ): Promise<T> => {
            const result = await commit(operation);
            if (loseReply) {
              loseReply = false;
              throw new Error("fixture commit reply lost");
            }
            return result;
          },
        );
        await expect(revoke(kind, mobile, write)).rejects.toThrow(
          "fixture commit reply lost",
        );
        const durable = await standing(mobile.id);
        expect(durable.is_active).toBe(false);
        expect(durable.deleted_at).not.toBeNull();
        expect(await auditActions()).toEqual(["api_key.revoke"]);
        expect(mobileEvents.some((event) => event.startsWith("evict:"))).toBe(
          false,
        );
        const retried = await revoke(kind, mobile, write);
        expect(retried?.revokedNow).toBe(false);
        expect(retried?.receipt.revokedAt).toBe(
          new Date(durable.deleted_at!).toISOString(),
        );
        expectEviction(mobile);
        expect(await auditActions()).toEqual(["api_key.revoke"]);
      },
      PGLITE_TIMEOUT_MS,
    );

    test(
      `${kind}: eviction failure retains tombstone and retry repairs without another audit`,
      async () => {
        const mobile = await seedMobile();
        const audit = createTransactionalAudit();
        const write: Audit = async (tx) => {
          mobileEvents.push("audit");
          await audit.write(tx, {
            actor: { type: "user", id: USER_ID },
            action: "api_key.revoke",
            result: "success",
            resource: { type: "api_key", id: mobile.id },
          });
        };
        rejectEviction = true;
        await expect(revoke(kind, mobile, write)).rejects.toThrow(
          "cache invalidation not confirmed",
        );
        const tombstone = await standing(mobile.id);
        expect(tombstone.is_active).toBe(false);
        expect(tombstone.deleted_at).not.toBeNull();
        expectEviction(mobile);
        expect(mobileEvents.indexOf("audit")).toBeLessThan(
          mobileEvents.findIndex((e) => e.startsWith("evict:")),
        );
        expect(await auditActions()).toEqual(["api_key.revoke"]);
        mobileEvents.length = 0;
        rejectEviction = false;
        const retry = await revoke(kind, mobile, write);
        expect(retry?.revokedNow).toBe(false);
        expect(retry?.receipt.revokedAt).toBe(
          new Date(tombstone.deleted_at!).toISOString(),
        );
        expectEviction(mobile);
        expect(mobileEvents).not.toContain("audit");
        expect(await auditActions()).toEqual(["api_key.revoke"]);
      },
      PGLITE_TIMEOUT_MS,
    );

    for (const status of ["expired", "inactive"] as const) {
      if (kind === "exact" && status === "inactive") continue;
      test(
        `${kind}: ${status} mobile credentials still receive a durable revocation receipt`,
        async () => {
          const mobile = await seedMobile();
          if (status === "expired") {
            await dbWrite.execute(
              sql`UPDATE api_keys SET expires_at = now() - interval '1 hour' WHERE id = ${mobile.id}`,
            );
          } else {
            await dbWrite.execute(
              sql`UPDATE api_keys SET is_active = false WHERE id = ${mobile.id}`,
            );
          }
          const result = await revoke(kind, mobile);
          expect(result?.receipt.credentialId).toBe(mobile.id);
          expect(result?.revokedNow).toBe(true);
          expect((await standing(mobile.id)).deleted_at).not.toBeNull();
          expectEviction(mobile);
        },
        PGLITE_TIMEOUT_MS,
      );
    }

    test(
      `${kind}: successful and already-revoked calls repeat the same immutable fence`,
      async () => {
        const mobile = await seedMobile();
        const first = await revoke(kind, mobile);
        expect(first?.revokedNow).toBe(true);
        expect((await standing(mobile.id)).is_active).toBe(false);
        expectEviction(mobile);
        mobileEvents.length = 0;
        const retry = await revoke(kind, mobile);
        expect(retry?.revokedNow).toBe(false);
        expect(retry?.receipt).toEqual(first?.receipt);
        expectEviction(mobile);
      },
      PGLITE_TIMEOUT_MS,
    );
  }

  test(
    "wrong owner, wrong organization and unknown secret have no fence or eviction effects",
    async () => {
      const mobile = await seedMobile();
      const other = "00000000-0000-4000-8000-0000000000e1";
      expect(
        await apiKeysService.revokeMobileCredentialForAccount(
          mobile.id,
          other,
          ORG_ID,
        ),
      ).toBeNull();
      expect(
        await apiKeysService.revokeMobileCredentialForAccount(
          mobile.id,
          USER_ID,
          other,
        ),
      ).toBeNull();
      expect(
        await apiKeysService.revokePresentedMobileCredential(
          `eliza_mobile_${"b".repeat(64)}`,
        ),
      ).toBeNull();
      expect(
        await apiKeysService.revokePresentedMobileCredential("invalid"),
      ).toBeNull();
      expect(mobileEvents).toEqual([]);
      expect((await standing(mobile.id)).is_active).toBe(true);
    },
    PGLITE_TIMEOUT_MS,
  );

  test(
    "a concurrent account tombstone is recognized and still evicted",
    async () => {
      const mobile = await seedMobile();
      const tombstone =
        apiKeysRepository.tombstoneMobileByOwner.bind(apiKeysRepository);
      spyOn(apiKeysRepository, "tombstoneMobileByOwner").mockImplementation(
        async (...args) => {
          await tombstone(...args);
          // Simulate a competing writer winning before the caller's RETURNING.
          return undefined;
        },
      );
      const result = await revoke("account", mobile);
      expect(result?.revokedNow).toBe(false);
      expect((await standing(mobile.id)).is_active).toBe(false);
      expectEviction(mobile);
    },
    PGLITE_TIMEOUT_MS,
  );

  test(
    "a concurrent exact-secret tombstone is recognized and still evicted",
    async () => {
      const mobile = await seedMobile();
      const tombstone =
        apiKeysRepository.tombstoneExactMobileCredential.bind(
          apiKeysRepository,
        );
      spyOn(
        apiKeysRepository,
        "tombstoneExactMobileCredential",
      ).mockImplementation(async (...args) => {
        await tombstone(...args);
        return undefined;
      });
      const result = await revoke("secret", mobile);
      expect(result?.revokedNow).toBe(false);
      expect((await standing(mobile.id)).is_active).toBe(false);
      expectEviction(mobile);
    },
    PGLITE_TIMEOUT_MS,
  );
});
