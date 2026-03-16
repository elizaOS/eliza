//! Integration tests for elizaos-plugin-form.
//!
//! These test the public API as a consumer would use it, exercising
//! cross-module interactions: builder → validation → intent → TTL → template → service.

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
use std::collections::HashMap;

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

fn contact_form() -> FormDefinition {
    FormBuilder::create("contact")
        .name("Contact Form")
        .control(ControlBuilder::text("name").required())
        .control(ControlBuilder::email("email").required())
        .control(ControlBuilder::text("subject").required())
        .control(ControlBuilder::text("message").required().min_length(10))
        .control(
            ControlBuilder::select(
                "priority",
                vec![
                    FormControlOption {
                        value: "low".to_string(),
                        label: "Low".to_string(),
                        description: None,
                    },
                    FormControlOption {
                        value: "medium".to_string(),
                        label: "Medium".to_string(),
                        description: None,
                    },
                    FormControlOption {
                        value: "high".to_string(),
                        label: "High".to_string(),
                        description: None,
                    },
                ],
            )
            .required(),
        )
        .build()
}

fn make_session_with_effort(time_spent_ms: i64, last_interaction_at: i64) -> FormSession {
    let now: i64 = 1_700_000_000_000;
    FormSession {
        id: "test-session".to_string(),
        form_id: "test-form".to_string(),
        form_version: Some(1),
        entity_id: "user-1".to_string(),
        room_id: "room-1".to_string(),
        status: SessionStatus::Active,
        fields: HashMap::new(),
        history: Vec::new(),
        parent_session_id: None,
        context: None,
        locale: None,
        last_asked_field: None,
        last_message_id: None,
        cancel_confirmation_asked: None,
        effort: SessionEffort {
            interaction_count: 5,
            time_spent_ms,
            first_interaction_at: now - time_spent_ms,
            last_interaction_at,
        },
        expires_at: now + 14 * 24 * 60 * 60 * 1000,
        expiration_warned: None,
        nudge_count: None,
        last_nudge_at: None,
        created_at: now - time_spent_ms,
        updated_at: last_interaction_at,
        submitted_at: None,
        meta: None,
    }
}

// ============================================================================
// BUILDER: FLUENT API AND CONTROL BUILDER
// ============================================================================

#[test]
fn test_builder_fluent_api_full_form() {
    let form = FormBuilder::create("registration")
        .name("User Registration")
        .description("Create your account")
        .version(1)
        .control(
            ControlBuilder::email("email")
                .required()
                .ask("What email should we use?")
                .example("user@example.com"),
        )
        .control(
            ControlBuilder::text("username")
                .required()
                .min_length(3)
                .max_length(20)
                .pattern("^[a-z0-9_]+$"),
        )
        .control(ControlBuilder::number("age").min(13.0))
        .on_submit("handle_registration")
        .ttl(FormDefinitionTTL {
            min_days: Some(7.0),
            max_days: Some(30.0),
            effort_multiplier: None,
        })
        .build();

    assert_eq!(form.id, "registration");
    assert_eq!(form.name, "User Registration");
    assert_eq!(form.description, Some("Create your account".to_string()));
    assert_eq!(form.version, Some(1));
    assert_eq!(form.controls.len(), 3);
    assert!(form.controls[0].required);
    assert_eq!(form.controls[0].type_name, "email");
    assert_eq!(
        form.controls[0].ask_prompt,
        Some("What email should we use?".to_string())
    );
    assert_eq!(form.controls[1].min_length, Some(3));
    assert_eq!(form.controls[1].max_length, Some(20));
    assert_eq!(form.controls[1].pattern, Some("^[a-z0-9_]+$".to_string()));
    assert_eq!(form.controls[2].min, Some(13.0));
    assert_eq!(
        form.hooks.unwrap().on_submit,
        Some("handle_registration".to_string())
    );
    let ttl = form.ttl.unwrap();
    assert_eq!(ttl.min_days, Some(7.0));
    assert_eq!(ttl.max_days, Some(30.0));
}

#[test]
fn test_builder_all_control_types() {
    let form = FormBuilder::create("all_types")
        .control(ControlBuilder::text("name"))
        .control(ControlBuilder::email("email"))
        .control(ControlBuilder::number("age"))
        .control(ControlBuilder::boolean("agree"))
        .control(ControlBuilder::date("birthday"))
        .control(ControlBuilder::file("avatar"))
        .control(ControlBuilder::select(
            "color",
            vec![FormControlOption {
                value: "red".to_string(),
                label: "Red".to_string(),
                description: None,
            }],
        ))
        .build();

    assert_eq!(form.controls.len(), 7);
    assert_eq!(form.controls[0].type_name, "text");
    assert_eq!(form.controls[1].type_name, "email");
    assert_eq!(form.controls[2].type_name, "number");
    assert_eq!(form.controls[3].type_name, "boolean");
    assert_eq!(form.controls[4].type_name, "date");
    assert_eq!(form.controls[5].type_name, "file");
    assert_eq!(form.controls[6].type_name, "select");
}

#[test]
fn test_builder_auto_label_from_key() {
    let form = FormBuilder::create("test_form")
        .control(ControlBuilder::text("first_name"))
        .control(ControlBuilder::text("email_address"))
        .build();

    assert_eq!(form.name, "Test Form");
    assert_eq!(form.controls[0].label, "First Name");
    assert_eq!(form.controls[1].label, "Email Address");
}

#[test]
fn test_builder_explicit_label_preserved() {
    let c = ControlBuilder::text("first_name")
        .label("Given Name")
        .build();
    assert_eq!(c.label, "Given Name");
}

#[test]
fn test_builder_control_behavior_flags() {
    let c = ControlBuilder::text("password")
        .required()
        .sensitive()
        .hidden()
        .readonly()
        .multiple()
        .build();

    assert!(c.required);
    assert_eq!(c.sensitive, Some(true));
    assert_eq!(c.hidden, Some(true));
    assert_eq!(c.readonly, Some(true));
    assert_eq!(c.multiple, Some(true));
}

#[test]
fn test_builder_file_options() {
    let c = ControlBuilder::file("document")
        .accept(vec!["image/*".to_string(), "application/pdf".to_string()])
        .max_size(10 * 1024 * 1024)
        .max_files(5)
        .build();

    let file_opts = c.file.unwrap();
    assert_eq!(
        file_opts.accept,
        Some(vec![
            "image/*".to_string(),
            "application/pdf".to_string()
        ])
    );
    assert_eq!(file_opts.max_size, Some(10 * 1024 * 1024));
    assert_eq!(file_opts.max_files, Some(5));
}

#[test]
fn test_builder_required_and_optional_shorthand() {
    let form = FormBuilder::create("test")
        .required(&["name", "email"])
        .optional(&["bio", "phone"])
        .build();

    assert_eq!(form.controls.len(), 4);
    assert!(form.controls[0].required);
    assert!(form.controls[1].required);
    assert!(!form.controls[2].required);
    assert!(!form.controls[3].required);
}

