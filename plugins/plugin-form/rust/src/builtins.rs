//! Built-in control types for the Form Plugin.
//!
//! Seven standard types: text, number, email, boolean, select, date, file.
//! These are registered automatically and provide consistent validation,
//! parsing, formatting, and LLM extraction hints.

use crate::types::{FormControl, ValidationResult};
use crate::validation::{register_type_handler, TypeHandler};
use regex::Regex;
use serde_json::Value as JsonValue;
use std::sync::LazyLock;

// ============================================================================
// BUILTIN CONTROL TYPE DEFINITION
// ============================================================================

/// A built-in control type definition with validation, parsing, and formatting.
#[derive(Clone)]
pub struct ControlTypeDef {
    pub id: &'static str,
    pub builtin: bool,
    pub validate: Option<fn(&JsonValue, &FormControl) -> ValidationResult>,
    pub parse: Option<fn(&str) -> JsonValue>,
    pub format: Option<fn(&JsonValue) -> String>,
    pub extraction_prompt: &'static str,
}

// ============================================================================
// REGEX PATTERNS
// ============================================================================

static EMAIL_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[^\s@]+@[^\s@]+\.[^\s@]+$").unwrap());

static ISO_DATE_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\d{4}-\d{2}-\d{2}$").unwrap());

// ============================================================================
// VALIDATE FUNCTIONS
// ============================================================================

fn validate_text(value: &JsonValue, control: &FormControl) -> ValidationResult {
    if value.is_null() {
        return ValidationResult::ok();
    }
    let s = match value {
        JsonValue::String(s) => s.clone(),
        _ => value.to_string(),
    };

    if let Some(min_len) = control.min_length {
        if s.len() < min_len {
            return ValidationResult::err(format!(
                "Must be at least {} characters",
                min_len
            ));
        }
    }
    if let Some(max_len) = control.max_length {
        if s.len() > max_len {
            return ValidationResult::err(format!(
                "Must be at most {} characters",
                max_len
            ));
        }
    }
    if let Some(ref pat) = control.pattern {
        if let Ok(re) = Regex::new(pat) {
            if !re.is_match(&s) {
                return ValidationResult::err("Invalid format");
            }
        }
    }
    if let Some(ref enum_vals) = control.enum_values {
        if !enum_vals.contains(&s) {
            return ValidationResult::err(format!(
                "Must be one of: {}",
                enum_vals.join(", ")
            ));
        }
    }
    ValidationResult::ok()
}

fn validate_number(value: &JsonValue, control: &FormControl) -> ValidationResult {
    if value.is_null() || (value.is_string() && value.as_str().unwrap_or("").is_empty()) {
        return ValidationResult::ok();
    }
    let num = match value {
        JsonValue::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        JsonValue::String(s) => s.parse::<f64>().unwrap_or(f64::NAN),
        _ => f64::NAN,
    };
    if num.is_nan() {
        return ValidationResult::err("Must be a valid number");
    }
    if let Some(min) = control.min {
        if num < min {
            return ValidationResult::err(format!("Must be at least {}", min));
        }
    }
    if let Some(max) = control.max {
        if num > max {
            return ValidationResult::err(format!("Must be at most {}", max));
        }
    }
    ValidationResult::ok()
}

fn validate_email(value: &JsonValue, _control: &FormControl) -> ValidationResult {
    if value.is_null() || (value.is_string() && value.as_str().unwrap_or("").is_empty()) {
        return ValidationResult::ok();
    }
    let s = match value {
        JsonValue::String(s) => s.trim().to_lowercase(),
        _ => value.to_string(),
    };
    if !EMAIL_REGEX.is_match(&s) {
        return ValidationResult::err("Invalid email format");
    }
    ValidationResult::ok()
}

fn validate_boolean(value: &JsonValue, _control: &FormControl) -> ValidationResult {
    if value.is_null() {
        return ValidationResult::ok();
    }
    if value.is_boolean() {
        return ValidationResult::ok();
    }
    let s = match value {
        JsonValue::String(s) => s.to_lowercase(),
        _ => value.to_string().to_lowercase(),
    };
    let valid = ["true", "false", "yes", "no", "1", "0", "on", "off"];
    if !valid.contains(&s.as_str()) {
        return ValidationResult::err("Must be yes/no or true/false");
    }
    ValidationResult::ok()
}

