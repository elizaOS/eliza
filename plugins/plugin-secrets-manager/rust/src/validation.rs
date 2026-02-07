//! Secret validation module.
//!
//! Provides validation strategies for common API keys and secret formats.

use once_cell::sync::Lazy;
use regex::Regex;
use std::collections::HashMap;
use std::sync::RwLock;

/// Result of secret validation.
#[derive(Debug, Clone)]
pub struct ValidationResult {
    /// Whether the value is valid.
    pub is_valid: bool,
    /// Error message if invalid.
    pub error: Option<String>,
}

impl ValidationResult {
    /// Create a valid result.
    pub fn valid() -> Self {
        Self {
            is_valid: true,
            error: None,
        }
    }

    /// Create an invalid result with an error message.
    pub fn invalid(error: impl Into<String>) -> Self {
        Self {
            is_valid: false,
            error: Some(error.into()),
        }
    }
}

/// Type alias for validation functions.
pub type ValidationFn = fn(&str, &str) -> ValidationResult;

/// Registry of custom validation strategies.
static CUSTOM_VALIDATORS: Lazy<RwLock<HashMap<String, ValidationFn>>> =
    Lazy::new(|| RwLock::new(HashMap::new()));

/// Register a custom validation strategy.
pub fn register_validator(name: &str, validator: ValidationFn) {
    let mut validators = CUSTOM_VALIDATORS.write().unwrap();
    validators.insert(name.to_string(), validator);
}

/// Get a custom validation strategy.
pub fn get_validator(name: &str) -> Option<ValidationFn> {
    let validators = CUSTOM_VALIDATORS.read().unwrap();
    validators.get(name).copied()
}

/// Validate a secret value.
pub fn validate_secret(key: &str, value: &str, method: Option<&str>) -> ValidationResult {
    let method = match method {
        Some(m) if !m.is_empty() && m != "none" => m,
        _ => return ValidationResult::valid(),
    };

    // Check custom validators first
    if let Some(validator) = get_validator(method) {
        return validator(key, value);
    }

    // Built-in validators
    match method {
        "openai" => validate_openai(key, value),
        "anthropic" => validate_anthropic(key, value),
        "groq" => validate_groq(key, value),
        "google" | "gemini" => validate_google(key, value),
        "mistral" => validate_mistral(key, value),
        "cohere" => validate_cohere(key, value),
        "url" => validate_url(key, value),
        "discord" => validate_discord(key, value),
        "telegram" => validate_telegram(key, value),
        "github" => validate_github(key, value),
        "non_empty" => validate_non_empty(key, value),
        "auto" => {
            if let Some(inferred) = infer_validation_strategy(key) {
                validate_secret(key, value, Some(&inferred))
            } else {
                ValidationResult::valid()
            }
        }
        _ => ValidationResult::valid(),
    }
}

/// Infer validation strategy from key name.
pub fn infer_validation_strategy(key: &str) -> Option<String> {
    let key_lower = key.to_lowercase();

    if key_lower.contains("openai") {
        return Some("openai".to_string());
    }
    if key_lower.contains("anthropic") || key_lower.contains("claude") {
        return Some("anthropic".to_string());
    }
    if key_lower.contains("groq") {
        return Some("groq".to_string());
    }
    if key_lower.contains("google") || key_lower.contains("gemini") {
        return Some("google".to_string());
    }
    if key_lower.contains("mistral") {
        return Some("mistral".to_string());
    }
    if key_lower.contains("cohere") {
        return Some("cohere".to_string());
    }
    if key_lower.contains("url") || key_lower.contains("endpoint") {
        return Some("url".to_string());
    }
    if key_lower.contains("discord") {
        return Some("discord".to_string());
    }
    if key_lower.contains("telegram") {
        return Some("telegram".to_string());
    }
    if key_lower.contains("github") {
        return Some("github".to_string());
    }

    None
}

// ============================================================================
// Built-in Validators
// ============================================================================

