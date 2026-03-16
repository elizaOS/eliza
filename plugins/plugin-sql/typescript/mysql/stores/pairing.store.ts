import {
  type PairingAllowlistEntry,
  type PairingChannel,
  type PairingRequest,
  type UUID,
} from "@elizaos/core";
import { and, eq, inArray, sql } from "drizzle-orm";
import { v4 } from "uuid";
import {
  pairingAllowlistTable,
  pairingRequestTable,
} from "../tables";
import type { DrizzleDatabase } from "../types";

// ===============================
// Pairing Request Operations
// ===============================

/**
 * Get all pending pairing requests for a channel and agent.
 */
export async function getPairingRequests(
  db: DrizzleDatabase,
  channel: PairingChannel,
  agentId: UUID
): Promise<PairingRequest[]> {
  const results = await db
    .select()
    .from(pairingRequestTable)
    .where(
      and(eq(pairingRequestTable.channel, channel), eq(pairingRequestTable.agentId, agentId))
    )
    .orderBy(pairingRequestTable.createdAt);

  return results.map((row) => ({
    id: row.id as UUID,
    channel: row.channel as PairingChannel,
    senderId: row.senderId,
    code: row.code,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    metadata: (row.metadata as Record<string, string>) || undefined,
    agentId: row.agentId as UUID,
  }));
}

/**
 * Create a new pairing request.
 */
export async function createPairingRequest(
  db: DrizzleDatabase,
  request: PairingRequest
): Promise<UUID> {
  const id = request.id || (v4() as UUID);
  await db.insert(pairingRequestTable).values({
    id,
    channel: request.channel,
    senderId: request.senderId,
    code: request.code,
    createdAt: request.createdAt,
    lastSeenAt: request.lastSeenAt,
    metadata: request.metadata || {},
    agentId: request.agentId,
  });
  return id;
}

/**
 * Update an existing pairing request.
 */
export async function updatePairingRequest(
  db: DrizzleDatabase,
  request: PairingRequest
): Promise<void> {
  await db
    .update(pairingRequestTable)
    .set({
      lastSeenAt: request.lastSeenAt,
      metadata: request.metadata || {},
    })
    .where(eq(pairingRequestTable.id, request.id));
}

/**
 * Delete a pairing request by ID.
 */
export async function deletePairingRequest(
  db: DrizzleDatabase,
  id: UUID
): Promise<void> {
  await db.delete(pairingRequestTable).where(eq(pairingRequestTable.id, id));
}

// ===============================
// Pairing Allowlist Operations
// ===============================

/**
 * Get the allowlist for a channel and agent.
 */
export async function getPairingAllowlist(
  db: DrizzleDatabase,
  channel: PairingChannel,
  agentId: UUID
): Promise<PairingAllowlistEntry[]> {
  const results = await db
    .select()
    .from(pairingAllowlistTable)
    .where(
      and(
        eq(pairingAllowlistTable.channel, channel),
        eq(pairingAllowlistTable.agentId, agentId)
      )
    )
    .orderBy(pairingAllowlistTable.createdAt);

  return results.map((row) => ({
    id: row.id as UUID,
    channel: row.channel as PairingChannel,
    senderId: row.senderId,
    createdAt: row.createdAt,
    metadata: (row.metadata as Record<string, string>) || undefined,
    agentId: row.agentId as UUID,
  }));
}

/**
 * Create a new allowlist entry.
 * Uses onDuplicateKeyUpdate (MySQL) instead of onConflictDoNothing (PG).
 */
export async function createPairingAllowlistEntry(
  db: DrizzleDatabase,
  entry: PairingAllowlistEntry
): Promise<UUID> {
  const id = entry.id || (v4() as UUID);
  await db
    .insert(pairingAllowlistTable)
    .values({
      id,
      channel: entry.channel,
      senderId: entry.senderId,
      createdAt: entry.createdAt,
      metadata: entry.metadata || {},
      agentId: entry.agentId,
    })
    .onDuplicateKeyUpdate({ set: { id: sql`id` } });
  return id;
}

/**
 * Delete an allowlist entry by ID.
 */
export async function deletePairingAllowlistEntry(
  db: DrizzleDatabase,
  id: UUID
): Promise<void> {
  await db.delete(pairingAllowlistTable).where(eq(pairingAllowlistTable.id, id));
}

// ===============================
// Batch Pairing Operations
// ===============================

/**
 * Create multiple pairing requests.
 */