fn validate_select(value: &JsonValue, control: &FormControl) -> ValidationResult {
    if value.is_null() || (value.is_string() && value.as_str().unwrap_or("").is_empty()) {
        return ValidationResult::ok();
    }
    let s = match value {
        JsonValue::String(s) => s.clone(),
        _ => value.to_string(),
    };
    if let Some(ref opts) = control.options {
        let valid: Vec<&str> = opts.iter().map(|o| o.value.as_str()).collect();
        if !valid.contains(&s.as_str()) {
            let labels: Vec<&str> = opts.iter().map(|o| o.label.as_str()).collect();
            return ValidationResult::err(format!("Must be one of: {}", labels.join(", ")));
        }
    }
    if let Some(ref enum_vals) = control.enum_values {
        if control.options.is_none() && !enum_vals.contains(&s) {
            return ValidationResult::err(format!(
                "Must be one of: {}",
                enum_vals.join(", ")
            ));
        }
    }
    ValidationResult::ok()
}

fn validate_date(value: &JsonValue, _control: &FormControl) -> ValidationResult {
    if value.is_null() || (value.is_string() && value.as_str().unwrap_or("").is_empty()) {
        return ValidationResult::ok();
    }
    let s = match value {
        JsonValue::String(s) => s.clone(),
        _ => return ValidationResult::ok(), // numbers are timestamps, valid
    };
    if !ISO_DATE_REGEX.is_match(&s) {
        return ValidationResult::err("Must be in YYYY-MM-DD format");
    }
    if chrono::NaiveDate::parse_from_str(&s, "%Y-%m-%d").is_err() {
        return ValidationResult::err("Invalid date");
    }
    ValidationResult::ok()
}

fn validate_file(value: &JsonValue, _control: &FormControl) -> ValidationResult {
    if value.is_null() {
        return ValidationResult::ok();
    }
    if value.is_object() || value.is_array() {
        return ValidationResult::ok();
    }
    ValidationResult::err("Invalid file data")
}

// ============================================================================
// PARSE FUNCTIONS
// ============================================================================

fn parse_text(value: &str) -> JsonValue {
    JsonValue::String(value.trim().to_string())
}

fn parse_number(value: &str) -> JsonValue {
    let cleaned = value.replace([',', '$', ' '], "");
    match cleaned.parse::<f64>() {
        Ok(n) => serde_json::json!(n),
        Err(_) => JsonValue::String(value.to_string()),
    }
}

fn parse_email(value: &str) -> JsonValue {
    JsonValue::String(value.trim().to_lowercase())
}

fn parse_boolean(value: &str) -> JsonValue {
    let lower = value.to_lowercase();
    JsonValue::Bool(["true", "yes", "1", "on"].contains(&lower.as_str()))
}

fn parse_select(value: &str) -> JsonValue {
    JsonValue::String(value.trim().to_string())
}

fn parse_date(value: &str) -> JsonValue {
    if let Ok(d) = chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d") {
        return JsonValue::String(d.format("%Y-%m-%d").to_string());
    }
    if let Ok(d) = chrono::NaiveDate::parse_from_str(value, "%m/%d/%Y") {
        return JsonValue::String(d.format("%Y-%m-%d").to_string());
    }
    JsonValue::String(value.trim().to_string())
}

// ============================================================================
// FORMAT FUNCTIONS
// ============================================================================

fn format_text(value: &JsonValue) -> String {
    match value {
        JsonValue::String(s) => s.clone(),
        JsonValue::Null => String::new(),
        _ => value.to_string(),
    }
}

fn format_number(value: &JsonValue) -> String {
    if value.is_null() {
        return String::new();
    }
    match value.as_f64() {
        Some(n) => {
            if n.fract() == 0.0 {
                format!("{}", n as i64)
            } else {
                format!("{}", n)
            }
        }
        None => value.to_string(),
    }
}

fn format_email(value: &JsonValue) -> String {
    match value {
        JsonValue::String(s) => s.to_lowercase(),
        JsonValue::Null => String::new(),
        _ => value.to_string(),
    }
}

fn format_boolean(value: &JsonValue) -> String {
    match value {
        JsonValue::Bool(true) => "Yes".to_string(),
        JsonValue::Bool(false) => "No".to_string(),
        JsonValue::Null => String::new(),
        _ => value.to_string(),
    }
}

fn format_select(value: &JsonValue) -> String {
    match value {
        JsonValue::String(s) => s.clone(),
        JsonValue::Null => String::new(),
        _ => value.to_string(),
    }
}

fn format_date(value: &JsonValue) -> String {
    if value.is_null() {
        return String::new();
    }
    match value {
        JsonValue::String(s) => {
            if let Ok(d) = chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d") {
                return d.format("%Y-%m-%d").to_string();
            }
            s.clone()
        }
        _ => value.to_string(),
    }
}

