//! Field validation utilities for the Form Plugin.
//!
//! Validation happens at extraction time (instant feedback) and at submission
//! time (safety net). Custom type handlers can be registered for domain-specific
//! types like blockchain addresses or phone numbers.

use crate::types::{FormControl, ValidationResult};
use regex::Regex;
use serde_json::Value as JsonValue;
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

// ============================================================================
// TYPE HANDLER
// ============================================================================

/// Custom type handler for validation, parsing, and formatting.
///
/// Function-pointer based struct that mirrors the TypeScript TypeHandler
/// interface. All fields are optional; `None` means "use default behavior".
#[derive(Clone)]
pub struct TypeHandler {
    pub validate: Option<fn(&JsonValue, &FormControl) -> ValidationResult>,
    pub parse: Option<fn(&str) -> JsonValue>,
    pub format_value: Option<fn(&JsonValue) -> String>,
    pub extraction_prompt: Option<String>,
}

// ============================================================================
// TYPE HANDLER REGISTRY
// ============================================================================

static TYPE_HANDLERS: LazyLock<Mutex<HashMap<String, TypeHandler>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Register a custom type handler.
pub fn register_type_handler(type_name: &str, handler: TypeHandler) {
    TYPE_HANDLERS
        .lock()
        .unwrap()
        .insert(type_name.to_string(), handler);
}

/// Get a type handler (cloned).
pub fn get_type_handler(type_name: &str) -> Option<TypeHandler> {
    TYPE_HANDLERS.lock().unwrap().get(type_name).cloned()
}

/// Clear all type handlers (for testing).
pub fn clear_type_handlers() {
    TYPE_HANDLERS.lock().unwrap().clear();
}

// ============================================================================
// FIELD VALIDATION
// ============================================================================

/// Validate a value against a control's validation rules.
///
/// Order: required check -> empty optional pass -> custom handler -> type-specific.
pub fn validate_field(value: &JsonValue, control: &FormControl) -> ValidationResult {
    // 1. Required check
    if control.required {
        if value.is_null() || (value.is_string() && value.as_str().unwrap_or("").is_empty()) {
            return ValidationResult::err(format!(
                "{} is required",
                if control.label.is_empty() { &control.key } else { &control.label }
            ));
        }
    }

    // 2. Empty optional fields are valid
    if value.is_null() || (value.is_string() && value.as_str().unwrap_or("").is_empty()) {
        return ValidationResult::ok();
    }

    // 3. Custom type handler
    let handler = TYPE_HANDLERS.lock().unwrap().get(&control.type_name).cloned();
    if let Some(h) = handler {
        if let Some(validate_fn) = h.validate {
            let result = validate_fn(value, control);
            if !result.valid {
                return result;
            }
        }
    }

    // 4. Type-specific validation
    match control.type_name.as_str() {
        "email" => validate_email(value, control),
        "number" => validate_number(value, control),
        "boolean" => validate_boolean(value),
        "date" => validate_date(value, control),
        "select" => validate_select(value, control),
        "file" => validate_file(value, control),
        _ => validate_text(value, control),
    }
}

// ============================================================================
// TYPE-SPECIFIC VALIDATORS
// ============================================================================

fn field_label(control: &FormControl) -> &str {
    if control.label.is_empty() {
        &control.key
    } else {
        &control.label
    }
}

fn validate_text(value: &JsonValue, control: &FormControl) -> ValidationResult {
    let str_value = match value {
        JsonValue::String(s) => s.clone(),
        _ => value.to_string(),
    };

    // Pattern validation
    if let Some(ref pat) = control.pattern {
        if let Ok(re) = Regex::new(pat) {
            if !re.is_match(&str_value) {
                return ValidationResult::err(format!("{} has invalid format", field_label(control)));
            }
        }
    }

    // Length validation
    if let Some(min_len) = control.min_length {
        if str_value.len() < min_len {
            return ValidationResult::err(format!(
                "{} must be at least {} characters",
                field_label(control),
                min_len
            ));
        }
    }

    if let Some(max_len) = control.max_length {
        if str_value.len() > max_len {
            return ValidationResult::err(format!(
                "{} must be at most {} characters",
                field_label(control),
                max_len
            ));
        }
    }

    // Enum validation
    if let Some(ref enum_values) = control.enum_values {
        if !enum_values.is_empty() && !enum_values.contains(&str_value) {
            return ValidationResult::err(format!(
                "{} must be one of: {}",
                field_label(control),
                enum_values.join(", ")
            ));
        }
    }

    ValidationResult::ok()
}