#[test]
fn test_builder_dependency() {
    let c = ControlBuilder::text("state")
        .depends_on(FormControlDependency {
            field: "country".to_string(),
            condition: DependencyCondition::Equals,
            value: Some(json!("US")),
        })
        .build();

    let dep = c.depends_on.unwrap();
    assert_eq!(dep.field, "country");
    assert_eq!(dep.condition, DependencyCondition::Equals);
    assert_eq!(dep.value, Some(json!("US")));
}

#[test]
fn test_builder_ux_options() {
    let form = FormBuilder::create("test")
        .no_undo()
        .no_skip()
        .no_autofill()
        .max_undo_steps(3)
        .build();

    let ux = form.ux.unwrap();
    assert_eq!(ux.allow_undo, Some(false));
    assert_eq!(ux.allow_skip, Some(false));
    assert_eq!(ux.allow_autofill, Some(false));
    assert_eq!(ux.max_undo_steps, Some(3));
}

#[test]
fn test_builder_hooks_all() {
    let form = FormBuilder::create("test")
        .on_start("start_handler")
        .on_field_change("field_handler")
        .on_ready("ready_handler")
        .on_submit("submit_handler")
        .on_cancel("cancel_handler")
        .on_expire("expire_handler")
        .build();

    let hooks = form.hooks.unwrap();
    assert_eq!(hooks.on_start, Some("start_handler".to_string()));
    assert_eq!(hooks.on_field_change, Some("field_handler".to_string()));
    assert_eq!(hooks.on_ready, Some("ready_handler".to_string()));
    assert_eq!(hooks.on_submit, Some("submit_handler".to_string()));
    assert_eq!(hooks.on_cancel, Some("cancel_handler".to_string()));
    assert_eq!(hooks.on_expire, Some("expire_handler".to_string()));
}

#[test]
fn test_builder_meta_on_control_and_form() {
    let form = FormBuilder::create("test")
        .meta("category", json!("support"))
        .control(
            ControlBuilder::text("field")
                .meta("priority", json!(1))
                .meta("source", json!("api")),
        )
        .build();

    assert_eq!(
        form.meta.as_ref().unwrap().get("category"),
        Some(&json!("support"))
    );
    let ctrl_meta = form.controls[0].meta.as_ref().unwrap();
    assert_eq!(ctrl_meta.get("priority"), Some(&json!(1)));
    assert_eq!(ctrl_meta.get("source"), Some(&json!("api")));
}

#[test]
fn test_builder_nudge_config() {
    let form = FormBuilder::create("test")
        .nudge_after(24.0)
        .nudge_message("Hey, finish your form!")
        .build();

    let nudge = form.nudge.unwrap();
    assert_eq!(nudge.after_inactive_hours, Some(24.0));
    assert_eq!(nudge.message, Some("Hey, finish your form!".to_string()));
}

#[test]
fn test_builder_dbbind() {
    let c = ControlBuilder::text("firstName")
        .dbbind("first_name")
        .build();
    assert_eq!(c.dbbind, Some("first_name".to_string()));
}

#[test]
fn test_builder_ui_hints() {
    let c = ControlBuilder::text("name")
        .section("Personal Info")
        .order(1)
        .placeholder("Enter your name...")
        .help_text("Your full legal name")
        .widget("text-input")
        .build();

    let ui = c.ui.unwrap();
    assert_eq!(ui.section, Some("Personal Info".to_string()));
    assert_eq!(ui.order, Some(1));
    assert_eq!(ui.placeholder, Some("Enter your name...".to_string()));
    assert_eq!(ui.help_text, Some("Your full legal name".to_string()));
    assert_eq!(ui.widget, Some("text-input".to_string()));
}

// ============================================================================
// VALIDATION: ALL FIELD TYPES AND EDGE CASES
// ============================================================================

#[test]
fn test_validation_text_required_and_optional() {
    let mut ctrl = FormControl {
        key: "name".to_string(),
        label: "Name".to_string(),
        type_name: "text".to_string(),
        required: true,
        ..Default::default()
    };

    // Required: null fails
    assert!(!validate_field(&serde_json::Value::Null, &ctrl).valid);
    // Required: empty string fails
    assert!(!validate_field(&json!(""), &ctrl).valid);
    // Required: with value passes
    assert!(validate_field(&json!("Alice"), &ctrl).valid);

    // Optional: null and empty are valid
    ctrl.required = false;
    assert!(validate_field(&serde_json::Value::Null, &ctrl).valid);
    assert!(validate_field(&json!(""), &ctrl).valid);
}

#[test]
fn test_validation_text_min_max_length() {
    let ctrl = FormControl {
        key: "name".to_string(),
        label: "Name".to_string(),
        type_name: "text".to_string(),
        min_length: Some(3),
        max_length: Some(10),
        ..Default::default()
    };

    assert!(!validate_field(&json!("AB"), &ctrl).valid);
    assert!(validate_field(&json!("ABC"), &ctrl).valid);
    assert!(validate_field(&json!("ABCDEFGHIJ"), &ctrl).valid);
    assert!(!validate_field(&json!("ABCDEFGHIJK"), &ctrl).valid);
}

#[test]
fn test_validation_text_pattern() {
    let ctrl = FormControl {
        key: "code".to_string(),
        label: "Code".to_string(),
        type_name: "text".to_string(),
        pattern: Some("^[A-Z]{3}-\\d{3}$".to_string()),
        ..Default::default()
    };

    assert!(validate_field(&json!("ABC-123"), &ctrl).valid);
    assert!(!validate_field(&json!("abc-123"), &ctrl).valid);
    assert!(!validate_field(&json!("AB-12"), &ctrl).valid);
}

#[test]
fn test_validation_text_enum() {
    let ctrl = FormControl {
        key: "size".to_string(),
        label: "Size".to_string(),
        type_name: "text".to_string(),
        enum_values: Some(vec!["S".to_string(), "M".to_string(), "L".to_string(), "XL".to_string()]),
        ..Default::default()
    };

    assert!(validate_field(&json!("M"), &ctrl).valid);
    assert!(validate_field(&json!("XL"), &ctrl).valid);
    assert!(!validate_field(&json!("XXL"), &ctrl).valid);
}

#[test]
fn test_validation_email_various() {
    let ctrl = FormControl {
        key: "email".to_string(),
        label: "Email".to_string(),
        type_name: "email".to_string(),
        ..Default::default()
    };

    assert!(validate_field(&json!("user@example.com"), &ctrl).valid);
    assert!(validate_field(&json!("user@mail.example.com"), &ctrl).valid);
    assert!(validate_field(&json!("user+tag@example.com"), &ctrl).valid);
    assert!(!validate_field(&json!("not-an-email"), &ctrl).valid);
    assert!(!validate_field(&json!("user@"), &ctrl).valid);
    assert!(!validate_field(&json!("@example.com"), &ctrl).valid);
    assert!(!validate_field(&json!("user @example.com"), &ctrl).valid);
    assert!(!validate_field(&json!("user@example"), &ctrl).valid);
}

#[test]
fn test_validation_number_range() {
    let ctrl = FormControl {
        key: "age".to_string(),
        label: "Age".to_string(),
        type_name: "number".to_string(),
        min: Some(0.0),
        max: Some(120.0),
        ..Default::default()
    };

    assert!(validate_field(&json!(25), &ctrl).valid);
    assert!(validate_field(&json!(0), &ctrl).valid);
    assert!(validate_field(&json!(120), &ctrl).valid);
    assert!(!validate_field(&json!(-1), &ctrl).valid);
    assert!(!validate_field(&json!(121), &ctrl).valid);
    assert!(!validate_field(&json!("not a number"), &ctrl).valid);
}

