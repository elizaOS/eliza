//! Integration tests for elizaos-plugin-webhooks.
//!
//! These tests exercise the public API end-to-end, mirroring the TS test
//! suite for auth, mappings, and handlers.

use elizaos_plugin_webhooks::{
    apply_mapping, extract_token, find_mapping, render_template, validate_token,
    HookAction, HookMapping, HookMatch, RequestParts, WakeMode,
};
use serde_json::json;
use std::collections::HashMap;

// ═══════════════════════════════════════════════════════════════════════════
// Auth
// ═══════════════════════════════════════════════════════════════════════════

mod auth {
    use super::*;

    fn req_with_header(key: &str, value: &str) -> RequestParts {
        let mut headers = HashMap::new();
        headers.insert(key.to_string(), vec![value.to_string()]);
        RequestParts {
            headers,
            ..Default::default()
        }
    }

    #[test]
    fn extracts_from_bearer_header() {
        let req = req_with_header("authorization", "Bearer my-secret-token");
        assert_eq!(extract_token(&req), Some("my-secret-token".into()));
    }

    #[test]
    fn extracts_from_x_otto_token_header() {
        let req = req_with_header("x-otto-token", "my-token");
        assert_eq!(extract_token(&req), Some("my-token".into()));
    }

    #[test]
    fn extracts_from_query_param_in_url() {
        let req = RequestParts {
            url: Some("http://localhost/hooks/wake?token=query-tok".into()),
            ..Default::default()
        };
        assert_eq!(extract_token(&req), Some("query-tok".into()));
    }

    #[test]
    fn prefers_bearer_over_x_otto_token() {
        let mut headers = HashMap::new();
        headers.insert(
            "authorization".to_string(),
            vec!["Bearer bearer-tok".to_string()],
        );
        headers.insert("x-otto-token".to_string(), vec!["header-tok".to_string()]);
        let req = RequestParts {
            headers,
            ..Default::default()
        };
        assert_eq!(extract_token(&req), Some("bearer-tok".into()));
    }

    #[test]
    fn returns_none_when_no_token() {
        let req = RequestParts::default();
        assert_eq!(extract_token(&req), None);
    }

    #[test]
    fn validate_true_for_match() {
        let req = req_with_header("authorization", "Bearer correct");
        assert!(validate_token(&req, "correct"));
    }

    #[test]
    fn validate_false_for_mismatch() {
        let req = req_with_header("authorization", "Bearer wrong");
        assert!(!validate_token(&req, "correct"));
    }

    #[test]
    fn validate_false_for_missing() {
        let req = RequestParts::default();
        assert!(!validate_token(&req, "any"));
    }