fn validate_email(value: &JsonValue, control: &FormControl) -> ValidationResult {
    let str_value = match value {
        JsonValue::String(s) => s.clone(),
        _ => value.to_string(),
    };

    let email_re = Regex::new(r"^[^\s@]+@[^\s@]+\.[^\s@]+$").unwrap();
    if !email_re.is_match(&str_value) {
        return ValidationResult::err(format!(
            "{} must be a valid email address",
            field_label(control)
        ));
    }

    // Also apply text validation (pattern, length)
    validate_text(value, control)
}

fn validate_number(value: &JsonValue, control: &FormControl) -> ValidationResult {
    let num_value = match value {
        JsonValue::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        JsonValue::String(s) => {
            let cleaned = s.replace([',', '$'], "");
            cleaned.parse::<f64>().unwrap_or(f64::NAN)
        }
        _ => f64::NAN,
    };

    if num_value.is_nan() {
        return ValidationResult::err(format!("{} must be a number", field_label(control)));
    }

    if let Some(min) = control.min {
        if num_value < min {
            return ValidationResult::err(format!(
                "{} must be at least {}",
                field_label(control),
                min
            ));
        }
    }

    if let Some(max) = control.max {
        if num_value > max {
            return ValidationResult::err(format!(
                "{} must be at most {}",
                field_label(control),
                max
            ));
        }
    }

    ValidationResult::ok()
}

fn validate_boolean(value: &JsonValue) -> ValidationResult {
    if value.is_boolean() {
        return ValidationResult::ok();
    }

    let str_value = match value {
        JsonValue::String(s) => s.to_lowercase(),
        _ => value.to_string().to_lowercase(),
    };

    let valid = ["true", "false", "yes", "no", "1", "0", "on", "off"];
    if valid.contains(&str_value.as_str()) {
        ValidationResult::ok()
    } else {
        ValidationResult::err("Must be true or false")
    }
}

fn validate_date(value: &JsonValue, control: &FormControl) -> ValidationResult {
    let str_value = match value {
        JsonValue::String(s) => s.clone(),
        JsonValue::Number(n) => {
            // Timestamp
            if n.as_i64().is_some() {
                return ValidationResult::ok();
            }
            return ValidationResult::err(format!(
                "{} must be a valid date",
                field_label(control)
            ));
        }
        _ => {
            return ValidationResult::err(format!(
                "{} must be a valid date",
                field_label(control)
            ));
        }
    };

    // Try to parse ISO date or common formats
    if chrono::NaiveDate::parse_from_str(&str_value, "%Y-%m-%d").is_ok() {
        // Check min/max as timestamps if provided
        if let Some(min) = control.min {
            if let Ok(d) = chrono::NaiveDate::parse_from_str(&str_value, "%Y-%m-%d") {
                let ts = d.and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp_millis() as f64;
                if ts < min {
                    return ValidationResult::err(format!(
                        "{} is too early",
                        field_label(control)
                    ));
                }
            }
        }
        if let Some(max) = control.max {
            if let Ok(d) = chrono::NaiveDate::parse_from_str(&str_value, "%Y-%m-%d") {
                let ts = d.and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp_millis() as f64;
                if ts > max {
                    return ValidationResult::err(format!(
                        "{} is too late",
                        field_label(control)
                    ));
                }
            }
        }
        return ValidationResult::ok();
    }

    // Try ISO 8601 datetime
    if chrono::DateTime::parse_from_rfc3339(&str_value).is_ok() {
        return ValidationResult::ok();
    }

    // Try other common formats
    if chrono::NaiveDate::parse_from_str(&str_value, "%m/%d/%Y").is_ok() {
        return ValidationResult::ok();
    }

    ValidationResult::err(format!(
        "{} must be a valid date",
        field_label(control)
    ))
}

fn validate_select(value: &JsonValue, control: &FormControl) -> ValidationResult {
    if control.options.is_none() || control.options.as_ref().unwrap().is_empty() {
        return ValidationResult::ok();
    }

    let str_value = match value {
        JsonValue::String(s) => s.clone(),
        _ => value.to_string(),
    };

    let valid_values: Vec<&str> = control
        .options
        .as_ref()
        .unwrap()
        .iter()
        .map(|opt| opt.value.as_str())
        .collect();

    if !valid_values.contains(&str_value.as_str()) {
        return ValidationResult::err(format!(
            "{} must be one of the available options",
            field_label(control)
        ));
    }

    ValidationResult::ok()
}

