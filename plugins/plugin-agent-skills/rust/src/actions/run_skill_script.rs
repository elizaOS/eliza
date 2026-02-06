//! Run Skill Script Action
//!
//! Executes scripts bundled with installed skills.
//! Scripts run via subprocess without loading their contents into context.

use std::process::Command;

use crate::service::AgentSkillsService;
use super::ActionResult;

/// Action that executes a skill script.
pub struct RunSkillScriptAction;

impl RunSkillScriptAction {
    /// Action name constant.
    pub const NAME: &'static str = "RUN_SKILL_SCRIPT";

    /// Action description.
    pub const DESCRIPTION: &'static str =
        "Execute a script bundled with an installed skill. Provide skill slug and script name.";

    /// Similar action names.
    pub const SIMILES: &[&'static str] = &["EXECUTE_SKILL_SCRIPT", "SKILL_SCRIPT"];

    /// Execute the run skill script action.
    pub fn handle(
        service: &AgentSkillsService,
        skill_slug: &str,
        script_name: &str,
        args: &[String],
    ) -> ActionResult {
        if skill_slug.is_empty() || script_name.is_empty() {
            return ActionResult::fail("Both skillSlug and script are required");
        }

        let script_path = match service.get_script_path(skill_slug, script_name) {
            Some(path) => path,
            None => {
                return ActionResult::fail(format!(
                    "Script \"{}\" not found in skill \"{}\"",
                    script_name, skill_slug
                ))
            }
        };

        let ext = std::path::Path::new(&script_path)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("");

        let (cmd, cmd_args) = match ext {
            "py" => ("python3", vec![script_path.clone()]),
            "sh" => ("bash", vec![script_path.clone()]),
            "js" => ("node", vec![script_path.clone()]),
            _ => (script_path.as_str(), Vec::new()),
        };

        let mut full_args = cmd_args;
        full_args.extend(args.iter().cloned());

        match Command::new(cmd).args(&full_args).output() {
            Ok(output) => {
                let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

                if output.status.success() {
                    ActionResult::ok(format!("Script executed successfully:\n```\n{}\n```", stdout))
                } else {
                    ActionResult::fail(format!("Script failed:\n```\n{}\n```", stderr))
                }
            }
            Err(e) => ActionResult::fail(format!("Failed to execute script: {}", e)),
        }
    }
}
