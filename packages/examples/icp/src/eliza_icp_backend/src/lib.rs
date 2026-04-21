//! elizaOS ICP Canister
//!
//! This canister runs an elizaOS agent on the Internet Computer using the same
//! database adapter pattern as plugin-inmemorydb, but with ICP stable memory.
//!
//! ## Key Features
//!
//! - Same API as plugin-inmemorydb (InMemoryDatabaseAdapter -> IcpDatabaseAdapter)
//! - Persistent storage across canister upgrades
//! - Vector search for semantic memory retrieval
//! - OpenAI integration via HTTP outcalls
//! - VetKeys for secure key derivation
//!
//! ## elizaOS Sync Runtime
//!
//! This canister demonstrates using elizaOS's sync runtime pattern, which allows
//! running elizaOS agents in environments without tokio or async runtimes.
//!
//! When the `elizaos` crate is available, the `eliza_bridge` module provides a
//! full `DatabaseAdapterSync` implementation that can be used with `SyncAgentRuntime`.
//!
//! ```rust,ignore
//! use elizaos::{SyncAgentRuntime, Character};
//! use crate::eliza_bridge::IcpElizaAdapter;
//!
//! let character = Character { name: "MyAgent".to_string(), ..Default::default() };
//! let adapter = IcpElizaAdapter::new("agent-id");
//! let runtime = SyncAgentRuntime::new(character, Some(Box::new(adapter)))?;
//!
//! // Handle messages using canonical elizaOS pattern
//! let result = runtime.message_service().handle_message(&runtime, &mut msg, None)?;
//! ```

mod eliza_bridge;
mod http_outcalls;
mod onchain_llm;
mod storage;
mod types;
mod vetkeys;

// Import ELIZA Classic plugin for pattern-based responses (no API keys needed)
use elizaos_plugin_eliza_classic::ElizaClassicPlugin;

use candid::Principal;
use ic_cdk::{init, post_upgrade, pre_upgrade, query, update};
use ic_cdk::api::management_canister::http_request::{
    HttpResponse, TransformArgs,
};
use serde_json::{json, Value};
use std::cell::RefCell;

pub use eliza_bridge::IcpElizaAdapterStandalone;
pub use http_outcalls::{is_openai_configured, OpenAIClient};
pub use onchain_llm::{check_llm_canister_health, check_llm_ready, OnChainLLMClient};
pub use storage::{create_database_adapter, IcpDatabaseAdapter};
pub use types::*;
pub use vetkeys::{contexts as vetkey_contexts, set_vetkd_canister_id, VetKeysManager};

// ========== Canister State ==========

thread_local! {
    static CREATED_AT: RefCell<u64> = const { RefCell::new(0) };
    static AGENT_STATE: RefCell<Option<AgentState>> = const { RefCell::new(None) };
    static OPENAI_CONFIG: RefCell<Option<OpenAIConfig>> = const { RefCell::new(None) };
    // ELIZA Classic plugin for pattern-based responses
    static ELIZA_CLASSIC: RefCell<Option<ElizaClassicPlugin>> = const { RefCell::new(None) };
    // Inference mode selection
    static INFERENCE_MODE: RefCell<InferenceMode> = const { RefCell::new(InferenceMode::ElizaClassic) };
    // On-chain LLM configuration (for llama_cpp_canister)
    static ONCHAIN_LLM_CONFIG: RefCell<Option<OnChainLLMConfig>> = const { RefCell::new(None) };
    // DFINITY LLM configuration (managed by DFINITY, free, Llama 3.1 8B / Qwen3 32B)
    static DFINITY_LLM_CONFIG: RefCell<Option<DfinityLLMConfig>> = const { RefCell::new(None) };
}

// ========== Lifecycle Hooks ==========

#[init]
fn init() {
    CREATED_AT.with(|c| *c.borrow_mut() = ic_cdk::api::time());
    // Initialize ELIZA Classic plugin for pattern-based responses
    ELIZA_CLASSIC.with(|e| *e.borrow_mut() = Some(ElizaClassicPlugin::new()));
    ic_cdk::println!("elizaOS ICP canister initialized with ELIZA Classic");
}

#[pre_upgrade]
fn pre_upgrade() {
    ic_cdk::println!("Preparing for upgrade...");
}

