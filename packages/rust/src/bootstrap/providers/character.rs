//! CHARACTER provider implementation.

use async_trait::async_trait;

use crate::error::PluginResult;
use crate::runtime::IAgentRuntime;
use crate::types::{Memory, ProviderResult, State};

use super::Provider;

/// Provider for character information.
pub struct CharacterProvider;

#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
impl Provider for CharacterProvider {
    fn name(&self) -> &'static str {
        "CHARACTER"
    }

    fn description(&self) -> &'static str {
        "Provides the agent's character definition and personality information"
    }

    fn is_dynamic(&self) -> bool {
        false
    }

    async fn get(
        &self,
        runtime: &dyn IAgentRuntime,
        _message: &Memory,
        _state: Option<&State>,
    ) -> PluginResult<ProviderResult> {
        let character = runtime.character();
        let mut sections = Vec::new();

        // Name section
        sections.push(format!("# Agent: {}", character.name));

        // Bio section
        if !character.bio.is_empty() {
            sections.push(format!("\n## Bio\n{}", character.bio));
        }

        // Personality/Adjectives section
        if !character.adjectives.is_empty() {
            sections.push(format!(
                "\n## Personality Traits\n{}",
                character.adjectives.join(", ")
            ));
        }

        // Lore/Background section
        if !character.lore.is_empty() {
            sections.push(format!("\n## Background\n{}", character.lore));
        }

        // Topics/Knowledge areas section
        if !character.topics.is_empty() {
            sections.push(format!(
                "\n## Knowledge Areas\n{}",
                character.topics.join(", ")
            ));
        }

        // Style section
        let mut style_parts = Vec::new();
        if !character.style.all.is_empty() {
            style_parts.push(format!("General: {}", character.style.all.join(", ")));
        }
        if !character.style.chat.is_empty() {
            style_parts.push(format!("Chat: {}", character.style.chat.join(", ")));
        }
        if !character.style.post.is_empty() {
            style_parts.push(format!("Posts: {}", character.style.post.join(", ")));
        }
        if !style_parts.is_empty() {
            sections.push(format!("\n## Communication Style\n{}", style_parts.join("\n")));
        }

        let context_text = sections.join("\n");

        Ok(ProviderResult::new(context_text)
            .with_value("agentName", character.name.clone())
            .with_value("hasCharacter", true)
            .with_data("name", character.name.clone())
            .with_data("bio", character.bio.clone()))
    }
}

