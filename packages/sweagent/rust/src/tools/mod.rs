//! Tools module for SWE-agent
//!
//! This module provides tool handling, command parsing, and action processing.

pub mod bundle;
pub mod commands;
pub mod parsing;
pub mod registry;

pub use bundle::*;
pub use commands::*;
pub use parsing::*;
pub use registry::*;

use crate::environment::SWEEnv;
use crate::exceptions::Result;
use crate::types::ModelOutput;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Configuration for tool filtering
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ToolFilterConfig {
    #[serde(default)]
    pub blocklist_error_template: String,
    #[serde(default)]
    pub blocklist: Vec<String>,
    #[serde(default)]
    pub blocklist_standalone: Vec<String>,
    #[serde(default)]
    pub block_unless_regex: HashMap<String, String>,
}

/// Configuration for tools
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolConfig {
    #[serde(default)]
    pub commands: Vec<BundleConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parse_function: Option<ParseFunctionConfig>,
    #[serde(default = "default_execution_timeout")]
    pub execution_timeout: u64,
    #[serde(default = "default_max_consecutive_timeouts")]
    pub max_consecutive_execution_timeouts: usize,
    #[serde(default = "default_total_execution_timeout")]
    pub total_execution_timeout: u64,
    #[serde(default = "default_submit_command")]
    pub submit_command: String,
    #[serde(default)]
    pub use_function_calling: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filter: Option<ToolFilterConfig>,
    #[serde(default = "default_format_error_template")]
    pub format_error_template: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command_docs: Option<String>,
    #[serde(default)]
    pub env_variables: HashMap<String, String>,
}

fn default_execution_timeout() -> u64 {
    500
}

fn default_max_consecutive_timeouts() -> usize {
    3
}

fn default_total_execution_timeout() -> u64 {
    7200
}

fn default_submit_command() -> String {
    "submit".to_string()
}

fn default_format_error_template() -> String {
    "Invalid format. Please use the correct format for actions.".to_string()
}

impl Default for ToolConfig {
    fn default() -> Self {
        Self {
            commands: Vec::new(),
            parse_function: None,
            execution_timeout: default_execution_timeout(),
            max_consecutive_execution_timeouts: default_max_consecutive_timeouts(),
            total_execution_timeout: default_total_execution_timeout(),
            submit_command: default_submit_command(),
            use_function_calling: false,
            filter: None,
            format_error_template: default_format_error_template(),
            command_docs: None,
            env_variables: HashMap::new(),
        }
    }
}

/// Tool handler for managing agent tools
pub struct ToolHandler {
    pub config: ToolConfig,
    bundles: Vec<Bundle>,
    parser: Box<dyn ParseFunction>,
    multiline_commands: HashMap<String, String>,
}

impl ToolHandler {
    pub fn new(config: ToolConfig) -> Result<Self> {
        let bundles: Vec<Bundle> = config
            .commands
            .iter()
            .map(create_bundle)
            .collect::<Result<Vec<_>>>()?;

        let parser = config
            .parse_function
            .as_ref()
            .map(create_parser)
            .unwrap_or_else(|| Box::new(ThoughtActionParser::new()));

        let mut multiline_commands = HashMap::new();
        for bundle in &bundles {
            if let Some(ref end_name) = bundle.end_name {
                multiline_commands.insert(bundle.name.clone(), end_name.clone());
            }
        }

        Ok(Self {
            config,
            bundles,
            parser,
            multiline_commands,
        })
    }

    /// Install tools in the environment
    pub async fn install(&self, env: &mut SWEEnv) -> Result<()> {
        // Set environment variables
        if !self.config.env_variables.is_empty() {
            env.set_env_variables(self.config.env_variables.clone())
                .await?;
        }

        // Install each bundle
        let cwd = env.communicate("pwd", Some(5)).await?;

        for bundle in &self.bundles {
            if let Some(ref install_script) = bundle.install_script {
                env.communicate(install_script, Some(300)).await?;
            }
        }

        // Return to original directory
        env.communicate(&format!("cd {}", cwd.trim()), Some(5))
            .await?;

        Ok(())
    }

