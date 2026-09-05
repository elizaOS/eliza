/**
 * Restores the `AgentSandbox` Date contract after a JSON round-trip
 * (CONVERSATIONS-500-2026-07-22). The scope cache and the Durable Object
 * envelope both JSON-serialize the agent row, so every `timestamp` column that
 * Drizzle hands out as a JS `Date` on a live DB hydration arrives back as an
 * ISO **string**. Downstream consumers rely on the typed contract — e.g. the
 * shared-agent conversations route calls `agent.created_at.toISOString()`,
 * which throws and 500s the read on EVERY cache hit (the exact "first call
 * 200, then all 500" defect). Rehydrating at the boundary keeps a cache/DO hit
 * equivalent to a fresh DB hydration for every caller; malformed values fail
 * HERE because returning a row that violates `AgentSandbox` would defer the
 * fault into an unrelated route consumer.
 *
 * Deliberately dependency-light (only `@elizaos/core` errors and the sandbox
 * row type) so transport layers — the conversation coordinator and the
 * Durable Object — can use it without dragging the resolver/auth/cache module
 * graph into their own graphs.
 */

import { ElizaError } from "@elizaos/core/edge";

import type { AgentSandbox } from "../../../db/repositories/agent-sandboxes";

/**
 * The `AgentSandbox` timestamp columns Drizzle selects as JS `Date`s. These are
 * the fields that survive a live DB hydration as `Date` but are lost to `string`
 * when the agent row round-trips through JSON serialization.
 */
const AGENT_SANDBOX_DATE_FIELDS = [
  "created_at",
  "updated_at",
  "deleted_at",
  "claimed_at",
  "pool_ready_at",
  "last_backup_at",
  "last_heartbeat_at",
  "last_billed_at",
  "shutdown_warning_sent_at",
  "scheduled_shutdown_at",
] as const satisfies ReadonlyArray<keyof AgentSandbox>;

type AgentSandboxDateField = (typeof AGENT_SANDBOX_DATE_FIELDS)[number];
export type CachedAgentSandbox = Omit<AgentSandbox, AgentSandboxDateField> & {
  [Field in AgentSandboxDateField]: unknown;
};

function invalidCachedAgentTimestamp(field: AgentSandboxDateField, value: unknown): ElizaError {
  return new ElizaError("Shared-agent cache contains an invalid timestamp", {
    code: "INVALID_CACHED_AGENT_TIMESTAMP",
    context: { field, value },
    severity: "fatal",
  });
}

function rehydrateRequiredCachedDate(value: unknown, field: AgentSandboxDateField): Date {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  throw invalidCachedAgentTimestamp(field, value);
}

function rehydrateNullableCachedDate(value: unknown, field: AgentSandboxDateField): Date | null {
  return value === null ? null : rehydrateRequiredCachedDate(value, field);
}

export function rehydrateCachedAgentDates(agent: CachedAgentSandbox): AgentSandbox {
  return {
    ...agent,
    created_at: rehydrateRequiredCachedDate(agent.created_at, "created_at"),
    updated_at: rehydrateRequiredCachedDate(agent.updated_at, "updated_at"),
    deleted_at: rehydrateNullableCachedDate(agent.deleted_at, "deleted_at"),
    claimed_at: rehydrateNullableCachedDate(agent.claimed_at, "claimed_at"),
    pool_ready_at: rehydrateNullableCachedDate(agent.pool_ready_at, "pool_ready_at"),
    last_backup_at: rehydrateNullableCachedDate(agent.last_backup_at, "last_backup_at"),
    last_heartbeat_at: rehydrateNullableCachedDate(agent.last_heartbeat_at, "last_heartbeat_at"),
    last_billed_at: rehydrateNullableCachedDate(agent.last_billed_at, "last_billed_at"),
    shutdown_warning_sent_at: rehydrateNullableCachedDate(
      agent.shutdown_warning_sent_at,
      "shutdown_warning_sent_at",
    ),
    scheduled_shutdown_at: rehydrateNullableCachedDate(
      agent.scheduled_shutdown_at,
      "scheduled_shutdown_at",
    ),
  };
}
