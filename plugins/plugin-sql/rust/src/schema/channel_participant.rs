#![allow(missing_docs)]
//! Channel participant schema for elizaOS database
//!
//! Corresponds to the TypeScript channelParticipantsTable in packages/plugin-sql/typescript/schema/channelParticipant.ts

/// SQL for creating the channel_participants table
pub const CREATE_CHANNEL_PARTICIPANTS_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS channel_participants (
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    entity_id TEXT NOT NULL,
    PRIMARY KEY (channel_id, entity_id)
)
"#;

/// Channel participant record structure for database operations
#[derive(Clone, Debug)]
pub struct ChannelParticipantRecord {
    pub channel_id: String,
    pub entity_id: String,
}
