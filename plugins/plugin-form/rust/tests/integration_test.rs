//! Integration tests for elizaos-plugin-form.
//!
//! These test the public API as a consumer would use it.

use elizaos_plugin_form::builder::*;
use elizaos_plugin_form::builtins::*;
use elizaos_plugin_form::defaults::*;
use elizaos_plugin_form::intent::*;
use elizaos_plugin_form::service::*;
use elizaos_plugin_form::template::*;
use elizaos_plugin_form::ttl::*;
use elizaos_plugin_form::types::*;
use elizaos_plugin_form::validation::*;

use serde_json::json;

// ============================================================================
// HELPERS
// ============================================================================

fn registration_form() -> FormDefinition {
    FormBuilder::create("registration")
        .name("User Registration")
        .control(
            ControlBuilder::text("name")
                .label("Full Name")
                .required()
                .ask("What's your name?"),
        )
        .control(
            ControlBuilder::email("email")
                .label("Email")
                .required()
                .ask("What's your email?"),
        )
        .control(ControlBuilder::text("bio").label("Bio"))
        .on_submit("handle_registration")
        .build()
}

// ============================================================================
// SERVICE: REGISTER, START, SET, PROGRESS, SUBMIT
// ============================================================================

#[test]
fn test_service_register_start_fill_submit() {
    let mut svc = FormService::new();
    svc.register_form(registration_form());

    // Verify registration
    assert!(svc.get_form("registration").is_some());
    assert_eq!(svc.list_forms().len(), 1);

    // Start session
    let sid = svc
        .start_session("registration", "user-1", "room-1", 1000)
        .unwrap();
    let session = svc.get_session(&sid).unwrap();
    assert_eq!(session.form_id, "registration");
    assert_eq!(session.entity_id, "user-1");
    assert_eq!(session.room_id, "room-1");
    assert_eq!(session.status, SessionStatus::Active);
    assert_eq!(session.fields.len(), 3);

    // Initial progress
    assert_eq!(svc.progress(&sid), 0.0);
    assert!(!svc.is_ready(&sid));
    assert_eq!(svc.next_required_field(&sid).as_deref(), Some("name"));

    // Fill name
    svc.set_field(&sid, "name", json!("Alice"), 2000).unwrap();
    assert_eq!(svc.progress(&sid), 50.0);
    assert_eq!(svc.next_required_field(&sid).as_deref(), Some("email"));

    // Fill email
    svc.set_field(&sid, "email", json!("alice@example.com"), 3000)
        .unwrap();
    assert_eq!(svc.progress(&sid), 100.0);
    assert!(svc.is_ready(&sid));
    assert!(svc.next_required_field(&sid).is_none());

    // Submit
    let submission = svc.submit(&sid, 4000).unwrap();
    assert_eq!(submission.form_id, "registration");
    assert_eq!(submission.entity_id, "user-1");
    assert_eq!(submission.values.len(), 2);
    assert_eq!(submission.values.get("name"), Some(&json!("Alice")));
    assert_eq!(
        submission.values.get("email"),
        Some(&json!("alice@example.com"))
    );
    assert_eq!(submission.submitted_at, 4000);

    // Verify session status
    let session = svc.get_session(&sid).unwrap();
    assert_eq!(session.status, SessionStatus::Submitted);
    assert_eq!(session.submitted_at, Some(4000));
}

// ============================================================================
// SERVICE: STASH AND RESTORE
// ============================================================================

#[test]
fn test_service_stash_and_restore() {
    let mut svc = FormService::new();
    svc.register_form(registration_form());
    let sid = svc
        .start_session("registration", "user-1", "room-1", 1000)
        .unwrap();

    // Fill one field
    svc.set_field(&sid, "name", json!("Alice"), 2000).unwrap();
    assert_eq!(svc.progress(&sid), 50.0);

    // Stash
    svc.stash(&sid, 3000).unwrap();
    assert_eq!(
        svc.get_session(&sid).unwrap().status,
        SessionStatus::Stashed
    );

    // Verify no active session for this entity/room
    assert!(svc.find_active_session("user-1", "room-1").is_none());

    // Restore
    svc.restore(&sid, 4000).unwrap();
    assert_eq!(
        svc.get_session(&sid).unwrap().status,
        SessionStatus::Active
    );

    // Progress preserved
    assert_eq!(svc.progress(&sid), 50.0);

    // Can continue filling
    svc.set_field(&sid, "email", json!("alice@example.com"), 5000)
        .unwrap();
    assert!(svc.is_ready(&sid));
}