#[post_upgrade]
fn post_upgrade() {
    CREATED_AT.with(|c| *c.borrow_mut() = ic_cdk::api::time());
    // Re-initialize ELIZA Classic plugin after upgrade
    ELIZA_CLASSIC.with(|e| *e.borrow_mut() = Some(ElizaClassicPlugin::new()));
    ic_cdk::println!("elizaOS ICP canister upgraded with ELIZA Classic");
}

// ========== Agent Management ==========

/// Initialize the agent with a character configuration
#[update]
fn init_agent(config: Option<CharacterConfig>) -> Result<String, CanisterError> {
    if AGENT_STATE.with(|s| s.borrow().is_some()) {
        return Err(CanisterError::AlreadyInitialized);
    }

    let character = config.unwrap_or_default();
    let agent_id = generate_uuid();

    // Create database adapter (matches plugin-inmemorydb pattern)
    let adapter = create_database_adapter(&agent_id);

    // Create agent in storage
    let agent_data = json!({
        "id": agent_id,
        "name": character.name,
        "bio": character.bio,
        "system": character.system,
        "createdAt": now_millis()
    });
    adapter.create_agent(agent_data)?;

    // Set agent state
    let state = AgentState::new(agent_id.clone(), character.clone());
    AGENT_STATE.with(|s| *s.borrow_mut() = Some(state));

    ic_cdk::println!("Agent '{}' initialized with ID: {}", character.name, agent_id);
    Ok(agent_id)
}

/// Configure OpenAI integration (full config)
#[update]
fn configure_openai(config: OpenAIConfig) -> Result<(), CanisterError> {
    ensure_initialized()?;
    OPENAI_CONFIG.with(|c| *c.borrow_mut() = Some(config));
    ic_cdk::println!("OpenAI configured");
    Ok(())
}

/// Set OpenAI API key (simple configuration)
/// Uses default model (gpt-5-mini) and settings
#[update]
fn set_openai_key(api_key: String) -> Result<(), CanisterError> {
    ensure_initialized()?;
    
    if api_key.trim().is_empty() {
        return Err(CanisterError::InvalidInput("API key cannot be empty".to_string()));
    }
    
    let config = OpenAIConfig {
        api_key: Some(api_key),
        ..Default::default()
    };
    
    OPENAI_CONFIG.with(|c| *c.borrow_mut() = Some(config));
    ic_cdk::println!("OpenAI API key configured");
    Ok(())
}

/// Check if OpenAI is configured
#[query]
fn is_openai_ready() -> bool {
    OPENAI_CONFIG.with(|c| {
        c.borrow()
            .as_ref()
            .map(|config| config.is_configured())
            .unwrap_or(false)
    })
}

// ========== Inference Mode Configuration ==========

/// Set the inference mode (ElizaClassic, OpenAI, OnChainLLM, or DfinityLLM)
#[update]
fn set_inference_mode(mode: InferenceMode) -> Result<(), CanisterError> {
    ensure_initialized()?;
    
    // Validate that the mode is available
    match &mode {
        InferenceMode::OpenAI => {
            if !is_openai_ready() {
                return Err(CanisterError::InvalidInput(
                    "OpenAI is not configured. Call set_openai_key first.".to_string(),
                ));
            }
        }
        InferenceMode::OnChainLLM => {
            let configured = ONCHAIN_LLM_CONFIG.with(|c| {
                c.borrow().as_ref().map(|cfg| cfg.is_configured()).unwrap_or(false)
            });
            if !configured {
                return Err(CanisterError::InvalidInput(
                    "On-chain LLM is not configured. Call configure_onchain_llm first.".to_string(),
                ));
            }
        }
        InferenceMode::DfinityLLM => {
            // DFINITY LLM is always available (it's free and managed by DFINITY)
            // Auto-configure if not already set
            DFINITY_LLM_CONFIG.with(|c| {
                if c.borrow().is_none() {
                    *c.borrow_mut() = Some(DfinityLLMConfig::default());
                }
            });
        }
        InferenceMode::ElizaClassic => {
            // Always available
        }
    }
    
    INFERENCE_MODE.with(|m| *m.borrow_mut() = mode.clone());
    ic_cdk::println!("Inference mode set to: {:?}", mode);
    Ok(())
}

/// Get the current inference mode
#[query]
fn get_inference_mode() -> InferenceMode {
    INFERENCE_MODE.with(|m| m.borrow().clone())
}

