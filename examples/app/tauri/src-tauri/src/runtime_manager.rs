use crate::types::{effective_mode, AppConfig, ProviderMode};
use elizaos::types::agent::Character;
use elizaos::types::model::LLMMode;
use elizaos::types::primitives::{string_to_uuid, UUID};
use elizaos::types::settings::SettingValue;
use elizaos::{runtime::RuntimeOptions, AgentRuntime};
use elizaos_plugin_eliza_classic::ElizaClassicPlugin;
use std::sync::Arc;
use tokio::sync::Mutex;

pub struct RuntimeState {
    pub runtime: Arc<AgentRuntime>,
    pub mode: ProviderMode,
}

pub type SharedRuntime = Arc<Mutex<Option<RuntimeState>>>;

async fn build_runtime(cfg: &AppConfig) -> anyhow::Result<Arc<AgentRuntime>> {
    let mode = effective_mode(cfg);

    // Always have ELIZA classic available as a fallback / offline mode.
    // For LLM modes, we register TEXT_SMALL/TEXT_LARGE handlers from plugins where available.
    let plugins: Vec<elizaos::types::Plugin> = Vec::new();

    // ELIZA classic doesn't expose an elizaos::Plugin in Rust; we wire it by registering
    // a model handler directly that returns ELIZA responses.
    let eliza = Arc::new(ElizaClassicPlugin::new());

    let runtime: Arc<AgentRuntime> = AgentRuntime::new(RuntimeOptions {
            character: Some(Character {
                name: "Eliza".to_string(),
                bio: elizaos::types::agent::Bio::Single("A helpful assistant for simple back-and-forth chat.".to_string()),
                system: Some("You are a helpful assistant. If no LLM is available, respond in the style of classic ELIZA.".to_string()),
                ..Default::default()
            }),
            plugins,
            adapter: None,
            log_level: elizaos::runtime::LogLevel::Error,
            action_planning: Some(false),
            check_should_respond: Some(false),
            llm_mode: Some(LLMMode::Small),
            ..Default::default()
        })
        .await?;

    // Basic settings parity with TS
    runtime
        .set_setting("CHECK_SHOULD_RESPOND", SettingValue::Bool(false), false)
        .await;
    runtime
        .set_setting("LLM_MODE", SettingValue::String("DEFAULT".to_string()), false)
        .await;

    // Classic ELIZA handler (TEXT_SMALL + TEXT_LARGE) used when no LLM is configured.
    let eliza_small = Arc::clone(&eliza);
    runtime
        .register_model("TEXT_SMALL", Box::new(move |params: serde_json::Value| {
            let eliza = Arc::clone(&eliza_small);
            Box::pin(async move {
                let prompt = params.get("prompt").and_then(|v| v.as_str()).unwrap_or("");
                Ok(eliza.generate_response(prompt))
            })
        }))
        .await;

    let eliza_large = Arc::clone(&eliza);
    runtime
        .register_model("TEXT_LARGE", Box::new(move |params: serde_json::Value| {
            let eliza = Arc::clone(&eliza_large);
            Box::pin(async move {
                let prompt = params.get("prompt").and_then(|v| v.as_str()).unwrap_or("");
                Ok(eliza.generate_response(prompt))
            })
        }))
        .await;

    // When configured, register OpenAI / xAI model handlers from plugins.
    match mode {
        ProviderMode::OpenAI => {
            std::env::set_var("OPENAI_API_KEY", cfg.provider.openai_api_key.clone());
            std::env::set_var("OPENAI_BASE_URL", cfg.provider.openai_base_url.clone());
            std::env::set_var("OPENAI_SMALL_MODEL", cfg.provider.openai_small_model.clone());
            std::env::set_var("OPENAI_LARGE_MODEL", cfg.provider.openai_large_model.clone());
            let plugin = elizaos_plugin_openai::create_openai_elizaos_plugin()?;
            runtime.register_plugin(plugin).await?;
        }
        ProviderMode::XAI => {
            std::env::set_var("XAI_API_KEY", cfg.provider.xai_api_key.clone());
            std::env::set_var("XAI_BASE_URL", cfg.provider.xai_base_url.clone());
            std::env::set_var("XAI_SMALL_MODEL", cfg.provider.xai_small_model.clone());
            std::env::set_var("XAI_LARGE_MODEL", cfg.provider.xai_large_model.clone());
            let plugin = elizaos_plugin_xai::create_xai_elizaos_plugin()?;
            runtime.register_plugin(plugin).await?;
        }
        ProviderMode::ElizaClassic => {}
    }

    runtime.initialize().await?;
    Ok(runtime)
}

pub async fn get_or_create_runtime(shared: &SharedRuntime, cfg: &AppConfig) -> anyhow::Result<Arc<AgentRuntime>> {
    let mut guard = shared.lock().await;
    let mode = effective_mode(cfg);

    if let Some(state) = guard.as_ref() {
        if state.mode == mode {
            return Ok(Arc::clone(&state.runtime));
        }
    }

    let runtime = build_runtime(cfg).await?;
    *guard = Some(RuntimeState { runtime: Arc::clone(&runtime), mode });
    Ok(runtime)
}

pub fn room_id() -> UUID {
    string_to_uuid("tauri-example-room")
}

#[cfg(test)]
mod tests {
    use super::*;
    use elizaos::services::IMessageService;
    use elizaos::types::memory::Memory;
    use std::sync::Arc;
    use tokio::sync::Mutex;

    #[tokio::test]
    async fn eliza_classic_responds_and_runtime_is_cached() {
        let shared: SharedRuntime = Arc::new(Mutex::new(None));
        let cfg = AppConfig::default();

        let rt1 = get_or_create_runtime(&shared, &cfg).await.unwrap();
        let rt2 = get_or_create_runtime(&shared, &cfg).await.unwrap();
        assert!(Arc::ptr_eq(&rt1, &rt2));

        let user_id = string_to_uuid("tauri-test-user");
        let mut msg = Memory::message(user_id, room_id(), "hello");

        let service = rt1.message_service();
        let result = service
            .handle_message(&rt1, &mut msg, None, None)
            .await
            .unwrap();

        let text = result
            .response_content
            .and_then(|c| c.text)
            .unwrap_or_default();
        assert!(!text.trim().is_empty());
    }
}