#[test]
fn test_validation_number_string_and_currency_formats() {
    let ctrl = FormControl {
        key: "price".to_string(),
        label: "Price".to_string(),
        type_name: "number".to_string(),
        ..Default::default()
    };

    assert!(validate_field(&json!("42"), &ctrl).valid);
    assert!(validate_field(&json!("1,234"), &ctrl).valid);
    assert!(validate_field(&json!("$50"), &ctrl).valid);
    assert!(validate_field(&json!(19.99), &ctrl).valid);
}

#[test]
fn test_validation_boolean_all_truthy_falsy() {
    let ctrl = FormControl {
        key: "agree".to_string(),
        label: "Agree".to_string(),
        type_name: "boolean".to_string(),
        ..Default::default()
    };

    // Truthy
    assert!(validate_field(&json!(true), &ctrl).valid);
    assert!(validate_field(&json!("yes"), &ctrl).valid);
    assert!(validate_field(&json!("1"), &ctrl).valid);
    assert!(validate_field(&json!("on"), &ctrl).valid);
    assert!(validate_field(&json!("true"), &ctrl).valid);

    // Falsy
    assert!(validate_field(&json!(false), &ctrl).valid);
    assert!(validate_field(&json!("no"), &ctrl).valid);
    assert!(validate_field(&json!("0"), &ctrl).valid);
    assert!(validate_field(&json!("off"), &ctrl).valid);
    assert!(validate_field(&json!("false"), &ctrl).valid);

    // Invalid
    assert!(!validate_field(&json!("maybe"), &ctrl).valid);
    assert!(!validate_field(&json!("sure"), &ctrl).valid);
}

#[test]
fn test_validation_date_formats() {
    let ctrl = FormControl {
        key: "birthday".to_string(),
        label: "Birthday".to_string(),
        type_name: "date".to_string(),
        ..Default::default()
    };

    assert!(validate_field(&json!("2024-01-15"), &ctrl).valid);
    assert!(validate_field(&json!("12/25/2024"), &ctrl).valid);
    assert!(validate_field(&json!(1700000000000_i64), &ctrl).valid);
    assert!(!validate_field(&json!("not-a-date"), &ctrl).valid);
    assert!(!validate_field(&json!(true), &ctrl).valid);
}

#[test]
fn test_validation_select_with_options() {
    let ctrl = FormControl {
        key: "color".to_string(),
        label: "Color".to_string(),
        type_name: "select".to_string(),
        options: Some(vec![
            FormControlOption {
                value: "red".to_string(),
                label: "Red".to_string(),
                description: None,
            },
            FormControlOption {
                value: "blue".to_string(),
                label: "Blue".to_string(),
                description: None,
            },
            FormControlOption {
                value: "green".to_string(),
                label: "Green".to_string(),
                description: None,
            },
        ]),
        ..Default::default()
    };

    assert!(validate_field(&json!("red"), &ctrl).valid);
    assert!(validate_field(&json!("blue"), &ctrl).valid);
    assert!(!validate_field(&json!("yellow"), &ctrl).valid);
}

#[test]
fn test_validation_file_with_constraints() {
    let ctrl = FormControl {
        key: "attachment".to_string(),
        label: "Attachment".to_string(),
        type_name: "file".to_string(),
        file: Some(FormControlFileOptions {
            accept: Some(vec!["image/*".to_string(), "application/pdf".to_string()]),
            max_size: Some(5 * 1024 * 1024),
            max_files: Some(3),
        }),
        ..Default::default()
    };

    // Valid file
    let valid_file = json!({"name": "photo.png", "mimeType": "image/png", "size": 1024});
    assert!(validate_field(&valid_file, &ctrl).valid);

    // Valid PDF
    let valid_pdf = json!({"name": "doc.pdf", "mimeType": "application/pdf", "size": 2048});
    assert!(validate_field(&valid_pdf, &ctrl).valid);

    // Invalid MIME type
    let bad_mime = json!({"name": "file.exe", "mimeType": "application/octet-stream", "size": 1024});
    assert!(!validate_field(&bad_mime, &ctrl).valid);

    // Exceeds max size
    let too_large = json!({"name": "big.png", "mimeType": "image/png", "size": 10_000_000});
    assert!(!validate_field(&too_large, &ctrl).valid);

    // Too many files
    let too_many = json!([
        {"name": "a.png", "mimeType": "image/png", "size": 100},
        {"name": "b.png", "mimeType": "image/png", "size": 100},
        {"name": "c.png", "mimeType": "image/png", "size": 100},
        {"name": "d.png", "mimeType": "image/png", "size": 100}
    ]);
    assert!(!validate_field(&too_many, &ctrl).valid);
}

#[test]
fn test_validation_custom_type_handler() {
    clear_type_handlers();

    register_type_handler(
        "wallet_address",
        TypeHandler {
            validate: Some(|v, _c| {
                let s = v.as_str().unwrap_or("");
                if s.starts_with("0x") && s.len() == 42 {
                    ValidationResult::ok()
                } else {
                    ValidationResult::err("Must be a valid Ethereum address")
                }
            }),
            parse: Some(|v| serde_json::Value::String(v.to_lowercase())),
            format_value: Some(|v| {
                let s = v.as_str().unwrap_or("");
                if s.len() > 10 {
                    format!("{}...{}", &s[..6], &s[s.len() - 4..])
                } else {
                    s.to_string()
                }
            }),
            extraction_prompt: Some("an Ethereum wallet address".to_string()),
        },
    );

    let mut ctrl = FormControl {
        key: "wallet".to_string(),
        label: "Wallet".to_string(),
        type_name: "wallet_address".to_string(),
        ..Default::default()
    };
    ctrl.required = false;

    let valid_addr = json!("0x742d35Cc6634C0532925a3b844Bc9e7595f2BD38");
    assert!(validate_field(&valid_addr, &ctrl).valid);

    let invalid_addr = json!("not_an_address");
    assert!(!validate_field(&invalid_addr, &ctrl).valid);

    // Parse
    assert_eq!(
        parse_value("0xABCD", &ctrl),
        json!("0xabcd")
    );

    // Format
    let handler = get_type_handler("wallet_address").unwrap();
    let fmt_fn = handler.format_value.unwrap();
    let formatted = fmt_fn(&valid_addr);
    assert!(formatted.contains("0x742d"));
    assert!(formatted.contains("..."));

    clear_type_handlers();
}

#[test]
fn test_validation_required_zero_and_false_are_valid() {
    let num_ctrl = FormControl {
        key: "count".to_string(),
        label: "Count".to_string(),
        type_name: "number".to_string(),
        required: true,
        ..Default::default()
    };

    assert!(validate_field(&json!(0), &num_ctrl).valid);

    let bool_ctrl = FormControl {
        key: "agree".to_string(),
        label: "Agree".to_string(),
        type_name: "boolean".to_string(),
        required: true,
        ..Default::default()
    };

    assert!(validate_field(&json!(false), &bool_ctrl).valid);
}