/// Configure the on-chain LLM (llama_cpp_canister)
#[update]
fn configure_onchain_llm(config: OnChainLLMConfig) -> Result<(), CanisterError> {
    ensure_initialized()?;
    
    if !config.is_configured() {
        return Err(CanisterError::InvalidInput(
            "Invalid on-chain LLM config: canister_id is required".to_string(),
        ));
    }
    
    ic_cdk::println!(
        "On-chain LLM configured: canister={}, model={}",
        config.canister_id,
        config.model_name
    );
    
    ONCHAIN_LLM_CONFIG.with(|c| *c.borrow_mut() = Some(config));
    Ok(())
}

/// Check if on-chain LLM is configured
#[query]
fn is_onchain_llm_ready() -> bool {
    ONCHAIN_LLM_CONFIG.with(|c| {
        c.borrow().as_ref().map(|cfg| cfg.is_configured()).unwrap_or(false)
    })
}

/// Configure the DFINITY LLM canister (Llama 3.1 8B, Qwen3 32B, etc.)
/// This is FREE and managed by DFINITY - no API keys needed!
#[update]
fn configure_dfinity_llm(config: DfinityLLMConfig) -> Result<(), CanisterError> {
    ensure_initialized()?;
    
    ic_cdk::println!(
        "DFINITY LLM configured: model={}, enabled={}",
        config.model,
        config.enabled
    );
    
    DFINITY_LLM_CONFIG.with(|c| *c.borrow_mut() = Some(config));
    Ok(())
}

/// Check if DFINITY LLM is enabled
#[query]
fn is_dfinity_llm_ready() -> bool {
    DFINITY_LLM_CONFIG.with(|c| {
        c.borrow().as_ref().map(|cfg| cfg.enabled).unwrap_or(true) // Default to true - always available!
    })
}

/// Get full inference status
#[query]
fn get_inference_status() -> InferenceStatus {
    let current_mode = INFERENCE_MODE.with(|m| m.borrow().clone());
    let openai_configured = is_openai_ready();
    let onchain_config = ONCHAIN_LLM_CONFIG.with(|c| c.borrow().clone());
    let dfinity_config = DFINITY_LLM_CONFIG.with(|c| c.borrow().clone());
    
    InferenceStatus {
        current_mode,
        eliza_classic_ready: true, // Always ready
        openai_configured,
        onchain_llm_configured: onchain_config.as_ref().map(|c| c.is_configured()).unwrap_or(false),
        onchain_llm_canister_id: onchain_config.as_ref().map(|c| c.canister_id.to_text()),
        onchain_llm_model: onchain_config.as_ref().map(|c| c.model_name.clone()),
        dfinity_llm_enabled: dfinity_config.as_ref().map(|c| c.enabled).unwrap_or(true), // Always available by default
        dfinity_llm_model: dfinity_config.as_ref().map(|c| c.model.to_string()),
    }
}

/// Check if the on-chain LLM canister is healthy and ready
#[update]
async fn check_onchain_llm_health() -> Result<bool, CanisterError> {
    let config = ONCHAIN_LLM_CONFIG.with(|c| c.borrow().clone());
    
    match config {
        Some(cfg) if cfg.is_configured() => {
            let health_ok = check_llm_canister_health(cfg.canister_id).await?;
            if !health_ok {
                return Ok(false);
            }
            check_llm_ready(cfg.canister_id).await
        }
        _ => Err(CanisterError::InvalidInput(
            "On-chain LLM is not configured".to_string(),
        )),
    }
}

/// Configure the vetKD system canister ID
/// For local development: use the chainkey_testing_canister ID
/// For mainnet: leave unconfigured (uses management canister)
#[update]
fn configure_vetkd(canister_id: Principal) -> Result<(), CanisterError> {
    set_vetkd_canister_id(canister_id);
    ic_cdk::println!("VetKD canister configured: {}", canister_id);
    Ok(())
}

/// Update the agent's character configuration
#[update]
fn update_character(config: CharacterConfig) -> Result<(), CanisterError> {
    let mut state = ensure_initialized()?;
    state.character = config;
    AGENT_STATE.with(|s| *s.borrow_mut() = Some(state));
    Ok(())
}

/// Get the current agent state
#[query]
fn get_agent_state() -> Option<AgentState> {
    AGENT_STATE.with(|s| s.borrow().clone())
}

// ========== Chat Interface ==========

