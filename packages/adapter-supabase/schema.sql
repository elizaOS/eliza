-- Drop functions first
DROP FUNCTION IF EXISTS count_memories(text,uuid,boolean);
DROP FUNCTION IF EXISTS check_similarity_and_insert(text,uuid,jsonb,uuid,vector,timestamp with time zone,float);
DROP FUNCTION IF EXISTS create_room(uuid);
DROP FUNCTION IF EXISTS get_embedding_list(text,integer,text,text,text,integer);
DROP FUNCTION IF EXISTS get_goals(uuid,uuid,boolean,integer);
DROP FUNCTION IF EXISTS get_relationship(uuid,uuid);
DROP FUNCTION IF EXISTS remove_memories(text,uuid);
DROP FUNCTION IF EXISTS search_knowledge(vector,uuid,double precision,integer,text) CASCADE;
DROP FUNCTION IF EXISTS check_vector_extension();
DROP FUNCTION IF EXISTS set_config(text,text);
DROP FUNCTION IF EXISTS check_similarity_and_insert_knowledge(text,uuid,jsonb,vector,timestamp with time zone,boolean,uuid,integer,boolean,float);

-- Drop views first
DROP VIEW IF EXISTS knowledge CASCADE;
DROP VIEW IF EXISTS memories CASCADE;

-- Drop tables in correct order
DROP TABLE IF EXISTS knowledge_1536 CASCADE;
DROP TABLE IF EXISTS knowledge_1024 CASCADE;
DROP TABLE IF EXISTS knowledge_768 CASCADE;
DROP TABLE IF EXISTS knowledge_384 CASCADE;
DROP TABLE IF EXISTS memories_1536 CASCADE;
DROP TABLE IF EXISTS memories_1024 CASCADE;
DROP TABLE IF EXISTS memories_768 CASCADE;
DROP TABLE IF EXISTS memories_384 CASCADE;

-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS fuzzystrmatch;

-- Grant permissions to anon role
GRANT USAGE ON SCHEMA public TO anon;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;
GRANT INSERT ON ALL TABLES IN SCHEMA public TO anon;
GRANT UPDATE ON ALL TABLES IN SCHEMA public TO anon;
GRANT DELETE ON ALL TABLES IN SCHEMA public TO anon;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO anon;

-- Also set default privileges for future tables
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT INSERT ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT UPDATE ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT DELETE ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon;

BEGIN;

