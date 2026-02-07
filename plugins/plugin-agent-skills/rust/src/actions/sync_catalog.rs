//! Sync Catalog Action
//!
//! Manually trigger a sync of the skill catalog from the registry.

use crate::service::AgentSkillsService;
use super::ActionResult;

/// Action that syncs the skill catalog.
pub struct SyncCatalogAction;

impl SyncCatalogAction {
    /// Action name constant.
    pub const NAME: &'static str = "SYNC_SKILL_CATALOG";

    /// Action description.
    pub const DESCRIPTION: &'static str =
        "Sync the skill catalog from the registry to discover new skills.";

    /// Similar action names.
    pub const SIMILES: &[&'static str] = &["REFRESH_SKILLS", "UPDATE_CATALOG"];

    /// Execute the sync catalog action.
    pub async fn handle(service: &mut AgentSkillsService) -> ActionResult {
        match service.sync_catalog().await {
            Ok((added, total)) => ActionResult::ok(format!(
                "Skill catalog synced successfully.\n- Total skills: {}\n- New skills: {}",
                total, added
            )),
            Err(e) => ActionResult::fail(format!("Error syncing catalog: {}", e)),
        }
    }
}