    #[test]
    fn validate_false_for_different_length() {
        let req = req_with_header("authorization", "Bearer short");
        assert!(!validate_token(&req, "much-longer-expected-token"));
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Mappings
// ═══════════════════════════════════════════════════════════════════════════

mod mappings {
    use super::*;

    // ── render_template ──────────────────────────────────────────────────

    #[test]
    fn simple_placeholders() {
        assert_eq!(
            render_template("Hello {{name}}!", &json!({"name": "World"})),
            "Hello World!"
        );
    }

    #[test]
    fn nested_placeholders() {
        assert_eq!(
            render_template(
                "From: {{sender.name}}",
                &json!({"sender": {"name": "Alice"}}),
            ),
            "From: Alice"
        );
    }

    #[test]
    fn array_index_placeholders() {
        let data = json!({"items": [{"label": "Apple"}, {"label": "Banana"}]});
        assert_eq!(
            render_template("First: {{items[0].label}}", &data),
            "First: Apple"
        );
    }

    #[test]
    fn unresolved_left_as_is() {
        assert_eq!(
            render_template("Hi {{unknown}}", &json!({})),
            "Hi {{unknown}}"
        );
    }

    #[test]
    fn multiple_placeholders() {
        assert_eq!(
            render_template("{{a}} and {{b}}", &json!({"a": "1", "b": "2"})),
            "1 and 2"
        );
    }

    #[test]
    fn stringifies_objects() {
        let result = render_template("Data: {{obj}}", &json!({"obj": {"x": 1}}));
        assert_eq!(result, r#"Data: {"x":1}"#);
    }

    #[test]
    fn null_leaves_placeholder() {
        assert_eq!(
            render_template("Val: {{key}}", &json!({"key": null})),
            "Val: {{key}}"
        );
    }

    #[test]
    fn numeric_values() {
        assert_eq!(
            render_template("Count: {{n}}", &json!({"n": 42})),
            "Count: 42"
        );
    }

    #[test]
    fn boolean_values() {
        assert_eq!(
            render_template("Flag: {{flag}}", &json!({"flag": true})),
            "Flag: true"
        );
    }

    #[test]
    fn deeply_nested() {
        let data = json!({"a": {"b": {"c": {"d": "deep"}}}});
        assert_eq!(render_template("{{a.b.c.d}}", &data), "deep");
    }

    #[test]
    fn multiple_array_indices() {
        let data = json!({"matrix": [[1, 2], [3, 4]]});
        assert_eq!(render_template("{{matrix[1][0]}}", &data), "3");
    }

    // ── find_mapping ─────────────────────────────────────────────────────

    fn sample() -> Vec<HookMapping> {
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
        let m = sample();
        let found = find_mapping(&m, "gmail", &json!({})).unwrap();
        assert_eq!(found.name.as_deref(), Some("Gmail"));
    }

    #[test]
    fn finds_by_source() {
        let m = sample();
        let found = find_mapping(&m, "whatever", &json!({"source": "stripe"})).unwrap();
        assert_eq!(found.name.as_deref(), Some("Stripe"));
    }

    #[test]
    fn returns_none_no_match() {
        let m = sample();
        assert!(find_mapping(&m, "unknown", &json!({})).is_none());
    }

    // ── apply_mapping ────────────────────────────────────────────────────

    #[test]
    fn wake_mapping() {
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
    fn agent_mapping_with_template() {
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
        let r = apply_mapping(&mapping, "gmail", &payload);
        assert_eq!(r.action, HookAction::Agent);
        assert_eq!(r.message.as_deref(), Some("Email from Alice: Hi"));
        assert_eq!(r.session_key.as_deref(), Some("hook:gmail:msg-42"));
        assert_eq!(r.deliver, Some(true));
        assert_eq!(r.channel.as_deref(), Some("discord"));
        assert_eq!(r.to.as_deref(), Some("channel:123"));
    }

    #[test]
    fn defaults_to_agent() {
        let mapping = HookMapping::default();
        let r = apply_mapping(&mapping, "test", &json!({"message": "hello"}));
        assert_eq!(r.action, HookAction::Agent);
        assert_eq!(r.message.as_deref(), Some("hello"));
    }

    #[test]
    fn payload_text_for_wake() {
        let mapping = HookMapping {
            action: Some(HookAction::Wake),
            ..Default::default()
        };
        let r = apply_mapping(&mapping, "test", &json!({"text": "direct text"}));
        assert_eq!(r.text.as_deref(), Some("direct text"));
    }

    #[test]
    fn fallback_wake_text() {
        let mapping = HookMapping {
            action: Some(HookAction::Wake),
            ..Default::default()
        };
        let r = apply_mapping(&mapping, "mytest", &json!({}));
        assert_eq!(r.text.as_deref(), Some("Webhook received: mytest"));
    }

    #[test]
    fn fallback_agent_message() {
        let mapping = HookMapping {
            action: Some(HookAction::Agent),
            ..Default::default()
        };
        let r = apply_mapping(&mapping, "mytest", &json!({}));
        assert_eq!(r.message.as_deref(), Some("Webhook payload from mytest"));
    }

    #[test]
    fn wake_uses_message_template_as_fallback() {
        let mapping = HookMapping {
            action: Some(HookAction::Wake),
            message_template: Some("Msg: {{val}}".into()),
            ..Default::default()
        };
        let r = apply_mapping(&mapping, "test", &json!({"val": "ok"}));
        assert_eq!(r.text.as_deref(), Some("Msg: ok"));
    }
}