fn format_file(value: &JsonValue) -> String {
    if value.is_null() {
        return String::new();
    }
    if let Some(arr) = value.as_array() {
        return format!("{} file(s)", arr.len());
    }
    if value.is_object() {
        if let Some(name) = value.get("name").and_then(|n| n.as_str()) {
            return name.to_string();
        }
        return "File attached".to_string();
    }
    "File attached".to_string()
}

// ============================================================================
// BUILTIN TYPES
// ============================================================================

/// All 7 built-in control types.
pub fn builtin_types() -> Vec<ControlTypeDef> {
    vec![
        ControlTypeDef {
            id: "text",
            builtin: true,
            validate: Some(validate_text),
            parse: Some(parse_text),
            format: Some(format_text),
            extraction_prompt: "a text string",
        },
        ControlTypeDef {
            id: "number",
            builtin: true,
            validate: Some(validate_number),
            parse: Some(parse_number),
            format: Some(format_number),
            extraction_prompt: "a number (integer or decimal)",
        },
        ControlTypeDef {
            id: "email",
            builtin: true,
            validate: Some(validate_email),
            parse: Some(parse_email),
            format: Some(format_email),
            extraction_prompt: "an email address (e.g., user@example.com)",
        },
        ControlTypeDef {
            id: "boolean",
            builtin: true,
            validate: Some(validate_boolean),
            parse: Some(parse_boolean),
            format: Some(format_boolean),
            extraction_prompt: "a yes/no or true/false value",
        },
        ControlTypeDef {
            id: "select",
            builtin: true,
            validate: Some(validate_select),
            parse: Some(parse_select),
            format: Some(format_select),
            extraction_prompt: "one of the available options",
        },
        ControlTypeDef {
            id: "date",
            builtin: true,
            validate: Some(validate_date),
            parse: Some(parse_date),
            format: Some(format_date),
            extraction_prompt: "a date (preferably in YYYY-MM-DD format)",
        },
        ControlTypeDef {
            id: "file",
            builtin: true,
            validate: Some(validate_file),
            parse: None,
            format: Some(format_file),
            extraction_prompt: "a file attachment (upload required)",
        },
    ]
}

/// Get a built-in type by id.
pub fn get_builtin_type(id: &str) -> Option<ControlTypeDef> {
    builtin_types().into_iter().find(|t| t.id == id)
}

/// Check if a type id is a built-in type.
pub fn is_builtin_type(id: &str) -> bool {
    builtin_types().iter().any(|t| t.id == id)
}

/// Register all built-in types with the validation module's type handler registry.
pub fn register_builtin_types() {
    for bt in builtin_types() {
        let handler = TypeHandler {
            validate: bt.validate,
            parse: bt.parse,
            format_value: bt.format,
            extraction_prompt: Some(bt.extraction_prompt.to_string()),
        };
        register_type_handler(bt.id, handler);
    }
}

// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::FormControlOption;
    use serde_json::json;

    fn make_control(type_name: &str) -> FormControl {
        FormControl {
            key: "field".to_string(),
            label: "Field".to_string(),
            type_name: type_name.to_string(),
            ..Default::default()
        }
    }

    // ═══ TYPE EXISTENCE ═══

    #[test]
    fn test_text_type_exists() {
        assert!(get_builtin_type("text").is_some());
    }

    #[test]
    fn test_number_type_exists() {
        assert!(get_builtin_type("number").is_some());
    }

    #[test]
    fn test_email_type_exists() {
        assert!(get_builtin_type("email").is_some());
    }

    #[test]
    fn test_boolean_type_exists() {
        assert!(get_builtin_type("boolean").is_some());
    }

    #[test]
    fn test_select_type_exists() {
        assert!(get_builtin_type("select").is_some());
    }

    #[test]
    fn test_date_type_exists() {
        assert!(get_builtin_type("date").is_some());
    }

    #[test]
    fn test_file_type_exists() {
        assert!(get_builtin_type("file").is_some());
    }

    #[test]
    fn test_all_seven_types() {
        assert_eq!(builtin_types().len(), 7);
    }

    #[test]
    fn test_all_are_builtin() {
        for t in builtin_types() {
            assert!(t.builtin);
        }
    }

    // ═══ TEXT VALIDATION ═══

    #[test]
    fn test_text_valid() {
        let c = make_control("text");
        let r = validate_text(&json!("hello"), &c);
        assert!(r.valid);
    }

    #[test]
    fn test_text_null_valid() {
        let c = make_control("text");
        let r = validate_text(&JsonValue::Null, &c);
        assert!(r.valid);
    }

    #[test]
    fn test_text_min_length_fail() {
        let mut c = make_control("text");
        c.min_length = Some(5);
        let r = validate_text(&json!("hi"), &c);
        assert!(!r.valid);
    }

    #[test]
    fn test_text_max_length_fail() {
        let mut c = make_control("text");
        c.max_length = Some(3);
        let r = validate_text(&json!("hello"), &c);
        assert!(!r.valid);
    }

    #[test]
    fn test_text_pattern_fail() {
        let mut c = make_control("text");
        c.pattern = Some("^[A-Z]+$".to_string());
        let r = validate_text(&json!("abc"), &c);
        assert!(!r.valid);
    }

    #[test]
    fn test_text_enum_fail() {
        let mut c = make_control("text");
        c.enum_values = Some(vec!["a".into(), "b".into()]);
        let r = validate_text(&json!("c"), &c);
        assert!(!r.valid);
    }

    // ═══ NUMBER VALIDATION ═══

    #[test]
    fn test_number_valid() {
        let c = make_control("number");
        let r = validate_number(&json!(42), &c);
        assert!(r.valid);
    }

    #[test]
    fn test_number_nan() {
        let c = make_control("number");
        let r = validate_number(&json!("abc"), &c);
        assert!(!r.valid);
    }

    #[test]
    fn test_number_min_fail() {
        let mut c = make_control("number");
        c.min = Some(10.0);
        let r = validate_number(&json!(5), &c);
        assert!(!r.valid);
    }

    #[test]
    fn test_number_max_fail() {
        let mut c = make_control("number");
        c.max = Some(100.0);
        let r = validate_number(&json!(200), &c);
        assert!(!r.valid);
    }

    #[test]
    fn test_number_string_valid() {
        let c = make_control("number");
        let r = validate_number(&json!("42"), &c);
        assert!(r.valid);
    }

    // ═══ EMAIL VALIDATION ═══

    #[test]
    fn test_email_valid() {
        let c = make_control("email");
        let r = validate_email(&json!("user@example.com"), &c);
        assert!(r.valid);
    }

    #[test]
    fn test_email_invalid() {
        let c = make_control("email");
        let r = validate_email(&json!("not-an-email"), &c);
        assert!(!r.valid);
    }

    #[test]
    fn test_email_null_valid() {
        let c = make_control("email");
        let r = validate_email(&JsonValue::Null, &c);
        assert!(r.valid);
    }

    // ═══ BOOLEAN VALIDATION ═══

    #[test]
    fn test_boolean_true() {
        let c = make_control("boolean");
        let r = validate_boolean(&json!(true), &c);
        assert!(r.valid);
    }

    #[test]
    fn test_boolean_false() {
        let c = make_control("boolean");
        let r = validate_boolean(&json!(false), &c);
        assert!(r.valid);
    }

    #[test]
    fn test_boolean_yes_string() {
        let c = make_control("boolean");
        let r = validate_boolean(&json!("yes"), &c);
        assert!(r.valid);
    }

    #[test]
    fn test_boolean_invalid_string() {
        let c = make_control("boolean");
        let r = validate_boolean(&json!("maybe"), &c);
        assert!(!r.valid);
    }

    // ═══ SELECT VALIDATION ═══

    #[test]
    fn test_select_valid() {
        let mut c = make_control("select");
        c.options = Some(vec![FormControlOption {
            value: "a".into(),
            label: "A".into(),
            description: None,
        }]);
        let r = validate_select(&json!("a"), &c);
        assert!(r.valid);
    }

    #[test]
    fn test_select_invalid() {
        let mut c = make_control("select");
        c.options = Some(vec![FormControlOption {
            value: "a".into(),
            label: "A".into(),
            description: None,
        }]);
        let r = validate_select(&json!("b"), &c);
        assert!(!r.valid);
    }

    // ═══ DATE VALIDATION ═══

    #[test]
    fn test_date_valid_iso() {
        let c = make_control("date");
        let r = validate_date(&json!("2024-01-15"), &c);
        assert!(r.valid);
    }

    #[test]
    fn test_date_invalid_format() {
        let c = make_control("date");
        let r = validate_date(&json!("01/15/2024"), &c);
        assert!(!r.valid);
    }

    #[test]
    fn test_date_invalid_value() {
        let c = make_control("date");
        let r = validate_date(&json!("2024-13-45"), &c);
        assert!(!r.valid);
    }

    #[test]
    fn test_date_null_valid() {
        let c = make_control("date");
        let r = validate_date(&JsonValue::Null, &c);
        assert!(r.valid);
    }

    // ═══ FILE VALIDATION ═══

    #[test]
    fn test_file_valid_object() {
        let c = make_control("file");
        let r = validate_file(&json!({"name": "test.pdf"}), &c);
        assert!(r.valid);
    }

    #[test]
    fn test_file_invalid_string() {
        let c = make_control("file");
        let r = validate_file(&json!("not-a-file"), &c);
        assert!(!r.valid);
    }

    #[test]
    fn test_file_null_valid() {
        let c = make_control("file");
        let r = validate_file(&JsonValue::Null, &c);
        assert!(r.valid);
    }

    // ═══ PARSE FUNCTIONS ═══

    #[test]
    fn test_parse_text_trims() {
        assert_eq!(parse_text("  hello  "), json!("hello"));
    }

    #[test]
    fn test_parse_number_int() {
        assert_eq!(parse_number("42"), json!(42.0));
    }

    #[test]
    fn test_parse_number_with_formatting() {
        assert_eq!(parse_number("$1,234.56"), json!(1234.56));
    }

    #[test]
    fn test_parse_email_lowercase() {
        assert_eq!(parse_email("User@Example.COM"), json!("user@example.com"));
    }

    #[test]
    fn test_parse_boolean_yes() {
        assert_eq!(parse_boolean("yes"), json!(true));
    }

    #[test]
    fn test_parse_boolean_no() {
        assert_eq!(parse_boolean("no"), json!(false));
    }

    #[test]
    fn test_parse_date_iso() {
        assert_eq!(parse_date("2024-01-15"), json!("2024-01-15"));
    }

    #[test]
    fn test_parse_date_us_format() {
        assert_eq!(parse_date("01/15/2024"), json!("2024-01-15"));
    }

    // ═══ FORMAT FUNCTIONS ═══

    #[test]
    fn test_format_text_string() {
        assert_eq!(format_text(&json!("hello")), "hello");
    }

    #[test]
    fn test_format_number_int() {
        assert_eq!(format_number(&json!(42)), "42");
    }

    #[test]
    fn test_format_number_float() {
        assert_eq!(format_number(&json!(3.14)), "3.14");
    }

    #[test]
    fn test_format_email_lower() {
        assert_eq!(format_email(&json!("User@Example.COM")), "user@example.com");
    }

    #[test]
    fn test_format_boolean_yes() {
        assert_eq!(format_boolean(&json!(true)), "Yes");
    }

    #[test]
    fn test_format_boolean_no() {
        assert_eq!(format_boolean(&json!(false)), "No");
    }

    #[test]
    fn test_format_file_array() {
        assert_eq!(format_file(&json!([{"name": "a"}, {"name": "b"}])), "2 file(s)");
    }

    #[test]
    fn test_format_file_single() {
        assert_eq!(format_file(&json!({"name": "resume.pdf"})), "resume.pdf");
    }

    // ═══ LOOKUP FUNCTIONS ═══

    #[test]
    fn test_get_builtin_found() {
        assert!(get_builtin_type("text").is_some());
        assert_eq!(get_builtin_type("text").unwrap().id, "text");
    }

    #[test]
    fn test_get_builtin_not_found() {
        assert!(get_builtin_type("custom_widget").is_none());
    }

    #[test]
    fn test_is_builtin_true() {
        assert!(is_builtin_type("text"));
        assert!(is_builtin_type("number"));
        assert!(is_builtin_type("email"));
        assert!(is_builtin_type("boolean"));
        assert!(is_builtin_type("select"));
        assert!(is_builtin_type("date"));
        assert!(is_builtin_type("file"));
    }

    #[test]
    fn test_is_builtin_false() {
        assert!(!is_builtin_type("phone"));
        assert!(!is_builtin_type("address"));
        assert!(!is_builtin_type("solana_address"));
    }

    // ═══ REGISTRATION ═══

    #[test]
    fn test_register_builtin_types() {
        crate::validation::clear_type_handlers();
        register_builtin_types();
        assert!(crate::validation::get_type_handler("text").is_some());
        assert!(crate::validation::get_type_handler("number").is_some());
        assert!(crate::validation::get_type_handler("email").is_some());
        assert!(crate::validation::get_type_handler("boolean").is_some());
        assert!(crate::validation::get_type_handler("select").is_some());
        assert!(crate::validation::get_type_handler("date").is_some());
        assert!(crate::validation::get_type_handler("file").is_some());
        crate::validation::clear_type_handlers();
    }

    #[test]
    fn test_extraction_prompts() {
        for t in builtin_types() {
            assert!(!t.extraction_prompt.is_empty(), "Missing prompt for {}", t.id);
        }
    }
}
