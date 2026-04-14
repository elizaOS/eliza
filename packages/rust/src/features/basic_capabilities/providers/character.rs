//! CHARACTER provider implementation.

use async_trait::async_trait;
use once_cell::sync::Lazy;

use crate::error::PluginResult;
use crate::generated::spec_helpers::require_provider_spec;
use crate::runtime::IAgentRuntime;
use crate::types::{Memory, ProviderResult, State};

use super::Provider;

// Get text content from centralized specs
static SPEC: Lazy<&'static crate::generated::spec_helpers::ProviderDoc> =
    Lazy::new(|| require_provider_spec("CHARACTER"));

/// Replace `{{name}}` and `{{agentName}}` placeholders with the character's name.
///
/// Supports character template files where the name is injected at render time
/// so changing the character's name doesn't require rewriting every field.
fn resolve_name(text: &str, name: &str) -> String {
    text.replace("{{agentName}}", name).replace("{{name}}", name)
}

/// Resolve `{{name}}` in every element of a string slice.
fn resolve_name_vec(items: &[String], name: &str) -> Vec<String> {
    items.iter().map(|s| resolve_name(s, name)).collect()
}

/// Provider for character information.
pub struct CharacterProvider;

#[async_trait]
impl Provider for CharacterProvider {
    fn name(&self) -> &'static str {
        &SPEC.name
    }

    fn description(&self) -> &'static str {
        &SPEC.description
    }

    fn is_dynamic(&self) -> bool {
        SPEC.dynamic.unwrap_or(false)
    }

    async fn get(
        &self,
        runtime: &dyn IAgentRuntime,
        _message: &Memory,
        _state: Option<&State>,
    ) -> PluginResult<ProviderResult> {
        let character = runtime.character();
        let agent_name = &character.name;
        let mut sections = Vec::new();

        // Name section
        sections.push(format!("# Agent: {}", agent_name));

        // Bio section (resolve {{name}} placeholders)
        if !character.bio.is_empty() {
            let bio_text = resolve_name(&format!("{}", character.bio), agent_name);
            sections.push(format!("\n## Bio\n{}", bio_text));
        }

        // Personality/Adjectives section (resolve {{name}} placeholders)
        if !character.adjectives.is_empty() {
            let resolved = resolve_name_vec(&character.adjectives, agent_name);
            sections.push(format!("\n## Personality Traits\n{}", resolved.join(", ")));
        }

        // Lore/Background section (resolve {{name}} placeholders)
        if !character.lore.is_empty() {
            let lore_text = resolve_name(&format!("{}", character.lore), agent_name);
            sections.push(format!("\n## Background\n{}", lore_text));
        }

        // Topics/Knowledge areas section (resolve {{name}} placeholders)
        if !character.topics.is_empty() {
            let resolved = resolve_name_vec(&character.topics, agent_name);
            sections.push(format!("\n## Knowledge Areas\n{}", resolved.join(", ")));
        }

        // Style section (resolve {{name}} placeholders)
        let mut style_parts = Vec::new();
        if !character.style.all.is_empty() {
            let resolved = resolve_name_vec(&character.style.all, agent_name);
            style_parts.push(format!("General: {}", resolved.join(", ")));
        }
        if !character.style.chat.is_empty() {
            let resolved = resolve_name_vec(&character.style.chat, agent_name);
            style_parts.push(format!("Chat: {}", resolved.join(", ")));
        }
        if !character.style.post.is_empty() {
            let resolved = resolve_name_vec(&character.style.post, agent_name);
            style_parts.push(format!("Posts: {}", resolved.join(", ")));
        }
        if !style_parts.is_empty() {
            sections.push(format!(
                "\n## Communication Style\n{}",
                style_parts.join("\n")
            ));
        }

        let context_text = sections.join("\n");

        Ok(ProviderResult::new(context_text)
            .with_value("agentName", character.name.clone())
            .with_value("hasCharacter", true)
            .with_data("name", character.name.clone())
            .with_data("bio", character.bio.clone()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── resolve_name ────────────────────────────────────────────────────

    #[test]
    fn test_resolve_name_single_placeholder() {
        assert_eq!(resolve_name("Hello {{name}}!", "Sakuya"), "Hello Sakuya!");
    }

    #[test]
    fn test_resolve_name_multiple_placeholders() {
        assert_eq!(
            resolve_name("{{name}} is {{name}}", "Reimu"),
            "Reimu is Reimu"
        );
    }

    #[test]
    fn test_resolve_agent_name_placeholder() {
        assert_eq!(
            resolve_name("Speak as {{agentName}} would.", "Marisa"),
            "Speak as Marisa would."
        );
    }

    #[test]
    fn test_resolve_name_no_placeholder() {
        assert_eq!(
            resolve_name("No placeholders here.", "Marisa"),
            "No placeholders here."
        );
    }

    #[test]
    fn test_resolve_name_empty_string() {
        assert_eq!(resolve_name("", "Sakuya"), "");
    }

    #[test]
    fn test_resolve_name_placeholder_only() {
        assert_eq!(resolve_name("{{name}}", "Patchouli"), "Patchouli");
    }

    // ── resolve_name_vec ────────────────────────────────────────────────

    #[test]
    fn test_resolve_name_vec_resolves_all() {
        let items = vec![
            "{{name}} is great.".to_string(),
            "I am {{name}}.".to_string(),
        ];
        let result = resolve_name_vec(&items, "Sakuya");
        assert_eq!(result, vec!["Sakuya is great.", "I am Sakuya."]);
    }

    #[test]
    fn test_resolve_name_vec_empty() {
        let items: Vec<String> = vec![];
        let result = resolve_name_vec(&items, "Sakuya");
        assert!(result.is_empty());
    }

    #[test]
    fn test_resolve_name_vec_mixed() {
        let items = vec!["{{name}} rocks".to_string(), "no placeholder".to_string()];
        let result = resolve_name_vec(&items, "Remilia");
        assert_eq!(result, vec!["Remilia rocks", "no placeholder"]);
    }

    #[test]
    fn test_resolve_name_in_bio_template() {
        let bio = "{{name}} speaks softly with warmth and a gentle, cute demeanor.";
        let resolved = resolve_name(bio, "Sakuya");
        assert_eq!(
            resolved,
            "Sakuya speaks softly with warmth and a gentle, cute demeanor."
        );
        assert!(!resolved.contains("{{name}}"));
    }

    #[test]
    fn test_resolve_name_in_system_prompt_template() {
        let system = "You are {{name}}, an autonomous AI agent powered by ElizaOS.";
        let resolved = resolve_name(system, "Reimu");
        assert_eq!(
            resolved,
            "You are Reimu, an autonomous AI agent powered by ElizaOS."
        );
        assert!(!resolved.contains("{{name}}"));
    }

    #[test]
    fn test_resolve_name_vec_style_entries() {
        let style = vec![
            "Write as {{name}} would.".to_string(),
            "Be direct and confident.".to_string(),
        ];
        let resolved = resolve_name_vec(&style, "Marisa");
        assert_eq!(resolved[0], "Write as Marisa would.");
        assert_eq!(resolved[1], "Be direct and confident.");
        assert!(!resolved.iter().any(|s| s.contains("{{name}}")));
    }
}
