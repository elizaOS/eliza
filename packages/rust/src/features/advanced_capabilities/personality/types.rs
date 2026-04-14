//! Personality types — Rust port of the TypeScript personality/types.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Memory table for per-user interaction preferences.
pub const USER_PREFS_TABLE: &str = "user_personality_preferences";

/// Maximum number of interaction preferences a single user can store.
pub const MAX_PREFS_PER_USER: usize = 10;

/// A single user personality preference.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserPreference {
    /// User/entity ID.
    pub entity_id: Uuid,
    /// Preference key (e.g., "formality", "verbosity").
    pub key: String,
    /// Preference value.
    pub value: String,
    /// When the preference was set.
    pub updated_at: i64,
}

/// Character trait that can evolve over time.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterTrait {
    /// Trait name (e.g., "empathy", "humor", "directness").
    pub name: String,
    /// Current intensity (0.0 - 1.0).
    pub intensity: f64,
    /// How much this trait has changed from baseline.
    pub drift: f64,
    /// When this trait was last adjusted.
    pub last_adjusted_at: i64,
}

/// A proposed character modification.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterModification {
    /// Which aspect of the character to modify.
    pub field: CharacterField,
    /// The proposed new value.
    pub new_value: serde_json::Value,
    /// Reason for the modification.
    pub reason: String,
    /// Confidence in this modification (0.0 - 1.0).
    pub confidence: f64,
}

/// Fields of a character that can be modified.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CharacterField {
    /// Bio / personality description.
    Bio,
    /// Communication style.
    Style,
    /// Topics the character specializes in.
    Topics,
    /// Adjectives describing the character.
    Adjectives,
    /// Custom trait.
    Trait(String),
}

/// Snapshot of character state for tracking evolution.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterSnapshot {
    /// When this snapshot was taken.
    pub timestamp: i64,
    /// Character name at snapshot time.
    pub name: String,
    /// Character traits at snapshot time.
    pub traits: Vec<CharacterTrait>,
    /// Reason for the snapshot (e.g., "evolution checkpoint", "manual save").
    pub reason: String,
}

/// Result of a character evolution evaluation.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvolutionResult {
    /// Whether evolution was applied.
    pub applied: bool,
    /// What changed.
    pub modifications: Vec<CharacterModification>,
    /// Summary of changes.
    pub summary: String,
}
