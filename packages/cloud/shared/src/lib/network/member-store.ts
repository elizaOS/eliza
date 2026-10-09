/**
 * Postgres-backed NetworkStore for the Network plugin, over the `network`
 * schema (migration 0474), and the server-owned `execution.network` binding.
 *
 * Authority key: the plugin's `memberId` is the server-resolved Cloud user id
 * of the canonical Personal agent (`agent.user_id`). The store maps it to
 * `network.members.cloud_user_id`, so building `execution.network` needs no
 * extra round trip before the turn, and a model can never choose the member.
 * Every write is a single statement, so it is atomic on Hyperdrive without an
 * interactive transaction.
 */

import type {
  NetworkMemberContext,
  NetworkMemberState,
  NetworkRouting,
  NetworkSignal,
  NetworkStore,
  SetStateExecution,
  SetStateInput,
} from "@elizaos/plugin-network";
import {
  createServiceNetworkStore,
  NetworkServiceClient,
  parseServiceTurn,
} from "@elizaos/plugin-network";
import { type SQL, sql } from "drizzle-orm";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import {
  isCanonicalPersonalSharedAgent,
  personalSharedProjectScope,
} from "../services/shared-runtime/personal-shared-identity";
import type { SharedRuntimeAgent } from "../services/shared-runtime/shared-runtime-agent";

/** Anything with Drizzle's `execute(sql)`; node-postgres, PGlite and pg-proxy all qualify. */
export interface NetworkSqlExecutor {
  execute(query: SQL): Promise<unknown>;
}

type Executor = NetworkSqlExecutor | (() => Promise<NetworkSqlExecutor>);

/** Drivers disagree on `execute` result shape: `{ rows }` vs a bare array. */
function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

const MEMBER_STATES = new Set<NetworkMemberState>(["open", "busy", "traveling", "paused"]);

function memberState(value: unknown): NetworkMemberState {
  return MEMBER_STATES.has(value as NetworkMemberState) ? (value as NetworkMemberState) : "open";
}

function facetsOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  // Some drivers return a Postgres array literal: {a,"b c"}.
  if (typeof value === "string" && value.startsWith("{") && value.endsWith("}")) {
    const body = value.slice(1, -1);
    if (!body) return [];
    return (body.match(/"(?:[^"\\]|\\.)*"|[^,]+/g) ?? []).map((item) =>
      item.startsWith('"') ? item.slice(1, -1).replace(/\\(.)/g, "$1") : item,
    );
  }
  return [];
}

