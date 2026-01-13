//! Action parsing implementations

use super::Bundle;
use crate::exceptions::{Result, SWEAgentError};
use regex::Regex;
use serde::{Deserialize, Serialize};

/// Trait for parsing model output into thought and action
pub trait ParseFunction: Send + Sync {
    fn parse(&self, output: &str, bundles: &[Bundle], strict: bool) -> Result<(String, String)>;
}

/// Thought and action parser (default)
pub struct ThoughtActionParser {
    thought_pattern: Regex,
    action_pattern: Regex,
}

impl ThoughtActionParser {
    pub fn new() -> Self {
        Self {
            thought_pattern: Regex::new(r"(?s)^(.*?)```").unwrap(),
            action_pattern: Regex::new(r"(?s)```(?:\w+)?\n?(.*?)```").unwrap(),
        }
    }
}

impl Default for ThoughtActionParser {
    fn default() -> Self {
        Self::new()
    }
}

impl ParseFunction for ThoughtActionParser {
    fn parse(&self, output: &str, _bundles: &[Bundle], strict: bool) -> Result<(String, String)> {
        // Extract thought (everything before the code block)
        let thought = self
            .thought_pattern
            .captures(output)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().trim().to_string())
            .unwrap_or_default();

        // Extract action (content of the code block)
        let action = self
            .action_pattern
            .captures(output)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().trim().to_string());

        match action {
            Some(a) => Ok((thought, a)),
            None => {
                if strict {
                    Err(SWEAgentError::FormatError(
                        "Could not find action in code block".to_string(),
                    ))
                } else {
                    Ok((output.to_string(), String::new()))
                }
            }
        }
    }
}

/// Action-only parser (no thought required)
pub struct ActionOnlyParser {
    action_pattern: Regex,
}

impl ActionOnlyParser {
    pub fn new() -> Self {
        Self {
            action_pattern: Regex::new(r"(?s)```(?:\w+)?\n?(.*?)```").unwrap(),
        }
    }
}

impl Default for ActionOnlyParser {
    fn default() -> Self {
        Self::new()
    }
}

impl ParseFunction for ActionOnlyParser {
    fn parse(&self, output: &str, _bundles: &[Bundle], strict: bool) -> Result<(String, String)> {
        let action = self
            .action_pattern
            .captures(output)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().trim().to_string());

        match action {
            Some(a) => Ok((String::new(), a)),
            None => {
                if strict {
                    Err(SWEAgentError::FormatError(
                        "Could not find action in code block".to_string(),
                    ))
                } else {
                    // Treat the entire output as the action
                    Ok((String::new(), output.trim().to_string()))
                }
            }
        }
    }
}

/// XML-style thought action parser
pub struct XmlThoughtActionParser {
    thought_pattern: Regex,
    action_pattern: Regex,
}

impl XmlThoughtActionParser {
    pub fn new() -> Self {
        Self {
            thought_pattern: Regex::new(r"(?s)<thought>(.*?)</thought>").unwrap(),
            action_pattern: Regex::new(r"(?s)<action>(.*?)</action>").unwrap(),
        }
    }
}

impl Default for XmlThoughtActionParser {
    fn default() -> Self {
        Self::new()
    }
}

impl ParseFunction for XmlThoughtActionParser {
    fn parse(&self, output: &str, _bundles: &[Bundle], strict: bool) -> Result<(String, String)> {
        let thought = self
            .thought_pattern
            .captures(output)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().trim().to_string())
            .unwrap_or_default();

        let action = self
            .action_pattern
            .captures(output)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().trim().to_string());

        match action {
            Some(a) => Ok((thought, a)),
            None => {
                if strict {
                    Err(SWEAgentError::FormatError(
                        "Could not find action in <action> tags".to_string(),
                    ))
                } else {
                    Ok((output.to_string(), String::new()))
                }
            }
        }
    }
}

/// Function calling parser for OpenAI-style function calls
pub struct FunctionCallingParser;

impl FunctionCallingParser {
    pub fn new() -> Self {
        Self
    }
}

impl Default for FunctionCallingParser {
    fn default() -> Self {
        Self::new()
    }
}

impl ParseFunction for FunctionCallingParser {
    fn parse(&self, output: &str, bundles: &[Bundle], strict: bool) -> Result<(String, String)> {
        // For function calling, we expect the output to be JSON or contain tool calls
        // This is a simplified implementation

        // Try to parse as JSON tool call
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(output) {
            if let Some(name) = json.get("name").and_then(|n| n.as_str()) {
                let args = json
                    .get("arguments")
                    .map(|a| a.to_string())
                    .unwrap_or_default();
                return Ok((String::new(), format!("{} {}", name, args)));
            }
        }

        // Fall back to thought action parsing
        ThoughtActionParser::new().parse(output, bundles, strict)
    }
}

