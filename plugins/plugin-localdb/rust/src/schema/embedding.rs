#![allow(missing_docs)]

pub const DIMENSION_384: i32 = 384;
pub const DIMENSION_512: i32 = 512;
pub const DIMENSION_768: i32 = 768;
pub const DIMENSION_1024: i32 = 1024;
pub const DIMENSION_1536: i32 = 1536;
pub const DIMENSION_3072: i32 = 3072;

pub const DEFAULT_DIMENSION: i32 = DIMENSION_384;

pub fn create_embeddings_table_sql(dimension: i32) -> String {
    format!(
        r#"
CREATE TABLE IF NOT EXISTS embeddings (
    id UUID PRIMARY KEY NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    embedding vector({}) NOT NULL
)
"#,
        dimension
    )
}

pub const CREATE_EMBEDDINGS_INDEXES: &str = r#"
CREATE INDEX IF NOT EXISTS idx_embeddings_hnsw ON embeddings 
USING hnsw (embedding vector_cosine_ops);
"#;

pub const ENSURE_VECTOR_EXTENSION: &str = r#"
CREATE EXTENSION IF NOT EXISTS vector;
"#;

#[derive(Clone, Debug)]
pub struct EmbeddingRecord {
    pub id: uuid::Uuid,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub embedding: Vec<f32>,
}

impl EmbeddingRecord {
    pub fn new(memory_id: uuid::Uuid, embedding: Vec<f32>) -> Self {
        EmbeddingRecord {
            id: memory_id,
            created_at: chrono::Utc::now(),
            embedding,
        }
    }

    pub fn dimension(&self) -> usize {
        self.embedding.len()
    }
}

pub fn search_embeddings_sql(dimension: i32, limit: i32) -> String {
    format!(
        r#"
SELECT 
    m.id,
    m.type,
    m.created_at,
    m.content,
    m.entity_id,
    m.agent_id,
    m.room_id,
    m.world_id,
    m.unique,
    m.metadata,
    e.embedding,
    1 - (e.embedding <=> $1::vector({})) as similarity
FROM memories m
JOIN embeddings e ON m.id = e.id
WHERE 1 - (e.embedding <=> $1::vector({})) > $2
ORDER BY similarity DESC
LIMIT {}
"#,
        dimension, dimension, limit
    )
}
