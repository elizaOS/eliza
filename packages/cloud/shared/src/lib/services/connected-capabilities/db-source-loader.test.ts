/**
 * Contract tests for the DB-backed source loader in `./index.ts` — the half
 * `connected-capabilities.test.ts` cannot exercise because it only ever sees
 * already-loaded, already-narrowed in-memory rows. `dbRead` is replaced with a
 * capturing double so these tests assert what the query actually requests
 * (column names and the `.limit()` value reaching the query layer), not just
 * the shape of a payload built from fixtures we control. That distinction is
 * the whole point: the PR this file follows up on (#19883/#23157) claimed "no
 * token/ciphertext is read" while the loader ran a bare `.select()`, and no
 * existing test could have caught that because none inspected the query
 * itself.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import * as realDbClient from "../../../db/client";

// See oauth-service.error-policy.test.ts for why the real exports are
// snapshotted and reinstalled in afterAll: mock.module patches the process-
// global module registry and survives mock.restore(), so a later suite that
// needs the real db/client (PGlite-backed) would otherwise inherit this stub.
const realDbClientExports = { ...realDbClient };

interface CapturedQuery {
  columns: string[];
  limit?: number;
  orderByArgCount?: number;
}

let captured: CapturedQuery[];

const notImplemented = () => {
  throw new Error("db access not stubbed in db-source-loader test");
};

mock.module("../../../db/client", () => ({
  dbRead: {
    select: (fields: Record<string, unknown> = {}) => {
      const entry: CapturedQuery = { columns: Object.keys(fields) };
      captured.push(entry);
      return {
        from: () => ({
          where: () => ({
            orderBy: (...args: unknown[]) => {
              entry.orderByArgCount = args.length;
              return {
                limit: (n: number) => {
                  entry.limit = n;
                  return Promise.resolve([]);
                },
              };
            },
          }),
        }),
      };
    },
  },
  db: {},
  dbWrite: {},
  runWithDbCache: <T>(fn: () => T) => fn(),
  runWithDbCacheAsync: <T>(fn: () => Promise<T>) => fn(),
  withReadDb: notImplemented,
  withWriteDb: notImplemented,
  getDbConnectionInfo: notImplemented,
  closeDatabaseConnectionsForTests: async () => {},
  shouldSkipTlsVerification: () => false,
  enforceTlsForRemote: notImplemented,
}));

const ORG_ID = "11111111-1111-4111-8111-111111111111";

describe("createDbSourceLoader — query shape (#19883 follow-up)", () => {
  beforeEach(() => {
    captured = [];
  });

  afterEach(() => {
    mock.restore();
  });

  afterAll(() => {
    mock.module("../../../db/client", () => realDbClientExports);
  });

  it("selects an explicit column list that excludes every secret-bearing column", async () => {
    const { connectedCapabilitiesService } = await import("./index");
    await connectedCapabilitiesService.list({ organizationId: ORG_ID, limit: 10, offset: 0 });

    expect(captured).toHaveLength(4);
    const [platformQuery, vendorQuery, discordQuery, phoneQuery] = captured;

    // platform_credentials: no *_secret_id pointer, no *_ciphertext/_nonce/
    // _auth_tag/_kms_* field for any of the three field-level-encrypted
    // columns (platform_user_id, platform_email, platform_display_name).
    expect(platformQuery?.columns).toEqual([
      "id",
      "platform",
      "platform_display_name",
      "platform_username",
      "status",
      "scopes",
      "last_used_at",
      "deleted_at",
    ]);
    for (const forbidden of [
      "access_token_secret_id",
      "refresh_token_secret_id",
      "api_key_secret_id",
      "platform_user_id_ciphertext",
      "platform_user_id_nonce",
      "platform_user_id_auth_tag",
      "platform_email_ciphertext",
      "platform_email_nonce",
      "platform_display_name_ciphertext",
      "platform_display_name_nonce",
    ]) {
      expect(platformQuery?.columns).not.toContain(forbidden);
    }

    // vendor_connections: no access/refresh token ciphertext, no DEK, no
    // nonce/auth tag. Refresh-token presence is a computed boolean
    // (`hasRefreshToken`), never the encrypted column itself.
    expect(vendorQuery?.columns).toEqual([
      "id",
      "vendor",
      "label",
      "expires_at",
      "scopes",
      "deleted_at",
      "hasRefreshToken",
    ]);
    for (const forbidden of [
      "access_token_encrypted",
      "refresh_token_encrypted",
      "encrypted_dek",
      "token_nonce",
      "token_auth_tag",
    ]) {
      expect(vendorQuery?.columns).not.toContain(forbidden);
    }

    // discord_connections: no bot token ciphertext, DEK, nonce, or auth tag.
    expect(discordQuery?.columns).toEqual(["id", "is_active", "status", "last_heartbeat"]);
    for (const forbidden of [
      "bot_token_encrypted",
      "encrypted_dek",
      "token_nonce",
      "token_auth_tag",
    ]) {
      expect(discordQuery?.columns).not.toContain(forbidden);
    }

    // phone_gateway_devices carries no secret columns at all; still assert
    // the explicit allowlist so a future column addition can't silently
    // widen this read path.
    expect(phoneQuery?.columns).toEqual([
      "id",
      "is_active",
      "can_send_sms",
      "can_receive_sms",
      "can_send_imessage",
      "can_receive_imessage",
      "friendly_name",
      "phone_account_label",
      "last_seen_at",
    ]);
  });

  it("bounds every source query with a fixed .limit(), independent of the requested page", async () => {
    const { connectedCapabilitiesService, MAX_ROWS_PER_CONNECTED_CAPABILITY_SOURCE } = await import(
      "./index"
    );

    // A tiny requested page must not shrink the query-layer bound, and the
    // bound must not scale with offset either — it is a constant per source,
    // not derived from the request.
    await connectedCapabilitiesService.list({ organizationId: ORG_ID, limit: 1, offset: 500 });

    expect(captured).toHaveLength(4);
    for (const query of captured) {
      expect(query.limit).toBe(MAX_ROWS_PER_CONNECTED_CAPABILITY_SOURCE);
      // Deterministic ordering (created_at, id) backs the cap: the same two
      // orderBy terms every time, so the same cap always returns the same
      // top rows rather than an arbitrary DB-order-dependent slice.
      expect(query.orderByArgCount).toBe(2);
    }
  });
});
