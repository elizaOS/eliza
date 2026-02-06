//! Search Skills Action
//!
//! Search the skill registry for available skills by keyword or category.

use crate::service::AgentSkillsService;
use super::ActionResult;

/// Action that searches the skill registry.
pub struct SearchSkillsAction;

impl SearchSkillsAction {
    /// Action name constant.
    pub const NAME: &'static str = "SEARCH_SKILLS";

    /// Action description.
    pub const DESCRIPTION: &'static str =
        "Search the skill registry for available skills by keyword or category.";

    /// Similar action names.
    pub const SIMILES: &[&'static str] = &["BROWSE_SKILLS", "LIST_SKILLS", "FIND_SKILLS"];

    /// Execute the search skills action.
    pub async fn handle(service: &mut AgentSkillsService, query: &str) -> ActionResult {
        match service.search(query, 10, false).await {
            Ok(results) => {
                if results.is_empty() {
                    return ActionResult::ok(format!("No skills found matching \"{}\".", query));
                }

                let mut lines = vec![format!("## Skills matching \"{}\"\n", query)];

                for (i, r) in results.iter().enumerate().take(10) {
                    lines.push(format!(
                        "{}. **{}** (`{}`)\n   {}",
                        i + 1,
                        r.display_name,
                        r.slug,
                        r.summary
                    ));
                }

                lines.push(String::new());
                lines.push(
                    "Use GET_SKILL_GUIDANCE with a skill name to get detailed instructions."
                        .to_string(),
                );

                ActionResult::ok(lines.join("\n"))
            }
            Err(e) => ActionResult::fail(format!("Error searching skills: {}", e)),
        }
    }
}