/// Process a chat message and return a response
/// Uses the same memory pattern as plugin-inmemorydb
#[update]
async fn chat(request: ChatRequest) -> Result<ChatResponse, CanisterError> {
    let state = ensure_initialized()?;

    if request.message.trim().is_empty() {
        return Err(CanisterError::InvalidInput("Message cannot be empty".to_string()));
    }

    let adapter = create_database_adapter(&state.agent_id);

    // Get or create user ID
    let user_id = request.user_id.unwrap_or_else(|| {
        format!("user-{}", ic_cdk::api::caller().to_text())
    });

    // Ensure user entity exists
    if adapter.get_entity(&user_id)?.is_none() {
        adapter.create_entity(json!({
            "id": user_id,
            "name": format!("User {}", &user_id[..8.min(user_id.len())]),
            "type": "user",
            "createdAt": now_millis()
        }))?;
    }

    // Get or create room ID
    let room_id = request.room_id.unwrap_or_else(|| {
        format!("room-{}-{}", user_id, state.agent_id)
    });

    // Ensure room exists
    if adapter.get_room(&room_id)?.is_none() {
        adapter.create_room(json!({
            "id": room_id,
            "name": format!("Chat with {}", state.character.name),
            "participants": [user_id.clone(), state.agent_id.clone()],
            "createdAt": now_millis()
        }))?;
    }

    // Create user message memory (matching plugin-inmemorydb create_memory)
    let user_message_id = adapter.create_memory(
        json!({
            "entityId": user_id,
            "agentId": state.agent_id,
            "roomId": room_id,
            "content": {
                "text": request.message
            },
            "createdAt": now_millis()
        }),
        "messages", // table_name
        false,      // unique
    )?;

    // Get recent conversation history
    let recent_memories = adapter.get_memories(
        None,                    // entity_id
        Some(&state.agent_id),   // agent_id
        Some(&room_id),          // room_id
        None,                    // world_id
        "messages",              // table_name
        Some(20),                // count
        None,                    // offset
        None,                    // unique
    )?;

    // Generate response
    let response_text = generate_response_with_context(
        &state.character,
        &request.message,
        &recent_memories,
        &state.agent_id,
    )
    .await;

    // Create agent response memory
    let agent_message_id = adapter.create_memory(
        json!({
            "entityId": state.agent_id,
            "agentId": state.agent_id,
            "roomId": room_id,
            "content": {
                "text": response_text
            },
            "createdAt": now_millis()
        }),
        "messages",
        false,
    )?;

    // Update agent state
    AGENT_STATE.with(|s| {
        if let Some(ref mut state) = *s.borrow_mut() {
            state.last_active = ic_cdk::api::time();
            state.message_count += 1;
        }
    });

    Ok(ChatResponse {
        message: response_text,
        room_id,
        message_id: agent_message_id,
        timestamp: ic_cdk::api::time(),
    })
}

/// Get conversation history for a room (returns JSON strings)
#[query]
fn get_conversation_history(room_id: String, count: Option<u32>) -> Vec<String> {
    let state = match AGENT_STATE.with(|s| s.borrow().clone()) {
        Some(s) => s,
        None => return vec![],
    };

    let adapter = create_database_adapter(&state.agent_id);

    adapter
        .get_memories(
            None,
            Some(&state.agent_id),
            Some(&room_id),
            None,
            "messages",
            count.map(|c| c as usize),
            None,
            None,
        )
        .unwrap_or_default()
        .into_iter()
        .filter_map(|v| serde_json::to_string(&v).ok())
        .collect()
}

// ========== Memory Management ==========

/// Create a new memory (matching plugin-inmemorydb API)
/// memory_json: JSON string of the memory object
#[update]
fn create_memory(
    memory_json: String,
    table_name: String,
    unique: bool,
) -> Result<String, CanisterError> {
    let state = ensure_initialized()?;
    let adapter = create_database_adapter(&state.agent_id);
    let memory: Value = serde_json::from_str(&memory_json)
        .map_err(|e| CanisterError::SerializationError(e.to_string()))?;
    let id = adapter.create_memory(memory, &table_name, unique)?;
    Ok(id)
}

