//! Hook mapping resolution and template rendering.
//!
//! Mappings define how arbitrary webhook payloads are transformed into
//! wake or agent actions.

use regex::Regex;
use serde_json::Value;
use std::sync::LazyLock;

use crate::types::{AppliedMapping, HookAction, HookMapping, WakeMode};

/// Pre-compiled regex for `{{placeholder}}` patterns.
static PLACEHOLDER_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\{\{([^}]+)\}\}").unwrap());

/// Pre-compiled regex for normalising array indices (`[n]` → `.n`).
static ARRAY_INDEX_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[(\d+)\]").unwrap());

// ── Path resolution ──────────────────────────────────────────────────────

/// Resolve a dot-separated path (with optional `[n]` array indices)
/// against a [`serde_json::Value`].
///
/// `messages[0].from` is normalised to `messages.0.from` and each segment
/// is resolved in turn.  Returns `None` when the path cannot be fully
/// resolved.
fn resolve_path<'a>(obj: &'a Value, path: &str) -> Option<&'a Value> {
    let normalised = ARRAY_INDEX_RE.replace_all(path, ".$1");
    let parts: Vec<&str> = normalised.split('.').collect();

    let mut current = obj;
    for part in &parts {
        match current {
            Value::Object(map) => {
                current = map.get(*part)?;
            }
            Value::Array(arr) => {
                let idx: usize = part.parse().ok()?;
                current = arr.get(idx)?;
            }
            _ => return None,
        }
    }
    Some(current)
}

// ── Template rendering ───────────────────────────────────────────────────

/// Render a Mustache-style template against a JSON data object.
///
/// Supported placeholder forms:
/// - `{{field}}`          – simple top-level field
/// - `{{nested.field}}`   – dot-separated nested access
/// - `{{array[0].field}}` – array index access
///
/// Unresolved placeholders are left as-is.
pub fn render_template(template: &str, data: &Value) -> String {
    PLACEHOLDER_RE
        .replace_all(template, |caps: &regex::Captures| {
            let expr = &caps[1];
            let path = expr.trim();
            match resolve_path(data, path) {
                None => format!("{{{{{expr}}}}}"),
                Some(Value::Null) => format!("{{{{{expr}}}}}"),
                Some(Value::String(s)) => s.clone(),
                Some(Value::Number(n)) => n.to_string(),
                Some(Value::Bool(b)) => b.to_string(),
                Some(other) => other.to_string(), // JSON serialised
            }
        })
        .into_owned()
}

// ── Mapping lookup ───────────────────────────────────────────────────────

/// Find the first mapping that matches `hook_name` or the payload source.
///
/// Matching rules:
/// 1. `mapping.match.path == hook_name`
/// 2. `mapping.match.source == payload["source"]`
pub fn find_mapping<'a>(
    mappings: &'a [HookMapping],
    hook_name: &str,
    payload: &Value,
) -> Option<&'a HookMapping> {
    for mapping in mappings {
        if let Some(ref m) = mapping.r#match {
            if let Some(ref path) = m.path {
                if path == hook_name {
                    return Some(mapping);
                }
            }
            if let Some(ref source) = m.source {
                if let Some(Value::String(payload_source)) = payload.get("source") {
                    if payload_source == source {
                        return Some(mapping);
                    }
                }
            }
        }
    }
    None
}

// ── Mapping application ──────────────────────────────────────────────────