// ============================================================================
// SERVICE: CANCEL
// ============================================================================

#[test]
fn test_service_cancel() {
    let mut svc = FormService::new();
    svc.register_form(registration_form());
    let sid = svc
        .start_session("registration", "user-1", "room-1", 1000)
        .unwrap();

    svc.set_field(&sid, "name", json!("Alice"), 2000).unwrap();
    svc.cancel(&sid, 3000).unwrap();

    let session = svc.get_session(&sid).unwrap();
    assert_eq!(session.status, SessionStatus::Cancelled);
    assert_eq!(session.updated_at, 3000);

    // No active session
    assert!(svc.find_active_session("user-1", "room-1").is_none());
}

// ============================================================================
// SERVICE: ERROR CASES
// ============================================================================

#[test]
fn test_service_form_not_found() {
    let mut svc = FormService::new();
    let result = svc.start_session("nonexistent", "user-1", "room-1", 1000);
    assert!(result.is_err());
    match result.unwrap_err() {
        FormError::FormNotFound(id) => assert_eq!(id, "nonexistent"),
        other => panic!("Expected FormNotFound, got {:?}", other),
    }
}

#[test]
fn test_service_session_not_found() {
    let mut svc = FormService::new();
    svc.register_form(registration_form());
    let result = svc.set_field("fake-session-id", "name", json!("Alice"), 1000);
    assert!(result.is_err());
    assert!(matches!(result.unwrap_err(), FormError::SessionNotFound));
}

#[test]
fn test_service_field_not_found() {
    let mut svc = FormService::new();
    svc.register_form(registration_form());
    let sid = svc
        .start_session("registration", "user-1", "room-1", 1000)
        .unwrap();
    let result = svc.set_field(&sid, "nonexistent_field", json!("value"), 2000);
    assert!(result.is_err());
    match result.unwrap_err() {
        FormError::FieldNotFound(name) => assert_eq!(name, "nonexistent_field"),
        other => panic!("Expected FieldNotFound, got {:?}", other),
    }
}

#[test]
fn test_service_submit_not_ready() {
    let mut svc = FormService::new();
    svc.register_form(registration_form());
    let sid = svc
        .start_session("registration", "user-1", "room-1", 1000)
        .unwrap();

    // Only fill one required field
    svc.set_field(&sid, "name", json!("Alice"), 2000).unwrap();
    let result = svc.submit(&sid, 3000);
    assert!(result.is_err());
    assert!(matches!(result.unwrap_err(), FormError::NotReady));
}

#[test]
fn test_service_restore_not_stashed() {
    let mut svc = FormService::new();
    svc.register_form(registration_form());
    let sid = svc
        .start_session("registration", "user-1", "room-1", 1000)
        .unwrap();

    // Session is Active, not Stashed
    let result = svc.restore(&sid, 2000);
    assert!(result.is_err());
    assert!(matches!(result.unwrap_err(), FormError::NotStashed));
}

#[test]
fn test_service_submit_session_not_found() {
    let mut svc = FormService::new();
    svc.register_form(registration_form());
    let result = svc.submit("nonexistent-session", 1000);
    assert!(result.is_err());
}

#[test]
fn test_service_cancel_session_not_found() {
    let mut svc = FormService::new();
    let result = svc.cancel("nonexistent-session", 1000);
    assert!(result.is_err());
    assert!(matches!(result.unwrap_err(), FormError::SessionNotFound));
}

// ============================================================================
// CROSS-MODULE: BUILDER + VALIDATION + INTENT
// ============================================================================