/// JSON parser for structured output
pub struct JsonParser;

impl JsonParser {
    pub fn new() -> Self {
        Self
    }
}

impl Default for JsonParser {
    fn default() -> Self {
        Self::new()
    }
}

impl ParseFunction for JsonParser {
    fn parse(&self, output: &str, _bundles: &[Bundle], strict: bool) -> Result<(String, String)> {
        // Try to find JSON in the output
        let json_pattern = Regex::new(r"(?s)\{.*\}").unwrap();

        if let Some(json_match) = json_pattern.find(output) {
            let json_str = json_match.as_str();
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(json_str) {
                let thought = json
                    .get("thought")
                    .and_then(|t| t.as_str())
                    .unwrap_or("")
                    .to_string();
                let action = json
                    .get("action")
                    .and_then(|a| a.as_str())
                    .unwrap_or("")
                    .to_string();
                return Ok((thought, action));
            }
        }

        if strict {
            Err(SWEAgentError::FormatError(
                "Could not parse JSON output".to_string(),
            ))
        } else {
            Ok((output.to_string(), String::new()))
        }
    }
}

/// Identity parser that returns output as-is
pub struct IdentityParser;

impl IdentityParser {
    pub fn new() -> Self {
        Self
    }
}

impl Default for IdentityParser {
    fn default() -> Self {
        Self::new()
    }
}

impl ParseFunction for IdentityParser {
    fn parse(&self, output: &str, _bundles: &[Bundle], _strict: bool) -> Result<(String, String)> {
        Ok((String::new(), output.to_string()))
    }
}

/// Configuration for parse functions
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ParseFunctionConfig {
    #[default]
    ThoughtAction,
    ActionOnly,
    XmlThoughtAction,
    FunctionCalling,
    Json,
    Identity,
}

/// Create a parser from configuration
pub fn create_parser(config: &ParseFunctionConfig) -> Box<dyn ParseFunction> {
    match config {
        ParseFunctionConfig::ThoughtAction => Box::new(ThoughtActionParser::new()),
        ParseFunctionConfig::ActionOnly => Box::new(ActionOnlyParser::new()),
        ParseFunctionConfig::XmlThoughtAction => Box::new(XmlThoughtActionParser::new()),
        ParseFunctionConfig::FunctionCalling => Box::new(FunctionCallingParser::new()),
        ParseFunctionConfig::Json => Box::new(JsonParser::new()),
        ParseFunctionConfig::Identity => Box::new(IdentityParser::new()),
    }
}

/// Get a parser by name string
pub fn get_parser(name: &str) -> Box<dyn ParseFunction> {
    match name {
        "thought_action" => Box::new(ThoughtActionParser::new()),
        "action_only" => Box::new(ActionOnlyParser::new()),
        "xml_thought_action" => Box::new(XmlThoughtActionParser::new()),
        "function_calling" => Box::new(FunctionCallingParser::new()),
        "json" => Box::new(JsonParser::new()),
        "identity" => Box::new(IdentityParser::new()),
        _ => Box::new(ThoughtActionParser::new()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_thought_action_parser() {
        let parser = ThoughtActionParser::new();
        let output = "Let me check the file.\n\n```\ncat file.txt\n```";
        let (thought, action) = parser.parse(output, &[], true).unwrap();

        assert_eq!(thought, "Let me check the file.");
        assert_eq!(action, "cat file.txt");
    }

    #[test]
    fn test_action_only_parser() {
        let parser = ActionOnlyParser::new();
        let output = "```bash\nls -la\n```";
        let (thought, action) = parser.parse(output, &[], true).unwrap();

        assert_eq!(thought, "");
        assert_eq!(action, "ls -la");
    }

    #[test]
    fn test_xml_parser() {
        let parser = XmlThoughtActionParser::new();
        let output = "<thought>Checking files</thought><action>ls</action>";
        let (thought, action) = parser.parse(output, &[], true).unwrap();

        assert_eq!(thought, "Checking files");
        assert_eq!(action, "ls");
    }

    #[test]
    fn test_strict_mode_failure() {
        let parser = ThoughtActionParser::new();
        let output = "No code block here";
        let result = parser.parse(output, &[], true);

        assert!(result.is_err());
    }

    #[test]
    fn test_non_strict_mode() {
        let parser = ThoughtActionParser::new();
        let output = "No code block here";
        let (thought, action) = parser.parse(output, &[], false).unwrap();

        assert_eq!(thought, "No code block here");
        assert_eq!(action, "");
    }
}
