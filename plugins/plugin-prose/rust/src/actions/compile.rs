//! PROSE_COMPILE action for validating OpenProse programs

use async_trait::async_trait;
use regex::Regex;
use serde_json::{json, Value};
use std::path::Path;
use tracing::info;

use crate::generated::specs::require_action_spec;
use crate::services::ProseService;
use crate::{Action, ActionExample, ActionResult};

/// Extract a value from an XML tag
fn extract_xml_value(text: &str, tag: &str) -> Option<String> {
    let pattern = format!(r"(?i)<{}>([\s\S]*?)</{}>", tag, tag);
    let re = Regex::new(&pattern).ok()?;
    re.captures(text)
        .and_then(|caps| caps.get(1))
        .map(|m| m.as_str().trim().to_string())
}

/// Basic validation result
struct ValidationResult {
    valid: bool,
    errors: Vec<String>,
    warnings: Vec<String>,
    summary: String,
}

/// Perform basic validation on prose content
fn basic_validate(content: &str) -> ValidationResult {
    let mut errors = Vec::new();
    let mut warnings = Vec::new();
    let lower = content.to_lowercase();

    // Check for program block
    if !lower.contains("program") {
        errors.push("Missing program declaration".to_string());
    }

    // Check for balanced braces
    let open_braces = content.matches('{').count();
    let close_braces = content.matches('}').count();
    if open_braces != close_braces {
        errors.push(format!(
            "Unbalanced braces: {} open, {} close",
            open_braces, close_braces
        ));
    }

    // Check for session definition
    if !lower.contains("session") {
        warnings.push("No session defined - program may not have an entry point".to_string());
    }

    // Check for version
    if !lower.contains("version") {
        warnings.push("No version specified".to_string());
    }

    let valid = errors.is_empty();
    let summary = if valid {
        "Program is syntactically correct.".to_string()
    } else {
        "Program has validation errors.".to_string()
    };

    ValidationResult {
        valid,
        errors,
        warnings,
        summary,
    }
}

/// Action to validate an OpenProse program
pub struct ProseCompileAction {
    name: &'static str,
    description: &'static str,
    similes: Vec<&'static str>,
    examples: Vec<ActionExample>,
}

impl ProseCompileAction {
    pub fn new() -> Self {
        let spec = require_action_spec("PROSE_COMPILE");
        Self {
            name: spec.name,
            description: spec.description,
            similes: spec.similes.clone(),
            examples: spec
                .examples
                .iter()
                .map(|ex| ActionExample {
                    user_message: ex[0].1.to_string(),
                    agent_response: ex[1].1.to_string(),
                })
                .collect(),
        }
    }

    fn extract_file(&self, text: &str) -> Option<String> {
        if let Some(file) = extract_xml_value(text, "file") {
            return Some(file);
        }

        let lower = text.to_lowercase();

        // "prose compile <file>" or "prose validate <file>"
        let re = Regex::new(r"prose\s+(?:compile|validate)\s+(\S+)").ok()?;
        if let Some(caps) = re.captures(&lower) {
            return Some(caps.get(1)?.as_str().to_string());
        }

        // "check <file.prose>" or "validate <file.prose>"
        let re = Regex::new(r"(?:check|validate)\s+(\S+\.prose)").ok()?;
        if let Some(caps) = re.captures(&lower) {
            return Some(caps.get(1)?.as_str().to_string());
        }

        None
    }
}

impl Default for ProseCompileAction {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Action for ProseCompileAction {
    fn name(&self) -> &str {
        self.name
    }

    fn similes(&self) -> Vec<&str> {
        self.similes.clone()
    }

    fn description(&self) -> &str {
        self.description
    }

    async fn validate(&self, message: &Value, _state: &Value) -> bool {
        let content = message
            .get("content")
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("");

        let lower = content.to_lowercase();

        lower.contains("prose compile")
            || lower.contains("prose validate")
            || (lower.contains("check") && lower.contains(".prose"))
            || (lower.contains("validate") && lower.contains(".prose"))
    }

    async fn handler(
        &self,
        message: &Value,
        _state: &Value,
        service: Option<&mut ProseService>,
    ) -> ActionResult {
        let content = message
            .get("content")
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("");

        let file = match self.extract_file(content) {
            Some(f) => f,
            None => {
                return ActionResult {
                    success: false,
                    text: "Please specify a .prose file to validate. Example: `prose compile workflow.prose`".to_string(),
                    data: None,
                    error: Some("No file specified".to_string()),
                };
            }
        };

        let svc = match service {
            Some(s) => s,
            None => {
                return ActionResult {
                    success: false,
                    text: "Prose service not available".to_string(),
                    data: None,
                    error: Some("Service unavailable".to_string()),
                };
            }
        };

        let cwd = std::env::current_dir().unwrap().display().to_string();
        let file_path = if Path::new(&file).is_absolute() {
            file.clone()
        } else {
            Path::new(&cwd).join(&file).display().to_string()
        };

        if !svc.file_exists(&file_path).await {
            return ActionResult {
                success: false,
                text: format!("File not found: {}", file_path),
                data: None,
                error: Some("File not found".to_string()),
            };
        }

        let program_content = match svc.read_prose_file(&file_path).await {
            Ok(c) => c,
            Err(e) => {
                return ActionResult {
                    success: false,
                    text: format!("Failed to read file: {}", e),
                    data: None,
                    error: Some(e.to_string()),
                };
            }
        };

        let result = basic_validate(&program_content);

        info!("Validated {}: valid={}", file, result.valid);

        let mut parts = Vec::new();
        parts.push(format!("## Validation Results for {}\n", file));
        parts.push(format!(
            "**Status:** {}\n",
            if result.valid { "✓ Valid" } else { "✗ Invalid" }
        ));
        parts.push(format!("**Summary:** {}\n", result.summary));

        if !result.errors.is_empty() {
            parts.push("\n### Errors\n".to_string());
            for error in &result.errors {
                parts.push(format!("- ❌ {}", error));
            }
        }

        if !result.warnings.is_empty() {
            parts.push("\n### Warnings\n".to_string());
            for warning in &result.warnings {
                parts.push(format!("- ⚠️ {}", warning));
            }
        }

        if result.valid && result.errors.is_empty() && result.warnings.is_empty() {
            parts.push("\nNo issues found. Program is ready to run.".to_string());
        }

        ActionResult {
            success: true,
            text: parts.join("\n"),
            data: Some(json!({
                "valid": result.valid,
                "errors": result.errors,
                "warnings": result.warnings,
                "file": file,
            })),
            error: None,
        }
    }

    fn examples(&self) -> Vec<ActionExample> {
        self.examples.clone()
    }
}
