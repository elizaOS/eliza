//! Unit tests for elicitation schemas and helpers

use super::schemas::*;
use schemars::schema_for;

#[test]
fn test_workflow_context_serialization() {
    let ctx = WorkflowContext {
        business_purpose: "Automate invoice processing".to_string(),
        target_app: Some("Excel".to_string()),
        expected_outcome: Some("All invoices processed".to_string()),
    };

    let json = serde_json::to_string(&ctx).unwrap();
    let deserialized: WorkflowContext = serde_json::from_str(&json).unwrap();

    assert_eq!(deserialized.business_purpose, "Automate invoice processing");
    assert_eq!(deserialized.target_app, Some("Excel".to_string()));
}

#[test]
fn test_workflow_context_default() {
    let ctx = WorkflowContext::default();
    assert_eq!(ctx.business_purpose, "");
    assert_eq!(ctx.target_app, None);
    assert_eq!(ctx.expected_outcome, None);
}

#[test]
fn test_workflow_context_partial_json() {
    let json = r#"{"business_purpose": "Test purpose"}"#;
    let ctx: WorkflowContext = serde_json::from_str(json).unwrap();

    assert_eq!(ctx.business_purpose, "Test purpose");
    assert_eq!(ctx.target_app, None);
}

#[test]
fn test_element_disambiguation_serialization() {
    let disambig = ElementDisambiguation {
        selected_index: 2,
        reason: Some("Submit button".to_string()),
    };

    let json = serde_json::to_string(&disambig).unwrap();
    let deserialized: ElementDisambiguation = serde_json::from_str(&json).unwrap();

    assert_eq!(deserialized.selected_index, 2);
    assert_eq!(deserialized.reason, Some("Submit button".to_string()));
}

#[test]
fn test_element_disambiguation_minimal() {
    let json = r#"{"selected_index": 5}"#;
    let disambig: ElementDisambiguation = serde_json::from_str(json).unwrap();

    assert_eq!(disambig.selected_index, 5);
    assert_eq!(disambig.reason, None);
}

#[test]
fn test_error_recovery_all_actions() {
    let actions = vec![
        ErrorRecoveryAction::Retry,
        ErrorRecoveryAction::WaitLonger,
        ErrorRecoveryAction::TryAlternativeSelector,
        ErrorRecoveryAction::Skip,
        ErrorRecoveryAction::Abort,
    ];

    for action in actions {
        let choice = ErrorRecoveryChoice {
            action: action.clone(),
            additional_context: None,
        };

        let json = serde_json::to_string(&choice).unwrap();
        let deserialized: ErrorRecoveryChoice = serde_json::from_str(&json).unwrap();

        assert_eq!(deserialized.action, action);
    }
}

#[test]
fn test_action_confirmation_true() {
    let confirm = ActionConfirmation {
        confirmed: true,
        notes: Some("Approved".to_string()),
    };

    let json = serde_json::to_string(&confirm).unwrap();
    let deserialized: ActionConfirmation = serde_json::from_str(&json).unwrap();

    assert!(deserialized.confirmed);
    assert_eq!(deserialized.notes, Some("Approved".to_string()));
}

#[test]
fn test_action_confirmation_false() {
    let confirm = ActionConfirmation {
        confirmed: false,
        notes: None,
    };

    let json = serde_json::to_string(&confirm).unwrap();
    let deserialized: ActionConfirmation = serde_json::from_str(&json).unwrap();

    assert!(!deserialized.confirmed);
}

#[test]
fn test_selector_refinement_full() {
    let refinement = SelectorRefinement {
        element_description: "Blue button".to_string(),
        element_type: Some(ElementTypeHint::Button),
        visible_text: Some("Submit".to_string()),
    };

    let json = serde_json::to_string(&refinement).unwrap();
    let deserialized: SelectorRefinement = serde_json::from_str(&json).unwrap();

    assert_eq!(deserialized.element_description, "Blue button");
    assert_eq!(deserialized.element_type, Some(ElementTypeHint::Button));
}

#[test]
fn test_all_element_type_hints() {
    let types = vec![
        ElementTypeHint::Button,
        ElementTypeHint::TextField,
        ElementTypeHint::Checkbox,
        ElementTypeHint::Dropdown,
        ElementTypeHint::Link,
        ElementTypeHint::Menu,
        ElementTypeHint::Tab,
        ElementTypeHint::ListItem,
        ElementTypeHint::Other,
    ];

    for et in types {
        let refinement = SelectorRefinement {
            element_description: "test".to_string(),
            element_type: Some(et.clone()),
            visible_text: None,
        };

        let json = serde_json::to_string(&refinement).unwrap();
        let deserialized: SelectorRefinement = serde_json::from_str(&json).unwrap();

        assert_eq!(deserialized.element_type, Some(et));
    }
}

// Schema generation tests

#[test]
fn test_workflow_context_schema() {
    let schema = schema_for!(WorkflowContext);
    let json = serde_json::to_value(&schema).unwrap();
    assert!(json.get("properties").is_some() || json.get("$defs").is_some());
}

#[test]
fn test_element_disambiguation_schema() {
    let schema = schema_for!(ElementDisambiguation);
    let json = serde_json::to_value(&schema).unwrap();
    assert!(json.get("properties").is_some() || json.get("$defs").is_some());
}

#[test]
fn test_error_recovery_choice_schema() {
    let schema = schema_for!(ErrorRecoveryChoice);
    let json = serde_json::to_value(&schema).unwrap();
    assert!(json.get("properties").is_some() || json.get("$defs").is_some());
}

// Edge cases

#[test]
fn test_unicode_content() {
    let ctx = WorkflowContext {
        business_purpose: "自动化 🤖".to_string(),
        target_app: Some("エクセル".to_string()),
        expected_outcome: None,
    };

    let json = serde_json::to_string(&ctx).unwrap();
    let deserialized: WorkflowContext = serde_json::from_str(&json).unwrap();

    assert_eq!(deserialized.business_purpose, "自动化 🤖");
}

#[test]
fn test_empty_strings() {
    let ctx = WorkflowContext {
        business_purpose: "".to_string(),
        target_app: Some("".to_string()),
        expected_outcome: None,
    };

    let json = serde_json::to_string(&ctx).unwrap();
    let deserialized: WorkflowContext = serde_json::from_str(&json).unwrap();

    assert_eq!(deserialized.business_purpose, "");
}

#[test]
fn test_large_index() {
    let disambig = ElementDisambiguation {
        selected_index: usize::MAX,
        reason: None,
    };

    let json = serde_json::to_string(&disambig).unwrap();
    let deserialized: ElementDisambiguation = serde_json::from_str(&json).unwrap();

    assert_eq!(deserialized.selected_index, usize::MAX);
}

#[test]
fn test_zero_index() {
    let disambig = ElementDisambiguation {
        selected_index: 0,
        reason: Some("First".to_string()),
    };

    let json = serde_json::to_string(&disambig).unwrap();
    let deserialized: ElementDisambiguation = serde_json::from_str(&json).unwrap();

    assert_eq!(deserialized.selected_index, 0);
}
