//! Core bootstrap capabilities (TypeScript parity).
//!
//! TypeScript always registers a built-in "bootstrap" plugin during runtime initialization.
//! This module provides a minimal Rust equivalent for the core runtime plugin system
//! (`Plugin` + `ActionHandler` + `ProviderHandler`), with capability gating:
//! - basic: REPLY/IGNORE/NONE + common context providers
//! - extended/autonomy: placeholders for future parity expansion

use std::collections::HashMap;
use std::sync::{Arc, Weak};

use anyhow::Result;
use serde_json::Value;

use crate::runtime::AgentRuntime;
use crate::types::components::{
    ActionDefinition, ActionHandler, ActionResult, ProviderDefinition, ProviderHandler,
    ProviderResult,
};
use crate::types::database::GetMemoriesParams;
use crate::types::memory::Memory;
use crate::types::plugin::Plugin;
use crate::types::state::State;

/// Bootstrap capability configuration (mirrors TS `CapabilityConfig`).
#[derive(Clone, Debug, Default)]
pub struct CapabilityConfig {
    /// Disable basic capabilities (reply/ignore/none + core providers).
    pub disable_basic: bool,
    /// Enable extended capabilities (reserved for future parity).
    pub enable_extended: bool,
    /// Skip the character provider (useful for anonymous agents).
    pub skip_character_provider: bool,
    /// Enable autonomy capabilities (reserved for future parity).
    pub enable_autonomy: bool,
}

/// Create the built-in bootstrap plugin for the core runtime.
pub fn create_bootstrap_plugin(runtime: Weak<AgentRuntime>, config: CapabilityConfig) -> Plugin {
    let mut plugin = Plugin::new("bootstrap", "Core bootstrap capabilities");

    if !config.disable_basic {
        // Core actions (minimal parity)
        plugin = plugin
            .with_action(Arc::new(ReplyAction))
            .with_action(Arc::new(IgnoreAction))
            .with_action(Arc::new(NoneAction));

        // Core providers
        if !config.skip_character_provider {
            plugin = plugin.with_provider(Arc::new(CharacterProvider {
                runtime: runtime.clone(),
            }));
        }
        plugin = plugin
            .with_provider(Arc::new(ActionsListProvider {
                runtime: runtime.clone(),
            }))
            .with_provider(Arc::new(ProvidersListProvider {
                runtime: runtime.clone(),
            }))
            .with_provider(Arc::new(EvaluatorsListProvider {
                runtime: runtime.clone(),
            }))
            .with_provider(Arc::new(RecentMessagesProvider { runtime }));
    }

    // NOTE: enable_extended / enable_autonomy are wired but not yet expanded to full TS parity.
    // This pass focuses on closing the biggest missing behavior: bootstrap auto-registration
    // with flag precedence + minimum viable actions/providers.
    let _ = (config.enable_extended, config.enable_autonomy);

    plugin
}

struct ReplyAction;
struct IgnoreAction;
struct NoneAction;

#[async_trait::async_trait]
impl ActionHandler for ReplyAction {
    fn definition(&self) -> ActionDefinition {
        ActionDefinition {
            name: "REPLY".to_string(),
            description: "Reply to the user".to_string(),
            similes: Some(vec!["RESPOND".to_string()]),
            examples: None,
            priority: None,
            tags: None,
            parameters: None,
        }
    }

    async fn validate(&self, _message: &Memory, _state: Option<&State>) -> bool {
        true
    }

    async fn handle(
        &self,
        message: &Memory,
        _state: Option<&State>,
        options: Option<&crate::types::components::HandlerOptions>,
    ) -> Result<Option<ActionResult>, anyhow::Error> {
        // If the model provided <params> for REPLY with a "text" field, use it.
        let text = options
            .and_then(|o| o.parameters.as_ref())
            .and_then(|p| p.get("text"))
            .and_then(Value::as_str)
            .map(|s| s.to_string())
            .or_else(|| message.content.text.clone())
            .unwrap_or_default();

        let mut data: HashMap<String, Value> = HashMap::new();
        data.insert("actionName".to_string(), Value::String("REPLY".to_string()));
        data.insert("responseText".to_string(), Value::String(text.clone()));

        Ok(Some(ActionResult {
            success: true,
            text: Some(text),
            values: None,
            data: Some(data),
            error: None,
        }))
    }
}