#[test]
fn test_build_form_validate_fields_detect_intent() {
    // Build form with builder
    let form = FormBuilder::create("contact")
        .name("Contact Form")
        .control(
            ControlBuilder::email("email")
                .label("Email")
                .required()
                .ask("What's your email?"),
        )
        .control(
            ControlBuilder::number("age")
                .label("Age")
                .min(18.0)
                .max(120.0),
        )
        .build();

    assert_eq!(form.id, "contact");
    assert_eq!(form.controls.len(), 2);

    // Validate values against form controls
    let email_control = &form.controls[0];
    assert!(validate_field(&json!("user@example.com"), email_control).valid);
    assert!(!validate_field(&json!("not-an-email"), email_control).valid);

    let age_control = &form.controls[1];
    assert!(validate_field(&json!(25), age_control).valid);
    assert!(!validate_field(&json!(15), age_control).valid); // below min
    assert!(!validate_field(&json!(150), age_control).valid); // above max

    // Detect intents
    assert_eq!(quick_intent_detect("submit"), Some(FormIntent::Submit));
    assert_eq!(
        quick_intent_detect("cancel this"),
        Some(FormIntent::Cancel)
    );
    assert_eq!(
        quick_intent_detect("save for later"),
        Some(FormIntent::Stash)
    );
    assert_eq!(quick_intent_detect("my email is user@example.com"), None);

    // Intent classification
    assert!(is_lifecycle_intent(&FormIntent::Submit));
    assert!(is_lifecycle_intent(&FormIntent::Cancel));
    assert!(is_lifecycle_intent(&FormIntent::Stash));
    assert!(is_lifecycle_intent(&FormIntent::Restore));
    assert!(is_ux_intent(&FormIntent::Undo));
    assert!(is_ux_intent(&FormIntent::Skip));
    assert!(is_ux_intent(&FormIntent::Explain));
    assert!(has_data_to_extract(&FormIntent::FillForm));
    assert!(has_data_to_extract(&FormIntent::Other));
    assert!(!has_data_to_extract(&FormIntent::Submit));
}

#[test]
fn test_cross_module_validate_extracted_values() {
    // Build a form with various control types
    let form = FormBuilder::create("profile")
        .control(
            ControlBuilder::text("username")
                .required()
                .min_length(3)
                .max_length(20)
                .pattern("^[a-z0-9_]+$"),
        )
        .control(ControlBuilder::email("email").required())
        .control(ControlBuilder::number("age").min(13.0).max(120.0))
        .control(ControlBuilder::boolean("agree_tos").required())
        .build();

    // Validate username
    let username_ctrl = &form.controls[0];
    assert!(validate_field(&json!("alice_42"), username_ctrl).valid);
    assert!(!validate_field(&json!("AB"), username_ctrl).valid); // too short
    assert!(!validate_field(&json!("Alice"), username_ctrl).valid); // uppercase fails pattern

    // Validate email
    let email_ctrl = &form.controls[1];
    assert!(validate_field(&json!("alice@example.com"), email_ctrl).valid);
    assert!(!validate_field(&json!("invalid"), email_ctrl).valid);

    // Validate number
    let age_ctrl = &form.controls[2];
    assert!(validate_field(&json!(25), age_ctrl).valid);
    assert!(!validate_field(&json!(10), age_ctrl).valid);
    assert!(!validate_field(&json!("not a number"), age_ctrl).valid);

    // Validate boolean
    let tos_ctrl = &form.controls[3];
    assert!(validate_field(&json!(true), tos_ctrl).valid);
    assert!(validate_field(&json!("yes"), tos_ctrl).valid);
    assert!(!validate_field(&json!("maybe"), tos_ctrl).valid);

    // Parse values
    assert_eq!(parse_value("42", age_ctrl), json!(42.0));
    assert_eq!(parse_value("yes", tos_ctrl), json!(true));
    assert_eq!(
        parse_value("alice@test.com", email_ctrl),
        json!("alice@test.com")
    );
}

// ============================================================================
// TEMPLATE RENDERING WITH SERVICE SESSION
// ============================================================================

