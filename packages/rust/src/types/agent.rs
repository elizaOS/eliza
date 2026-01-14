//! Agent and Character types for elizaOS
//!
//! Contains Character, Agent, and related configuration types.

use super::primitives::{Content, UUID};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Example message for demonstration
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageExample {
    /// Associated user name
    pub name: String,
    /// Message content
    pub content: Content,
}

/// Template type - can be a string or a function (represented as string in JSON)
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(untagged)]
pub enum TemplateType {
    /// Simple string template
    String(String),
    /// Template with state interpolation (stored as string)
    Function(String),
}

/// Directory item for knowledge loading
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryItem {
    /// Path to the directory
    pub directory: String,
    /// Whether to load recursively
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recursive: Option<bool>,
    /// File extensions to include
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extensions: Option<Vec<String>>,
}

/// Knowledge item - can be a string path or structured item
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(untagged)]
pub enum KnowledgeItem {
    /// Simple path string
    Path(String),
    /// Path with shared flag
    PathWithShared {
        /// Path to knowledge file
        path: String,
        /// Whether knowledge is shared
        #[serde(skip_serializing_if = "Option::is_none")]
        shared: Option<bool>,
    },
    /// Directory item
    Directory(DirectoryItem),
}

/// Style configuration for the character
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StyleConfig {
    /// Style guidelines for all contexts
    #[serde(skip_serializing_if = "Option::is_none")]
    pub all: Option<Vec<String>>,
    /// Style guidelines for chat
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chat: Option<Vec<String>>,
    /// Style guidelines for posts
    #[serde(skip_serializing_if = "Option::is_none")]
    pub post: Option<Vec<String>>,
}

/// Character settings
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct CharacterSettings {
    /// Settings values
    #[serde(flatten)]
    pub values: HashMap<String, serde_json::Value>,
}

/// Character secrets
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct CharacterSecrets {
    /// Secret values
    #[serde(flatten)]
    pub values: HashMap<String, serde_json::Value>,
}

/// Configuration for an agent's character
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct Character {
    /// Optional unique identifier
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<UUID>,
    /// Character name
    pub name: String,
    /// Enable built-in advanced planning (core, gated by `advancedPlanning: true`)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub advanced_planning: Option<bool>,
    /// Enable built-in advanced memory (core, gated by `advancedMemory: true`)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub advanced_memory: Option<bool>,
    /// Optional username
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    /// Optional system prompt
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system: Option<String>,
    /// Optional prompt templates
    #[serde(skip_serializing_if = "Option::is_none")]
    pub templates: Option<HashMap<String, TemplateType>>,
    /// Character biography (can be string or array)
    #[serde(deserialize_with = "deserialize_bio")]
    pub bio: Bio,
    /// Example messages
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_examples: Option<Vec<Vec<MessageExample>>>,
    /// Example posts
    #[serde(skip_serializing_if = "Option::is_none")]
    pub post_examples: Option<Vec<String>>,
    /// Known topics
    #[serde(skip_serializing_if = "Option::is_none")]
    pub topics: Option<Vec<String>>,
    /// Character traits
    #[serde(skip_serializing_if = "Option::is_none")]
    pub adjectives: Option<Vec<String>>,
    /// Optional knowledge base
    #[serde(skip_serializing_if = "Option::is_none")]
    pub knowledge: Option<Vec<KnowledgeItem>>,
    /// Available plugins
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plugins: Option<Vec<String>>,
    /// Optional configuration
    #[serde(skip_serializing_if = "Option::is_none")]
    pub settings: Option<CharacterSettings>,
    /// Optional secrets
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secrets: Option<CharacterSecrets>,
    /// Writing style guides
    #[serde(skip_serializing_if = "Option::is_none")]
    pub style: Option<StyleConfig>,
}

impl Character {
    /// Parse a character from JSON string
    pub fn from_json(json: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(json)
    }

    /// Serialize character to JSON string
    pub fn to_json(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string(self)
    }