/// Apply a mapping to a payload, producing the final wake or agent
/// parameters.
pub fn apply_mapping(
    mapping: &HookMapping,
    hook_name: &str,
    payload: &Value,
) -> AppliedMapping {
    let action = mapping.action.unwrap_or(HookAction::Agent);
    let wake_mode = mapping.wake_mode.unwrap_or(WakeMode::Now);

    if action == HookAction::Wake {
        let text_template = mapping
            .text_template
            .as_deref()
            .or(mapping.message_template.as_deref());

        let text = if let Some(tmpl) = text_template {
            render_template(tmpl, payload)
        } else if let Some(Value::String(t)) = payload.get("text") {
            t.clone()
        } else {
            format!("Webhook received: {hook_name}")
        };

        return AppliedMapping {
            action: HookAction::Wake,
            wake_mode,
            text: Some(text),
            message: None,
            name: None,
            session_key: None,
            deliver: None,
            channel: None,
            to: None,
            model: None,
            thinking: None,
            timeout_seconds: None,
        };
    }

    // action == Agent
    let message = if let Some(ref tmpl) = mapping.message_template {
        render_template(tmpl, payload)
    } else if let Some(Value::String(m)) = payload.get("message") {
        m.clone()
    } else {
        format!("Webhook payload from {hook_name}")
    };

    let session_key = if let Some(ref sk) = mapping.session_key {
        render_template(sk, payload)
    } else {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        format!("hook:{hook_name}:{now}")
    };

    AppliedMapping {
        action: HookAction::Agent,
        wake_mode,
        text: None,
        message: Some(message),
        name: Some(mapping.name.clone().unwrap_or_else(|| hook_name.to_string())),
        session_key: Some(session_key),
        deliver: Some(mapping.deliver.unwrap_or(true)),
        channel: Some(mapping.channel.clone().unwrap_or_else(|| "last".to_string())),
        to: mapping.to.clone(),
        model: mapping.model.clone(),
        thinking: mapping.thinking.clone(),
        timeout_seconds: mapping.timeout_seconds,
    }
}

