/**
 * Defines the SQL script to create SQLite tables for the 'tee_logs' and 'tee_agents' tables.
 * 
 * @constant
 * @type {string}
 */
export const sqliteTables = `
BEGIN TRANSACTION;

-- Table: tee_logs
CREATE TABLE IF NOT EXISTS "tee_logs" (
    "id" TEXT PRIMARY KEY,
    "agentId" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "timestamp" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    "signature" TEXT NOT NULL
);

-- Table: tee_agents
CREATE TABLE IF NOT EXISTS "tee_agents" (
    "id" TEXT PRIMARY KEY,
    "agentId" TEXT NOT NULL,
    "agentName" TEXT NOT NULL,
    "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    "publicKey" TEXT NOT NULL,
    "attestation" TEXT NOT NULL
);

COMMIT;`;