#[async_trait::async_trait]
impl ActionHandler for IgnoreAction {
    fn definition(&self) -> ActionDefinition {
        ActionDefinition {
            name: "IGNORE".to_string(),
            description: "Do not respond".to_string(),
            similes: None,
            examples: None,
            priority: None,
            tags: None,
            parameters: None,
        }
    }

    async fn validate(&self, _message: &Memory, _state: Option<&State>) -> bool {
        true
    }

    async fn handle(
        &self,
        _message: &Memory,
        _state: Option<&State>,
        _options: Option<&crate::types::components::HandlerOptions>,
    ) -> Result<Option<ActionResult>, anyhow::Error> {
        let mut data: HashMap<String, Value> = HashMap::new();
        data.insert(
            "actionName".to_string(),
            Value::String("IGNORE".to_string()),
        );
        Ok(Some(ActionResult {
            success: true,
            text: Some("ignored".to_string()),
            values: None,
            data: Some(data),
            error: None,
        }))
    }
}

#[async_trait::async_trait]
impl ActionHandler for NoneAction {
    fn definition(&self) -> ActionDefinition {
        ActionDefinition {
            name: "NONE".to_string(),
            description: "No-op action".to_string(),
            similes: None,
            examples: None,
            priority: None,
            tags: None,
            parameters: None,
        }
    }

    async fn validate(&self, _message: &Memory, _state: Option<&State>) -> bool {
        true
    }

    async fn handle(
        &self,
        _message: &Memory,
        _state: Option<&State>,
        _options: Option<&crate::types::components::HandlerOptions>,
    ) -> Result<Option<ActionResult>, anyhow::Error> {
        let mut data: HashMap<String, Value> = HashMap::new();
        data.insert("actionName".to_string(), Value::String("NONE".to_string()));
        Ok(Some(ActionResult {
            success: true,
            text: Some("none".to_string()),
            values: None,
            data: Some(data),
            error: None,
        }))
    }
}

struct CharacterProvider {
    runtime: Weak<AgentRuntime>,
}

#[async_trait::async_trait]
impl ProviderHandler for CharacterProvider {
    fn definition(&self) -> ProviderDefinition {
        ProviderDefinition {
            name: "CHARACTER".to_string(),
            description: Some("Character definition and identity".to_string()),
            dynamic: Some(false),
            position: Some(0),
            private: Some(false),
        }
    }

    async fn get(
        &self,
        _message: &Memory,
        _state: &State,
    ) -> Result<ProviderResult, anyhow::Error> {
        let Some(rt) = self.runtime.upgrade() else {
            return Ok(ProviderResult::default());
        };
        #[cfg(not(feature = "wasm"))]
        let character = rt.character.read().await.clone();
        #[cfg(feature = "wasm")]
        let character = rt.character.read().unwrap().clone();
        let text = format!(
            "[CHARACTER]\nname: {}\nbio: {}\n[/CHARACTER]",
            character.name,
            character.bio_string()
        );
        Ok(ProviderResult {
            text: Some(text.clone()),
            values: Some(HashMap::from([(
                "characterName".to_string(),
                Value::String(character.name),
            )])),
            data: None,
        })
    }
}

struct ActionsListProvider {
    runtime: Weak<AgentRuntime>,
}

#[async_trait::async_trait]
impl ProviderHandler for ActionsListProvider {
    fn definition(&self) -> ProviderDefinition {
        ProviderDefinition {
            name: "ACTIONS".to_string(),
            description: Some("List available actions".to_string()),
            dynamic: Some(false),
            position: Some(10),
            private: Some(false),
        }
    }

    async fn get(
        &self,
        _message: &Memory,
        _state: &State,
    ) -> Result<ProviderResult, anyhow::Error> {
        let Some(rt) = self.runtime.upgrade() else {
            return Ok(ProviderResult::default());
        };
        let defs = rt.list_action_definitions().await;
        let lines = defs
            .iter()
            .map(|d| format!("- {}: {}", d.name, d.description))
            .collect::<Vec<_>>()
            .join("\n");
        Ok(ProviderResult {
            text: Some(format!("[ACTIONS]\n{}\n[/ACTIONS]", lines)),
            values: None,
            data: None,
        })
    }
}