fn validate_file(value: &JsonValue, control: &FormControl) -> ValidationResult {
    let file_opts = match &control.file {
        Some(f) => f,
        None => return ValidationResult::ok(),
    };

    let files = if value.is_array() {
        value.as_array().unwrap().clone()
    } else {
        vec![value.clone()]
    };

    // Check max files
    if let Some(max_files) = file_opts.max_files {
        if files.len() > max_files {
            return ValidationResult::err(format!("Maximum {} files allowed", max_files));
        }
    }

    for file in &files {
        if !file.is_object() {
            continue;
        }

        // Check file size
        if let Some(max_size) = file_opts.max_size {
            if let Some(size) = file.get("size").and_then(|s| s.as_u64()) {
                if size > max_size {
                    return ValidationResult::err(format!(
                        "File size exceeds maximum of {}",
                        format_bytes(max_size)
                    ));
                }
            }
        }

        // Check accepted MIME types
        if let Some(ref accept) = file_opts.accept {
            if let Some(mime) = file.get("mimeType").and_then(|m| m.as_str()) {
                let accepted = accept.iter().any(|pattern| matches_mime_type(mime, pattern));
                if !accepted {
                    return ValidationResult::err(format!("File type {} is not accepted", mime));
                }
            }
        }
    }

    ValidationResult::ok()
}

// ============================================================================
// HELPERS
// ============================================================================

/// Check if a MIME type matches a pattern (e.g., "image/*").
pub fn matches_mime_type(mime_type: &str, pattern: &str) -> bool {
    if pattern == "*/*" {
        return true;
    }
    if pattern.ends_with("/*") {
        let prefix = &pattern[..pattern.len() - 1]; // "image/" from "image/*"
        return mime_type.starts_with(prefix);
    }
    mime_type == pattern
}

fn format_bytes(bytes: u64) -> String {
    if bytes < 1024 {
        return format!("{} B", bytes);
    }
    if bytes < 1024 * 1024 {
        return format!("{:.1} KB", bytes as f64 / 1024.0);
    }
    if bytes < 1024 * 1024 * 1024 {
        return format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0));
    }
    format!("{:.1} GB", bytes as f64 / (1024.0 * 1024.0 * 1024.0))
}

// ============================================================================
// VALUE PARSING
// ============================================================================

/// Parse a string value to the appropriate type based on control type.
pub fn parse_value(value: &str, control: &FormControl) -> JsonValue {
    // Check custom handler first
    let handler = TYPE_HANDLERS.lock().unwrap().get(&control.type_name).cloned();
    if let Some(h) = handler {
        if let Some(parse_fn) = h.parse {
            return parse_fn(value);
        }
    }

    match control.type_name.as_str() {
        "number" => {
            let cleaned = value.replace([',', '$'], "");
            match cleaned.parse::<f64>() {
                Ok(n) => serde_json::json!(n),
                Err(_) => JsonValue::String(value.to_string()),
            }
        }
        "boolean" => {
            let lower = value.to_lowercase();
            let is_true = ["true", "yes", "1", "on"].contains(&lower.as_str());
            JsonValue::Bool(is_true)
        }
        "date" => {
            if let Ok(d) = chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d") {
                JsonValue::String(d.format("%Y-%m-%d").to_string())
            } else if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(value) {
                JsonValue::String(dt.format("%Y-%m-%d").to_string())
            } else {
                JsonValue::String(value.to_string())
            }
        }
        _ => JsonValue::String(value.to_string()),
    }
}

// ============================================================================
// VALUE FORMATTING
// ============================================================================

/// Format a value for display.
pub fn format_value(value: &JsonValue, control: &FormControl) -> String {
    if value.is_null() {
        return String::new();
    }

    // Check custom handler
    let handler = TYPE_HANDLERS.lock().unwrap().get(&control.type_name).cloned();
    if let Some(h) = handler {
        if let Some(fmt_fn) = h.format_value {
            return fmt_fn(value);
        }
    }

    // Sensitive fields masked
    if control.sensitive == Some(true) {
        let s = json_to_string(value);
        if s.len() > 8 {
            return format!("{}...{}", &s[..4], &s[s.len() - 4..]);
        }
        return "****".to_string();
    }

    match control.type_name.as_str() {
        "number" => {
            if let Some(n) = value.as_f64() {
                // Simple locale-like formatting
                if n.fract() == 0.0 {
                    format_with_commas(n as i64)
                } else {
                    format!("{}", n)
                }
            } else {
                json_to_string(value)
            }
        }
        "boolean" => {
            if value.as_bool().unwrap_or(false) {
                "Yes".to_string()
            } else {
                "No".to_string()
            }
        }
        "date" => json_to_string(value),
        "select" => {
            if let Some(ref opts) = control.options {
                let sv = json_to_string(value);
                if let Some(opt) = opts.iter().find(|o| o.value == sv) {
                    return opt.label.clone();
                }
            }
            json_to_string(value)
        }
        "file" => {
            if let Some(arr) = value.as_array() {
                arr.iter()
                    .map(|f| {
                        f.get("name")
                            .and_then(|n| n.as_str())
                            .unwrap_or("file")
                            .to_string()
                    })
                    .collect::<Vec<_>>()
                    .join(", ")
            } else if let Some(name) = value.get("name").and_then(|n| n.as_str()) {
                name.to_string()
            } else {
                "file".to_string()
            }
        }
        _ => json_to_string(value),
    }
}

