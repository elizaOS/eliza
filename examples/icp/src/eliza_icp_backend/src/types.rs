//! Types for the ICP elizaOS canister
//!
//! This module mirrors the plugin-inmemorydb types but adapted for ICP stable memory.
//! Uses serde_json::Value for flexible schema matching the TypeScript implementation.

use candid::CandidType;
use serde::{Deserialize, Serialize};

// ========== Error Types (matching plugin-inmemorydb) ==========

#[derive(Debug, Clone, CandidType, Serialize, Deserialize)]
pub enum StorageError {
    NotReady,
    NotFound(String),
    DimensionMismatch { expected: usize, actual: usize },
    Serialization(String),
    Other(String),
}

impl std::fmt::Display for StorageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StorageError::NotReady => write!(f, "Storage not ready"),
            StorageError::NotFound(id) => write!(f, "Item not found: {}", id),
            StorageError::DimensionMismatch { expected, actual } => {
                write!(f, "Dimension mismatch: expected {}, got {}", expected, actual)
            }
            StorageError::Serialization(msg) => write!(f, "Serialization error: {}", msg),
            StorageError::Other(msg) => write!(f, "Other error: {}", msg),
        }
    }
}

pub type StorageResult<T> = Result<T, StorageError>;

// ========== Canister-Specific Errors ==========

#[derive(Debug, Clone, CandidType, Serialize, Deserialize)]
pub enum CanisterError {
    NotInitialized,
    AlreadyInitialized,
    Storage(StorageError),
    InvalidInput(String),
    HttpOutcallError(String),
    VetKeyError(String),
    Unauthorized,
    SerializationError(String),
    InternalError(String),
}

impl std::fmt::Display for CanisterError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CanisterError::NotInitialized => write!(f, "Canister not initialized"),
            CanisterError::AlreadyInitialized => write!(f, "Canister already initialized"),
            CanisterError::Storage(e) => write!(f, "Storage error: {}", e),
            CanisterError::InvalidInput(msg) => write!(f, "Invalid input: {}", msg),
            CanisterError::HttpOutcallError(msg) => write!(f, "HTTP outcall error: {}", msg),
            CanisterError::VetKeyError(msg) => write!(f, "VetKey error: {}", msg),
            CanisterError::Unauthorized => write!(f, "Unauthorized"),
            CanisterError::SerializationError(msg) => write!(f, "Serialization error: {}", msg),
            CanisterError::InternalError(msg) => write!(f, "Internal error: {}", msg),
        }
    }
}

impl From<StorageError> for CanisterError {
    fn from(e: StorageError) -> Self {
        CanisterError::Storage(e)
    }
}

pub type CanisterResult<T> = Result<T, CanisterError>;

// ========== COLLECTIONS (matching plugin-inmemorydb exactly) ==========

pub struct COLLECTIONS;

impl COLLECTIONS {
    pub const AGENTS: &'static str = "agents";
    pub const ENTITIES: &'static str = "entities";
    pub const MEMORIES: &'static str = "memories";
    pub const ROOMS: &'static str = "rooms";
    pub const WORLDS: &'static str = "worlds";
    pub const COMPONENTS: &'static str = "components";
    pub const RELATIONSHIPS: &'static str = "relationships";
    pub const PARTICIPANTS: &'static str = "participants";
    pub const TASKS: &'static str = "tasks";
    pub const CACHE: &'static str = "cache";
    pub const LOGS: &'static str = "logs";
    pub const EMBEDDINGS: &'static str = "embeddings";
}

// ========== Vector Search Result (matching plugin-inmemorydb) ==========

#[derive(Clone, Debug, CandidType, Serialize, Deserialize)]
pub struct VectorSearchResult {
    pub id: String,
    pub distance: f32,
    pub similarity: f32,
}

// ========== Character Configuration ==========

#[derive(Debug, Clone, CandidType, Serialize, Deserialize)]
pub struct CharacterConfig {
    pub name: String,
    pub bio: String,
    pub system: Option<String>,
    pub personality_traits: Vec<String>,
    pub knowledge_base: Vec<String>,
}

impl Default for CharacterConfig {
    fn default() -> Self {
        Self {
            name: "Eliza".to_string(),
            bio: "A helpful AI assistant running on the Internet Computer.".to_string(),
            system: Some(
                "You are Eliza, a helpful AI assistant. Give direct, substantive answers. \
                 Do NOT act like a therapist or the classic ELIZA chatbot."
                    .to_string(),
            ),
            personality_traits: vec![
                "helpful".to_string(),
                "knowledgeable".to_string(),
                "friendly".to_string(),
                "direct".to_string(),
            ],
            knowledge_base: vec![],
        }
    }
}

// ========== Agent State ==========

#[derive(Debug, Clone, CandidType, Serialize, Deserialize)]
pub struct AgentState {
    pub agent_id: String,
    pub character: CharacterConfig,
    pub initialized: bool,
    pub created_at: u64,
    pub last_active: u64,
    pub message_count: u64,
}

