//! Simple template resolution for form-controlled prompts.
//!
//! Templates use `{{ key }}` syntax to substitute field values and
//! context variables into prompts, labels, and descriptions.

use crate::types::{FormControl, FormSession};
use regex::Regex;
use std::collections::HashMap;
use std::sync::LazyLock;

static TEMPLATE_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}").unwrap());

/// Build a map of template values from session fields and context.
pub fn build_template_values(session: &FormSession) -> HashMap<String, String> {
    let mut values = HashMap::new();

    // Add field values
    for (key, state) in &session.fields {
        if let Some(ref value) = state.value {
            match value {
                serde_json::Value::String(s) => {
                    values.insert(key.clone(), s.clone());
                }
                serde_json::Value::Number(n) => {
                    values.insert(key.clone(), n.to_string());
                }
                serde_json::Value::Bool(b) => {
                    values.insert(key.clone(), b.to_string());
                }
                _ => {}
            }
        }
    }

    // Add context values
    if let Some(ref context) = session.context {
        for (key, value) in context {
            match value {
                serde_json::Value::String(s) => {
                    values.insert(key.clone(), s.clone());
                }
                serde_json::Value::Number(n) => {
                    values.insert(key.clone(), n.to_string());
                }
                serde_json::Value::Bool(b) => {
                    values.insert(key.clone(), b.to_string());
                }
                _ => {}
            }
        }
    }

    values
}

/// Render a template string, replacing `{{ key }}` with values.
///
/// Unresolved placeholders are left as-is.
pub fn render_template(
    template: Option<&str>,
    values: &HashMap<String, String>,
) -> Option<String> {
    let tmpl = template?;

    let result = TEMPLATE_PATTERN.replace_all(tmpl, |caps: &regex::Captures| {
        let key = &caps[1];
        match values.get(key) {
            Some(v) => v.clone(),
            None => caps[0].to_string(),
        }
    });

    Some(result.into_owned())
}

/// Resolve template placeholders in a control's label, description,
/// askPrompt, example, extractHints, and nested fields.
pub fn resolve_control_templates(
    control: &FormControl,
    values: &HashMap<String, String>,
) -> FormControl {
    let mut resolved = control.clone();

    resolved.label = render_template(Some(&control.label), values).unwrap_or_default();

    resolved.description = control
        .description
        .as_deref()
        .and_then(|d| render_template(Some(d), values));

    resolved.ask_prompt = control
        .ask_prompt
        .as_deref()
        .and_then(|p| render_template(Some(p), values));

    resolved.example = control
        .example
        .as_deref()
        .and_then(|e| render_template(Some(e), values));

    resolved.extract_hints = control.extract_hints.as_ref().map(|hints| {
        hints
            .iter()
            .map(|h| render_template(Some(h), values).unwrap_or_else(|| h.clone()))
            .collect()
    });

    // Resolve option labels and descriptions
    resolved.options = control.options.as_ref().map(|opts| {
        opts.iter()
            .map(|opt| {
                let mut resolved_opt = opt.clone();
                resolved_opt.label =
                    render_template(Some(&opt.label), values).unwrap_or_else(|| opt.label.clone());
                resolved_opt.description = opt
                    .description
                    .as_deref()
                    .and_then(|d| render_template(Some(d), values));
                resolved_opt
            })
            .collect()
    });

    // Resolve nested fields
    resolved.fields = control.fields.as_ref().map(|fields| {
        fields
            .iter()
            .map(|f| resolve_control_templates(f, values))
            .collect()
    });

    resolved
}

// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{FieldState, FormControlOption, SessionEffort, SessionStatus};
    use serde_json::json;

    fn make_session() -> FormSession {
        let mut fields = HashMap::new();
        fields.insert(
            "name".to_string(),
            FieldState {
                value: Some(json!("Alice")),
                ..Default::default()
            },
        );
        fields.insert(
            "age".to_string(),
            FieldState {
                value: Some(json!(30)),
                ..Default::default()
            },
        );
        fields.insert(
            "active".to_string(),
            FieldState {
                value: Some(json!(true)),
                ..Default::default()
            },
        );

        let mut context = HashMap::new();
        context.insert("app_name".to_string(), json!("TestApp"));
        context.insert("version".to_string(), json!(2));

        FormSession {
            id: "s1".to_string(),
            form_id: "f1".to_string(),
            form_version: None,
            entity_id: "e1".to_string(),
            room_id: "r1".to_string(),
            status: SessionStatus::Active,
            fields,
            history: vec![],
            parent_session_id: None,
            context: Some(context),
            locale: None,
            last_asked_field: None,
            last_message_id: None,
            cancel_confirmation_asked: None,
            effort: SessionEffort {
                interaction_count: 0,
                time_spent_ms: 0,
                first_interaction_at: 0,
                last_interaction_at: 0,
            },
            expires_at: i64::MAX,
            expiration_warned: None,
            nudge_count: None,
            last_nudge_at: None,
            created_at: 0,
            updated_at: 0,
            submitted_at: None,
            meta: None,
        }
    }

    // ═══ BUILD TEMPLATE VALUES ═══

    #[test]
    fn test_build_values_from_fields() {
        let session = make_session();
        let values = build_template_values(&session);
        assert_eq!(values.get("name"), Some(&"Alice".to_string()));
    }

    #[test]
    fn test_build_values_number_field() {
        let session = make_session();
        let values = build_template_values(&session);
        assert_eq!(values.get("age"), Some(&"30".to_string()));
    }

    #[test]
    fn test_build_values_boolean_field() {
        let session = make_session();
        let values = build_template_values(&session);
        assert_eq!(values.get("active"), Some(&"true".to_string()));
    }

    #[test]
    fn test_build_values_from_context() {
        let session = make_session();
        let values = build_template_values(&session);
        assert_eq!(values.get("app_name"), Some(&"TestApp".to_string()));
    }

    #[test]
    fn test_build_values_context_number() {
        let session = make_session();
        let values = build_template_values(&session);
        assert_eq!(values.get("version"), Some(&"2".to_string()));
    }

    // ═══ RENDER TEMPLATE ═══

    #[test]
    fn test_render_substitution() {
        let mut values = HashMap::new();
        values.insert("name".to_string(), "Alice".to_string());
        let result = render_template(Some("Hello {{ name }}!"), &values);
        assert_eq!(result, Some("Hello Alice!".to_string()));
    }

    #[test]
    fn test_render_missing_value_preserved() {
        let values = HashMap::new();
        let result = render_template(Some("Hello {{ unknown }}!"), &values);
        assert_eq!(result, Some("Hello {{ unknown }}!".to_string()));
    }

    #[test]
    fn test_render_none_input() {
        let values = HashMap::new();
        assert_eq!(render_template(None, &values), None);
    }

    #[test]
    fn test_render_no_placeholders() {
        let values = HashMap::new();
        let result = render_template(Some("No placeholders here"), &values);
        assert_eq!(result, Some("No placeholders here".to_string()));
    }

    #[test]
    fn test_render_multiple_placeholders() {
        let mut values = HashMap::new();
        values.insert("first".to_string(), "Alice".to_string());
        values.insert("last".to_string(), "Smith".to_string());
        let result = render_template(Some("{{ first }} {{ last }}"), &values);
        assert_eq!(result, Some("Alice Smith".to_string()));
    }

    #[test]
    fn test_render_whitespace_variants() {
        let mut values = HashMap::new();
        values.insert("x".to_string(), "42".to_string());
        // Spaces around key
        assert_eq!(
            render_template(Some("{{x}}"), &values),
            Some("42".to_string())
        );
        assert_eq!(
            render_template(Some("{{ x }}"), &values),
            Some("42".to_string())
        );
        assert_eq!(
            render_template(Some("{{  x  }}"), &values),
            Some("42".to_string())
        );
    }

    // ═══ RESOLVE CONTROL TEMPLATES ═══

    #[test]
    fn test_resolve_label() {
        let mut values = HashMap::new();
        values.insert("currency".to_string(), "USD".to_string());
        let control = FormControl {
            key: "amount".to_string(),
            label: "Amount in {{ currency }}".to_string(),
            type_name: "number".to_string(),
            ..Default::default()
        };
        let resolved = resolve_control_templates(&control, &values);
        assert_eq!(resolved.label, "Amount in USD");
    }

    #[test]
    fn test_resolve_ask_prompt() {
        let mut values = HashMap::new();
        values.insert("name".to_string(), "Alice".to_string());
        let control = FormControl {
            key: "email".to_string(),
            label: "Email".to_string(),
            type_name: "email".to_string(),
            ask_prompt: Some("Hi {{ name }}, what's your email?".to_string()),
            ..Default::default()
        };
        let resolved = resolve_control_templates(&control, &values);
        assert_eq!(
            resolved.ask_prompt,
            Some("Hi Alice, what's your email?".to_string())
        );
    }

    #[test]
    fn test_resolve_description() {
        let mut values = HashMap::new();
        values.insert("app".to_string(), "TestApp".to_string());
        let control = FormControl {
            key: "email".to_string(),
            label: "Email".to_string(),
            type_name: "email".to_string(),
            description: Some("Email for {{ app }}".to_string()),
            ..Default::default()
        };
        let resolved = resolve_control_templates(&control, &values);
        assert_eq!(
            resolved.description,
            Some("Email for TestApp".to_string())
        );
    }

    #[test]
    fn test_resolve_nested_fields() {
        let mut values = HashMap::new();
        values.insert("currency".to_string(), "USD".to_string());
        let control = FormControl {
            key: "payment".to_string(),
            label: "Payment".to_string(),
            type_name: "text".to_string(),
            fields: Some(vec![FormControl {
                key: "amount".to_string(),
                label: "Amount in {{ currency }}".to_string(),
                type_name: "number".to_string(),
                ..Default::default()
            }]),
            ..Default::default()
        };
        let resolved = resolve_control_templates(&control, &values);
        assert_eq!(resolved.fields.unwrap()[0].label, "Amount in USD");
    }

    #[test]
    fn test_resolve_options() {
        let mut values = HashMap::new();
        values.insert("region".to_string(), "North".to_string());
        let control = FormControl {
            key: "plan".to_string(),
            label: "Plan".to_string(),
            type_name: "select".to_string(),
            options: Some(vec![FormControlOption {
                value: "basic".to_string(),
                label: "Basic ({{ region }})".to_string(),
                description: Some("For {{ region }} region".to_string()),
            }]),
            ..Default::default()
        };
        let resolved = resolve_control_templates(&control, &values);
        let opts = resolved.options.unwrap();
        assert_eq!(opts[0].label, "Basic (North)");
        assert_eq!(opts[0].description, Some("For North region".to_string()));
    }

    #[test]
    fn test_resolve_example() {
        let mut values = HashMap::new();
        values.insert("domain".to_string(), "example.com".to_string());
        let control = FormControl {
            key: "email".to_string(),
            label: "Email".to_string(),
            type_name: "email".to_string(),
            example: Some("user@{{ domain }}".to_string()),
            ..Default::default()
        };
        let resolved = resolve_control_templates(&control, &values);
        assert_eq!(resolved.example, Some("user@example.com".to_string()));
    }
}