#[test]
fn test_validation_error_messages_use_label() {
    let ctrl = FormControl {
        key: "user_email".to_string(),
        label: "Email Address".to_string(),
        type_name: "email".to_string(),
        required: true,
        ..Default::default()
    };

    let result = validate_field(&json!(""), &ctrl);
    assert!(!result.valid);
    assert!(result.error.as_ref().unwrap().contains("Email Address"));
}

#[test]
fn test_validation_error_falls_back_to_key() {
    let ctrl = FormControl {
        key: "user_email".to_string(),
        label: String::new(),
        type_name: "text".to_string(),
        required: true,
        ..Default::default()
    };

    let result = validate_field(&serde_json::Value::Null, &ctrl);
    assert!(!result.valid);
    assert!(result.error.as_ref().unwrap().contains("user_email"));
}

// ============================================================================
// VALIDATION: PARSE AND FORMAT VALUES
// ============================================================================

#[test]
fn test_parse_all_types() {
    let num = FormControl { type_name: "number".to_string(), ..Default::default() };
    assert_eq!(parse_value("42", &num), json!(42.0));
    assert_eq!(parse_value("1,234.56", &num).as_f64().unwrap(), 1234.56);
    assert_eq!(parse_value("$50", &num).as_f64().unwrap(), 50.0);

    let bool_c = FormControl { type_name: "boolean".to_string(), ..Default::default() };
    assert_eq!(parse_value("yes", &bool_c), json!(true));
    assert_eq!(parse_value("no", &bool_c), json!(false));
    assert_eq!(parse_value("true", &bool_c), json!(true));
    assert_eq!(parse_value("false", &bool_c), json!(false));
    assert_eq!(parse_value("1", &bool_c), json!(true));
    assert_eq!(parse_value("0", &bool_c), json!(false));

    let date_c = FormControl { type_name: "date".to_string(), ..Default::default() };
    assert_eq!(parse_value("2024-01-15", &date_c), json!("2024-01-15"));

    let text_c = FormControl { type_name: "text".to_string(), ..Default::default() };
    assert_eq!(parse_value("hello", &text_c), json!("hello"));

    let email_c = FormControl { type_name: "email".to_string(), ..Default::default() };
    assert_eq!(parse_value("user@test.com", &email_c), json!("user@test.com"));
}

#[test]
fn test_format_values() {
    let num_c = FormControl {
        key: "c".to_string(),
        type_name: "number".to_string(),
        ..Default::default()
    };
    assert_eq!(format_value(&json!(1234), &num_c), "1,234");
    assert_eq!(format_value(&json!(19.99), &num_c), "19.99");

    let bool_c = FormControl {
        key: "c".to_string(),
        type_name: "boolean".to_string(),
        ..Default::default()
    };
    assert_eq!(format_value(&json!(true), &bool_c), "Yes");
    assert_eq!(format_value(&json!(false), &bool_c), "No");

    let select_c = FormControl {
        key: "c".to_string(),
        type_name: "select".to_string(),
        options: Some(vec![FormControlOption {
            value: "US".to_string(),
            label: "United States".to_string(),
            description: None,
        }]),
        ..Default::default()
    };
    assert_eq!(format_value(&json!("US"), &select_c), "United States");
    assert_eq!(format_value(&json!("XX"), &select_c), "XX");

    let null_c = FormControl {
        key: "c".to_string(),
        type_name: "text".to_string(),
        ..Default::default()
    };
    assert_eq!(format_value(&serde_json::Value::Null, &null_c), "");
}

#[test]
fn test_format_sensitive_values() {
    let ctrl = FormControl {
        key: "token".to_string(),
        type_name: "text".to_string(),
        sensitive: Some(true),
        ..Default::default()
    };

    assert_eq!(format_value(&json!("abcdefghijkl"), &ctrl), "abcd...ijkl");
    assert_eq!(format_value(&json!("1234"), &ctrl), "****");
}

#[test]
fn test_format_file_values() {
    let ctrl = FormControl {
        key: "docs".to_string(),
        type_name: "file".to_string(),
        ..Default::default()
    };

    assert_eq!(
        format_value(&json!([{"name": "a.pdf"}, {"name": "b.png"}]), &ctrl),
        "a.pdf, b.png"
    );
    assert_eq!(
        format_value(&json!({"name": "resume.pdf"}), &ctrl),
        "resume.pdf"
    );
}

#[test]
fn test_mime_type_matching() {
    assert!(matches_mime_type("image/png", "image/*"));
    assert!(matches_mime_type("image/jpeg", "image/*"));
    assert!(matches_mime_type("application/pdf", "application/pdf"));
    assert!(matches_mime_type("anything/here", "*/*"));
    assert!(!matches_mime_type("application/pdf", "image/*"));
    assert!(!matches_mime_type("image/png", "image/jpeg"));
}

// ============================================================================
// INTENT DETECTION
// ============================================================================

#[test]
fn test_intent_submit_phrases() {
    let submit_phrases = [
        "submit", "done", "finish", "send it", "that's all", "i'm done",
        "complete", "all set", "SUBMIT", "Done",
    ];
    for phrase in &submit_phrases {
        assert_eq!(
            quick_intent_detect(phrase),
            Some(FormIntent::Submit),
            "Expected Submit for '{}'",
            phrase
        );
    }
}

#[test]
fn test_intent_cancel_phrases() {
    let cancel_phrases = [
        "cancel", "abort", "nevermind", "never mind", "forget it",
        "stop", "quit", "exit",
    ];
    for phrase in &cancel_phrases {
        assert_eq!(
            quick_intent_detect(phrase),
            Some(FormIntent::Cancel),
            "Expected Cancel for '{}'",
            phrase
        );
    }
}

#[test]
fn test_intent_stash_phrases() {
    let stash_phrases = [
        "save", "stash", "later", "pause", "save for later", "save this",
    ];
    for phrase in &stash_phrases {
        assert_eq!(
            quick_intent_detect(phrase),
            Some(FormIntent::Stash),
            "Expected Stash for '{}'",
            phrase
        );
    }
}

#[test]
fn test_intent_restore_phrases() {
    let restore_phrases = ["resume", "continue", "go back to the form", "get back to it"];
    for phrase in &restore_phrases {
        assert_eq!(
            quick_intent_detect(phrase),
            Some(FormIntent::Restore),
            "Expected Restore for '{}'",
            phrase
        );
    }
}

#[test]
fn test_intent_skip_phrases() {
    let skip_phrases = ["skip", "pass", "don't know", "next", "no idea"];
    for phrase in &skip_phrases {
        assert_eq!(
            quick_intent_detect(phrase),
            Some(FormIntent::Skip),
            "Expected Skip for '{}'",
            phrase
        );
    }
}

#[test]
fn test_intent_explain_phrases() {
    assert_eq!(quick_intent_detect("why"), Some(FormIntent::Explain));
    assert_eq!(quick_intent_detect("why?"), Some(FormIntent::Explain));
    assert_eq!(quick_intent_detect("explain"), Some(FormIntent::Explain));
    assert_eq!(quick_intent_detect("what's that for?"), Some(FormIntent::Explain));
}

