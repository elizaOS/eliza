/**
 * Exercises telemetry-session active classification against an isolated real PGlite database.
 * The fixture includes null-ended rows whose token lifetime or idle window has elapsed.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { sql } from "drizzle-orm";
import { sqlRows } from "../execute-helpers";

process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";

let dbWrite: typeof import("../helpers").dbWrite;
let closeDatabaseConnectionsForTests: typeof import("../client").closeDatabaseConnectionsForTests;
let userSessionsRepository: typeof import("./user-sessions").userSessionsRepository;
let userSessionsService: typeof import("../../lib/services/user-sessions").userSessionsService;

beforeAll(async () => {
  ({ dbWrite } = await import("../helpers"));
  ({ closeDatabaseConnectionsForTests } = await import("../client"));
  ({ userSessionsRepository } = await import("./user-sessions"));
  ({ userSessionsService } = await import("../../lib/services/user-sessions"));

  await dbWrite.execute(sql`
    CREATE TABLE user_sessions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL,
      organization_id uuid NOT NULL,
      session_token text NOT NULL UNIQUE,
      credits_used numeric(10, 2) NOT NULL DEFAULT 0,
      requests_made integer NOT NULL DEFAULT 0,
      tokens_consumed bigint NOT NULL DEFAULT 0,
      started_at timestamp NOT NULL DEFAULT now(),
      last_activity_at timestamp NOT NULL DEFAULT now(),
      token_expires_at timestamp,
      ended_at timestamp,
      ended_reason text,
      retention_expires_at timestamp,
      metadata_purged_at timestamp,
      ip_address text,
      user_agent text,
      device_info jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    )
  `);
});

beforeEach(async () => {
  setSystemTime(new Date("2026-08-25T12:00:00.000Z"));
  await dbWrite.execute(sql`DELETE FROM user_sessions`);
});

afterAll(async () => {
  setSystemTime();
  await closeDatabaseConnectionsForTests();
});

describe("UserSessionsRepository telemetry lifecycle", () => {
  test("excludes expired and idle null-ended telemetry from active reads and aggregation", async () => {
    const userId = "00000000-0000-4000-8000-000000000001";
    const organizationId = "00000000-0000-4000-8000-000000000002";

    await dbWrite.execute(sql`
      INSERT INTO user_sessions (
        user_id,
        organization_id,
        session_token,
        credits_used,
        requests_made,
        tokens_consumed,
        started_at,
        last_activity_at,
        token_expires_at
      )
      VALUES
        (${userId}, ${organizationId}, 'fresh', 1, 2, 3, '2026-08-25 12:00:00', '2026-08-25 12:00:00', '2026-08-25 12:30:00'),
        (${userId}, ${organizationId}, 'expired', 10, 20, 30, '2026-08-25 10:00:00', '2026-08-25 11:55:00', '2026-08-25 11:59:00'),
        (${userId}, ${organizationId}, 'idle', 100, 200, 300, '2026-08-25 09:00:00', '2026-08-25 10:00:00', '2026-08-25 12:30:00')
    `);

    const active = await userSessionsRepository.listActiveByUser(userId);
    expect(active.map((session) => session.session_token)).toEqual(["fresh"]);
    await expect(userSessionsRepository.getCurrentSessionStats(userId)).resolves.toEqual({
      credits_used: 1,
      requests_made: 2,
      tokens_consumed: 3,
    });
  });

  test("closes stale rows, redacts metadata, deletes only retained ended rows, and is retry-safe", async () => {
    const userId = "00000000-0000-4000-8000-000000000011";
    const organizationId = "00000000-0000-4000-8000-000000000012";
    await dbWrite.execute(sql`
      INSERT INTO user_sessions (
        user_id,
        organization_id,
        session_token,
        last_activity_at,
        token_expires_at,
        ended_at,
        ended_reason,
        retention_expires_at,
        ip_address,
        user_agent,
        device_info
      )
      VALUES
        (${userId}, ${organizationId}, 'current', '2026-08-25 12:00:00', '2026-08-25 12:30:00', NULL, NULL, NULL, '192.0.2.1', 'current-agent', '{"current":true}'::jsonb),
        (${userId}, ${organizationId}, 'expired-cleanup', '2026-08-25 12:00:00', '2026-08-25 11:59:00', NULL, NULL, NULL, '192.0.2.2', 'expired-agent', '{"expired":true}'::jsonb),
        (${userId}, ${organizationId}, 'idle-cleanup', '2026-08-25 10:00:00', '2026-08-25 12:30:00', NULL, NULL, NULL, '192.0.2.3', 'idle-agent', '{"idle":true}'::jsonb),
        (${userId}, ${organizationId}, 'retained-ended', '2026-08-24 12:00:00', '2026-08-24 12:00:00', '2026-08-24 12:00:00', 'logout', '2026-09-23 12:00:00', NULL, NULL, '{}'::jsonb),
        (${userId}, ${organizationId}, 'deletable-ended', '2026-07-25 12:00:00', '2026-07-25 12:00:00', '2026-07-25 12:00:00', 'logout', '2026-08-24 12:00:00', NULL, NULL, '{}'::jsonb)
    `);

    await expect(userSessionsRepository.cleanupLifecycle(new Date(), 50)).resolves.toEqual({
      scanned: 3,
      closed: 2,
      retained: 2,
      deleted: 1,
    });

    const rows = await sqlRows<{
      session_token: string;
      ended_reason: string | null;
      ip_address: string | null;
      user_agent: string | null;
      device_info: Record<string, unknown>;
      metadata_purged_at: Date | null;
    }>(
      dbWrite,
      sql`SELECT session_token, ended_reason, ip_address, user_agent, device_info, metadata_purged_at
          FROM user_sessions ORDER BY ended_reason NULLS FIRST, session_token`,
    );
    expect(rows).toHaveLength(4);
    expect(rows.find((row) => row.session_token === "current")).toMatchObject({
      ended_reason: null,
      ip_address: "192.0.2.1",
      user_agent: "current-agent",
      device_info: { current: true },
      metadata_purged_at: null,
    });
    const closed = rows.filter(
      (row) => row.ended_reason === "expired" || row.ended_reason === "idle",
    );
    expect(closed.map((row) => row.ended_reason).sort()).toEqual(["expired", "idle"]);
    for (const row of closed) {
      expect(row.session_token).toMatch(/^closed:/);
      expect(row.ip_address).toBeNull();
      expect(row.user_agent).toBeNull();
      expect(row.device_info).toEqual({});
      expect(row.metadata_purged_at).not.toBeNull();
    }

    await expect(userSessionsRepository.cleanupLifecycle(new Date(), 50)).resolves.toEqual({
      scanned: 0,
      closed: 0,
      retained: 0,
      deleted: 0,
    });
  });

  test("records logout, revocation, and administrative closure reasons idempotently", async () => {
    const userId = "00000000-0000-4000-8000-000000000021";
    const organizationId = "00000000-0000-4000-8000-000000000022";
    await dbWrite.execute(sql`
      INSERT INTO user_sessions (user_id, organization_id, session_token, token_expires_at)
      VALUES
        (${userId}, ${organizationId}, 'logout-token', '2026-08-25 12:30:00'),
        (${userId}, ${organizationId}, 'revoke-token', '2026-08-25 12:30:00'),
        (${userId}, ${organizationId}, 'admin-token', '2026-08-25 12:30:00')
    `);

    await userSessionsRepository.endSession("logout-token", "logout");
    await userSessionsRepository.endSession("admin-token", "administrative_cleanup");
    expect(await userSessionsRepository.endAllUserSessions(userId, "revoked")).toBe(1);
    expect(await userSessionsRepository.endAllUserSessions(userId, "revoked")).toBe(0);

    const reasons = await sqlRows<{ ended_reason: string }>(
      dbWrite,
      sql`SELECT ended_reason FROM user_sessions ORDER BY ended_reason`,
    );
    expect(reasons.map((row) => row.ended_reason)).toEqual([
      "administrative_cleanup",
      "logout",
      "revoked",
    ]);
  });

  test("keeps concurrent refresh tokens as separate bounded telemetry rows", async () => {
    const userId = "00000000-0000-4000-8000-000000000031";
    const organizationId = "00000000-0000-4000-8000-000000000032";
    const tokenExpiresAt = new Date("2026-08-25T12:30:00.000Z");

    const sessions = await Promise.all([
      userSessionsService.getOrCreateSession({
        user_id: userId,
        organization_id: organizationId,
        session_token: "refresh-token-a",
        token_expires_at: tokenExpiresAt,
      }),
      userSessionsService.getOrCreateSession({
        user_id: userId,
        organization_id: organizationId,
        session_token: "refresh-token-b",
        token_expires_at: tokenExpiresAt,
      }),
    ]);

    expect(sessions.every(Boolean)).toBe(true);
    await expect(userSessionsRepository.listActiveByUser(userId)).resolves.toHaveLength(2);
  });

  test("dry-runs and applies legacy lifecycle backfill in bounded batches", async () => {
    const userId = "00000000-0000-4000-8000-000000000041";
    const organizationId = "00000000-0000-4000-8000-000000000042";
    await dbWrite.execute(sql`
      INSERT INTO user_sessions (
        user_id,
        organization_id,
        session_token,
        started_at,
        last_activity_at,
        ended_at,
        ip_address,
        user_agent,
        device_info
      )
      VALUES
        (${userId}, ${organizationId}, 'legacy-stale', '2026-08-25 09:00:00', '2026-08-25 09:30:00', NULL, '192.0.2.10', 'stale-agent', '{"stale":true}'::jsonb),
        (${userId}, ${organizationId}, 'legacy-ended', '2026-08-25 10:00:00', '2026-08-25 10:30:00', '2026-08-25 11:00:00', '192.0.2.11', 'ended-agent', '{"ended":true}'::jsonb),
        (${userId}, ${organizationId}, 'legacy-current', '2026-08-25 11:30:00', '2026-08-25 11:50:00', NULL, '192.0.2.12', 'current-agent', '{"current":true}'::jsonb)
    `);

    await expect(userSessionsRepository.previewLifecycleBackfill(new Date())).resolves.toEqual({
      pending: 3,
      staleNullEnded: 1,
      endedMissingRetention: 1,
    });
    await expect(userSessionsRepository.applyLifecycleBackfillBatch(1)).resolves.toEqual({
      updated: 1,
      active: 1,
      ended: 0,
    });
    await expect(userSessionsRepository.previewLifecycleBackfill(new Date())).resolves.toEqual({
      pending: 2,
      staleNullEnded: 1,
      endedMissingRetention: 1,
    });
    await expect(userSessionsRepository.applyLifecycleBackfillBatch(10)).resolves.toEqual({
      updated: 2,
      active: 1,
      ended: 1,
    });

    const ended = await sqlRows<{
      session_token: string;
      ended_reason: string;
      retention_expires_at: Date | null;
      metadata_purged_at: Date | null;
      ip_address: string | null;
      user_agent: string | null;
      device_info: Record<string, unknown>;
    }>(
      dbWrite,
      sql`SELECT session_token, ended_reason, retention_expires_at, metadata_purged_at,
                 ip_address, user_agent, device_info
          FROM user_sessions WHERE ended_at IS NOT NULL`,
    );
    expect(ended[0]).toMatchObject({
      ended_reason: "legacy_ended",
      ip_address: null,
      user_agent: null,
      device_info: {},
    });
    expect(ended[0]?.session_token).toMatch(/^closed:/);
    expect(ended[0]?.retention_expires_at).not.toBeNull();
    expect(ended[0]?.metadata_purged_at).not.toBeNull();
  });
});