    /// Get the bio as a single string
    pub fn bio_string(&self) -> String {
        match &self.bio {
            Bio::Single(s) => s.clone(),
            Bio::Multiple(v) => v.join("\n"),
        }
    }
}

impl Default for Character {
    fn default() -> Self {
        Character {
            id: None,
            name: "Unnamed Character".to_string(),
            advanced_planning: None,
            advanced_memory: None,
            username: None,
            system: None,
            templates: None,
            bio: Bio::Single(String::new()),
            message_examples: None,
            post_examples: None,
            topics: None,
            adjectives: None,
            knowledge: None,
            plugins: None,
            settings: None,
            secrets: None,
            style: None,
        }
    }
}

/// Biography can be a single string or multiple strings
#[derive(Clone, Debug, Serialize)]
#[serde(untagged)]
pub enum Bio {
    /// Single string bio
    Single(String),
    /// Multiple string bio
    Multiple(Vec<String>),
}

fn deserialize_bio<'de, D>(deserializer: D) -> Result<Bio, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::de::Error;

    let value = serde_json::Value::deserialize(deserializer)?;
    match value {
        serde_json::Value::String(s) => Ok(Bio::Single(s)),
        serde_json::Value::Array(arr) => {
            let strings: Result<Vec<String>, _> = arr
                .into_iter()
                .map(|v| {
                    v.as_str()
                        .map(String::from)
                        .ok_or_else(|| D::Error::custom("expected string in bio array"))
                })
                .collect();
            Ok(Bio::Multiple(strings?))
        }
        _ => Err(D::Error::custom("bio must be string or array of strings")),
    }
}

/// Agent status enumeration
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AgentStatus {
    /// Agent is active
    #[default]
    Active,
    /// Agent is inactive
    Inactive,
}

/// Represents an operational agent, extending Character with runtime status
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Agent {
    /// Character configuration
    #[serde(flatten)]
    pub character: Character,
    /// Whether agent is enabled
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    /// Current status
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<AgentStatus>,
    /// Creation timestamp
    pub created_at: i64,
    /// Last update timestamp
    pub updated_at: i64,
}

impl Agent {
    /// Create a new agent from a character
    pub fn from_character(character: Character) -> Self {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;

        Agent {
            character,
            enabled: Some(true),
            status: Some(AgentStatus::Active),
            created_at: now,
            updated_at: now,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_character_from_json() {
        let json = r#"{
            "name": "TestAgent",
            "bio": "A test agent for testing purposes"
        }"#;

        let character = Character::from_json(json).unwrap();
        assert_eq!(character.name, "TestAgent");
        assert_eq!(character.bio_string(), "A test agent for testing purposes");
    }

    #[test]
    fn test_character_parses_advanced_planning_flag() {
        let json = r#"{
            "name": "TestAgent",
            "bio": "A test agent",
            "advancedPlanning": true
        }"#;

        let character = Character::from_json(json).unwrap();
        assert_eq!(character.advanced_planning, Some(true));
    }

    #[test]
    fn test_character_parses_advanced_memory_flag() {
        let json = r#"{
            "name": "TestAgent",
            "bio": "A test agent",
            "advancedMemory": true
        }"#;

        let character = Character::from_json(json).unwrap();
        assert_eq!(character.advanced_memory, Some(true));
    }

    #[test]
    fn test_character_with_array_bio() {
        let json = r#"{
            "name": "TestAgent",
            "bio": ["Line 1", "Line 2", "Line 3"]
        }"#;

        let character = Character::from_json(json).unwrap();
        assert_eq!(character.bio_string(), "Line 1\nLine 2\nLine 3");
    }

    #[test]
    fn test_agent_serialization() {
        let character = Character {
            name: "TestAgent".to_string(),
            bio: Bio::Single("Test bio".to_string()),
            ..Default::default()
        };

        let agent = Agent::from_character(character);
        let json = serde_json::to_string(&agent).unwrap();

        assert!(json.contains("\"name\":\"TestAgent\""));
        assert!(json.contains("\"createdAt\""));
        assert!(json.contains("\"updatedAt\""));
    }
}
