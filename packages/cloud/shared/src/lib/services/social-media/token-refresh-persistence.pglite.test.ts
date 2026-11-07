/** Proves social OAuth refreshes rotate the credential's real PGlite-backed secrets. */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import * as actualDb from "../../../db/client";
import { organizations } from "../../../db/schemas/organizations";
import { platformCredentials } from "../../../db/schemas/platform-credentials";
import { secretAuditLog, secrets } from "../../../db/schemas/secrets";
import { users } from "../../../db/schemas/users";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const CREDENTIAL_ID = "33333333-3333-4333-8333-333333333333";
const MASTER_KEY = "a".repeat(64);
const pg = new PGlite();
const database = drizzle(pg);
const originalFetch = globalThis.fetch;
const originalTwitterClientId = process.env.TWITTER_CLIENT_ID;
const originalTwitterClientSecret = process.env.TWITTER_CLIENT_SECRET;

mock.module("../../../db/client", () => ({
  ...actualDb,
  dbRead: database,
  dbWrite: database,
}));

const actualSecrets = await import("../secrets");
const testSecretsService = new actualSecrets.SecretsService(
  new actualSecrets.SecretsEncryptionService(new actualSecrets.LocalKMSProvider(MASTER_KEY)),
);

mock.module("../secrets", () => ({
  ...actualSecrets,
  secretsService: testSecretsService,
}));

const { socialMediaService } = await import("./index");

const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;

async function createTables(): Promise<void> {
  const seenEnums = new Set<string>();
  for (const table of [organizations, users, secrets, secretAuditLog, platformCredentials]) {
    const config = getTableConfig(table);
    for (const column of config.columns) {
      const definition = (
        column as unknown as { enum?: { enumName: string; enumValues: string[] } }
      ).enum;
      if (definition && !seenEnums.has(definition.enumName)) {
        await pg.exec(
          `CREATE TYPE ${quote(definition.enumName)} AS ENUM (${definition.enumValues
            .map((value) => `'${value.replaceAll("'", "''")}'`)
            .join(",")})`,
        );
        seenEnums.add(definition.enumName);
      }
    }
    await pg.exec(
      `CREATE TABLE ${quote(config.name)} (${config.columns
        .map(
          (column) =>
            `${quote(column.name)} ${column.getSQLType()}${column.name === "id" ? " PRIMARY KEY DEFAULT gen_random_uuid()" : ""}`,
        )
        .join(",")})`,
    );
  }
}

async function storedToken(secretId: string): Promise<string> {
  return testSecretsService.getDecryptedValue(secretId, ORGANIZATION_ID);
}

beforeAll(createTables);

beforeEach(async () => {
  await pg.exec("TRUNCATE platform_credentials, secret_audit_log, secrets, users, organizations");
  await pg.query("INSERT INTO organizations (id,name,slug) VALUES ($1,'Fixture','fixture')", [
    ORGANIZATION_ID,
  ]);
  await pg.query(
    "INSERT INTO users (id,organization_id,steward_user_id) VALUES ($1,$2,'fixture-user')",
    [USER_ID, ORGANIZATION_ID],
  );

  const audit = {
    actorType: "user" as const,
    actorId: USER_ID,
    source: "token-refresh-persistence-test",
  };
  const accessSecret = await testSecretsService.create(
    {
      organizationId: ORGANIZATION_ID,
      name: "TWITTER_ACCESS_TOKEN",
      value: "access-0",
      createdBy: USER_ID,
    },
    audit,
  );
  const refreshSecret = await testSecretsService.create(
    {
      organizationId: ORGANIZATION_ID,
      name: "TWITTER_REFRESH_TOKEN",
      value: "refresh-0",
      createdBy: USER_ID,
    },
    audit,
  );
  await pg.exec("UPDATE secrets SET version=1, access_count=0");
  await pg.query(
    "INSERT INTO platform_credentials (id,organization_id,user_id,platform,platform_user_id,status,access_token_secret_id,refresh_token_secret_id,token_expires_at) VALUES ($1,$2,$3,'twitter','fixture-twitter-user','active',$4,$5,$6)",
    [
      CREDENTIAL_ID,
      ORGANIZATION_ID,
      USER_ID,
      accessSecret.id,
      refreshSecret.id,
      new Date(Date.now() - 60_000),
    ],
  );
  process.env.TWITTER_CLIENT_ID = "fixture-client";
  process.env.TWITTER_CLIENT_SECRET = "fixture-secret";
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  if (originalTwitterClientId === undefined) delete process.env.TWITTER_CLIENT_ID;
  else process.env.TWITTER_CLIENT_ID = originalTwitterClientId;
  if (originalTwitterClientSecret === undefined) delete process.env.TWITTER_CLIENT_SECRET;
  else process.env.TWITTER_CLIENT_SECRET = originalTwitterClientSecret;
  mock.module("../../../db/client", () => actualDb);
  mock.module("../secrets", () => actualSecrets);
  await pg.close();
});

describe("social token refresh persistence", () => {
  test("two refresh cycles retain the secret identities and persist each new token", async () => {
    let refreshNumber = 0;
    const submittedRefreshTokens: string[] = [];
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      refreshNumber += 1;
      const body = new URLSearchParams(String(init?.body));
      submittedRefreshTokens.push(body.get("refresh_token") ?? "");
      return Response.json({
        access_token: `access-${refreshNumber}`,
        refresh_token: `refresh-${refreshNumber}`,
        expires_in: 3600,
      });
    }) as typeof fetch;

    const before = (
      await pg.query<{ access_token_secret_id: string; refresh_token_secret_id: string }>(
        "SELECT access_token_secret_id,refresh_token_secret_id FROM platform_credentials WHERE id=$1",
        [CREDENTIAL_ID],
      )
    ).rows[0];

    const first = await socialMediaService.getCredentialsForPlatform(
      ORGANIZATION_ID,
      "twitter",
      CREDENTIAL_ID,
    );
    expect(first?.accessToken).toBe("access-1");
    expect(first?.refreshToken).toBe("refresh-1");
    expect(await storedToken(before.access_token_secret_id)).toBe("access-1");
    expect(await storedToken(before.refresh_token_secret_id)).toBe("refresh-1");

    await pg.query("UPDATE platform_credentials SET token_expires_at=$1 WHERE id=$2", [
      new Date(Date.now() - 60_000),
      CREDENTIAL_ID,
    ]);
    const second = await socialMediaService.getCredentialsForPlatform(
      ORGANIZATION_ID,
      "twitter",
      CREDENTIAL_ID,
    );
    expect(second?.accessToken).toBe("access-2");
    expect(second?.refreshToken).toBe("refresh-2");
    expect(submittedRefreshTokens).toEqual(["refresh-0", "refresh-1"]);
    expect(await storedToken(before.access_token_secret_id)).toBe("access-2");
    expect(await storedToken(before.refresh_token_secret_id)).toBe("refresh-2");

    const after = (
      await pg.query<{
        access_token_secret_id: string;
        refresh_token_secret_id: string;
        token_expires_at: Date;
      }>(
        "SELECT access_token_secret_id,refresh_token_secret_id,token_expires_at FROM platform_credentials WHERE id=$1",
        [CREDENTIAL_ID],
      )
    ).rows[0];
    expect(after.access_token_secret_id).toBe(before.access_token_secret_id);
    expect(after.refresh_token_secret_id).toBe(before.refresh_token_secret_id);
    expect(after.token_expires_at.getTime()).toBeGreaterThan(Date.now());
    expect((await pg.query("SELECT id FROM secrets")).rows).toHaveLength(2);
  });
});