#[test]
fn test_template_rendering_with_service_session() {
    let mut svc = FormService::new();
    svc.register_form(registration_form());
    let sid = svc
        .start_session("registration", "user-1", "room-1", 1000)
        .unwrap();

    // Set fields
    svc.set_field(&sid, "name", json!("Alice"), 2000).unwrap();
    svc.set_field(&sid, "email", json!("alice@example.com"), 3000)
        .unwrap();

    // Build template values from session
    let session = svc.get_session(&sid).unwrap();
    let values = build_template_values(session);
    assert_eq!(values.get("name"), Some(&"Alice".to_string()));
    assert_eq!(
        values.get("email"),
        Some(&"alice@example.com".to_string())
    );

    // Render templates
    let rendered = render_template(
        Some("Hello {{ name }}, we'll contact you at {{ email }}."),
        &values,
    );
    assert_eq!(
        rendered,
        Some("Hello Alice, we'll contact you at alice@example.com.".to_string())
    );

    // Unresolved placeholders preserved
    let rendered = render_template(
        Some("Welcome {{ name }}, your role is {{ role }}."),
        &values,
    );
    assert_eq!(
        rendered,
        Some("Welcome Alice, your role is {{ role }}.".to_string())
    );

    // None input returns None
    assert_eq!(render_template(None, &values), None);
}