#[test]
fn test_intent_example_phrases() {
    assert_eq!(quick_intent_detect("example"), Some(FormIntent::Example));
    assert_eq!(quick_intent_detect("example?"), Some(FormIntent::Example));
    assert_eq!(quick_intent_detect("like what?"), Some(FormIntent::Example));
    assert_eq!(quick_intent_detect("show me"), Some(FormIntent::Example));
}

#[test]
fn test_intent_exclusion_patterns() {
    // "save and submit" should NOT be stash (should be submit)
    assert_ne!(
        quick_intent_detect("save and submit"),
        Some(FormIntent::Stash)
    );
    // "skip to" should NOT be skip
    assert_ne!(
        quick_intent_detect("skip to question 5"),
        Some(FormIntent::Skip)
    );
}

#[test]
fn test_intent_edge_cases() {
    assert_eq!(quick_intent_detect(""), None);
    assert_eq!(quick_intent_detect("a"), None);
    assert_eq!(quick_intent_detect("my email is user@example.com"), None);
    assert_eq!(quick_intent_detect("  submit  "), Some(FormIntent::Submit));
    assert_eq!(quick_intent_detect("I want to cancel this"), Some(FormIntent::Cancel));
}

#[test]
fn test_intent_classification_helpers() {
    // Lifecycle intents
    assert!(is_lifecycle_intent(&FormIntent::Submit));
    assert!(is_lifecycle_intent(&FormIntent::Cancel));
    assert!(is_lifecycle_intent(&FormIntent::Stash));
    assert!(is_lifecycle_intent(&FormIntent::Restore));
    assert!(!is_lifecycle_intent(&FormIntent::Undo));
    assert!(!is_lifecycle_intent(&FormIntent::FillForm));

    // UX intents
    assert!(is_ux_intent(&FormIntent::Undo));
    assert!(is_ux_intent(&FormIntent::Skip));
    assert!(is_ux_intent(&FormIntent::Explain));
    assert!(is_ux_intent(&FormIntent::Example));
    assert!(is_ux_intent(&FormIntent::Progress));
    assert!(is_ux_intent(&FormIntent::Autofill));
    assert!(!is_ux_intent(&FormIntent::Submit));

    // Data extraction
    assert!(has_data_to_extract(&FormIntent::FillForm));
    assert!(has_data_to_extract(&FormIntent::Other));
    assert!(!has_data_to_extract(&FormIntent::Submit));
    assert!(!has_data_to_extract(&FormIntent::Undo));
}

// ============================================================================
// TTL: CALCULATION AND EXPIRY
// ============================================================================

const HOUR_MS: i64 = 60 * 60 * 1000;
const DAY_MS: i64 = 24 * HOUR_MS;
const NOW: i64 = 1_700_000_000_000;

#[test]
fn test_ttl_zero_effort_gives_min_days() {
    let session = make_session_with_effort(0, NOW);
    let expires = calculate_ttl(&session, None, NOW);
    let days = (expires - NOW) as f64 / DAY_MS as f64;
    assert!((days - 14.0).abs() < 0.01);
}

#[test]
fn test_ttl_high_effort_capped_at_max() {
    let session = make_session_with_effort(240 * 60_000, NOW);
    let expires = calculate_ttl(&session, None, NOW);
    let days = (expires - NOW) as f64 / DAY_MS as f64;
    assert!((days - 90.0).abs() < 0.01);
}

#[test]
fn test_ttl_medium_effort_proportional() {
    // 2 hours = 120 min * 0.5 = 60 days
    let session = make_session_with_effort(120 * 60_000, NOW);
    let expires = calculate_ttl(&session, None, NOW);
    let days = (expires - NOW) as f64 / DAY_MS as f64;
    assert!((days - 60.0).abs() < 0.01);
}

#[test]
fn test_ttl_custom_form_config() {
    let form = FormDefinition {
        id: "test".to_string(),
        name: "Test".to_string(),
        controls: vec![],
        ttl: Some(FormDefinitionTTL {
            min_days: Some(7.0),
            max_days: Some(30.0),
            effort_multiplier: Some(1.0),
        }),
        ..Default::default()
    };

    // 0 effort => 7 days min
    let session = make_session_with_effort(0, NOW);
    let expires = calculate_ttl(&session, Some(&form), NOW);
    let days = (expires - NOW) as f64 / DAY_MS as f64;
    assert!((days - 7.0).abs() < 0.01);

    // High effort => 30 days max
    let session2 = make_session_with_effort(600 * 60_000, NOW);
    let expires2 = calculate_ttl(&session2, Some(&form), NOW);
    let days2 = (expires2 - NOW) as f64 / DAY_MS as f64;
    assert!((days2 - 30.0).abs() < 0.01);
}

#[test]
fn test_ttl_expiration_helpers() {
    let mut session = make_session_with_effort(0, NOW);
    session.expires_at = NOW + 12 * HOUR_MS;
    assert!(is_expiring_soon(&session, 24 * HOUR_MS, NOW));
    assert!(!is_expired(&session, NOW));

    session.expires_at = NOW - 1000;
    assert!(is_expired(&session, NOW));

    session.expires_at = NOW;
    assert!(!is_expired(&session, NOW)); // exactly at expiry is NOT expired
}

#[test]
fn test_ttl_format_time_remaining() {
    let mut session = make_session_with_effort(0, NOW);

    session.expires_at = NOW + 14 * DAY_MS;
    assert_eq!(format_time_remaining(&session, NOW), "14 days");

    session.expires_at = NOW + DAY_MS + HOUR_MS;
    assert_eq!(format_time_remaining(&session, NOW), "1 day");

    session.expires_at = NOW + 5 * HOUR_MS;
    assert_eq!(format_time_remaining(&session, NOW), "5 hours");

    session.expires_at = NOW + 45 * 60_000;
    assert_eq!(format_time_remaining(&session, NOW), "45 minutes");

    session.expires_at = NOW - 1000;
    assert_eq!(format_time_remaining(&session, NOW), "expired");
}

#[test]
fn test_ttl_format_effort() {
    assert_eq!(format_effort(&make_session_with_effort(30_000, NOW)), "just started");
    assert_eq!(format_effort(&make_session_with_effort(60_000, NOW)), "1 minute");
    assert_eq!(format_effort(&make_session_with_effort(5 * 60_000, NOW)), "5 minutes");
    assert_eq!(format_effort(&make_session_with_effort(60 * 60_000, NOW)), "1 hour");
    assert_eq!(format_effort(&make_session_with_effort(90 * 60_000, NOW)), "1h 30m");
    assert_eq!(format_effort(&make_session_with_effort(2 * 60 * 60_000, NOW)), "2 hours");
}

#[test]
fn test_ttl_cancel_confirmation() {
    // Less than 5 min: no confirmation
    assert!(!should_confirm_cancel(&make_session_with_effort(2 * 60_000, NOW)));
    // Exactly 5 min: no confirmation (threshold is >5min)
    assert!(!should_confirm_cancel(&make_session_with_effort(5 * 60_000, NOW)));
    // More than 5 min: confirmation needed
    assert!(should_confirm_cancel(&make_session_with_effort(6 * 60_000, NOW)));
}