impl AgentState {
    pub fn new(agent_id: String, character: CharacterConfig) -> Self {
        let now = ic_cdk::api::time();
        Self {
            agent_id,
            character,
            initialized: true,
            created_at: now,
            last_active: now,
            message_count: 0,
        }
    }
}

impl Default for AgentState {
    fn default() -> Self {
        Self {
            agent_id: String::new(),
            character: CharacterConfig::default(),
            initialized: false,
            created_at: 0,
            last_active: 0,
            message_count: 0,
        }
    }
}

// ========== Inference Mode ==========

/// The inference backend to use for generating responses
#[derive(Debug, Clone, CandidType, Serialize, Deserialize, PartialEq)]
pub enum InferenceMode {
    /// Pattern-based Rogerian psychotherapist (instant, free, fully on-chain)
    ElizaClassic,
    /// OpenAI API via HTTP outcalls (fast, costs cycles + API key)
    OpenAI,
    /// On-chain LLM via llama_cpp_canister (slower, costs cycles only, fully decentralized)
    OnChainLLM,
    /// DFINITY LLM canister - Llama 3.1 8B / Qwen3 32B (fast, free, managed by DFINITY)
    DfinityLLM,
}

impl Default for InferenceMode {
    fn default() -> Self {
        InferenceMode::ElizaClassic
    }
}

// ========== DFINITY LLM Configuration ==========

/// Available models on the DFINITY LLM canister
#[derive(Debug, Clone, CandidType, Serialize, Deserialize, PartialEq)]
pub enum DfinityLLMModel {
    /// Llama 3.1 8B - fast, general purpose
    Llama3_1_8B,
    /// Qwen3 32B - larger, more capable
    Qwen3_32B,
    /// Llama 4 Scout - newer model
    Llama4Scout,
}

impl Default for DfinityLLMModel {
    fn default() -> Self {
        DfinityLLMModel::Llama3_1_8B
    }
}

impl std::fmt::Display for DfinityLLMModel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DfinityLLMModel::Llama3_1_8B => write!(f, "Llama 3.1 8B"),
            DfinityLLMModel::Qwen3_32B => write!(f, "Qwen3 32B"),
            DfinityLLMModel::Llama4Scout => write!(f, "Llama 4 Scout"),
        }
    }
}

#[derive(Debug, Clone, CandidType, Serialize, Deserialize)]
pub struct DfinityLLMConfig {
    /// Which model to use
    pub model: DfinityLLMModel,
    /// System prompt to set the AI's behavior
    pub system_prompt: Option<String>,
    /// Whether this mode is enabled
    pub enabled: bool,
}

impl Default for DfinityLLMConfig {
    fn default() -> Self {
        Self {
            model: DfinityLLMModel::Llama3_1_8B,
            system_prompt: None,
            enabled: true, // Available by default - it's free!
        }
    }
}

// ========== On-Chain LLM Configuration ==========

#[derive(Debug, Clone, CandidType, Serialize, Deserialize)]
pub struct OnChainLLMConfig {
    /// The canister ID of the llama_cpp_canister
    pub canister_id: candid::Principal,
    /// Model name for logging/display (e.g., "qwen2.5-0.5b")
    pub model_name: String,
    /// Max tokens to generate per response
    pub max_tokens: u32,
    /// Temperature for generation (0.0-1.0)
    pub temperature: f32,
    /// Cache type for KV cache (e.g., "q8_0", "f16")
    pub cache_type_k: String,
    /// Custom system prompt (overrides character's)
    pub system_prompt: Option<String>,
}

impl Default for OnChainLLMConfig {
    fn default() -> Self {
        Self {
            canister_id: candid::Principal::anonymous(),
            model_name: "qwen2.5-0.5b".to_string(),
            max_tokens: 256,
            temperature: 0.7,
            cache_type_k: "q8_0".to_string(),
            system_prompt: None,
        }
    }
}

impl OnChainLLMConfig {
    /// Check if the config is valid (has a real canister ID)
    pub fn is_configured(&self) -> bool {
        self.canister_id != candid::Principal::anonymous()
    }
}

/// Status of inference backends
#[derive(Debug, Clone, CandidType, Serialize, Deserialize)]
pub struct InferenceStatus {
    pub current_mode: InferenceMode,
    pub eliza_classic_ready: bool,
    pub openai_configured: bool,
    pub onchain_llm_configured: bool,
    pub onchain_llm_canister_id: Option<String>,
    pub onchain_llm_model: Option<String>,
    /// DFINITY LLM canister (always available - it's free!)
    pub dfinity_llm_enabled: bool,
    pub dfinity_llm_model: Option<String>,
}

// ========== OpenAI Configuration ==========

#[derive(Debug, Clone, CandidType, Serialize, Deserialize)]
pub struct OpenAIConfig {
    /// API endpoint URL (default: OpenAI's API)
    pub api_url: String,
    /// Model to use
    pub model: String,
    /// Temperature for generation
    pub temperature: f32,
    /// Max tokens to generate
    pub max_tokens: Option<u32>,
    /// API key (stored in canister state - consider using vetKeys for production)
    pub api_key: Option<String>,
}