export function createPostgresNetworkStore(executor: Executor): NetworkStore {
  const db = typeof executor === "function" ? executor : async () => executor;
  return {
    async getMemberContext(cloudUserId: string): Promise<NetworkMemberContext | null> {
      const [row] = rowsOf(
        await (await db()).execute(sql`
          SELECT "id", "first_name", "city", "state", "state_from", "paused_until", "facets"
            FROM "network"."members"
           WHERE "cloud_user_id" = ${cloudUserId}::uuid AND "state" <> 'removed'
           LIMIT 1
        `),
      );
      if (!row) return null;
      return {
        memberId: String(row.id),
        firstName: typeof row.first_name === "string" && row.first_name ? row.first_name : "there",
        city: typeof row.city === "string" ? row.city : "",
        state: memberState(row.state),
        stateFrom: iso(row.state_from),
        stateUntil: iso(row.paused_until),
        facets: facetsOf(row.facets),
        // Active items (open invitations, threads) arrive with the
        // opportunities schema; none exist in the minimal table set.
        activeItems: [],
      };
    },

    async setState(input: SetStateInput): Promise<SetStateExecution> {
      const until = input.until ? new Date(input.until).toISOString() : null;
      const from = input.from ? new Date(input.from).toISOString() : null;
      // One statement: lock the member, insert the idempotent event, and apply
      // the state only when the event was new. A replayed key inserts nothing,
      // updates nothing, and falls through to the stored event below. A request
      // matching the current state and end date writes no event (plugin
      // contract: SetStateExecution.unchanged).
      const applied = rowsOf(
        await (await db()).execute(sql`
          WITH "member" AS (
            SELECT "id", "state", "state_from", "paused_until" FROM "network"."members"
             WHERE "cloud_user_id" = ${input.memberId}::uuid AND "state" <> 'removed'
             FOR UPDATE
          ), "event" AS (
            INSERT INTO "network"."member_events" ("member_id", "idempotency_key", "type", "payload")
            SELECT "member"."id", ${input.idempotencyKey}, 'member.state_changed',
                   jsonb_build_object(
                     'previous', "member"."state",
                     'current', ${input.state}::text,
                     'from', ${from}::text,
                     'until', ${until}::text,
                     'note', ${input.note}::text
                   )
              FROM "member"
             WHERE NOT ("member"."state" = ${input.state}::text
                        AND "member"."state_from" IS NOT DISTINCT FROM ${from}::timestamptz
                        AND "member"."paused_until" IS NOT DISTINCT FROM ${until}::timestamptz)
            ON CONFLICT ("idempotency_key") DO NOTHING
            RETURNING "id", "member_id", "payload", "created_at"
          ), "updated" AS (
            UPDATE "network"."members" AS m
               SET "state" = ${input.state}, "state_from" = ${from}::timestamptz,
                   "paused_until" = ${until}::timestamptz, "updated_at" = now()
              FROM "event"
             WHERE m."id" = "event"."member_id"
            RETURNING m."id"
          )
          SELECT "event"."id", "event"."payload", "event"."created_at",
                 (SELECT count(*) FROM "updated") AS "updated",
                 (SELECT count(*) FROM "member") AS "members",
                 NULL::text AS "member_state", NULL::timestamptz AS "member_from",
                 NULL::timestamptz AS "member_until"
            FROM "event"
          UNION ALL
          SELECT NULL, NULL, NULL, 0, (SELECT count(*) FROM "member"),
                 (SELECT "state" FROM "member"), (SELECT "state_from" FROM "member"),
                 (SELECT "paused_until" FROM "member")
           WHERE NOT EXISTS (SELECT 1 FROM "event")
        `),
      );
      const first = applied[0];
      if (!first || Number(first.members) === 0) {
        throw new Error("Network member is not available for this account");
      }
      let event = first;
      let replayed = false;
      if (first.id === null || first.id === undefined) {
        const [stored] = rowsOf(
          await (await db()).execute(sql`
            SELECT "id", "payload", "created_at" FROM "network"."member_events"
             WHERE "idempotency_key" = ${input.idempotencyKey}
          `),
        );
        if (!stored) {
          const unchanged =
            first.member_state === input.state &&
            (iso(first.member_from) ?? null) === from &&
            (iso(first.member_until) ?? null) === until;
          if (!unchanged) throw new Error("Network state change was neither applied nor recorded");
          return {
            eventId: null,
            previous: memberState(first.member_state),
            current: memberState(first.member_state),
            from,
            until,
            committedAt: new Date(),
            replayed: false,
            unchanged: true,
          };
        }
        event = stored;
        replayed = true;
      }
      const payload = (
        typeof event.payload === "string" ? JSON.parse(event.payload) : event.payload
      ) as Record<string, unknown>;
      return {
        eventId: `evt-${String(event.id)}`,
        previous: memberState(payload.previous),
        current: memberState(payload.current),
        from: iso(payload.from),
        until: iso(payload.until),
        committedAt: new Date(iso(event.created_at) ?? Date.now()),
        replayed,
        unchanged: false,
      };
    },

    async recordSignals(input: {
      memberId: string;
      messageId: string;
      signals: NetworkSignal[];
    }): Promise<{ recorded: number }> {
      if (input.signals.length === 0) return { recorded: 0 };
      const values = sql.join(
        input.signals.map(
          (signal) => sql`(${signal.kind}::text, ${signal.evidence.slice(0, 500)}::text)`,
        ),
        sql`, `,
      );
      const inserted = rowsOf(
        await (await db()).execute(sql`
          INSERT INTO "network"."member_signals" ("member_id", "message_id", "kind", "evidence")
          SELECT m."id", ${input.messageId}, v."kind", v."evidence"
            FROM "network"."members" m, (VALUES ${values}) AS v("kind", "evidence")
           WHERE m."cloud_user_id" = ${input.memberId}::uuid
          ON CONFLICT ("member_id", "message_id", "kind") DO NOTHING
          RETURNING "id"
        `),
      );
      return { recorded: inserted.length };
    },
  };
}

/**
 * The Network takeover: a store backed by the Network service for this turn,
 * when the gateway attached a valid open-turn context and the service is
 * configured (NETWORK_SERVICE_URL, SERVICE_TURN_SECRET). Otherwise undefined,
 * and the turn uses the Cloud Postgres store.
 */
export function serviceNetworkStoreFactory(
  trustedNetworkTurn: unknown,
  env: Record<string, string | undefined> = getCloudAwareEnv() as Record<
    string,
    string | undefined
  >,
): (() => NetworkStore) | undefined {
  if (trustedNetworkTurn === undefined) return undefined;
  const turn = parseServiceTurn(trustedNetworkTurn);
  const baseUrl = env.NETWORK_SERVICE_URL?.trim();
  const secret = env.SERVICE_TURN_SECRET;
  if (!turn || !baseUrl || !secret) return undefined;
  const client = new NetworkServiceClient({ baseUrl, secret });
  return () => createServiceNetworkStore(client, turn);
}

/** Production store over Cloud's request-scoped (Hyperdrive) write connection. */
export function createSharedNetworkStore(): NetworkStore {
  return createPostgresNetworkStore(
    async () => (await import("../../db/client")).dbWrite as unknown as NetworkSqlExecutor,
  );
}

/**
 * Server-owned `execution.network` for a turn. Present only when the hosting
 * boundary already attested a canonical personal identity (`personalShared`)
 * whose server-resolved turn project is The Network. Ordinary turns, Dedicated or
 * sandbox agents, and group rooms never get it.
 */
export function sharedNetworkExecution(
  agent: Pick<
    SharedRuntimeAgent,
    "id" | "user_id" | "organization_id" | "execution_tier" | "project"
  >,
  personalShared: boolean,
  isGroupRoom: boolean,
  storeFactory: () => NetworkStore = createSharedNetworkStore,
  routing?: NetworkRouting,
): { memberId: string; store: NetworkStore; routing?: NetworkRouting } | undefined {
  if (!personalShared || isGroupRoom || !isCanonicalPersonalSharedAgent(agent)) return undefined;
  if (personalSharedProjectScope(agent.project) !== "network") return undefined;
  return { memberId: agent.user_id, store: storeFactory(), ...(routing ? { routing } : {}) };
}