struct ProvidersListProvider {
    runtime: Weak<AgentRuntime>,
}

#[async_trait::async_trait]
impl ProviderHandler for ProvidersListProvider {
    fn definition(&self) -> ProviderDefinition {
        ProviderDefinition {
            name: "PROVIDERS".to_string(),
            description: Some("List available providers".to_string()),
            dynamic: Some(false),
            position: Some(11),
            private: Some(false),
        }
    }

    async fn get(
        &self,
        _message: &Memory,
        _state: &State,
    ) -> Result<ProviderResult, anyhow::Error> {
        let Some(rt) = self.runtime.upgrade() else {
            return Ok(ProviderResult::default());
        };
        let defs = rt.list_provider_definitions().await;
        let lines = defs
            .iter()
            .map(|d| {
                let desc = d.description.clone().unwrap_or_default();
                format!("- {}: {}", d.name, desc)
            })
            .collect::<Vec<_>>()
            .join("\n");
        Ok(ProviderResult {
            text: Some(format!("[PROVIDERS]\n{}\n[/PROVIDERS]", lines)),
            values: None,
            data: None,
        })
    }
}

struct EvaluatorsListProvider {
    runtime: Weak<AgentRuntime>,
}

#[async_trait::async_trait]
impl ProviderHandler for EvaluatorsListProvider {
    fn definition(&self) -> ProviderDefinition {
        ProviderDefinition {
            name: "EVALUATORS".to_string(),
            description: Some("List available evaluators".to_string()),
            dynamic: Some(false),
            position: Some(12),
            private: Some(false),
        }
    }

    async fn get(
        &self,
        _message: &Memory,
        _state: &State,
    ) -> Result<ProviderResult, anyhow::Error> {
        let Some(rt) = self.runtime.upgrade() else {
            return Ok(ProviderResult::default());
        };
        let defs = rt.list_evaluator_definitions().await;
        let lines = defs
            .iter()
            .map(|d| format!("- {}: {}", d.name, d.description))
            .collect::<Vec<_>>()
            .join("\n");
        Ok(ProviderResult {
            text: Some(format!("[EVALUATORS]\n{}\n[/EVALUATORS]", lines)),
            values: None,
            data: None,
        })
    }
}

struct RecentMessagesProvider {
    runtime: Weak<AgentRuntime>,
}

#[async_trait::async_trait]
impl ProviderHandler for RecentMessagesProvider {
    fn definition(&self) -> ProviderDefinition {
        ProviderDefinition {
            name: "RECENT_MESSAGES".to_string(),
            description: Some("Recent conversation messages".to_string()),
            dynamic: Some(true),
            position: Some(20),
            private: Some(false),
        }
    }

    async fn get(&self, message: &Memory, _state: &State) -> Result<ProviderResult, anyhow::Error> {
        let Some(rt) = self.runtime.upgrade() else {
            return Ok(ProviderResult::default());
        };
        let Some(adapter) = rt.get_adapter() else {
            return Ok(ProviderResult::default());
        };

        let memories = adapter
            .get_memories(GetMemoriesParams {
                table_name: "messages".to_string(),
                room_id: Some(message.room_id.clone()),
                count: Some(20),
                unique: Some(false),
                ..Default::default()
            })
            .await
            .unwrap_or_default();

        let mut lines: Vec<String> = Vec::new();
        for m in memories {
            if let Some(t) = &m.content.text {
                let sender = if m.entity_id == rt.agent_id {
                    #[cfg(not(feature = "wasm"))]
                    {
                        rt.character.read().await.name.clone()
                    }
                    #[cfg(feature = "wasm")]
                    {
                        rt.character.read().unwrap().name.clone()
                    }
                } else {
                    "User".to_string()
                };
                lines.push(format!("{}: {}", sender, t));
            }
        }

        Ok(ProviderResult {
            text: Some(format!(
                "[RECENT_MESSAGES]\n{}\n[/RECENT_MESSAGES]",
                lines.join("\n")
            )),
            values: None,
            data: None,
        })
    }
}