#[test]
fn test_resolve_control_templates_with_session_values() {
    let mut svc = FormService::new();
    svc.register_form(registration_form());
    let sid = svc
        .start_session("registration", "user-1", "room-1", 1000)
        .unwrap();
    svc.set_field(&sid, "name", json!("Alice"), 2000).unwrap();

    let session = svc.get_session(&sid).unwrap();
    let values = build_template_values(session);

    // Resolve a control's ask_prompt
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

// ============================================================================
// TTL CALCULATION FOR SERVICE SESSIONS
// ============================================================================

#[test]
fn test_ttl_for_new_service_session() {
    let mut svc = FormService::new();
    svc.register_form(registration_form());
    let now: i64 = 1_700_000_000_000;
    let sid = svc
        .start_session("registration", "user-1", "room-1", now)
        .unwrap();

    let session = svc.get_session(&sid).unwrap();

    // New session has 0 effort, so TTL should be min_days (14 days by default)
    let expires = calculate_ttl(session, None, now);
    let day_ms: f64 = 24.0 * 60.0 * 60.0 * 1000.0;
    let days = (expires - now) as f64 / day_ms;
    assert!((days - 14.0).abs() < 0.01);
}

#[test]
fn test_ttl_with_form_config() {
    let form = FormBuilder::create("quick_form")
        .control(ControlBuilder::text("name").required())
        .ttl(FormDefinitionTTL {
            min_days: Some(7.0),
            max_days: Some(30.0),
            effort_multiplier: Some(1.0),
        })
        .build();

    let mut svc = FormService::new();
    svc.register_form(form);
    let now: i64 = 1_700_000_000_000;
    let sid = svc
        .start_session("quick_form", "user-1", "room-1", now)
        .unwrap();

    let session = svc.get_session(&sid).unwrap();
    let form = svc.get_form("quick_form").unwrap();

    // 0 effort -> min_days = 7
    let expires = calculate_ttl(session, Some(form), now);
    let day_ms: f64 = 24.0 * 60.0 * 60.0 * 1000.0;
    let days = (expires - now) as f64 / day_ms;
    assert!((days - 7.0).abs() < 0.01);
}

#[test]
fn test_session_expiration_helpers() {
    let mut svc = FormService::new();
    svc.register_form(registration_form());
    let now: i64 = 1_700_000_000_000;
    let sid = svc
        .start_session("registration", "user-1", "room-1", now)
        .unwrap();

    let session = svc.get_session(&sid).unwrap();

    // Session should not be expired right after creation
    assert!(!is_expired(session, now));

    // Should not be expiring soon (14 days away)
    let one_day_ms: i64 = 24 * 60 * 60 * 1000;
    assert!(!is_expiring_soon(session, one_day_ms, now));

    // Format time remaining
    let remaining = format_time_remaining(session, now);
    assert!(remaining.contains("14 days") || remaining.contains("13 days"));

    // Format effort (just started)
    let effort = format_effort(session);
    assert_eq!(effort, "just started");
}

// ============================================================================
// DEFAULTS AND BUILTINS
// ============================================================================

#[test]
fn test_defaults_applied_to_builder_form() {
    let form = FormBuilder::create("minimal_form")
        .control(ControlBuilder::text("user_name").required())
        .build();

    let form = apply_form_defaults(form);

    // Form defaults
    assert_eq!(form.name, "Minimal Form");
    assert_eq!(form.version, Some(1));
    assert_eq!(form.status, Some(FormStatus::Active));
    assert!(form.ux.is_some());
    assert!(form.ttl.is_some());
    assert!(form.nudge.is_some());

    // UX defaults
    let ux = form.ux.unwrap();
    assert_eq!(ux.allow_undo, Some(true));
    assert_eq!(ux.allow_skip, Some(true));

    // TTL defaults
    let ttl = form.ttl.unwrap();
    assert_eq!(ttl.min_days, Some(14.0));
    assert_eq!(ttl.max_days, Some(90.0));

    // Control defaults
    assert_eq!(form.controls[0].label, "User Name");
    assert_eq!(form.controls[0].confirm_threshold, Some(0.8));
}

#[test]
fn test_builtin_types_available() {
    let types = builtin_types();
    assert_eq!(types.len(), 7);

    let type_ids: Vec<&str> = types.iter().map(|t| t.id).collect();
    assert!(type_ids.contains(&"text"));
    assert!(type_ids.contains(&"number"));
    assert!(type_ids.contains(&"email"));
    assert!(type_ids.contains(&"boolean"));
    assert!(type_ids.contains(&"select"));
    assert!(type_ids.contains(&"date"));
    assert!(type_ids.contains(&"file"));

    // All have extraction prompts
    for t in &types {
        assert!(!t.extraction_prompt.is_empty());
    }

    // All are marked builtin
    for t in &types {
        assert!(t.builtin);
    }
}

#[test]
fn test_builtin_type_lookup() {
    assert!(get_builtin_type("text").is_some());
    assert!(get_builtin_type("email").is_some());
    assert!(get_builtin_type("nonexistent").is_none());
    assert!(is_builtin_type("number"));
    assert!(!is_builtin_type("custom_widget"));
}

#[test]
fn test_prettify_key_names() {
    assert_eq!(prettify("first_name"), "First Name");
    assert_eq!(prettify("email-address"), "Email Address");
    assert_eq!(prettify("email"), "Email");
    assert_eq!(prettify(""), "");
}

// ============================================================================
// SERVICE: MULTIPLE FORMS AND SESSIONS
// ============================================================================

#[test]
fn test_service_multiple_forms() {
    let mut svc = FormService::new();

    let form1 = FormBuilder::create("contact")
        .control(ControlBuilder::text("name").required())
        .build();
    let form2 = FormBuilder::create("feedback")
        .control(ControlBuilder::text("message").required())
        .build();

    svc.register_form(form1);
    svc.register_form(form2);

    assert_eq!(svc.list_forms().len(), 2);
    assert!(svc.get_form("contact").is_some());
    assert!(svc.get_form("feedback").is_some());

    let sid1 = svc
        .start_session("contact", "user-1", "room-1", 1000)
        .unwrap();
    let sid2 = svc
        .start_session("feedback", "user-1", "room-1", 1000)
        .unwrap();

    assert_ne!(sid1, sid2);
    assert_eq!(svc.get_session(&sid1).unwrap().form_id, "contact");
    assert_eq!(svc.get_session(&sid2).unwrap().form_id, "feedback");
}

#[test]
fn test_service_session_tracks_effort() {
    let mut svc = FormService::new();
    svc.register_form(registration_form());
    let sid = svc
        .start_session("registration", "user-1", "room-1", 1000)
        .unwrap();

    // Initial effort
    let session = svc.get_session(&sid).unwrap();
    assert_eq!(session.effort.interaction_count, 0);
    assert_eq!(session.effort.first_interaction_at, 1000);

    // After setting fields
    svc.set_field(&sid, "name", json!("Alice"), 2000).unwrap();
    svc.set_field(&sid, "email", json!("alice@test.com"), 3000)
        .unwrap();

    let session = svc.get_session(&sid).unwrap();
    assert_eq!(session.effort.interaction_count, 2);
    assert_eq!(session.effort.last_interaction_at, 3000);
}