impl Default for OpenAIConfig {
    fn default() -> Self {
        Self {
            api_url: "https://api.openai.com/v1/chat/completions".to_string(),
            model: "gpt-5-mini".to_string(),
            temperature: 0.7,
            max_tokens: Some(1024),
            api_key: None,
        }
    }
}

impl OpenAIConfig {
    /// Check if OpenAI is properly configured with an API key
    pub fn is_configured(&self) -> bool {
        self.api_key.as_ref().map(|k| !k.is_empty()).unwrap_or(false)
    }
}

// ========== OpenAI Types ==========

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenAIChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenAIChatRequest {
    pub model: String,
    pub messages: Vec<OpenAIChatMessage>,
    pub temperature: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenAIChatResponse {
    pub id: String,
    pub object: String,
    pub created: u64,
    pub model: String,
    pub choices: Vec<OpenAIChatChoice>,
    pub usage: Option<OpenAIUsage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenAIChatChoice {
    pub index: u32,
    pub message: OpenAIChatMessage,
    pub finish_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenAIUsage {
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    pub total_tokens: u32,
}

// ========== VetKeys Types ==========

#[derive(Debug, Clone, CandidType, Serialize, Deserialize)]
pub struct VetKeyContext {
    pub purpose: String,
    pub domain: Option<String>,
}

#[derive(Debug, Clone, CandidType, Serialize, Deserialize)]
pub struct EncryptedVetKey {
    pub encrypted_key: Vec<u8>,
    pub public_key: Vec<u8>,
    pub context: VetKeyContext,
}

// ========== Memory Types (matching elizaOS) ==========

/// Content type for memories
#[derive(Debug, Clone, Default, CandidType, Serialize, Deserialize)]
pub struct Content {
    pub text: Option<String>,
    pub thought: Option<String>,
    pub content_type: Option<String>,
    pub source: Option<String>,
}

/// Memory type for storing conversations and data
#[derive(Debug, Clone, CandidType, Serialize, Deserialize)]
pub struct Memory {
    pub id: Option<String>,
    pub entity_id: String,
    pub agent_id: Option<String>,
    pub room_id: String,
    pub content: Content,
    pub created_at: Option<i64>,
    pub world_id: Option<String>,
    pub unique: Option<bool>,
    pub similarity: Option<f32>,
}

impl Memory {
    /// Create a new message memory
    pub fn message(entity_id: String, room_id: String, text: &str) -> Self {
        Self {
            id: Some(generate_uuid()),
            entity_id,
            agent_id: None,
            room_id,
            content: Content {
                text: Some(text.to_string()),
                ..Default::default()
            },
            created_at: Some(now_millis()),
            world_id: None,
            unique: Some(true),
            similarity: None,
        }
    }
}

// ========== API Types ==========

#[derive(Debug, Clone, CandidType, Serialize, Deserialize)]
pub struct ChatRequest {
    pub message: String,
    pub user_id: Option<String>,
    pub room_id: Option<String>,
}

#[derive(Debug, Clone, CandidType, Serialize, Deserialize)]
pub struct ChatResponse {
    pub message: String,
    pub room_id: String,
    pub message_id: String,
    pub timestamp: u64,
}

#[derive(Debug, Clone, CandidType, Serialize, Deserialize)]
pub struct HealthStatus {
    pub status: String,
    pub agent_id: Option<String>,
    pub agent_name: Option<String>,
    pub initialized: bool,
    pub message_count: u64,
    pub memory_count: u64,
    pub uptime_ns: u64,
}

// ========== Helper Functions ==========

/// Generate a UUID v4 using ICP's time and caller for entropy
pub fn generate_uuid() -> String {
    use sha2::{Digest, Sha256};

    let time = ic_cdk::api::time();
    let caller = ic_cdk::api::caller();

    thread_local! {
        static COUNTER: std::cell::RefCell<u64> = const { std::cell::RefCell::new(0) };
    }

    let counter = COUNTER.with(|c| {
        let mut c = c.borrow_mut();
        *c = c.wrapping_add(1);
        *c
    });

    let mut hasher = Sha256::new();
    hasher.update(time.to_be_bytes());
    hasher.update(caller.as_slice());
    hasher.update(counter.to_be_bytes());

    let result = hasher.finalize();

    format!(
        "{:08x}-{:04x}-4{:03x}-{:04x}-{:012x}",
        u32::from_be_bytes([result[0], result[1], result[2], result[3]]),
        u16::from_be_bytes([result[4], result[5]]),
        u16::from_be_bytes([result[6], result[7]]) & 0x0FFF,
        (u16::from_be_bytes([result[8], result[9]]) & 0x3FFF) | 0x8000,
        u64::from_be_bytes([
            result[10], result[11], result[12], result[13], result[14], result[15], 0, 0
        ]) >> 16
    )
}

/// Get current timestamp in milliseconds (matching plugin-inmemorydb)
pub fn now_millis() -> i64 {
    (ic_cdk::api::time() / 1_000_000) as i64
}
