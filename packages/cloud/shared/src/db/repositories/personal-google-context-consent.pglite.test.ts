/**
 * Real Drizzle-generated production UPDATEs on cached, in-memory PGlite.
 * Fixture DDL uses actual schema column types; this is not a production migration/FK test.
 * Run in its own Bun process because db/client is replaced only at the DB boundary.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import { googlePersonalContextConsent } from "../../lib/services/shared-runtime/shared-google-consent";
import * as realDbClient from "../client";
import { organizations } from "../schemas/organizations";
import { platformCredentials } from "../schemas/platform-credentials";
import { users } from "../schemas/users";

const pg = new PGlite();
const actualDb = drizzle(pg);
const originalDb = { ...realDbClient };
mock.module("../client", () => ({ ...originalDb, dbWrite: actualDb, dbRead: actualDb }));
const {
  bindPersonalGoogleContextConsent,
  clearPersonalGoogleContextConsent,
  readPersonalGoogleContextOwner,
  authorizePersonalGoogleContextRead,
} = await import("./personal-google-context-consent");
const { getGoogleAccessToken, managedGoogleConnectorDeps } = await import(
  "../../lib/services/agent-google-connector/shared"
);
const { createSharedGoogleReadPort } = await import(
  "../../lib/services/shared-runtime/shared-google-read-port"
);
const { fetchManagedGoogleGmailSearch, readManagedGoogleGmailMessage } = await import(
  "../../lib/services/agent-google-connector/gmail"
);
const { fetchManagedGoogleCalendarFeed } = await import(
  "../../lib/services/agent-google-connector/calendar"
);
const ORG = "11111111-1111-4111-8111-111111111111";
const OWNER = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const GRANT = "44444444-4444-4444-8444-444444444444";
const STALE = "55555555-5555-4555-8555-555555555555";
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
];
const q = (name: string) => '"' + name.replaceAll('"', '""') + '"';
const lit = (value: string) => "'" + value.replaceAll("'", "''") + "'";

beforeAll(async () => {
  const enums = new Set<string>();
  for (const table of [organizations, users, platformCredentials]) {
    const config = getTableConfig(table);
    for (const column of config.columns) {
      const enumeration = (
        column as unknown as { enum?: { enumName: string; enumValues: string[] } }
      ).enum;
      if (enumeration?.enumName && !enums.has(enumeration.enumName)) {
        await pg.exec(
          "CREATE TYPE " +
            q(enumeration.enumName) +
            " AS ENUM (" +
            enumeration.enumValues.map(lit).join(",") +
            ")",
        );
        enums.add(enumeration.enumName);
      }
    }
    await pg.exec(
      "CREATE TABLE " +
        q(config.name) +
        " (" +
        config.columns.map((column) => q(column.name) + " " + column.getSQLType()).join(",") +
        ")",
    );
  }
});
beforeEach(async () => {
  await pg.exec("TRUNCATE users, organizations, platform_credentials");
  await pg.query(
    "INSERT INTO organizations (id,is_active,account_lifecycle_state) VALUES ($1,true,'active')",
    [ORG],
  );
  for (const id of [OWNER, OTHER])
    await pg.query(
      "INSERT INTO users (id,organization_id,is_active,preferences,account_lifecycle_state) VALUES ($1,$2,true,$3,'active')",
      [id, ORG, JSON.stringify({ theme: "light", otherPreference: { keep: true } })],
    );
  await pg.query(
    "INSERT INTO platform_credentials (id,organization_id,user_id,platform,status,scopes,source_context) VALUES ($1,$2,$3,'google','active',$4::jsonb,$5::jsonb)",
    [GRANT, ORG, OWNER, JSON.stringify(SCOPES), '{"connectionRole":"OWNER"}'],
  );
});
afterAll(async () => {
  managedGoogleConnectorDeps.dbRead = originalDb.dbRead;
  mock.module("../client", () => originalDb);
  await pg.close();
});
async function preferences() {
  const result = await pg.query<{ preferences: string }>(
    "SELECT preferences FROM users WHERE id=$1",
    [OWNER],
  );
  return JSON.parse(result.rows[0]!.preferences) as Record<string, unknown>;
}
const bind = () =>
  bindPersonalGoogleContextConsent({
    organizationId: ORG,
    userId: OWNER,
    grantId: GRANT,
    consent: googlePersonalContextConsent(),
  });

describe("atomic personal Google consent SQL", () => {
  test("real atomic merge retains unrelated and interleaved preference edits", async () => {
    await Promise.all([
      pg.query(
        "UPDATE users SET preferences=jsonb_set(preferences::jsonb,'{theme}',$2::jsonb)::text WHERE id=$1",
        [OWNER, JSON.stringify("dark")],
      ),
      bind(),
    ]);
    expect(await preferences()).toMatchObject({
      theme: "dark",
      otherPreference: { keep: true },
      personalGoogleContext: { grantId: GRANT, purpose: "personal_google_context_v1" },
    });
  });

  test("wrong owner or partial granted scopes cannot enable context", async () => {
    await expect(
      bindPersonalGoogleContextConsent({
        organizationId: ORG,
        userId: OTHER,
        grantId: GRANT,
        consent: googlePersonalContextConsent(),
      }),
    ).rejects.toThrow("GOOGLE_PERSONAL_CONTEXT_OWNER_OR_GRANT_CHANGED");
    await pg.query("UPDATE platform_credentials SET scopes=$1::jsonb WHERE id=$2", [
      JSON.stringify([SCOPES[1]]),
      GRANT,
    ]);
    await expect(bind()).rejects.toThrow("GOOGLE_PERSONAL_CONTEXT_OWNER_OR_GRANT_CHANGED");
    expect((await preferences()).personalGoogleContext).toBeUndefined();
    await pg.query("UPDATE platform_credentials SET scopes=$1::jsonb WHERE id=$2", [
      JSON.stringify(SCOPES),
      GRANT,
    ]);
    expect(
      await readPersonalGoogleContextOwner({ organizationId: ORG, userId: OWNER }),
    ).toBeDefined();
    await pg.query("UPDATE users SET expires_at=NOW()-interval '1 minute' WHERE id=$1", [OWNER]);
    expect(
      await readPersonalGoogleContextOwner({ organizationId: ORG, userId: OWNER }),
    ).toBeUndefined();
    await expect(bind()).rejects.toThrow("GOOGLE_PERSONAL_CONTEXT_OWNER_OR_GRANT_CHANGED");
    await pg.query("UPDATE users SET expires_at=NULL WHERE id=$1", [OWNER]);
    await pg.query("UPDATE organizations SET account_deletion_request_id=$1 WHERE id=$2", [
      STALE,
      ORG,
    ]);
    expect(
      await readPersonalGoogleContextOwner({ organizationId: ORG, userId: OWNER }),
    ).toBeUndefined();
    await expect(bind()).rejects.toThrow("GOOGLE_PERSONAL_CONTEXT_OWNER_OR_GRANT_CHANGED");
  });

  test("revocation clears only its selected grant and retains unrelated preferences", async () => {
    await bind();
    await pg.query(
      "INSERT INTO platform_credentials (id,organization_id,user_id,platform,status) VALUES ($1,$2,$3,'google','revoked')",
      [STALE, ORG, OWNER],
    );
    expect(
      await clearPersonalGoogleContextConsent({ organizationId: ORG, grantId: STALE }),
    ).toBeUndefined();
    expect((await preferences()).personalGoogleContext).toBeDefined();
    await pg.query("UPDATE platform_credentials SET status='revoked' WHERE id=$1", [GRANT]);
    await clearPersonalGoogleContextConsent({ organizationId: ORG, grantId: GRANT });
    expect(await preferences()).toEqual({ theme: "light", otherPreference: { keep: true } });
    await expect(bind()).rejects.toThrow("GOOGLE_PERSONAL_CONTEXT_OWNER_OR_GRANT_CHANGED");
  });
  test("fresh primary consent and grant checks fence a previously usable cached token", async () => {
    await bind();
    const originalGetToken = managedGoogleConnectorDeps.oauthService.getValidToken;
    let tokenCacheUses = 0;
    let revokeDuringTokenRead = false;
    managedGoogleConnectorDeps.oauthService.getValidToken = async () => {
      tokenCacheUses += 1;
      if (revokeDuringTokenRead)
        await pg.query("UPDATE platform_credentials SET status='revoked' WHERE id=$1", [GRANT]);
      return { accessToken: "synthetic-cached-token", refreshed: false, fromCache: true };
    };
    const args = {
      organizationId: ORG,
      userId: OWNER,
      side: "owner" as const,
      grantId: GRANT,
      personalContextRead: true as const,
    };
    try {
      expect(await getGoogleAccessToken(args)).toMatchObject({ connectionId: GRANT });
      expect(tokenCacheUses).toBe(1);
      revokeDuringTokenRead = true;
      await expect(getGoogleAccessToken(args)).rejects.toThrow("no longer authorized");
      expect(tokenCacheUses).toBe(2);
      revokeDuringTokenRead = false;
      await pg.query("UPDATE platform_credentials SET status='active' WHERE id=$1", [GRANT]);
      // Admission can be valid and then become revoked before the actual
      // managed read/token path. The server flag must survive every hop.
      const port = createSharedGoogleReadPort(
        {
          organizationId: ORG,
          userId: OWNER,
          grantId: GRANT,
          authorizePrivateRead: async () => {
            if (
              !(await authorizePersonalGoogleContextRead({
                organizationId: ORG,
                userId: OWNER,
                grantId: GRANT,
              }))
            ) {
              throw new Error("Private read not authorized");
            }
          },
        },
        {
          initiateManagedGoogleConnection: async () => {
            throw new Error("No OAuth creation in this fixture");
          },
          getManagedGoogleConnectorStatus: async () => {
            await pg.query("UPDATE platform_credentials SET status='revoked' WHERE id=$1", [GRANT]);
            return {
              provider: "google",
              side: "owner",
              mode: "cloud_managed",
              configured: true,
              connected: true,
              reason: "connected",
              connectionId: GRANT,
              identity: null,
              grantedCapabilities: ["google.gmail.triage", "google.calendar.read"],
              grantedScopes: SCOPES,
              expiresAt: null,
              hasRefreshToken: false,
              linkedAt: null,
              lastUsedAt: null,
            };
          },
          fetchManagedGoogleGmailSearch,
          readManagedGoogleGmailMessage,
          fetchManagedGoogleCalendarFeed,
        },
      );
      await expect(port.read({ kind: "gmail_search", query: "invoice" })).rejects.toThrow(
        "no longer authorized",
      );
      await expect(getGoogleAccessToken(args)).rejects.toThrow("no longer authorized");
      await pg.query("UPDATE platform_credentials SET status='active' WHERE id=$1", [GRANT]);
      await pg.query("UPDATE platform_credentials SET scopes=$1::jsonb WHERE id=$2", [
        JSON.stringify([SCOPES[1]]),
        GRANT,
      ]);
      await expect(getGoogleAccessToken(args)).rejects.toThrow("no longer authorized");
      await pg.query("UPDATE platform_credentials SET scopes=$1::jsonb WHERE id=$2", [
        JSON.stringify(SCOPES),
        GRANT,
      ]);
      await pg.query("UPDATE users SET preferences=$1 WHERE id=$2", [
        JSON.stringify({
          personalGoogleContext: {
            ...googlePersonalContextConsent(),
            grantId: STALE,
          },
        }),
        OWNER,
      ]);
      await expect(getGoogleAccessToken(args)).rejects.toThrow("no longer authorized");
      await pg.query("UPDATE users SET preferences='{}' WHERE id=$1", [OWNER]);
      await expect(getGoogleAccessToken(args)).rejects.toThrow("no longer authorized");
      await bind();
      await pg.query("UPDATE users SET expires_at=NOW()-interval '1 minute' WHERE id=$1", [OWNER]);
      expect(
        await readPersonalGoogleContextOwner({ organizationId: ORG, userId: OWNER }),
      ).toBeUndefined();
      await expect(bind()).rejects.toThrow("GOOGLE_PERSONAL_CONTEXT_OWNER_OR_GRANT_CHANGED");
      await pg.query("UPDATE users SET expires_at=NULL WHERE id=$1", [OWNER]);
      await pg.query("UPDATE organizations SET account_deletion_request_id=$1 WHERE id=$2", [
        STALE,
        ORG,
      ]);
      await expect(getGoogleAccessToken(args)).rejects.toThrow("no longer authorized");
      expect(tokenCacheUses).toBe(2);
    } finally {
      managedGoogleConnectorDeps.oauthService.getValidToken = originalGetToken;
    }
  });
});