/// Get memories with filters (returns JSON strings)
#[query]
fn get_memories(
    entity_id: Option<String>,
    room_id: Option<String>,
    table_name: String,
    count: Option<u32>,
) -> Vec<String> {
    let state = match AGENT_STATE.with(|s| s.borrow().clone()) {
        Some(s) => s,
        None => return vec![],
    };

    let adapter = create_database_adapter(&state.agent_id);

    adapter
        .get_memories(
            entity_id.as_deref(),
            Some(&state.agent_id),
            room_id.as_deref(),
            None,
            &table_name,
            count.map(|c| c as usize),
            None,
            None,
        )
        .unwrap_or_default()
        .into_iter()
        .filter_map(|v| serde_json::to_string(&v).ok())
        .collect()
}

/// Search memories by embedding (returns JSON strings)
#[query]
fn search_memories(
    table_name: String,
    embedding: Vec<f32>,
    match_threshold: Option<f32>,
    count: Option<u32>,
    room_id: Option<String>,
) -> Vec<String> {
    let state = match AGENT_STATE.with(|s| s.borrow().clone()) {
        Some(s) => s,
        None => return vec![],
    };

    let adapter = create_database_adapter(&state.agent_id);

    adapter
        .search_memories(
            &table_name,
            &embedding,
            match_threshold,
            count.map(|c| c as usize),
            room_id.as_deref(),
            None,
            None,
            None,
        )
        .unwrap_or_default()
        .into_iter()
        .filter_map(|v| serde_json::to_string(&v).ok())
        .collect()
}

/// Delete a memory by ID
#[update]
fn delete_memory(id: String) -> Result<(), CanisterError> {
    let state = ensure_initialized()?;
    let adapter = create_database_adapter(&state.agent_id);
    adapter.delete_memory(&id)?;
    Ok(())
}

// ========== Room Management ==========

/// Create a new room
#[update]
fn create_room(name: Option<String>) -> Result<String, CanisterError> {
    let state = ensure_initialized()?;
    let adapter = create_database_adapter(&state.agent_id);

    let id = adapter.create_room(json!({
        "name": name,
        "participants": [state.agent_id],
        "createdAt": now_millis()
    }))?;

    Ok(id)
}

/// Get all rooms (returns JSON strings)
#[query]
fn get_rooms() -> Vec<String> {
    let state = match AGENT_STATE.with(|s| s.borrow().clone()) {
        Some(s) => s,
        None => return vec![],
    };

    let _adapter = create_database_adapter(&state.agent_id);

    storage::IcpMemoryStorage::get_all(COLLECTIONS::ROOMS)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|v| serde_json::to_string(&v).ok())
        .collect()
}

/// Delete a room
#[update]
fn delete_room(id: String) -> Result<(), CanisterError> {
    let state = ensure_initialized()?;
    let adapter = create_database_adapter(&state.agent_id);
    adapter.delete_room(&id)?;
    Ok(())
}

// ========== VetKeys Integration ==========

/// Get a derived encryption key for a user
/// The user provides their transport public key for secure key delivery
#[update]
async fn get_user_encryption_key(transport_public_key: Vec<u8>) -> Result<EncryptedVetKey, CanisterError> {
    let caller = ic_cdk::api::caller();
    // Use insecure_test_key_1 for local testing, key_1 for mainnet
    let manager = VetKeysManager::for_local_testing();
    manager.derive_user_encryption_key(&caller, &transport_public_key).await
}

/// Get the canister's vetKD public key (for IBE encryption)
#[update]
async fn get_vetkd_public_key() -> Result<Vec<u8>, CanisterError> {
    // Use insecure_test_key_1 for local testing, key_1 for mainnet
    let manager = VetKeysManager::for_local_testing();
    manager.get_public_key(vetkey_contexts::USER_DATA).await
}

// ========== Health & Diagnostics ==========

/// Get the health status of the canister
#[query]
fn health() -> HealthStatus {
    let state = AGENT_STATE.with(|s| s.borrow().clone());
    let created_at = CREATED_AT.with(|c| *c.borrow());

    let memory_count = state.as_ref().map(|s| {
        let adapter = create_database_adapter(&s.agent_id);
        adapter.memory_count()
    }).unwrap_or(0);

    HealthStatus {
        status: "healthy".to_string(),
        agent_id: state.as_ref().map(|s| s.agent_id.clone()),
        agent_name: state.as_ref().map(|s| s.character.name.clone()),
        initialized: state.is_some(),
        message_count: state.as_ref().map(|s| s.message_count).unwrap_or(0),
        memory_count,
        uptime_ns: ic_cdk::api::time().saturating_sub(created_at),
    }
}