#[test]
fn test_ttl_nudge_logic() {
    // Active recently: no nudge
    let session = make_session_with_effort(60_000, NOW - HOUR_MS);
    assert!(!should_nudge(&session, None, NOW));

    // Inactive long enough: nudge
    let session2 = make_session_with_effort(60_000, NOW - 49 * HOUR_MS);
    assert!(should_nudge(&session2, None, NOW));

    // Max nudges reached: no nudge
    let mut session3 = make_session_with_effort(60_000, NOW - 49 * HOUR_MS);
    session3.nudge_count = Some(3);
    assert!(!should_nudge(&session3, None, NOW));

    // Recently nudged: no nudge
    let mut session4 = make_session_with_effort(60_000, NOW - 49 * HOUR_MS);
    session4.last_nudge_at = Some(NOW - 12 * HOUR_MS);
    assert!(!should_nudge(&session4, None, NOW));

    // Nudge disabled: no nudge
    let form_no_nudge = FormDefinition {
        id: "t".to_string(),
        name: "T".to_string(),
        controls: vec![],
        nudge: Some(FormDefinitionNudge {
            enabled: Some(false),
            ..Default::default()
        }),
        ..Default::default()
    };
    let session5 = make_session_with_effort(60_000, NOW - 49 * HOUR_MS);
    assert!(!should_nudge(&session5, Some(&form_no_nudge), NOW));
}

// ============================================================================
// DEFAULTS APPLICATION
// ============================================================================

#[test]
fn test_defaults_minimal_form_expansion() {
    let form = apply_form_defaults(FormDefinition {
        id: "user_registration".to_string(),
        controls: vec![FormControl {
            key: "user_email".to_string(),
            ..Default::default()
        }],
        ..Default::default()
    });

    assert_eq!(form.name, "User Registration");
    assert_eq!(form.version, Some(1));
    assert_eq!(form.status, Some(FormStatus::Active));
    assert_eq!(form.debug, Some(false));

    let ux = form.ux.unwrap();
    assert_eq!(ux.allow_undo, Some(true));
    assert_eq!(ux.allow_skip, Some(true));
    assert_eq!(ux.max_undo_steps, Some(5));
    assert_eq!(ux.show_examples, Some(true));
    assert_eq!(ux.show_explanations, Some(true));
    assert_eq!(ux.allow_autofill, Some(true));

    let ttl = form.ttl.unwrap();
    assert_eq!(ttl.min_days, Some(14.0));
    assert_eq!(ttl.max_days, Some(90.0));
    assert_eq!(ttl.effort_multiplier, Some(0.5));

    let nudge = form.nudge.unwrap();
    assert_eq!(nudge.enabled, Some(true));
    assert_eq!(nudge.after_inactive_hours, Some(48.0));
    assert_eq!(nudge.max_nudges, Some(3));

    // Control defaults
    assert_eq!(form.controls[0].label, "User Email");
    assert_eq!(form.controls[0].type_name, "text");
    assert_eq!(form.controls[0].confirm_threshold, Some(0.8));
}

#[test]
fn test_defaults_preserve_explicit_values() {
    let form = apply_form_defaults(FormDefinition {
        id: "test".to_string(),
        name: "My Form".to_string(),
        version: Some(5),
        status: Some(FormStatus::Draft),
        controls: vec![FormControl {
            key: "field".to_string(),
            label: "Custom Label".to_string(),
            type_name: "email".to_string(),
            confirm_threshold: Some(0.95),
            ..Default::default()
        }],
        ux: Some(FormDefinitionUX {
            allow_undo: Some(false),
            allow_skip: None,
            max_undo_steps: None,
            show_examples: None,
            show_explanations: None,
            allow_autofill: None,
        }),
        ..Default::default()
    });

    assert_eq!(form.name, "My Form");
    assert_eq!(form.version, Some(5));
    assert_eq!(form.status, Some(FormStatus::Draft));

    assert_eq!(form.controls[0].label, "Custom Label");
    assert_eq!(form.controls[0].type_name, "email");
    assert_eq!(form.controls[0].confirm_threshold, Some(0.95));

    let ux = form.ux.unwrap();
    assert_eq!(ux.allow_undo, Some(false)); // preserved
    assert_eq!(ux.allow_skip, Some(true)); // filled by default
}

#[test]
fn test_prettify_key_names() {
    assert_eq!(prettify("first_name"), "First Name");
    assert_eq!(prettify("email-address"), "Email Address");
    assert_eq!(prettify("email"), "Email");
    assert_eq!(prettify("full_name-display"), "Full Name Display");
    assert_eq!(prettify(""), "");
    assert_eq!(prettify("Name"), "Name");
}

// ============================================================================
// TEMPLATE RENDERING
// ============================================================================

#[test]
fn test_template_basic_substitution() {
    let mut values = HashMap::new();
    values.insert("name".to_string(), "Alice".to_string());
    values.insert("company".to_string(), "Acme Corp".to_string());

    assert_eq!(
        render_template(Some("Hello {{ name }} from {{ company }}!"), &values),
        Some("Hello Alice from Acme Corp!".to_string())
    );
}

#[test]
fn test_template_unresolved_preserved() {
    let values = HashMap::new();
    assert_eq!(
        render_template(Some("Hello {{ unknown }}!"), &values),
        Some("Hello {{ unknown }}!".to_string())
    );
}

#[test]
fn test_template_none_input() {
    let values = HashMap::new();
    assert_eq!(render_template(None, &values), None);
}

#[test]
fn test_template_whitespace_variants() {
    let mut values = HashMap::new();
    values.insert("x".to_string(), "42".to_string());

    assert_eq!(render_template(Some("{{x}}"), &values), Some("42".to_string()));
    assert_eq!(render_template(Some("{{ x }}"), &values), Some("42".to_string()));
    assert_eq!(render_template(Some("{{  x  }}"), &values), Some("42".to_string()));
}

#[test]
fn test_template_build_values_from_session() {
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

    let session = FormSession {
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
    };

    let values = build_template_values(&session);
    assert_eq!(values.get("name"), Some(&"Alice".to_string()));
    assert_eq!(values.get("age"), Some(&"30".to_string()));
    assert_eq!(values.get("active"), Some(&"true".to_string()));
    assert_eq!(values.get("app_name"), Some(&"TestApp".to_string()));
}

#[test]
fn test_template_resolve_control() {
    let mut values = HashMap::new();
    values.insert("name".to_string(), "Alice".to_string());
    values.insert("currency".to_string(), "USD".to_string());

    let control = FormControl {
        key: "amount".to_string(),
        label: "Amount in {{ currency }}".to_string(),
        type_name: "number".to_string(),
        ask_prompt: Some("Hi {{ name }}, enter amount:".to_string()),
        description: Some("Amount in {{ currency }}".to_string()),
        example: Some("100 {{ currency }}".to_string()),
        ..Default::default()
    };

    let resolved = resolve_control_templates(&control, &values);
    assert_eq!(resolved.label, "Amount in USD");
    assert_eq!(resolved.ask_prompt, Some("Hi Alice, enter amount:".to_string()));
    assert_eq!(resolved.description, Some("Amount in USD".to_string()));
    assert_eq!(resolved.example, Some("100 USD".to_string()));
}

