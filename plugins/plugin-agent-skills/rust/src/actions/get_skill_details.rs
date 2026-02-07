//! Get Skill Details Action
//!
//! Get detailed information about a specific skill from the registry.

use crate::service::AgentSkillsService;
use super::ActionResult;

/// Action that retrieves detailed skill information.
pub struct GetSkillDetailsAction;

impl GetSkillDetailsAction {
    /// Action name constant.
    pub const NAME: &'static str = "GET_SKILL_DETAILS";

    /// Action description.
    pub const DESCRIPTION: &'static str =
        "Get detailed information about a specific skill including version, owner, and stats.";

    /// Similar action names.
    pub const SIMILES: &[&'static str] = &["SKILL_INFO", "SKILL_DETAILS"];

    /// Extract a slug-like pattern from text.
    pub fn extract_slug(text: &str) -> Option<String> {
        let re = regex::Regex::new(r"\b([a-z][a-z0-9-]*[a-z0-9])\b").ok()?;
        re.find(text).map(|m| m.as_str().to_string())
    }

    /// Execute the get skill details action.
    pub async fn handle(
        service: &mut AgentSkillsService,
        slug: &str,
    ) -> ActionResult {
        if slug.is_empty() {
            return ActionResult::fail("Skill slug is required");
        }

        match service.get_skill_details(slug, false).await {
            Ok(Some(details)) => {
                let is_installed = service.is_installed(slug);
                let status = if is_installed { "Installed" } else { "Available" };

                let downloads = details.skill.stats.get("downloads").unwrap_or(&0);
                let stars = details.skill.stats.get("stars").unwrap_or(&0);
                let versions = details.skill.stats.get("versions").unwrap_or(&0);

                let mut text = format!(
                    "## {}\n\n\
                     **Slug:** `{}`\n\
                     **Version:** {}\n\
                     **Status:** {}\n\n\
                     {}\n\n\
                     **Stats:**\n\
                     - Downloads: {}\n\
                     - Stars: {}\n\
                     - Versions: {}",
                    details.skill.display_name,
                    details.skill.slug,
                    details.latest_version.version,
                    status,
                    details.skill.summary,
                    downloads,
                    stars,
                    versions,
                );

                if let Some(ref owner) = details.owner {
                    text.push_str(&format!(
                        "\n\n**Author:** {} (@{})",
                        owner.display_name, owner.handle
                    ));
                }

                if let Some(ref changelog) = details.latest_version.changelog {
                    text.push_str(&format!("\n**Changelog:** {}", changelog));
                }

                ActionResult::ok(text)
            }
            Ok(None) => {
                ActionResult::fail(format!("Skill \"{}\" not found in the registry.", slug))
            }
            Err(e) => ActionResult::fail(format!("Error getting skill details: {}", e)),
        }
    }
}