export async function createPairingRequests(
  db: DrizzleDatabase,
  requests: PairingRequest[]
): Promise<UUID[]> {
  if (requests.length === 0) return [];

  const ids: UUID[] = [];
  const values = requests.map((request) => {
    const id = request.id || (v4() as UUID);
    ids.push(id);
    return {
      id,
      channel: request.channel,
      senderId: request.senderId,
      code: request.code,
      createdAt: request.createdAt,
      lastSeenAt: request.lastSeenAt,
      metadata: request.metadata || {},
      agentId: request.agentId,
    };
  });

  await db.insert(pairingRequestTable).values(values);
  return ids;
}

/**
 * Updates multiple pairing requests in a single UPDATE using SQL CASE expressions.
 * MySQL uses CAST(... AS JSON) for JSON columns.
 */
export async function updatePairingRequests(
  db: DrizzleDatabase,
  requests: PairingRequest[]
): Promise<void> {
  if (requests.length === 0) return;

  const ids = requests.map((r) => r.id);

  const lastSeenCases = requests.map((r) =>
    sql`WHEN ${pairingRequestTable.id} = ${r.id} THEN ${r.lastSeenAt}`
  );

  const metaCases = requests.map((r) => {
    const metaJson = JSON.stringify(r.metadata || {});
    return sql`WHEN ${pairingRequestTable.id} = ${r.id} THEN CAST(${metaJson} AS JSON)`;
  });

  await db
    .update(pairingRequestTable)
    .set({
      lastSeenAt: sql`CASE ${sql.join(lastSeenCases, sql` `)} ELSE ${pairingRequestTable.lastSeenAt} END`,
      metadata: sql`CASE ${sql.join(metaCases, sql` `)} ELSE ${pairingRequestTable.metadata} END`,
    })
    .where(inArray(pairingRequestTable.id, ids));
}

/**
 * Delete multiple pairing requests.
 */
export async function deletePairingRequests(
  db: DrizzleDatabase,
  ids: UUID[]
): Promise<void> {
  if (ids.length === 0) return;

  await db.delete(pairingRequestTable).where(inArray(pairingRequestTable.id, ids));
}

/**
 * Create multiple pairing allowlist entries.
 * Uses onDuplicateKeyUpdate (MySQL) instead of onConflictDoNothing (PG).
 */
export async function createPairingAllowlistEntries(
  db: DrizzleDatabase,
  entries: PairingAllowlistEntry[]
): Promise<UUID[]> {
  if (entries.length === 0) return [];

  const ids: UUID[] = [];
  const values = entries.map((entry) => {
    const id = entry.id || (v4() as UUID);
    ids.push(id);
    return {
      id,
      channel: entry.channel,
      senderId: entry.senderId,
      createdAt: entry.createdAt,
      metadata: entry.metadata || {},
      agentId: entry.agentId,
    };
  });

  await db
    .insert(pairingAllowlistTable)
    .values(values)
    .onDuplicateKeyUpdate({ set: { id: sql`id` } });
  return ids;
}

/**
 * Update pairing allowlist entries (batch) - MySQL version
 * 
 * WHY: Same rationale as PostgreSQL - allowlist config changes over time.
 * 
 * @param {DrizzleDatabase} db - The database instance
 * @param {PairingAllowlistEntry[]} entries - Full entries (ID required for each)
 */
export async function updatePairingAllowlistEntries(
  db: DrizzleDatabase,
  entries: PairingAllowlistEntry[]
): Promise<void> {
  if (entries.length === 0) return;

  const ids = entries.map(e => e.id);
  
  const channelCases = entries.map(e => 
    sql`WHEN ${pairingAllowlistTable.id} = ${e.id} THEN ${e.channel}`
  );
  const senderIdCases = entries.map(e => 
    sql`WHEN ${pairingAllowlistTable.id} = ${e.id} THEN ${e.senderId}`
  );
  const metadataCases = entries.map(e => {
    const jsonString = JSON.stringify(e.metadata || {});
    return sql`WHEN ${pairingAllowlistTable.id} = ${e.id} THEN CAST(${jsonString} AS JSON)`;
  });
  
  await db
    .update(pairingAllowlistTable)
    .set({
      channel: sql`CASE ${sql.join(channelCases, sql` `)} ELSE ${pairingAllowlistTable.channel} END`,
      senderId: sql`CASE ${sql.join(senderIdCases, sql` `)} ELSE ${pairingAllowlistTable.senderId} END`,
      metadata: sql`CASE ${sql.join(metadataCases, sql` `)} ELSE ${pairingAllowlistTable.metadata} END`,
    })
    .where(inArray(pairingAllowlistTable.id, ids));
}

/**
 * Delete multiple pairing allowlist entries.
 */
export async function deletePairingAllowlistEntries(
  db: DrizzleDatabase,
  ids: UUID[]
): Promise<void> {
  if (ids.length === 0) return;

  await db.delete(pairingAllowlistTable).where(inArray(pairingAllowlistTable.id, ids));
}
