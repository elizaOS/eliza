/**
 * MySQL tables built from core abstract schemas.
 * Built once and cached to avoid repeated buildTable() calls.
 */

import { buildBaseTables } from "@elizaos/core";
import { buildTable } from "../schema-builders";
import { mysqlAdapter } from "../schema-builders";

// Build all tables once using the MySQL adapter
const tables = buildBaseTables(buildTable, mysqlAdapter);

// Re-export with "Table" suffix to match existing naming convention
export const agentTable = tables.agent;
export const cacheTable = tables.cache;
export const channelTable = tables.channel;
export const channelParticipantsTable = tables.channelParticipant;
export const componentTable = tables.component;
export const embeddingTable = tables.embedding;
export const entityTable = tables.entity;
export const logTable = tables.log;
export const memoryTable = tables.memory;
export const messageTable = tables.message;
export const messageServerTable = tables.messageServer;
export const messageServerAgentsTable = tables.messageServerAgent;
export const pairingAllowlistTable = tables.pairingAllowlist;
export const pairingRequestTable = tables.pairingRequest;
export const participantTable = tables.participant;
export const relationshipTable = tables.relationship;
export const roomTable = tables.room;
export const serverTable = tables.server;
export const taskTable = tables.task;
export const worldTable = tables.world;

// Dimension map for embeddings
import { VECTOR_DIMS } from "@elizaos/core";

export const DIMENSION_MAP = {
  [VECTOR_DIMS.SMALL]: "dim384",
  [VECTOR_DIMS.MEDIUM]: "dim512",
  [VECTOR_DIMS.LARGE]: "dim768",
  [VECTOR_DIMS.XL]: "dim1024",
  [VECTOR_DIMS.XXL]: "dim1536",
  [VECTOR_DIMS.XXXL]: "dim3072",
} as const;

export type EmbeddingDimensionColumn =
  | "dim384"
  | "dim512"
  | "dim768"
  | "dim1024"
  | "dim1536"
  | "dim3072";