/// Validate OpenAI API key format.
pub fn validate_openai(_key: &str, value: &str) -> ValidationResult {
    if value.is_empty() {
        return ValidationResult::invalid("Empty value");
    }

    if !value.starts_with("sk-") {
        return ValidationResult::invalid("OpenAI keys must start with 'sk-'");
    }

    if value.len() < 20 {
        return ValidationResult::invalid("OpenAI key too short");
    }

    static PATTERN: Lazy<Regex> = Lazy::new(|| Regex::new(r"^sk-[a-zA-Z0-9_-]+$").unwrap());
    if !PATTERN.is_match(value) {
        return ValidationResult::invalid("Invalid characters in OpenAI key");
    }

    ValidationResult::valid()
}

/// Validate Anthropic API key format.
pub fn validate_anthropic(_key: &str, value: &str) -> ValidationResult {
    if value.is_empty() {
        return ValidationResult::invalid("Empty value");
    }

    if !value.starts_with("sk-ant-") {
        return ValidationResult::invalid("Anthropic keys must start with 'sk-ant-'");
    }

    if value.len() < 20 {
        return ValidationResult::invalid("Anthropic key too short");
    }

    ValidationResult::valid()
}

/// Validate Groq API key format.
pub fn validate_groq(_key: &str, value: &str) -> ValidationResult {
    if value.is_empty() {
        return ValidationResult::invalid("Empty value");
    }

    if !value.starts_with("gsk_") {
        return ValidationResult::invalid("Groq keys must start with 'gsk_'");
    }

    if value.len() < 20 {
        return ValidationResult::invalid("Groq key too short");
    }

    ValidationResult::valid()
}

/// Validate Google/Gemini API key format.
pub fn validate_google(_key: &str, value: &str) -> ValidationResult {
    if value.is_empty() {
        return ValidationResult::invalid("Empty value");
    }

    if value.len() < 30 {
        return ValidationResult::invalid("Google API key too short");
    }

    static PATTERN: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[a-zA-Z0-9_-]+$").unwrap());
    if !PATTERN.is_match(value) {
        return ValidationResult::invalid("Invalid characters in Google API key");
    }

    ValidationResult::valid()
}

/// Validate Mistral API key format.
pub fn validate_mistral(_key: &str, value: &str) -> ValidationResult {
    if value.is_empty() {
        return ValidationResult::invalid("Empty value");
    }

    if value.len() < 20 {
        return ValidationResult::invalid("Mistral key too short");
    }

    ValidationResult::valid()
}

/// Validate Cohere API key format.
pub fn validate_cohere(_key: &str, value: &str) -> ValidationResult {
    if value.is_empty() {
        return ValidationResult::invalid("Empty value");
    }

    if value.len() < 20 {
        return ValidationResult::invalid("Cohere key too short");
    }

    static PATTERN: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[a-zA-Z0-9_-]+$").unwrap());
    if !PATTERN.is_match(value) {
        return ValidationResult::invalid("Invalid characters in Cohere key");
    }

    ValidationResult::valid()
}

/// Validate URL format.
pub fn validate_url(_key: &str, value: &str) -> ValidationResult {
    if value.is_empty() {
        return ValidationResult::invalid("Empty value");
    }

    static PATTERN: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"(?i)^https?://[^\s/$.?#].[^\s]*$").unwrap());
    if !PATTERN.is_match(value) {
        return ValidationResult::invalid("Invalid URL format");
    }

    ValidationResult::valid()
}

/// Validate Discord bot token format.
pub fn validate_discord(_key: &str, value: &str) -> ValidationResult {
    if value.is_empty() {
        return ValidationResult::invalid("Empty value");
    }

    let parts: Vec<&str> = value.split('.').collect();
    if parts.len() != 3 {
        return ValidationResult::invalid("Discord token must have 3 parts separated by dots");
    }

    if value.len() < 50 {
        return ValidationResult::invalid("Discord token too short");
    }

    ValidationResult::valid()
}

/// Validate Telegram bot token format.
pub fn validate_telegram(_key: &str, value: &str) -> ValidationResult {
    if value.is_empty() {
        return ValidationResult::invalid("Empty value");
    }

    static PATTERN: Lazy<Regex> = Lazy::new(|| Regex::new(r"^\d+:[A-Za-z0-9_-]+$").unwrap());
    if !PATTERN.is_match(value) {
        return ValidationResult::invalid("Invalid Telegram token format");
    }

    ValidationResult::valid()
}