    /// Get current state from environment
    pub async fn get_state(&self, env: &SWEEnv) -> HashMap<String, String> {
        let mut state = HashMap::new();

        if let Some(cwd) = env.get_cwd() {
            state.insert("working_dir".to_string(), cwd);
        }

        let open_files = env.get_open_files();
        if !open_files.is_empty() {
            state.insert("open_files".to_string(), open_files.join(", "));
        }

        if let Ok(git_status) = env.get_git_status().await {
            state.insert("git_status".to_string(), git_status);
        }

        state
    }

    /// Parse thought and action from model output
    pub fn parse_actions(&self, output: &ModelOutput) -> Result<(String, String)> {
        self.parser.parse(&output.message, &self.bundles, true)
    }

    /// Check if an action should be blocked
    pub fn should_block_action(&self, action: &str) -> bool {
        let action = action.trim();
        if action.is_empty() {
            return false;
        }

        if let Some(ref filter) = self.config.filter {
            // Check blocklist
            for blocked in &filter.blocklist {
                if action.starts_with(blocked) {
                    return true;
                }
            }

            // Check standalone blocklist
            if filter.blocklist_standalone.contains(&action.to_string()) {
                return true;
            }

            // Check block unless regex
            let command_name = action.split_whitespace().next().unwrap_or("");
            if let Some(pattern) = filter.block_unless_regex.get(command_name) {
                if let Ok(re) = Regex::new(pattern) {
                    if !re.is_match(action) {
                        return true;
                    }
                }
            }
        }

        false
    }

    /// Check if observation contains submission command
    pub fn check_for_submission_cmd(&self, observation: &str) -> bool {
        observation.contains(crate::exceptions::tokens::SUBMISSION_MARKER)
    }

    /// Guard multiline input with heredoc syntax
    pub fn guard_multiline_input(&self, action: &str) -> String {
        for (cmd_name, end_name) in &self.multiline_commands {
            let pattern = format!(r"^{}\b", regex::escape(cmd_name));
            if let Ok(re) = Regex::new(&pattern) {
                if re.is_match(action) {
                    // Check if already has heredoc syntax
                    if !action.contains("<<") {
                        let lines: Vec<&str> = action.lines().collect();
                        if lines.len() > 1 {
                            let mut guarded_lines = Vec::new();
                            guarded_lines.push(format!("{} << '{}'", lines[0], end_name));
                            guarded_lines.extend(lines[1..].iter().map(|s| s.to_string()));
                            guarded_lines.push(end_name.clone());
                            return guarded_lines.join("\n");
                        }
                    }
                    break;
                }
            }
        }

        action.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tool_handler_creation() {
        let config = ToolConfig::default();
        let handler = ToolHandler::new(config).unwrap();
        assert!(!handler.should_block_action("ls -la"));
    }

    #[test]
    fn test_should_block_action() {
        let config = ToolConfig {
            filter: Some(ToolFilterConfig {
                blocklist: vec!["rm -rf".to_string()],
                blocklist_standalone: vec!["exit".to_string()],
                ..Default::default()
            }),
            ..Default::default()
        };
        let handler = ToolHandler::new(config).unwrap();

        assert!(handler.should_block_action("rm -rf /"));
        assert!(!handler.should_block_action("rm file.txt"));
    }

    #[test]
    fn test_guard_multiline_input() {
        let config = ToolConfig {
            commands: vec![BundleConfig {
                name: "edit".to_string(),
                end_name: Some("ENDEDIT".to_string()),
                ..Default::default()
            }],
            ..Default::default()
        };
        let handler = ToolHandler::new(config).unwrap();

        let multiline = "edit file.txt\nline1\nline2";
        let guarded = handler.guard_multiline_input(multiline);
        assert!(guarded.contains("<<"));
        assert!(guarded.contains("ENDEDIT"));
    }
}