#[test]
fn test_template_resolve_nested_fields() {
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
fn test_template_resolve_options() {
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

// ============================================================================
// SERVICE: FULL LIFECYCLE
// ============================================================================

#[test]
fn test_service_full_lifecycle() {
    let mut svc = FormService::new();
    svc.register_form(registration_form());

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

    // Progress
    assert_eq!(svc.progress(&sid), 0.0);
    assert!(!svc.is_ready(&sid));
    assert_eq!(svc.next_required_field(&sid).as_deref(), Some("name"));

    // Fill fields
    svc.set_field(&sid, "name", json!("Alice"), 2000).unwrap();
    assert_eq!(svc.progress(&sid), 50.0);
    assert_eq!(svc.next_required_field(&sid).as_deref(), Some("email"));

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
    assert_eq!(submission.values.get("email"), Some(&json!("alice@example.com")));
    assert_eq!(submission.submitted_at, 4000);

    let session = svc.get_session(&sid).unwrap();
    assert_eq!(session.status, SessionStatus::Submitted);
    assert_eq!(session.submitted_at, Some(4000));
}

#[test]
fn test_service_stash_and_restore() {
    let mut svc = FormService::new();
    svc.register_form(registration_form());
    let sid = svc.start_session("registration", "user-1", "room-1", 1000).unwrap();

    svc.set_field(&sid, "name", json!("Alice"), 2000).unwrap();
    assert_eq!(svc.progress(&sid), 50.0);

    // Stash
    svc.stash(&sid, 3000).unwrap();
    assert_eq!(svc.get_session(&sid).unwrap().status, SessionStatus::Stashed);
    assert!(svc.find_active_session("user-1", "room-1").is_none());

    // Restore
    svc.restore(&sid, 4000).unwrap();
    assert_eq!(svc.get_session(&sid).unwrap().status, SessionStatus::Active);
    assert_eq!(svc.progress(&sid), 50.0); // progress preserved

    // Can continue
    svc.set_field(&sid, "email", json!("alice@example.com"), 5000).unwrap();
    assert!(svc.is_ready(&sid));
}

#[test]
fn test_service_cancel() {
    let mut svc = FormService::new();
    svc.register_form(registration_form());
    let sid = svc.start_session("registration", "user-1", "room-1", 1000).unwrap();

    svc.set_field(&sid, "name", json!("Alice"), 2000).unwrap();
    svc.cancel(&sid, 3000).unwrap();

    let session = svc.get_session(&sid).unwrap();
    assert_eq!(session.status, SessionStatus::Cancelled);
    assert_eq!(session.updated_at, 3000);
    assert!(svc.find_active_session("user-1", "room-1").is_none());
}

#[test]
fn test_service_error_form_not_found() {
    let mut svc = FormService::new();
    let result = svc.start_session("nonexistent", "user-1", "room-1", 1000);
    assert!(result.is_err());
    assert!(matches!(result.unwrap_err(), FormError::FormNotFound(_)));
}

#[test]
fn test_service_error_session_not_found() {
    let mut svc = FormService::new();
    svc.register_form(registration_form());
    let result = svc.set_field("fake-session", "name", json!("Alice"), 1000);
    assert!(matches!(result.unwrap_err(), FormError::SessionNotFound));
}

#[test]
fn test_service_error_field_not_found() {
    let mut svc = FormService::new();
    svc.register_form(registration_form());
    let sid = svc.start_session("registration", "user-1", "room-1", 1000).unwrap();
    let result = svc.set_field(&sid, "nonexistent_field", json!("value"), 2000);
    assert!(matches!(result.unwrap_err(), FormError::FieldNotFound(_)));
}

#[test]
fn test_service_error_submit_not_ready() {
    let mut svc = FormService::new();
    svc.register_form(registration_form());
    let sid = svc.start_session("registration", "user-1", "room-1", 1000).unwrap();
    svc.set_field(&sid, "name", json!("Alice"), 2000).unwrap();
    assert!(matches!(svc.submit(&sid, 3000).unwrap_err(), FormError::NotReady));
}

#[test]
fn test_service_error_restore_not_stashed() {
    let mut svc = FormService::new();
    svc.register_form(registration_form());
    let sid = svc.start_session("registration", "user-1", "room-1", 1000).unwrap();
    assert!(matches!(svc.restore(&sid, 2000).unwrap_err(), FormError::NotStashed));
}

#[test]
fn test_service_multiple_forms_and_sessions() {
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

    let sid1 = svc.start_session("contact", "user-1", "room-1", 1000).unwrap();
    let sid2 = svc.start_session("feedback", "user-1", "room-1", 1000).unwrap();

    assert_ne!(sid1, sid2);
    assert_eq!(svc.get_session(&sid1).unwrap().form_id, "contact");
    assert_eq!(svc.get_session(&sid2).unwrap().form_id, "feedback");
}

#[test]
fn test_service_effort_tracking() {
    let mut svc = FormService::new();
    svc.register_form(registration_form());
    let sid = svc.start_session("registration", "user-1", "room-1", 1000).unwrap();

    let session = svc.get_session(&sid).unwrap();
    assert_eq!(session.effort.interaction_count, 0);
    assert_eq!(session.effort.first_interaction_at, 1000);

    svc.set_field(&sid, "name", json!("Alice"), 2000).unwrap();
    svc.set_field(&sid, "email", json!("alice@test.com"), 3000).unwrap();

    let session = svc.get_session(&sid).unwrap();
    assert_eq!(session.effort.interaction_count, 2);
    assert_eq!(session.effort.last_interaction_at, 3000);
}

#[test]
fn test_service_default_values_applied() {
    let form = FormBuilder::create("with_defaults")
        .control(
            ControlBuilder::text("country")
                .required()
                .default_value(json!("US")),
        )
        .control(
            ControlBuilder::boolean("newsletter")
                .default_value(json!(true)),
        )
        .build();

    let mut svc = FormService::new();
    svc.register_form(form);

    let sid = svc.start_session("with_defaults", "user-1", "room-1", 1000).unwrap();
    let session = svc.get_session(&sid).unwrap();

    let country_state = session.fields.get("country").unwrap();
    assert_eq!(country_state.value, Some(json!("US")));
    assert_eq!(country_state.status, FieldStatus::Uncertain);
    assert_eq!(country_state.source, Some(FieldSource::Default));

    let newsletter_state = session.fields.get("newsletter").unwrap();
    assert_eq!(newsletter_state.value, Some(json!(true)));
}

#[test]
fn test_service_no_required_fields_is_always_ready() {
    let form = FormBuilder::create("optional_only")
        .control(ControlBuilder::text("bio"))
        .control(ControlBuilder::text("phone"))
        .build();

    let mut svc = FormService::new();
    svc.register_form(form);

    let sid = svc.start_session("optional_only", "user-1", "room-1", 1000).unwrap();
    assert_eq!(svc.progress(&sid), 100.0);
    assert!(svc.is_ready(&sid));
}

// ============================================================================
// CROSS-MODULE: BUILDER + VALIDATION + INTENT
// ============================================================================

#[test]
fn test_cross_module_build_validate_intent() {
    let form = contact_form();
    assert_eq!(form.controls.len(), 5);

    // Validate form fields
    let email_ctrl = &form.controls[1];
    assert!(validate_field(&json!("user@example.com"), email_ctrl).valid);
    assert!(!validate_field(&json!("not-an-email"), email_ctrl).valid);

    let msg_ctrl = &form.controls[3];
    assert!(validate_field(&json!("This is a long enough message"), msg_ctrl).valid);
    assert!(!validate_field(&json!("Too short"), msg_ctrl).valid);

    let priority_ctrl = &form.controls[4];
    assert!(validate_field(&json!("high"), priority_ctrl).valid);
    assert!(!validate_field(&json!("urgent"), priority_ctrl).valid);

    // Detect intents
    assert_eq!(quick_intent_detect("submit"), Some(FormIntent::Submit));
    assert_eq!(quick_intent_detect("I want to cancel"), Some(FormIntent::Cancel));
    assert_eq!(quick_intent_detect("save for later"), Some(FormIntent::Stash));
}

// ============================================================================
// CROSS-MODULE: SERVICE + TEMPLATE + TTL
// ============================================================================

#[test]
fn test_cross_module_service_template_ttl() {
    let mut svc = FormService::new();
    svc.register_form(registration_form());
    let now: i64 = 1_700_000_000_000;
    let sid = svc.start_session("registration", "user-1", "room-1", now).unwrap();

    svc.set_field(&sid, "name", json!("Alice"), now + 1000).unwrap();
    svc.set_field(&sid, "email", json!("alice@test.com"), now + 2000).unwrap();

    // Template rendering from session
    let session = svc.get_session(&sid).unwrap();
    let values = build_template_values(session);
    let rendered = render_template(
        Some("Hello {{ name }}, your email is {{ email }}."),
        &values,
    );
    assert_eq!(
        rendered,
        Some("Hello Alice, your email is alice@test.com.".to_string())
    );

    // TTL for session
    let expires = calculate_ttl(session, None, now);
    let days = (expires - now) as f64 / (24.0 * 60.0 * 60.0 * 1000.0);
    assert!((days - 14.0).abs() < 0.01);

    assert!(!is_expired(session, now));
    assert_eq!(format_effort(session), "just started");
}

// ============================================================================
// BUILTINS: TYPE REGISTRY
// ============================================================================

#[test]
fn test_builtin_types_complete() {
    let types = builtin_types();
    assert_eq!(types.len(), 7);

    let ids: Vec<&str> = types.iter().map(|t| t.id).collect();
    assert!(ids.contains(&"text"));
    assert!(ids.contains(&"number"));
    assert!(ids.contains(&"email"));
    assert!(ids.contains(&"boolean"));
    assert!(ids.contains(&"select"));
    assert!(ids.contains(&"date"));
    assert!(ids.contains(&"file"));

    for t in &types {
        assert!(t.builtin);
        assert!(!t.extraction_prompt.is_empty());
    }
}

#[test]
fn test_builtin_type_lookup() {
    assert!(get_builtin_type("text").is_some());
    assert!(get_builtin_type("email").is_some());
    assert!(get_builtin_type("nonexistent").is_none());
    assert!(is_builtin_type("number"));
    assert!(is_builtin_type("boolean"));
    assert!(!is_builtin_type("phone"));
    assert!(!is_builtin_type("custom_widget"));
}

#[test]
fn test_builtin_registration_and_handler_use() {
    clear_type_handlers();
    register_builtin_types();

    assert!(get_type_handler("text").is_some());
    assert!(get_type_handler("number").is_some());
    assert!(get_type_handler("email").is_some());
    assert!(get_type_handler("boolean").is_some());
    assert!(get_type_handler("select").is_some());
    assert!(get_type_handler("date").is_some());
    assert!(get_type_handler("file").is_some());
    assert!(get_type_handler("nonexistent").is_none());

    clear_type_handlers();
}

// ============================================================================
// TYPES: SERIALIZATION
// ============================================================================

#[test]
fn test_types_form_definition_serialization() {
    let form = FormBuilder::create("test")
        .name("Test Form")
        .version(2)
        .control(ControlBuilder::text("name").required())
        .control(ControlBuilder::email("email"))
        .build();

    let json_str = serde_json::to_string(&form).unwrap();
    let deserialized: FormDefinition = serde_json::from_str(&json_str).unwrap();

    assert_eq!(deserialized.id, "test");
    assert_eq!(deserialized.name, "Test Form");
    assert_eq!(deserialized.version, Some(2));
    assert_eq!(deserialized.controls.len(), 2);
    assert_eq!(deserialized.controls[0].key, "name");
    assert!(deserialized.controls[0].required);
}

#[test]
fn test_types_validation_result() {
    let ok = ValidationResult::ok();
    assert!(ok.valid);
    assert!(ok.error.is_none());

    let err = ValidationResult::err("Something went wrong");
    assert!(!err.valid);
    assert_eq!(err.error, Some("Something went wrong".to_string()));
}

#[test]
fn test_types_session_status_variants() {
    let statuses = vec![
        SessionStatus::Active,
        SessionStatus::Ready,
        SessionStatus::Submitted,
        SessionStatus::Stashed,
        SessionStatus::Cancelled,
        SessionStatus::Expired,
    ];

    for status in statuses {
        let json_val = serde_json::to_value(&status).unwrap();
        let deserialized: SessionStatus = serde_json::from_value(json_val).unwrap();
        assert_eq!(deserialized, status);
    }
}

#[test]
fn test_types_field_status_variants() {
    let statuses = vec![
        FieldStatus::Empty,
        FieldStatus::Filled,
        FieldStatus::Uncertain,
        FieldStatus::Invalid,
        FieldStatus::Skipped,
        FieldStatus::Pending,
    ];

    for status in statuses {
        let json_val = serde_json::to_value(&status).unwrap();
        let deserialized: FieldStatus = serde_json::from_value(json_val).unwrap();
        assert_eq!(deserialized, status);
    }
}

#[test]
fn test_types_form_intent_serialization() {
    let intents = vec![
        FormIntent::FillForm,
        FormIntent::Submit,
        FormIntent::Stash,
        FormIntent::Restore,
        FormIntent::Cancel,
        FormIntent::Undo,
        FormIntent::Skip,
        FormIntent::Explain,
        FormIntent::Example,
        FormIntent::Progress,
        FormIntent::Autofill,
        FormIntent::Other,
    ];

    for intent in intents {
        let json_val = serde_json::to_value(&intent).unwrap();
        let deserialized: FormIntent = serde_json::from_value(json_val).unwrap();
        assert_eq!(deserialized, intent);
    }
}

#[test]
fn test_types_constants() {
    assert_eq!(DEFAULT_TTL_MIN_DAYS, 14.0);
    assert_eq!(DEFAULT_TTL_MAX_DAYS, 90.0);
    assert_eq!(DEFAULT_TTL_EFFORT_MULTIPLIER, 0.5);
    assert_eq!(DEFAULT_NUDGE_AFTER_INACTIVE_HOURS, 48.0);
    assert_eq!(DEFAULT_NUDGE_MAX_NUDGES, 3);
    assert_eq!(DEFAULT_CONFIRM_THRESHOLD, 0.8);
}