fn json_to_string(value: &JsonValue) -> String {
    match value {
        JsonValue::String(s) => s.clone(),
        JsonValue::Null => String::new(),
        _ => value.to_string(),
    }
}

fn format_with_commas(n: i64) -> String {
    let s = n.abs().to_string();
    let bytes: Vec<u8> = s.bytes().collect();
    let mut result = String::new();
    for (i, &b) in bytes.iter().enumerate() {
        if i > 0 && (bytes.len() - i) % 3 == 0 {
            result.push(',');
        }
        result.push(b as char);
    }
    if n < 0 {
        format!("-{}", result)
    } else {
        result
    }
}

// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn text_control(key: &str) -> FormControl {
        FormControl {
            key: key.to_string(),
            label: key.to_string(),
            type_name: "text".to_string(),
            ..Default::default()
        }
    }

    fn email_control(key: &str) -> FormControl {
        FormControl {
            key: key.to_string(),
            label: key.to_string(),
            type_name: "email".to_string(),
            ..Default::default()
        }
    }

    fn number_control(key: &str) -> FormControl {
        FormControl {
            key: key.to_string(),
            label: key.to_string(),
            type_name: "number".to_string(),
            ..Default::default()
        }
    }

    fn bool_control(key: &str) -> FormControl {
        FormControl {
            key: key.to_string(),
            label: key.to_string(),
            type_name: "boolean".to_string(),
            ..Default::default()
        }
    }

    fn date_control(key: &str) -> FormControl {
        FormControl {
            key: key.to_string(),
            label: key.to_string(),
            type_name: "date".to_string(),
            ..Default::default()
        }
    }

    fn select_control(key: &str, opts: &[(&str, &str)]) -> FormControl {
        use crate::types::FormControlOption;
        FormControl {
            key: key.to_string(),
            label: key.to_string(),
            type_name: "select".to_string(),
            options: Some(
                opts.iter()
                    .map(|(v, l)| FormControlOption {
                        value: v.to_string(),
                        label: l.to_string(),
                        description: None,
                    })
                    .collect(),
            ),
            ..Default::default()
        }
    }

    fn file_control(key: &str) -> FormControl {
        use crate::types::FormControlFileOptions;
        FormControl {
            key: key.to_string(),
            label: key.to_string(),
            type_name: "file".to_string(),
            file: Some(FormControlFileOptions {
                accept: Some(vec!["image/*".to_string(), "application/pdf".to_string()]),
                max_size: Some(5 * 1024 * 1024),
                max_files: Some(3),
            }),
            ..Default::default()
        }
    }

    // ═══ REQUIRED / OPTIONAL ═══

    #[test]
    fn test_required_null_value() {
        let mut c = text_control("name");
        c.required = true;
        let r = validate_field(&JsonValue::Null, &c);
        assert!(!r.valid);
        assert!(r.error.unwrap().contains("required"));
    }

    #[test]
    fn test_required_empty_string() {
        let mut c = text_control("name");
        c.required = true;
        let r = validate_field(&json!(""), &c);
        assert!(!r.valid);
    }

    #[test]
    fn test_required_with_value() {
        let mut c = text_control("name");
        c.required = true;
        let r = validate_field(&json!("Alice"), &c);
        assert!(r.valid);
    }

    #[test]
    fn test_optional_null_is_valid() {
        let c = text_control("bio");
        let r = validate_field(&JsonValue::Null, &c);
        assert!(r.valid);
    }

    #[test]
    fn test_optional_empty_string_is_valid() {
        let c = text_control("bio");
        let r = validate_field(&json!(""), &c);
        assert!(r.valid);
    }

    // ═══ EMAIL ═══

    #[test]
    fn test_email_valid() {
        let c = email_control("email");
        assert!(validate_field(&json!("user@example.com"), &c).valid);
    }

    #[test]
    fn test_email_valid_subdomain() {
        let c = email_control("email");
        assert!(validate_field(&json!("user@mail.example.com"), &c).valid);
    }

    #[test]
    fn test_email_invalid_no_at() {
        let c = email_control("email");
        assert!(!validate_field(&json!("userexample.com"), &c).valid);
    }

    #[test]
    fn test_email_invalid_no_domain() {
        let c = email_control("email");
        assert!(!validate_field(&json!("user@"), &c).valid);
    }

    #[test]
    fn test_email_invalid_no_tld() {
        let c = email_control("email");
        assert!(!validate_field(&json!("user@example"), &c).valid);
    }

    #[test]
    fn test_email_invalid_space() {
        let c = email_control("email");
        assert!(!validate_field(&json!("user @example.com"), &c).valid);
    }

    // ═══ NUMBER ═══

    #[test]
    fn test_number_valid_integer() {
        let c = number_control("age");
        assert!(validate_field(&json!(25), &c).valid);
    }

    #[test]
    fn test_number_valid_float() {
        let c = number_control("price");
        assert!(validate_field(&json!(19.99), &c).valid);
    }

    #[test]
    fn test_number_valid_string() {
        let c = number_control("age");
        assert!(validate_field(&json!("42"), &c).valid);
    }

    #[test]
    fn test_number_valid_with_comma() {
        let c = number_control("salary");
        assert!(validate_field(&json!("1,234"), &c).valid);
    }

    #[test]
    fn test_number_valid_with_dollar() {
        let c = number_control("price");
        assert!(validate_field(&json!("$50"), &c).valid);
    }

    #[test]
    fn test_number_invalid_nan() {
        let c = number_control("age");
        assert!(!validate_field(&json!("not a number"), &c).valid);
    }

    #[test]
    fn test_number_below_min() {
        let mut c = number_control("age");
        c.min = Some(18.0);
        assert!(!validate_field(&json!(15), &c).valid);
    }

    #[test]
    fn test_number_above_max() {
        let mut c = number_control("age");
        c.max = Some(120.0);
        assert!(!validate_field(&json!(150), &c).valid);
    }

    #[test]
    fn test_number_at_min_boundary() {
        let mut c = number_control("age");
        c.min = Some(18.0);
        assert!(validate_field(&json!(18), &c).valid);
    }

    #[test]
    fn test_number_at_max_boundary() {
        let mut c = number_control("age");
        c.max = Some(120.0);
        assert!(validate_field(&json!(120), &c).valid);
    }

    #[test]
    fn test_number_with_min_and_max() {
        let mut c = number_control("rating");
        c.min = Some(1.0);
        c.max = Some(5.0);
        assert!(validate_field(&json!(3), &c).valid);
        assert!(!validate_field(&json!(0), &c).valid);
        assert!(!validate_field(&json!(6), &c).valid);
    }

    // ═══ BOOLEAN ═══

    #[test]
    fn test_boolean_true() {
        let c = bool_control("agree");
        assert!(validate_field(&json!(true), &c).valid);
    }

    #[test]
    fn test_boolean_false() {
        let c = bool_control("agree");
        assert!(validate_field(&json!(false), &c).valid);
    }

    #[test]
    fn test_boolean_yes() {
        let c = bool_control("agree");
        assert!(validate_field(&json!("yes"), &c).valid);
    }

    #[test]
    fn test_boolean_no() {
        let c = bool_control("agree");
        assert!(validate_field(&json!("no"), &c).valid);
    }

    #[test]
    fn test_boolean_one() {
        let c = bool_control("agree");
        assert!(validate_field(&json!("1"), &c).valid);
    }

    #[test]
    fn test_boolean_zero() {
        let c = bool_control("agree");
        assert!(validate_field(&json!("0"), &c).valid);
    }

    #[test]
    fn test_boolean_on() {
        let c = bool_control("agree");
        assert!(validate_field(&json!("on"), &c).valid);
    }

    #[test]
    fn test_boolean_off() {
        let c = bool_control("agree");
        assert!(validate_field(&json!("off"), &c).valid);
    }

    #[test]
    fn test_boolean_invalid() {
        let c = bool_control("agree");
        assert!(!validate_field(&json!("maybe"), &c).valid);
    }

    // ═══ DATE ═══

    #[test]
    fn test_date_valid_iso() {
        let c = date_control("birthday");
        assert!(validate_field(&json!("2024-01-15"), &c).valid);
    }

    #[test]
    fn test_date_valid_us_format() {
        let c = date_control("birthday");
        assert!(validate_field(&json!("12/25/2024"), &c).valid);
    }

    #[test]
    fn test_date_valid_timestamp() {
        let c = date_control("birthday");
        assert!(validate_field(&json!(1700000000000_i64), &c).valid);
    }

    #[test]
    fn test_date_invalid_string() {
        let c = date_control("birthday");
        assert!(!validate_field(&json!("not-a-date"), &c).valid);
    }

    #[test]
    fn test_date_invalid_type() {
        let c = date_control("birthday");
        assert!(!validate_field(&json!(true), &c).valid);
    }

    // ═══ SELECT ═══

    #[test]
    fn test_select_valid() {
        let c = select_control("color", &[("red", "Red"), ("blue", "Blue")]);
        assert!(validate_field(&json!("red"), &c).valid);
    }

    #[test]
    fn test_select_invalid() {
        let c = select_control("color", &[("red", "Red"), ("blue", "Blue")]);
        assert!(!validate_field(&json!("green"), &c).valid);
    }

    #[test]
    fn test_select_no_options_is_valid() {
        let mut c = text_control("choice");
        c.type_name = "select".to_string();
        c.options = None;
        assert!(validate_field(&json!("anything"), &c).valid);
    }

    #[test]
    fn test_select_empty_options_is_valid() {
        let mut c = text_control("choice");
        c.type_name = "select".to_string();
        c.options = Some(vec![]);
        assert!(validate_field(&json!("anything"), &c).valid);
    }

    // ═══ TEXT VALIDATION ═══

    #[test]
    fn test_text_valid() {
        let c = text_control("name");
        assert!(validate_field(&json!("Alice"), &c).valid);
    }

    #[test]
    fn test_text_pattern_match() {
        let mut c = text_control("code");
        c.pattern = Some("^[A-Z]{3}$".to_string());
        assert!(validate_field(&json!("ABC"), &c).valid);
    }

    #[test]
    fn test_text_pattern_fail() {
        let mut c = text_control("code");
        c.pattern = Some("^[A-Z]{3}$".to_string());
        assert!(!validate_field(&json!("abc"), &c).valid);
    }

    #[test]
    fn test_text_below_min_length() {
        let mut c = text_control("name");
        c.min_length = Some(3);
        assert!(!validate_field(&json!("AB"), &c).valid);
    }

    #[test]
    fn test_text_at_min_length() {
        let mut c = text_control("name");
        c.min_length = Some(3);
        assert!(validate_field(&json!("ABC"), &c).valid);
    }

    #[test]
    fn test_text_above_max_length() {
        let mut c = text_control("name");
        c.max_length = Some(5);
        assert!(!validate_field(&json!("ABCDEF"), &c).valid);
    }

    #[test]
    fn test_text_at_max_length() {
        let mut c = text_control("name");
        c.max_length = Some(5);
        assert!(validate_field(&json!("ABCDE"), &c).valid);
    }

    #[test]
    fn test_text_enum_valid() {
        let mut c = text_control("size");
        c.enum_values = Some(vec!["S".to_string(), "M".to_string(), "L".to_string()]);
        assert!(validate_field(&json!("M"), &c).valid);
    }

    #[test]
    fn test_text_enum_invalid() {
        let mut c = text_control("size");
        c.enum_values = Some(vec!["S".to_string(), "M".to_string(), "L".to_string()]);
        assert!(!validate_field(&json!("XL"), &c).valid);
    }

    // ═══ FILE ═══

    #[test]
    fn test_file_valid_single() {
        let c = file_control("avatar");
        let file = json!({"name": "photo.png", "mimeType": "image/png", "size": 1024});
        assert!(validate_field(&file, &c).valid);
    }

    #[test]
    fn test_file_valid_multiple() {
        let c = file_control("docs");
        let files = json!([
            {"name": "a.png", "mimeType": "image/png", "size": 1024},
            {"name": "b.pdf", "mimeType": "application/pdf", "size": 2048}
        ]);
        assert!(validate_field(&files, &c).valid);
    }

    #[test]
    fn test_file_exceed_max_files() {
        let c = file_control("docs");
        let files = json!([
            {"name": "a.png", "mimeType": "image/png", "size": 100},
            {"name": "b.png", "mimeType": "image/png", "size": 100},
            {"name": "c.png", "mimeType": "image/png", "size": 100},
            {"name": "d.png", "mimeType": "image/png", "size": 100}
        ]);
        assert!(!validate_field(&files, &c).valid);
    }

    #[test]
    fn test_file_exceed_max_size() {
        let c = file_control("avatar");
        let file = json!({"name": "big.png", "mimeType": "image/png", "size": 10_000_000});
        assert!(!validate_field(&file, &c).valid);
    }

    #[test]
    fn test_file_wrong_mime_type() {
        let c = file_control("avatar");
        let file = json!({"name": "file.exe", "mimeType": "application/octet-stream", "size": 1024});
        assert!(!validate_field(&file, &c).valid);
    }

    #[test]
    fn test_file_no_options_is_valid() {
        let mut c = text_control("attachment");
        c.type_name = "file".to_string();
        c.file = None;
        assert!(validate_field(&json!({"name": "file.txt"}), &c).valid);
    }

    // ═══ MIME MATCHING ═══

    #[test]
    fn test_mime_exact_match() {
        assert!(matches_mime_type("image/png", "image/png"));
    }

    #[test]
    fn test_mime_wildcard() {
        assert!(matches_mime_type("image/png", "image/*"));
        assert!(matches_mime_type("image/jpeg", "image/*"));
    }

    #[test]
    fn test_mime_universal() {
        assert!(matches_mime_type("application/pdf", "*/*"));
    }

    #[test]
    fn test_mime_no_match() {
        assert!(!matches_mime_type("application/pdf", "image/*"));
    }

    #[test]
    fn test_mime_exact_no_match() {
        assert!(!matches_mime_type("image/png", "image/jpeg"));
    }

    // ═══ TYPE HANDLER REGISTRY ═══

    #[test]
    fn test_register_and_get_handler() {
        clear_type_handlers();
        let handler = TypeHandler {
            validate: Some(|_v, _c| ValidationResult::ok()),
            parse: None,
            format_value: None,
            extraction_prompt: Some("a custom type".to_string()),
        };
        register_type_handler("custom", handler);
        assert!(get_type_handler("custom").is_some());
        assert!(get_type_handler("unknown").is_none());
        clear_type_handlers();
    }

    #[test]
    fn test_custom_handler_validate() {
        clear_type_handlers();
        let handler = TypeHandler {
            validate: Some(|v, _c| {
                let s = v.as_str().unwrap_or("");
                if s.starts_with("VALID") {
                    ValidationResult::ok()
                } else {
                    ValidationResult::err("Must start with VALID")
                }
            }),
            parse: None,
            format_value: None,
            extraction_prompt: None,
        };
        register_type_handler("custom_check", handler);

        let mut c = text_control("field");
        c.type_name = "custom_check".to_string();

        assert!(validate_field(&json!("VALID-123"), &c).valid);
        assert!(!validate_field(&json!("INVALID"), &c).valid);
        clear_type_handlers();
    }

    #[test]
    fn test_clear_handlers() {
        clear_type_handlers();
        register_type_handler(
            "temp",
            TypeHandler {
                validate: None,
                parse: None,
                format_value: None,
                extraction_prompt: None,
            },
        );
        assert!(get_type_handler("temp").is_some());
        clear_type_handlers();
        assert!(get_type_handler("temp").is_none());
    }

    // ═══ PARSE VALUE ═══

    #[test]
    fn test_parse_number() {
        let c = number_control("price");
        let v = parse_value("1,234.56", &c);
        assert_eq!(v.as_f64().unwrap(), 1234.56);
    }

    #[test]
    fn test_parse_number_dollar() {
        let c = number_control("price");
        let v = parse_value("$50", &c);
        assert_eq!(v.as_f64().unwrap(), 50.0);
    }

    #[test]
    fn test_parse_boolean_true() {
        let c = bool_control("agree");
        assert_eq!(parse_value("yes", &c), json!(true));
        assert_eq!(parse_value("true", &c), json!(true));
        assert_eq!(parse_value("1", &c), json!(true));
        assert_eq!(parse_value("on", &c), json!(true));
    }

    #[test]
    fn test_parse_boolean_false() {
        let c = bool_control("agree");
        assert_eq!(parse_value("no", &c), json!(false));
        assert_eq!(parse_value("false", &c), json!(false));
        assert_eq!(parse_value("0", &c), json!(false));
        assert_eq!(parse_value("off", &c), json!(false));
    }

    #[test]
    fn test_parse_date_iso() {
        let c = date_control("dob");
        let v = parse_value("2024-01-15", &c);
        assert_eq!(v.as_str().unwrap(), "2024-01-15");
    }

    #[test]
    fn test_parse_text() {
        let c = text_control("name");
        assert_eq!(parse_value("Alice", &c), json!("Alice"));
    }

    #[test]
    fn test_parse_email() {
        let c = email_control("email");
        assert_eq!(parse_value("a@b.com", &c), json!("a@b.com"));
    }

    #[test]
    fn test_parse_with_custom_handler() {
        clear_type_handlers();
        register_type_handler(
            "upper",
            TypeHandler {
                validate: None,
                parse: Some(|v| JsonValue::String(v.to_uppercase())),
                format_value: None,
                extraction_prompt: None,
            },
        );
        let mut c = text_control("code");
        c.type_name = "upper".to_string();
        assert_eq!(parse_value("abc", &c), json!("ABC"));
        clear_type_handlers();
    }

    // ═══ FORMAT VALUE ═══

    #[test]
    fn test_format_number() {
        let c = number_control("count");
        assert_eq!(format_value(&json!(1234), &c), "1,234");
    }

    #[test]
    fn test_format_number_float() {
        let c = number_control("price");
        assert_eq!(format_value(&json!(19.99), &c), "19.99");
    }

    #[test]
    fn test_format_boolean_true() {
        let c = bool_control("agree");
        assert_eq!(format_value(&json!(true), &c), "Yes");
    }

    #[test]
    fn test_format_boolean_false() {
        let c = bool_control("agree");
        assert_eq!(format_value(&json!(false), &c), "No");
    }

    #[test]
    fn test_format_select_shows_label() {
        let c = select_control("country", &[("US", "United States"), ("UK", "United Kingdom")]);
        assert_eq!(format_value(&json!("US"), &c), "United States");
    }

    #[test]
    fn test_format_select_unknown_value() {
        let c = select_control("country", &[("US", "United States")]);
        assert_eq!(format_value(&json!("XX"), &c), "XX");
    }

    #[test]
    fn test_format_sensitive_long() {
        let mut c = text_control("token");
        c.sensitive = Some(true);
        assert_eq!(
            format_value(&json!("abcdefghij"), &c),
            "abcd...ghij"
        );
    }

    #[test]
    fn test_format_sensitive_short() {
        let mut c = text_control("pin");
        c.sensitive = Some(true);
        assert_eq!(format_value(&json!("1234"), &c), "****");
    }

    #[test]
    fn test_format_null() {
        let c = text_control("name");
        assert_eq!(format_value(&JsonValue::Null, &c), "");
    }

    #[test]
    fn test_format_file_array() {
        let mut c = text_control("docs");
        c.type_name = "file".to_string();
        let v = json!([{"name": "a.pdf"}, {"name": "b.png"}]);
        assert_eq!(format_value(&v, &c), "a.pdf, b.png");
    }

    #[test]
    fn test_format_file_single() {
        let mut c = text_control("doc");
        c.type_name = "file".to_string();
        let v = json!({"name": "resume.pdf"});
        assert_eq!(format_value(&v, &c), "resume.pdf");
    }

    #[test]
    fn test_format_text() {
        let c = text_control("name");
        assert_eq!(format_value(&json!("Alice"), &c), "Alice");
    }

    #[test]
    fn test_format_with_custom_handler() {
        clear_type_handlers();
        register_type_handler(
            "shout",
            TypeHandler {
                validate: None,
                parse: None,
                format_value: Some(|v| {
                    v.as_str().unwrap_or("").to_uppercase()
                }),
                extraction_prompt: None,
            },
        );
        let mut c = text_control("msg");
        c.type_name = "shout".to_string();
        assert_eq!(format_value(&json!("hello"), &c), "HELLO");
        clear_type_handlers();
    }

    // ═══ EDGE CASES ═══

    #[test]
    fn test_unknown_type_uses_text_validation() {
        let mut c = text_control("custom");
        c.type_name = "unknown_type".to_string();
        c.min_length = Some(2);
        assert!(validate_field(&json!("abc"), &c).valid);
        assert!(!validate_field(&json!("a"), &c).valid);
    }

    #[test]
    fn test_required_with_zero_is_valid() {
        let mut c = number_control("count");
        c.required = true;
        assert!(validate_field(&json!(0), &c).valid);
    }

    #[test]
    fn test_required_with_false_is_valid() {
        let mut c = bool_control("agree");
        c.required = true;
        assert!(validate_field(&json!(false), &c).valid);
    }

    #[test]
    fn test_label_fallback_to_key() {
        let mut c = FormControl {
            key: "my_field".to_string(),
            label: String::new(),
            type_name: "text".to_string(),
            required: true,
            ..Default::default()
        };
        c.required = true;
        let r = validate_field(&JsonValue::Null, &c);
        assert!(r.error.unwrap().contains("my_field"));
    }

    #[test]
    fn test_number_negative_valid() {
        let c = number_control("balance");
        assert!(validate_field(&json!(-10), &c).valid);
    }

    #[test]
    fn test_format_bytes_helper() {
        assert_eq!(format_bytes(500), "500 B");
        assert_eq!(format_bytes(1024), "1.0 KB");
        assert_eq!(format_bytes(1048576), "1.0 MB");
        assert_eq!(format_bytes(1073741824), "1.0 GB");
    }
}