/// Get the canister's cycles balance
#[query]
fn cycles_balance() -> u64 {
    ic_cdk::api::canister_balance()
}

/// Get the caller's principal
#[query]
fn whoami() -> Principal {
    ic_cdk::api::caller()
}

/// Check if OpenAI is configured
#[query]
fn is_openai_enabled() -> bool {
    OPENAI_CONFIG.with(|c| {
        c.borrow().as_ref().map(is_openai_configured).unwrap_or(false)
    })
}

// ========== Internal Functions ==========

fn ensure_initialized() -> Result<AgentState, CanisterError> {
    AGENT_STATE
        .with(|s| s.borrow().clone())
        .ok_or(CanisterError::NotInitialized)
}

/// Generate response based on current inference mode
/// Supports: ELIZA Classic, OpenAI, or On-Chain LLM
async fn generate_response_with_context(
    character: &CharacterConfig,
    user_message: &str,
    recent_memories: &[Value],
    agent_id: &str,
) -> String {
    // Get current inference mode
    let mode = INFERENCE_MODE.with(|m| m.borrow().clone());
    
    // Build system prompt once
    let system_prompt = character.system.clone().unwrap_or_else(|| {
        format!(
            "You are {}, {}. Your personality: {}. Give direct, substantive answers.",
            character.name,
            character.bio,
            character.personality_traits.join(", ")
        )
    });
    
    // Build conversation history from memories
    let history: Vec<(String, String)> = recent_memories
        .iter()
        .rev()
        .take(10)
        .rev()
        .filter_map(|m| {
            let text = m.get("content")?.get("text")?.as_str()?;
            let entity_id = m.get("entityId")?.as_str()?;
            let role = if entity_id == agent_id {
                "assistant"
            } else {
                "user"
            };
            Some((role.to_string(), text.to_string()))
        })
        .collect();
    
    match mode {
        InferenceMode::DfinityLLM => {
            // Try DFINITY LLM (Llama 3.1 8B / Qwen3 32B - fast, free, managed by DFINITY)
            if let Some(response) = try_dfinity_llm_response(&system_prompt, user_message, &history).await {
                return response;
            }
            // Fall back to ELIZA Classic
            ic_cdk::println!("DFINITY LLM failed, falling back to ELIZA Classic");
            generate_pattern_response(character, user_message)
        }
        InferenceMode::OpenAI => {
            // Try OpenAI
            if let Some(response) = try_openai_response(&system_prompt, user_message, &history, character).await {
                return response;
            }
            // Fall back to ELIZA Classic
            ic_cdk::println!("OpenAI failed, falling back to ELIZA Classic");
            generate_pattern_response(character, user_message)
        }
        InferenceMode::OnChainLLM => {
            // Try On-Chain LLM
            if let Some(response) = try_onchain_llm_response(&system_prompt, user_message, &history).await {
                return response;
            }
            // Fall back to ELIZA Classic
            ic_cdk::println!("On-chain LLM failed, falling back to ELIZA Classic");
            generate_pattern_response(character, user_message)
        }
        InferenceMode::ElizaClassic => {
            generate_pattern_response(character, user_message)
        }
    }
}

/// Try to generate response using OpenAI
async fn try_openai_response(
    system_prompt: &str,
    user_message: &str,
    history: &[(String, String)],
    character: &CharacterConfig,
) -> Option<String> {
    let config = OPENAI_CONFIG.with(|c| c.borrow().clone())?;
    
    if !is_openai_configured(&config) {
        return None;
    }
    
    let client = OpenAIClient::new(config);
    
    match client.chat_completion(system_prompt, user_message, history).await {
        Ok(response) => {
            let cleaned = response
                .strip_prefix(&format!("{}: ", character.name))
                .or_else(|| response.strip_prefix(&format!("{}:", character.name)))
                .unwrap_or(&response)
                .trim()
                .to_string();
            Some(cleaned)
        }
        Err(e) => {
            ic_cdk::println!("OpenAI error: {}", e);
            None
        }
    }
}

