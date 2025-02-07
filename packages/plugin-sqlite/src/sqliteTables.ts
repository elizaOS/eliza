export const sqliteTables = `
PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;

-- Table: accounts
CREATE TABLE IF NOT EXISTS "accounts" (
    "id" TEXT PRIMARY KEY,
    "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    "name" TEXT,
    "username" TEXT,
    "email" TEXT NOT NULL,
    "avatarUrl" TEXT,
    "details" TEXT DEFAULT '{}' CHECK(json_valid("details")) -- Ensuring details is a valid JSON field
);

-- Table: memories
CREATE TABLE IF NOT EXISTS "memories" (
    "id" TEXT PRIMARY KEY,
    "type" TEXT NOT NULL,
    "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    "content" TEXT NOT NULL,
    "embedding" BLOB NOT NULL, -- TODO: EMBEDDING ARRAY, CONVERT TO BEST FORMAT FOR SQLITE-VSS (JSON?)
    "userId" TEXT,
    "roomId" TEXT,
    "agentId" TEXT,
    "unique" INTEGER DEFAULT 1 NOT NULL,
    FOREIGN KEY ("userId") REFERENCES "accounts"("id"),
    FOREIGN KEY ("roomId") REFERENCES "rooms"("id"),
    FOREIGN KEY ("agentId") REFERENCES "accounts"("id")
);

-- Table: goals
CREATE TABLE IF NOT EXISTS "goals" (
    "id" TEXT PRIMARY KEY,
    "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT,
    "name" TEXT,
    "status" TEXT,
    "description" TEXT,
    "roomId" TEXT,
    "objectives" TEXT DEFAULT '[]' NOT NULL CHECK(json_valid("objectives")) -- Ensuring objectives is a valid JSON array
);

-- Table: logs
CREATE TABLE IF NOT EXISTS "logs" (
    "id" TEXT PRIMARY KEY,
    "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "roomId" TEXT NOT NULL
);

-- Table: participants
CREATE TABLE IF NOT EXISTS "participants" (
    "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT,
    "roomId" TEXT,
    "userState" TEXT,
    "id" TEXT PRIMARY KEY,
    "last_message_read" TEXT,
    FOREIGN KEY ("userId") REFERENCES "accounts"("id"),
    FOREIGN KEY ("roomId") REFERENCES "rooms"("id")
);

-- Table: relationships
CREATE TABLE IF NOT EXISTS "relationships" (
    "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    "userA" TEXT NOT NULL,
    "userB" TEXT NOT NULL,
    "status" "text",
    "id" TEXT PRIMARY KEY,
    "userId" TEXT NOT NULL,
    FOREIGN KEY ("userA") REFERENCES "accounts"("id"),
    FOREIGN KEY ("userB") REFERENCES "accounts"("id"),
    FOREIGN KEY ("userId") REFERENCES "accounts"("id")
);

-- Table: rooms
CREATE TABLE IF NOT EXISTS "rooms" (
    "id" TEXT PRIMARY KEY,
    "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Table: cache
CREATE TABLE IF NOT EXISTS "cache" (
    "key" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "value" TEXT DEFAULT '{}' CHECK(json_valid("value")),
    "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP,
    PRIMARY KEY ("key", "agentId")
);

-- Table: knowledge
CREATE TABLE IF NOT EXISTS "knowledge" (
    "id" TEXT PRIMARY KEY,
    "agentId" TEXT,
    "content" TEXT NOT NULL CHECK(json_valid("content")),
    "embedding" BLOB,
    "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    "isMain" INTEGER DEFAULT 0,
    "originalId" TEXT,
    "chunkIndex" INTEGER,
    "isShared" INTEGER DEFAULT 0,
    FOREIGN KEY ("agentId") REFERENCES "accounts"("id"),
    FOREIGN KEY ("originalId") REFERENCES "knowledge"("id"),
    CHECK((isShared = 1 AND agentId IS NULL) OR (isShared = 0 AND agentId IS NOT NULL))
);

-- Index: relationships_id_key
CREATE UNIQUE INDEX IF NOT EXISTS "relationships_id_key" ON "relationships" ("id");

-- Index: memories_id_key
CREATE UNIQUE INDEX IF NOT EXISTS "memories_id_key" ON "memories" ("id");

-- Index: participants_id_key
CREATE UNIQUE INDEX IF NOT EXISTS "participants_id_key" ON "participants" ("id");

-- Index: knowledge
CREATE INDEX IF NOT EXISTS "knowledge_agent_key" ON "knowledge" ("agentId");
CREATE INDEX IF NOT EXISTS "knowledge_agent_main_key" ON "knowledge" ("agentId", "isMain");
CREATE INDEX IF NOT EXISTS "knowledge_original_key" ON "knowledge" ("originalId");
CREATE INDEX IF NOT EXISTS "knowledge_content_key" ON "knowledge"
    ((json_extract(content, '$.text')))
    WHERE json_extract(content, '$.text') IS NOT NULL;
CREATE INDEX IF NOT EXISTS "knowledge_created_key" ON "knowledge" ("agentId", "createdAt");
CREATE INDEX IF NOT EXISTS "knowledge_shared_key" ON "knowledge" ("isShared");

COMMIT;`;