// ── Unit tests ───────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{HookMatch, WakeMode};
    use serde_json::json;

    #[test]
    fn replaces_simple_placeholders() {
        let data = json!({"name": "World"});
        assert_eq!(render_template("Hello {{name}}!", &data), "Hello World!");
    }

    #[test]
    fn replaces_nested_placeholders() {
        let data = json!({"sender": {"name": "Alice"}});
        assert_eq!(
            render_template("From: {{sender.name}}", &data),
            "From: Alice"
        );
    }

    #[test]
    fn replaces_array_index_placeholders() {
        let data = json!({"items": [{"label": "Apple"}, {"label": "Banana"}]});
        assert_eq!(
            render_template("First: {{items[0].label}}", &data),
            "First: Apple"
        );
    }

    #[test]
    fn leaves_unresolved_placeholders_as_is() {
        let data = json!({});
        assert_eq!(
            render_template("Hi {{unknown}}", &data),
            "Hi {{unknown}}"
        );
    }

    #[test]
    fn handles_multiple_placeholders() {
        let data = json!({"a": "1", "b": "2"});
        assert_eq!(render_template("{{a}} and {{b}}", &data), "1 and 2");
    }

    #[test]
    fn stringifies_objects() {
        let data = json!({"obj": {"x": 1}});
        let result = render_template("Data: {{obj}}", &data);
        assert_eq!(result, r#"Data: {"x":1}"#);
    }

    #[test]
    fn null_value_leaves_placeholder() {
        let data = json!({"key": null});
        assert_eq!(render_template("Val: {{key}}", &data), "Val: {{key}}");
    }

    #[test]
    fn numeric_values() {
        let data = json!({"n": 42});
        assert_eq!(render_template("Count: {{n}}", &data), "Count: 42");
    }

    #[test]
    fn boolean_values() {
        let data = json!({"flag": true});
        assert_eq!(render_template("Flag: {{flag}}", &data), "Flag: true");
    }

    #[test]
    fn deeply_nested_path() {
        let data = json!({"a": {"b": {"c": {"d": "deep"}}}});
        assert_eq!(render_template("{{a.b.c.d}}", &data), "deep");
    }

    #[test]
    fn multiple_array_indices() {
        let data = json!({"matrix": [[1, 2], [3, 4]]});
        assert_eq!(render_template("{{matrix[1][0]}}", &data), "3");
    }

    // ── find_mapping ─────────────────────────────────────────────────────

    fn sample_mappings() -> Vec<HookMapping> {
        vec![
            HookMapping {
                r#match: Some(HookMatch {
                    path: Some("gmail".into()),
                    ..Default::default()
                }),
                action: Some(HookAction::Agent),
                name: Some("Gmail".into()),
                ..Default::default()
            },
            HookMapping {
                r#match: Some(HookMatch {
                    path: Some("github".into()),
                    ..Default::default()
                }),
                action: Some(HookAction::Wake),
                name: Some("GitHub".into()),
                ..Default::default()
            },
            HookMapping {
                r#match: Some(HookMatch {
                    source: Some("stripe".into()),
                    ..Default::default()
                }),
                action: Some(HookAction::Agent),
                name: Some("Stripe".into()),
                ..Default::default()
            },
        ]
    }

    #[test]
    fn finds_by_path() {
        let mappings = sample_mappings();
        let found = find_mapping(&mappings, "gmail", &json!({}));
        assert_eq!(found.unwrap().name.as_deref(), Some("Gmail"));
    }

    #[test]
    fn finds_by_source_in_payload() {
        let mappings = sample_mappings();
        let found = find_mapping(&mappings, "whatever", &json!({"source": "stripe"}));
        assert_eq!(found.unwrap().name.as_deref(), Some("Stripe"));
    }

    #[test]
    fn returns_none_when_no_match() {
        let mappings = sample_mappings();
        assert!(find_mapping(&mappings, "unknown", &json!({})).is_none());
    }

    // ── apply_mapping ────────────────────────────────────────────────────

    #[test]
    fn applies_wake_mapping() {
        let mapping = HookMapping {
            action: Some(HookAction::Wake),
            text_template: Some("New event: {{type}}".into()),
            wake_mode: Some(WakeMode::Now),
            ..Default::default()
        };
        let result = apply_mapping(&mapping, "test", &json!({"type": "push"}));
        assert_eq!(result.action, HookAction::Wake);
        assert_eq!(result.text.as_deref(), Some("New event: push"));
        assert_eq!(result.wake_mode, WakeMode::Now);
    }

    #[test]
    fn applies_agent_mapping_with_template() {
        let mapping = HookMapping {
            action: Some(HookAction::Agent),
            name: Some("Gmail".into()),
            message_template: Some("Email from {{from}}: {{subject}}".into()),
            session_key: Some("hook:gmail:{{id}}".into()),
            deliver: Some(true),
            channel: Some("discord".into()),
            to: Some("channel:123".into()),
            ..Default::default()
        };
        let payload = json!({"from": "Alice", "subject": "Hi", "id": "msg-42"});
        let result = apply_mapping(&mapping, "gmail", &payload);
        assert_eq!(result.action, HookAction::Agent);
        assert_eq!(result.message.as_deref(), Some("Email from Alice: Hi"));
        assert_eq!(result.session_key.as_deref(), Some("hook:gmail:msg-42"));
        assert_eq!(result.deliver, Some(true));
        assert_eq!(result.channel.as_deref(), Some("discord"));
        assert_eq!(result.to.as_deref(), Some("channel:123"));
    }

    #[test]
    fn defaults_to_agent_action() {
        let mapping = HookMapping::default();
        let result = apply_mapping(&mapping, "test", &json!({"message": "hello"}));
        assert_eq!(result.action, HookAction::Agent);
        assert_eq!(result.message.as_deref(), Some("hello"));
    }

    #[test]
    fn uses_payload_text_for_wake_when_no_template() {
        let mapping = HookMapping {
            action: Some(HookAction::Wake),
            ..Default::default()
        };
        let result = apply_mapping(&mapping, "test", &json!({"text": "direct text"}));
        assert_eq!(result.text.as_deref(), Some("direct text"));
    }

    #[test]
    fn fallback_text_for_wake_without_template_or_payload() {
        let mapping = HookMapping {
            action: Some(HookAction::Wake),
            ..Default::default()
        };
        let result = apply_mapping(&mapping, "mytest", &json!({}));
        assert_eq!(result.text.as_deref(), Some("Webhook received: mytest"));
    }

    #[test]
    fn fallback_message_for_agent_without_template_or_payload() {
        let mapping = HookMapping {
            action: Some(HookAction::Agent),
            ..Default::default()
        };
        let result = apply_mapping(&mapping, "mytest", &json!({}));
        assert_eq!(
            result.message.as_deref(),
            Some("Webhook payload from mytest")
        );
    }

    #[test]
    fn wake_uses_message_template_as_text_fallback() {
        let mapping = HookMapping {
            action: Some(HookAction::Wake),
            message_template: Some("Msg: {{val}}".into()),
            ..Default::default()
        };
        let result = apply_mapping(&mapping, "test", &json!({"val": "ok"}));
        assert_eq!(result.text.as_deref(), Some("Msg: ok"));
    }
}