/// Try to generate response using On-Chain LLM (llama_cpp_canister)
async fn try_onchain_llm_response(
    system_prompt: &str,
    user_message: &str,
    history: &[(String, String)],
) -> Option<String> {
    let config = ONCHAIN_LLM_CONFIG.with(|c| c.borrow().clone())?;
    
    if !config.is_configured() {
        return None;
    }
    
    let client = OnChainLLMClient::new(config);
    
    match client.chat_completion(system_prompt, user_message, history).await {
        Ok(response) => {
            // Clean up the prompt cache after successful generation
            let _ = client.cleanup().await;
            Some(response)
        }
        Err(e) => {
            ic_cdk::println!("On-chain LLM error: {}", e);
            // Try to clean up even on error
            let _ = client.cleanup().await;
            None
        }
    }
}

/// Try to generate response using DFINITY LLM canister
/// This is FREE and managed by DFINITY - Llama 3.1 8B / Qwen3 32B
async fn try_dfinity_llm_response(
    system_prompt: &str,
    user_message: &str,
    _history: &[(String, String)],
) -> Option<String> {
    use ic_llm::{ChatMessage, Model};
    
    // Get config (or use defaults - DFINITY LLM is always available)
    let config = DFINITY_LLM_CONFIG.with(|c| c.borrow().clone())
        .unwrap_or_default();
    
    if !config.enabled {
        return None;
    }
    
    // Map our model enum to ic_llm Model
    let model = match config.model {
        DfinityLLMModel::Llama3_1_8B => Model::Llama3_1_8B,
        DfinityLLMModel::Qwen3_32B => Model::Qwen3_32B,
        DfinityLLMModel::Llama4Scout => Model::Llama4Scout,
    };
    
    // Build messages - DFINITY LLM supports up to 10 messages
    // For simplicity, we'll just use system + user message
    // (History could be added but requires AssistantMessage construction)
    let mut messages: Vec<ChatMessage> = Vec::new();
    
    // Add system message
    let system_content = config.system_prompt.as_ref()
        .map(|s| s.clone())
        .unwrap_or_else(|| system_prompt.to_string());
    messages.push(ChatMessage::System { content: system_content });
    
    // Add current user message
    messages.push(ChatMessage::User { content: user_message.to_string() });
    
    ic_cdk::println!(
        "Calling DFINITY LLM ({}) with {} messages",
        config.model,
        messages.len()
    );
    
    // Call DFINITY LLM - returns Response directly, not Result
    // Response has structure: { message: AssistantMessage { content: Option<String>, .. }, .. }
    let response = ic_llm::chat(model)
        .with_messages(messages)
        .send()
        .await;
    
    // Extract content from response message
    match response.message.content {
        Some(content) if !content.is_empty() => {
            ic_cdk::println!("DFINITY LLM response received: {} chars", content.len());
            Some(content)
        }
        Some(_) => {
            ic_cdk::println!("DFINITY LLM returned empty response");
            None
        }
        None => {
            ic_cdk::println!("DFINITY LLM returned no content");
            None
        }
    }
}

fn generate_pattern_response(_character: &CharacterConfig, user_message: &str) -> String {
    // Use ELIZA Classic for pattern-based Rogerian psychotherapist responses
    // This provides authentic ELIZA behavior without needing any API keys
    ELIZA_CLASSIC.with(|e| {
        if let Some(eliza) = e.borrow().as_ref() {
            eliza.generate_response(user_message)
        } else {
            // Fallback if ELIZA Classic not initialized (shouldn't happen)
            "I'm listening. Please tell me more.".to_string()
        }
    })
}

// ========== ELIZA Classic ==========

/// Get ELIZA Classic greeting message
#[query]
fn get_eliza_greeting() -> String {
    ELIZA_CLASSIC.with(|e| {
        if let Some(eliza) = e.borrow().as_ref() {
            eliza.get_greeting()
        } else {
            "How do you do? Please tell me your problem.".to_string()
        }
    })
}

/// Chat directly with ELIZA Classic (no memory, no state - just pattern matching)
/// Useful for testing the pattern-matching engine
#[query]
fn eliza_classic_chat(message: String) -> String {
    ELIZA_CLASSIC.with(|e| {
        if let Some(eliza) = e.borrow().as_ref() {
            eliza.generate_response(&message)
        } else {
            "I'm listening. Please tell me more.".to_string()
        }
    })
}

/// Reset ELIZA Classic conversation history
#[update]
fn reset_eliza_session() {
    ELIZA_CLASSIC.with(|e| {
        if let Some(eliza) = e.borrow().as_ref() {
            eliza.reset_history();
        }
    });
}

// ========== Candid Export ==========

ic_cdk::export_candid!();