/// Validate GitHub token format.
pub fn validate_github(_key: &str, value: &str) -> ValidationResult {
    if value.is_empty() {
        return ValidationResult::invalid("Empty value");
    }

    let valid_prefixes = ["ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_"];
    if !valid_prefixes.iter().any(|p| value.starts_with(p)) {
        return ValidationResult::invalid(
            "GitHub token must start with ghp_, gho_, ghu_, ghs_, ghr_, or github_pat_",
        );
    }

    if value.len() < 30 {
        return ValidationResult::invalid("GitHub token too short");
    }

    ValidationResult::valid()
}

/// Simple non-empty validation.
pub fn validate_non_empty(_key: &str, value: &str) -> ValidationResult {
    if value.is_empty() || value.trim().is_empty() {
        return ValidationResult::invalid("Value cannot be empty");
    }
    ValidationResult::valid()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_openai() {
        assert!(validate_openai("", "sk-abc123def456ghi789jkl").is_valid);
        assert!(!validate_openai("", "").is_valid);
        assert!(!validate_openai("", "invalid-key").is_valid);
        assert!(!validate_openai("", "sk-abc").is_valid); // Too short
    }

    #[test]
    fn test_validate_anthropic() {
        assert!(validate_anthropic("", "sk-ant-abc123def456ghi789").is_valid);
        assert!(!validate_anthropic("", "").is_valid);
        assert!(!validate_anthropic("", "sk-abc123").is_valid);
    }

    #[test]
    fn test_validate_groq() {
        assert!(validate_groq("", "gsk_abc123def456ghi789jkl").is_valid);
        assert!(!validate_groq("", "").is_valid);
        assert!(!validate_groq("", "invalid").is_valid);
    }

    #[test]
    fn test_validate_url() {
        assert!(validate_url("", "https://example.com").is_valid);
        assert!(validate_url("", "http://localhost:8080/api").is_valid);
        assert!(!validate_url("", "").is_valid);
        assert!(!validate_url("", "not-a-url").is_valid);
    }

    #[test]
    fn test_validate_discord() {
        assert!(validate_discord("", "MTExMTExMTExMTExMTExMTEx.XXXXXX.XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX").is_valid);
        assert!(!validate_discord("", "invalid").is_valid);
    }

    #[test]
    fn test_validate_telegram() {
        assert!(validate_telegram("", "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ").is_valid);
        assert!(!validate_telegram("", "invalid").is_valid);
    }

    #[test]
    fn test_validate_github() {
        assert!(validate_github("", "ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx").is_valid);
        assert!(validate_github("", "github_pat_xxxxxxxxxxxxxxxxxxxx").is_valid);
        assert!(!validate_github("", "invalid").is_valid);
    }

    #[test]
    fn test_infer_validation_strategy() {
        assert_eq!(infer_validation_strategy("OPENAI_API_KEY"), Some("openai".to_string()));
        assert_eq!(infer_validation_strategy("ANTHROPIC_API_KEY"), Some("anthropic".to_string()));
        assert_eq!(infer_validation_strategy("GROQ_API_KEY"), Some("groq".to_string()));
        assert_eq!(infer_validation_strategy("DATABASE_URL"), Some("url".to_string()));
        assert_eq!(infer_validation_strategy("RANDOM_KEY"), None);
    }

    #[test]
    fn test_validate_secret_auto() {
        // Auto should infer OpenAI validation
        let result = validate_secret("OPENAI_API_KEY", "sk-abc123def456ghi789jkl", Some("auto"));
        assert!(result.is_valid);

        let result = validate_secret("OPENAI_API_KEY", "invalid", Some("auto"));
        assert!(!result.is_valid);
    }

    #[test]
    fn test_custom_validator() {
        fn custom_validator(_key: &str, value: &str) -> ValidationResult {
            if value.starts_with("custom_") {
                ValidationResult::valid()
            } else {
                ValidationResult::invalid("Must start with custom_")
            }
        }

        register_validator("custom", custom_validator);

        let result = validate_secret("key", "custom_value", Some("custom"));
        assert!(result.is_valid);

        let result = validate_secret("key", "invalid_value", Some("custom"));
        assert!(!result.is_valid);
    }
}