-- Create base tables first
CREATE TABLE IF NOT EXISTS accounts (
    "id" UUID PRIMARY KEY,
    "createdAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    "name" TEXT,
    "username" TEXT,
    "email" TEXT NOT NULL,
    "avatarUrl" TEXT,
    "details" JSONB DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS rooms (
    "id" UUID PRIMARY KEY,
    "createdAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Create knowledge tables for all vector sizes
CREATE TABLE IF NOT EXISTS knowledge_1536 (
    "id" UUID PRIMARY KEY,
    "agentId" UUID REFERENCES accounts("id"),
    "content" JSONB NOT NULL,
    "embedding" vector(1536),
    "createdAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    "isMain" BOOLEAN DEFAULT FALSE,
    "originalId" UUID REFERENCES knowledge_1536("id"),
    "chunkIndex" INTEGER,
    "isShared" BOOLEAN DEFAULT FALSE,
    CHECK(("isShared" = true AND "agentId" IS NULL) OR ("isShared" = false AND "agentId" IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS knowledge_1024 (
    "id" UUID PRIMARY KEY,
    "agentId" UUID REFERENCES accounts("id"),
    "content" JSONB NOT NULL,
    "embedding" vector(1024),
    "createdAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    "isMain" BOOLEAN DEFAULT FALSE,
    "originalId" UUID REFERENCES knowledge_1024("id"),
    "chunkIndex" INTEGER,
    "isShared" BOOLEAN DEFAULT FALSE,
    CHECK(("isShared" = true AND "agentId" IS NULL) OR ("isShared" = false AND "agentId" IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS knowledge_768 (
    "id" UUID PRIMARY KEY,
    "agentId" UUID REFERENCES accounts("id"),
    "content" JSONB NOT NULL,
    "embedding" vector(768),
    "createdAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    "isMain" BOOLEAN DEFAULT FALSE,
    "originalId" UUID REFERENCES knowledge_768("id"),
    "chunkIndex" INTEGER,
    "isShared" BOOLEAN DEFAULT FALSE,
    CHECK(("isShared" = true AND "agentId" IS NULL) OR ("isShared" = false AND "agentId" IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS knowledge_384 (
    "id" UUID PRIMARY KEY,
    "agentId" UUID REFERENCES accounts("id"),
    "content" JSONB NOT NULL,
    "embedding" vector(384),
    "createdAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    "isMain" BOOLEAN DEFAULT FALSE,
    "originalId" UUID REFERENCES knowledge_384("id"),
    "chunkIndex" INTEGER,
    "isShared" BOOLEAN DEFAULT FALSE,
    CHECK(("isShared" = true AND "agentId" IS NULL) OR ("isShared" = false AND "agentId" IS NOT NULL))
);

-- Create memories tables
CREATE TABLE IF NOT EXISTS memories_1536 (
    "id" UUID PRIMARY KEY,
    "type" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    "content" JSONB NOT NULL,
    "embedding" vector(1536),
    "userId" UUID REFERENCES accounts("id"),
    "agentId" UUID REFERENCES accounts("id"),
    "roomId" UUID REFERENCES rooms("id"),
    "unique" BOOLEAN DEFAULT true NOT NULL,
    CONSTRAINT fk_room FOREIGN KEY ("roomId") REFERENCES rooms("id") ON DELETE CASCADE,
    CONSTRAINT fk_user FOREIGN KEY ("userId") REFERENCES accounts("id") ON DELETE CASCADE,
    CONSTRAINT fk_agent FOREIGN KEY ("agentId") REFERENCES accounts("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS memories_1024 (
    "id" UUID PRIMARY KEY,
    "type" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    "content" JSONB NOT NULL,
    "embedding" vector(1024),
    "userId" UUID REFERENCES accounts("id"),
    "agentId" UUID REFERENCES accounts("id"),
    "roomId" UUID REFERENCES rooms("id"),
    "unique" BOOLEAN DEFAULT true NOT NULL,
    CONSTRAINT fk_room FOREIGN KEY ("roomId") REFERENCES rooms("id") ON DELETE CASCADE,
    CONSTRAINT fk_user FOREIGN KEY ("userId") REFERENCES accounts("id") ON DELETE CASCADE,
    CONSTRAINT fk_agent FOREIGN KEY ("agentId") REFERENCES accounts("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS memories_768 (
    "id" UUID PRIMARY KEY,
    "type" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    "content" JSONB NOT NULL,
    "embedding" vector(768),
    "userId" UUID REFERENCES accounts("id"),
    "agentId" UUID REFERENCES accounts("id"),
    "roomId" UUID REFERENCES rooms("id"),
    "unique" BOOLEAN DEFAULT true NOT NULL,
    CONSTRAINT fk_room FOREIGN KEY ("roomId") REFERENCES rooms("id") ON DELETE CASCADE,
    CONSTRAINT fk_user FOREIGN KEY ("userId") REFERENCES accounts("id") ON DELETE CASCADE,
    CONSTRAINT fk_agent FOREIGN KEY ("agentId") REFERENCES accounts("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS memories_384 (
    "id" UUID PRIMARY KEY,
    "type" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    "content" JSONB NOT NULL,
    "embedding" vector(384),
    "userId" UUID REFERENCES accounts("id"),
    "agentId" UUID REFERENCES accounts("id"),
    "roomId" UUID REFERENCES rooms("id"),
    "unique" BOOLEAN DEFAULT true NOT NULL,
    CONSTRAINT fk_room FOREIGN KEY ("roomId") REFERENCES rooms("id") ON DELETE CASCADE,
    CONSTRAINT fk_user FOREIGN KEY ("userId") REFERENCES accounts("id") ON DELETE CASCADE,
    CONSTRAINT fk_agent FOREIGN KEY ("agentId") REFERENCES accounts("id") ON DELETE CASCADE
);

-- Create other tables
CREATE TABLE IF NOT EXISTS goals (
    "id" UUID PRIMARY KEY,
    "createdAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    "userId" UUID REFERENCES accounts("id"),
    "name" TEXT,
    "status" TEXT,
    "description" TEXT,
    "roomId" UUID REFERENCES rooms("id"),
    "objectives" JSONB DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT fk_room FOREIGN KEY ("roomId") REFERENCES rooms("id") ON DELETE CASCADE,
    CONSTRAINT fk_user FOREIGN KEY ("userId") REFERENCES accounts("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS logs (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "createdAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    "userId" UUID NOT NULL REFERENCES accounts("id"),
    "body" JSONB NOT NULL,
    "type" TEXT NOT NULL,
    "roomId" UUID NOT NULL REFERENCES rooms("id"),
    CONSTRAINT fk_room FOREIGN KEY ("roomId") REFERENCES rooms("id") ON DELETE CASCADE,
    CONSTRAINT fk_user FOREIGN KEY ("userId") REFERENCES accounts("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_logs_room_user ON logs("roomId", "userId");
CREATE INDEX IF NOT EXISTS idx_logs_type ON logs("type");

CREATE TABLE IF NOT EXISTS participants (
    "id" UUID PRIMARY KEY,
    "createdAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    "userId" UUID REFERENCES accounts("id"),
    "roomId" UUID REFERENCES rooms("id"),
    "userState" TEXT,
    "last_message_read" TEXT,
    UNIQUE("userId", "roomId"),
    CONSTRAINT fk_room FOREIGN KEY ("roomId") REFERENCES rooms("id") ON DELETE CASCADE,
    CONSTRAINT fk_user FOREIGN KEY ("userId") REFERENCES accounts("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS relationships (
    "id" UUID PRIMARY KEY,
    "createdAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    "userA" UUID NOT NULL REFERENCES accounts("id"),
    "userB" UUID NOT NULL REFERENCES accounts("id"),
    "status" TEXT,
    "userId" UUID NOT NULL REFERENCES accounts("id"),
    CONSTRAINT fk_user_a FOREIGN KEY ("userA") REFERENCES accounts("id") ON DELETE CASCADE,
    CONSTRAINT fk_user_b FOREIGN KEY ("userB") REFERENCES accounts("id") ON DELETE CASCADE,
    CONSTRAINT fk_user FOREIGN KEY ("userId") REFERENCES accounts("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS cache (
    "key" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "value" JSONB DEFAULT '{}'::jsonb,
    "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP,
    PRIMARY KEY ("key", "agentId")
);

CREATE TABLE IF NOT EXISTS app_config (
    key text PRIMARY KEY,
    value text NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);

-- Create all indexes
CREATE INDEX IF NOT EXISTS idx_memories_1024_embedding ON memories_1024 USING hnsw ("embedding" vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_memories_1024_type_room ON memories_1024("type", "roomId");
CREATE INDEX IF NOT EXISTS idx_memories_768_embedding ON memories_768 USING hnsw ("embedding" vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_memories_768_type_room ON memories_768("type", "roomId");
CREATE INDEX IF NOT EXISTS idx_memories_1536_embedding ON memories_1536 USING hnsw ("embedding" vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_memories_384_embedding ON memories_384 USING hnsw ("embedding" vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_memories_1536_type_room ON memories_1536("type", "roomId");
CREATE INDEX IF NOT EXISTS idx_memories_384_type_room ON memories_384("type", "roomId");
CREATE INDEX IF NOT EXISTS idx_participants_user ON participants("userId");
CREATE INDEX IF NOT EXISTS idx_participants_room ON participants("roomId");
CREATE INDEX IF NOT EXISTS idx_relationships_users ON relationships("userA", "userB");

CREATE INDEX IF NOT EXISTS idx_knowledge_1536_embedding ON knowledge_1536 USING ivfflat (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_knowledge_1024_embedding ON knowledge_1024 USING ivfflat (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_knowledge_768_embedding ON knowledge_768 USING ivfflat (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_knowledge_384_embedding ON knowledge_384 USING ivfflat (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS idx_knowledge_1536_agent ON knowledge_1536("agentId");
CREATE INDEX IF NOT EXISTS idx_knowledge_1536_agent_main ON knowledge_1536("agentId", "isMain");
CREATE INDEX IF NOT EXISTS idx_knowledge_1536_original ON knowledge_1536("originalId");
CREATE INDEX IF NOT EXISTS idx_knowledge_1536_created ON knowledge_1536("agentId", "createdAt");
CREATE INDEX IF NOT EXISTS idx_knowledge_1536_shared ON knowledge_1536("isShared");

CREATE INDEX IF NOT EXISTS idx_knowledge_1024_agent ON knowledge_1024("agentId");
CREATE INDEX IF NOT EXISTS idx_knowledge_1024_agent_main ON knowledge_1024("agentId", "isMain");
CREATE INDEX IF NOT EXISTS idx_knowledge_1024_original ON knowledge_1024("originalId");
CREATE INDEX IF NOT EXISTS idx_knowledge_1024_created ON knowledge_1024("agentId", "createdAt");
CREATE INDEX IF NOT EXISTS idx_knowledge_1024_shared ON knowledge_1024("isShared");

CREATE INDEX IF NOT EXISTS idx_knowledge_768_agent ON knowledge_768("agentId");
CREATE INDEX IF NOT EXISTS idx_knowledge_768_agent_main ON knowledge_768("agentId", "isMain");
CREATE INDEX IF NOT EXISTS idx_knowledge_768_original ON knowledge_768("originalId");
CREATE INDEX IF NOT EXISTS idx_knowledge_768_created ON knowledge_768("agentId", "createdAt");
CREATE INDEX IF NOT EXISTS idx_knowledge_768_shared ON knowledge_768("isShared");

CREATE INDEX IF NOT EXISTS idx_knowledge_384_agent ON knowledge_384("agentId");
CREATE INDEX IF NOT EXISTS idx_knowledge_384_agent_main ON knowledge_384("agentId", "isMain");
CREATE INDEX IF NOT EXISTS idx_knowledge_384_original ON knowledge_384("originalId");
CREATE INDEX IF NOT EXISTS idx_knowledge_384_created ON knowledge_384("agentId", "createdAt");
CREATE INDEX IF NOT EXISTS idx_knowledge_384_shared ON knowledge_384("isShared");

-- NOW create the views
CREATE OR REPLACE VIEW knowledge AS
    SELECT * FROM knowledge_1536
    UNION ALL
    SELECT * FROM knowledge_1024
    UNION ALL
    SELECT * FROM knowledge_768
    UNION ALL
    SELECT * FROM knowledge_384;

CREATE OR REPLACE VIEW memories AS
    SELECT * FROM memories_1536
    UNION ALL
    SELECT * FROM memories_1024
    UNION ALL
    SELECT * FROM memories_768
    UNION ALL
    SELECT * FROM memories_384;

-- THEN create all your functions
CREATE OR REPLACE FUNCTION check_similarity_and_insert(
    query_table_name text,
    query_userId uuid,
    query_content jsonb,
    query_roomId uuid,
    query_embedding vector,
    query_createdAt timestamp with time zone,
    similarity_threshold float
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    table_dimensions int;
    similar_exists boolean;
BEGIN
    -- Get dimensions from table name (e.g., memories_384 -> 384)
    table_dimensions := split_part(query_table_name, '_', 2)::int;

    -- Check if similar memory exists
    EXECUTE format('
        SELECT EXISTS (
            SELECT 1
            FROM %I
            WHERE roomId = $1
            AND (embedding <=> $2) < $3
        )', query_table_name)
    INTO similar_exists
    USING query_roomId, query_embedding, similarity_threshold;

    -- Only insert if no similar memory exists
    IF NOT similar_exists THEN
        EXECUTE format('
            INSERT INTO %I (
                id, "userId", content, embedding, "roomId", "createdAt", unique
            ) VALUES (
                gen_random_uuid(), $1, $2, $3, $4, $5, true
            )', query_table_name)
        USING
            query_userId,
            query_content,
            query_embedding,
            query_roomId,
            query_createdAt;
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION count_memories(
    query_table_name text,
    query_roomid uuid,
    query_unique boolean DEFAULT false
)
RETURNS bigint
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN (
        SELECT COUNT(*) FROM public.memories
        WHERE public.memories."type" = query_table_name
        AND (query_roomid IS NULL OR public.memories."roomId" = query_roomid)
        AND (query_unique IS FALSE OR public.memories."unique" = TRUE)
    );
END;
$$;

CREATE OR REPLACE FUNCTION create_room("roomId" uuid)
RETURNS uuid
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO rooms ("id")
    VALUES ("roomId")
    ON CONFLICT ("id") DO NOTHING;

    RETURN "roomId";
END;
$$;

CREATE OR REPLACE FUNCTION get_embedding_list(
    query_table_name text,
    query_threshold integer,
    query_input text,
    query_field_name text,
    query_field_sub_name text,
    query_match_count integer
)
RETURNS TABLE(embedding vector, levenshtein_score integer)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT public.memories."embedding", levenshtein("query_input", (public.memories."content"->>"query_field_name")::TEXT) AS "levenshtein_score"
    FROM public.memories
    WHERE public.memories."type" = "query_table_name"
    AND levenshtein("query_input", (public.memories."content"->>"query_field_name")::TEXT) <= "query_threshold"
    ORDER BY "levenshtein_score"
    LIMIT "query_match_count";
END;
$$;

CREATE OR REPLACE FUNCTION get_goals(
    only_in_progress boolean,
    query_roomid uuid,
    query_userid uuid,
    row_count integer DEFAULT NULL
)
RETURNS TABLE (
    id uuid,
    "createdAt" timestamp with time zone,
    "userId" uuid,
    name text,
    status text,
    description text,
    "roomId" uuid,
    objectives jsonb
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT g.*
    FROM goals g
    WHERE
        (query_userid IS NULL OR g."userId" = query_userid)
        AND (g."roomId" = query_roomId)
        AND (NOT only_in_progress OR g.status = 'IN_PROGRESS')
    ORDER BY g."createdAt" DESC
    LIMIT CASE
        WHEN row_count IS NOT NULL AND row_count > 0 THEN row_count
        ELSE NULL
    END;
END;
$$;

CREATE OR REPLACE FUNCTION get_relationship(userA uuid, userB uuid)
RETURNS SETOF relationships
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
    RETURN QUERY
    SELECT * FROM public.relationships
    WHERE (public.relationships."userA" = "userA" AND public.relationships."userB" = "userB")
    OR (public.relationships."userA" = "userB" AND public.relationships."userB" = "userA");
END;
$$;

CREATE OR REPLACE FUNCTION remove_memories(query_table_name text, query_roomId uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    DELETE FROM public.memories WHERE public.memories."roomId" = "query_roomId" AND public.memories."type" = "query_table_name";
END;
$$;

CREATE OR REPLACE FUNCTION search_knowledge(
    query_embedding vector,
    query_agent_id uuid,
    match_threshold double precision,
    match_count integer,
    search_text text
)
RETURNS TABLE(
    "id" uuid,
    "agentId" uuid,
    "content" jsonb,
    "embedding" vector,
    "createdAt" timestamp with time zone,
    "similarity" double precision
)
LANGUAGE plpgsql AS
$func$
BEGIN
    -- Determine embedding size and use appropriate table
    CASE vector_dims(query_embedding)
        WHEN 384 THEN
            RETURN QUERY SELECT * FROM search_knowledge_table('knowledge_384', query_embedding, query_agent_id, match_threshold, match_count, search_text);
        WHEN 768 THEN
            RETURN QUERY SELECT * FROM search_knowledge_table('knowledge_768', query_embedding, query_agent_id, match_threshold, match_count, search_text);
        WHEN 1024 THEN
            RETURN QUERY SELECT * FROM search_knowledge_table('knowledge_1024', query_embedding, query_agent_id, match_threshold, match_count, search_text);
        WHEN 1536 THEN
            RETURN QUERY SELECT * FROM search_knowledge_table('knowledge_1536', query_embedding, query_agent_id, match_threshold, match_count, search_text);
        ELSE
            RAISE EXCEPTION 'Unsupported embedding size: %', vector_dims(query_embedding);
    END CASE;
END;
$func$;

-- Drop the existing function first
DROP FUNCTION IF EXISTS search_knowledge_table(text,vector,uuid,double precision,integer,text) CASCADE;

-- Create the updated function
CREATE OR REPLACE FUNCTION search_knowledge_table(
    table_name text,
    query_embedding vector,
    query_agent_id uuid,
    match_threshold double precision,
    match_count integer,
    search_text text
)
RETURNS TABLE(
    "id" uuid,
    "agentId" uuid,
    "content" jsonb,
    "embedding" vector,
    "createdAt" timestamp with time zone,
    "similarity" double precision
)
LANGUAGE plpgsql AS
$func$
BEGIN
    RETURN QUERY EXECUTE format('
        WITH vector_matches AS (
            SELECT k."id",
                1 - (k."embedding" <=> $1) AS "vector_score"
            FROM %I k
            WHERE (k."agentId" IS NULL AND k."isShared" = true) OR k."agentId" = $2
            AND k."embedding" IS NOT NULL
        ),
        keyword_matches AS (
            SELECT k."id",
            CASE
                WHEN (k."content"->''text'')::text ILIKE ''%%'' || $5 || ''%%'' THEN 3.0
                ELSE 1.0
            END *
            CASE
                WHEN (k."content"->''metadata''->''isChunk'')::text = ''true'' THEN 1.5
                WHEN (k."content"->''metadata''->''isMain'')::text = ''true'' THEN 1.2
                ELSE 1.0
            END AS "keyword_score"
            FROM %I k
            WHERE (k."agentId" IS NULL AND k."isShared" = true) OR k."agentId" = $2
        )
        SELECT
            k."id",
            k."agentId",
            k."content",
            k."embedding",
            k."createdAt",
            (v."vector_score" * kw."keyword_score") AS "similarity"
        FROM %I k
        JOIN vector_matches v ON k."id" = v."id"
        LEFT JOIN keyword_matches kw ON k."id" = kw."id"
        WHERE (k."agentId" IS NULL AND k."isShared" = true) OR k."agentId" = $2
        AND (
            v."vector_score" >= $3
            OR (kw."keyword_score" > 1.0 AND v."vector_score" >= 0.3)
        )
        ORDER BY "similarity" DESC
        LIMIT $4;
    ', table_name, table_name, table_name)
    USING query_embedding, query_agent_id, match_threshold, match_count, search_text;
END;
$func$;

CREATE OR REPLACE FUNCTION check_vector_extension()
RETURNS boolean
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1
        FROM pg_extension
        WHERE extname = 'vector'
    );
END;
$$;

CREATE OR REPLACE FUNCTION set_config(key text, value text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO app_config (key, value)
    VALUES (key, value)
    ON CONFLICT (key)
    DO UPDATE SET
        value = EXCLUDED.value,
        updated_at = CURRENT_TIMESTAMP;
END;
$$;

CREATE OR REPLACE FUNCTION check_similarity_and_insert_knowledge(
    query_table_name text,
    query_agent_id uuid,
    query_content jsonb,
    query_embedding vector,
    query_created_at timestamp with time zone,
    query_is_main boolean DEFAULT false,
    query_original_id uuid DEFAULT null,
    query_chunk_index integer DEFAULT null,
    query_is_shared boolean DEFAULT false,
    similarity_threshold float DEFAULT 0.95
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    similar_exists boolean;
BEGIN
    -- Check if similar knowledge exists
    EXECUTE format('
        SELECT EXISTS (
            SELECT 1
            FROM %I
            WHERE (agentId = $1 OR (agentId IS NULL AND isShared = true))
            AND 1 - (embedding <=> $2) > $3
        )', query_table_name)
    INTO similar_exists
    USING
        query_agent_id,
        query_embedding,
        similarity_threshold;

    -- Only insert if no similar knowledge exists
    IF NOT similar_exists THEN
        EXECUTE format('
            INSERT INTO %I (
                id,
                agentId,
                content,
                embedding,
                "createdAt",
                "isMain",
                "originalId",
                "chunkIndex",
                "isShared"
            ) VALUES (
                gen_random_uuid(),
                $1,
                $2,
                $3,
                $4,
                $5,
                $6,
                $7,
                $8
            )', query_table_name)
        USING
            CASE WHEN query_is_shared THEN null ELSE query_agent_id END,
            query_content,
            query_embedding,
            query_created_at,
            query_is_main,
            query_original_id,
            query_chunk_index,
            query_is_shared;
    END IF;
END;
$$;

COMMIT;
