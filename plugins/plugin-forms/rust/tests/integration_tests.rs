//! Integration tests for forms plugin.

use elizaos_plugin_forms::{
    get_actions,
    get_providers,
    Action,
    CancelFormAction,
    // Actions
    CreateFormAction,
    FieldError,
    FieldValue,
    FormField,
    FormFieldType,
    FormStatus,
    FormStep,
    FormTemplate,
    FormUpdateResult,
    // Providers
    FormsContextProvider,
    Provider,
    UpdateFormAction,
};

#[test]
fn test_form_field_type_default() {
    let field_type = FormFieldType::default();
    assert_eq!(field_type, FormFieldType::Text);
}

#[test]
fn test_form_status_default() {
    let status = FormStatus::default();
    assert_eq!(status, FormStatus::Active);
}

#[test]
fn test_field_value_from_string() {
    let value = FieldValue::from("test".to_string());
    assert_eq!(value, FieldValue::String("test".to_string()));
}

#[test]
fn test_field_value_from_str() {
    let value = FieldValue::from("test");
    assert_eq!(value, FieldValue::String("test".to_string()));
}

#[test]
fn test_field_value_from_f64() {
    let value = FieldValue::from(42.5);
    assert_eq!(value, FieldValue::Number(42.5));
}

#[test]
fn test_field_value_from_bool() {
    let value = FieldValue::from(true);
    assert_eq!(value, FieldValue::Boolean(true));
}

#[test]
fn test_form_field_new() {
    let field = FormField::new("email", "Email Address", FormFieldType::Email);
    assert_eq!(field.id, "email");
    assert_eq!(field.label, "Email Address");
    assert_eq!(field.field_type, FormFieldType::Email);
    assert!(!field.optional);
    assert!(!field.secret);
    assert!(field.value.is_none());
}

#[test]
fn test_form_field_builder() {
    let field = FormField::new("password", "Password", FormFieldType::Text)
        .with_description("Enter your password")
        .with_criteria("Must be at least 8 characters")
        .optional()
        .secret();

    assert_eq!(field.description, Some("Enter your password".to_string()));
    assert_eq!(
        field.criteria,
        Some("Must be at least 8 characters".to_string())
    );
    assert!(field.optional);
    assert!(field.secret);
}

#[test]
fn test_form_step_new() {
    let fields = vec![
        FormField::new("name", "Name", FormFieldType::Text),
        FormField::new("email", "Email", FormFieldType::Email),
    ];

    let step = FormStep::new("step1", "Personal Info", fields);
    assert_eq!(step.id, "step1");
    assert_eq!(step.name, "Personal Info");
    assert_eq!(step.fields.len(), 2);
    assert!(!step.completed);
}

#[test]
fn test_form_template_new() {
    let fields = vec![FormField::new("name", "Name", FormFieldType::Text)];
    let steps = vec![FormStep::new("step1", "Step 1", fields)];

    let template =
        FormTemplate::new("Contact Form", steps).with_description("A simple contact form");

    assert_eq!(template.name, "Contact Form");
    assert_eq!(
        template.description,
        Some("A simple contact form".to_string())
    );
    assert_eq!(template.steps.len(), 1);
}

#[test]
fn test_form_update_result_success() {
    let result = FormUpdateResult::success();
    assert!(result.success);
    assert!(result.message.is_none());
}

#[test]
fn test_form_update_result_failure() {
    let result = FormUpdateResult::failure("Invalid input");
    assert!(!result.success);
    assert_eq!(result.message, Some("Invalid input".to_string()));
}

#[test]
fn test_field_error_serialization() {
    let error = FieldError {
        field_id: "email".to_string(),
        message: "Invalid email format".to_string(),
    };

    let json = serde_json::to_string(&error).unwrap();
    assert!(json.contains("email"));
    assert!(json.contains("Invalid email format"));
}

#[test]
fn test_form_field_serialization() {
    let field = FormField::new("test", "Test", FormFieldType::Number);
    let json = serde_json::to_string(&field).unwrap();

    assert!(json.contains("\"type\":\"number\""));
    assert!(json.contains("\"id\":\"test\""));
}

#[test]
fn test_form_status_serialization() {
    let status = FormStatus::Completed;
    let json = serde_json::to_string(&status).unwrap();
    assert_eq!(json, "\"completed\"");
}

// ============================================================
// Action Tests
// ============================================================

#[test]
fn test_get_all_actions() {
    let actions = get_actions();
    assert_eq!(actions.len(), 3);

    let names: Vec<_> = actions.iter().map(|a| a.name()).collect();
    assert!(names.contains(&"CREATE_FORM"));
    assert!(names.contains(&"UPDATE_FORM"));
    assert!(names.contains(&"CANCEL_FORM"));
}

#[test]
fn test_create_form_action() {
    let action = CreateFormAction;

    assert_eq!(action.name(), "CREATE_FORM");
    assert!(!action.similes().is_empty());
    assert!(!action.description().is_empty());

    // Should validate when forms service available and message contains form keywords
    assert!(action.validate("I need to fill out a form", false, true));
    assert!(action.validate("help me with this survey", false, true));
    assert!(action.validate("I want to contact you", false, true));

    // Should not validate without forms service
    assert!(!action.validate("I need to fill out a form", false, false));

    // Should not validate without form keywords
    assert!(!action.validate("hello there", false, true));
}

#[test]
fn test_create_form_extract_type() {
    assert_eq!(
        CreateFormAction::extract_form_type("contact form please"),
        Some("contact")
    );
    assert_eq!(
        CreateFormAction::extract_form_type("give some feedback"),
        Some("feedback")
    );
    assert_eq!(
        CreateFormAction::extract_form_type("apply for job"),
        Some("application")
    );
    assert_eq!(
        CreateFormAction::extract_form_type("take survey"),
        Some("survey")
    );
    assert_eq!(
        CreateFormAction::extract_form_type("sign up here"),
        Some("registration")
    );
    // "message" is a keyword for contact, so use text without any keywords
    assert_eq!(CreateFormAction::extract_form_type("hello world"), None);
}

#[test]
fn test_update_form_action() {
    let action = UpdateFormAction;

    assert_eq!(action.name(), "UPDATE_FORM");
    assert!(!action.similes().is_empty());

    // Should validate when has active forms and contains form input
    assert!(action.validate("My name is John Smith", true, true));
    assert!(action.validate("test@example.com", true, true));
    assert!(action.validate("my phone is 1234567890", true, true));

    // Should not validate without active forms
    assert!(!action.validate("My name is John", false, true));

    // Should not validate without forms service
    assert!(!action.validate("My name is John", true, false));
}

#[test]
fn test_update_form_contains_input() {
    assert!(UpdateFormAction::contains_form_input("My name is John"));
    assert!(UpdateFormAction::contains_form_input("I am 25 years old"));
    assert!(UpdateFormAction::contains_form_input("email@test.com"));
    assert!(UpdateFormAction::contains_form_input("123456789"));
    assert!(UpdateFormAction::contains_form_input(
        "This is a longer message"
    ));

    // Short messages should not be detected as input
    assert!(!UpdateFormAction::contains_form_input("Hi"));
    assert!(!UpdateFormAction::contains_form_input("OK"));
}

#[test]
fn test_cancel_form_action() {
    let action = CancelFormAction;

    assert_eq!(action.name(), "CANCEL_FORM");
    assert!(!action.similes().is_empty());

    // Should validate when has active forms and wants to cancel
    assert!(action.validate("cancel the form", true, true));
    assert!(action.validate("stop please", true, true));
    assert!(action.validate("nevermind", true, true));

    // Should not validate without active forms
    assert!(!action.validate("cancel", false, true));

    // Should not validate without cancel intent
    assert!(!action.validate("continue please", true, true));
}

#[test]
fn test_cancel_form_wants_cancel() {
    assert!(CancelFormAction::wants_cancel("cancel"));
    assert!(CancelFormAction::wants_cancel("stop this"));
    assert!(CancelFormAction::wants_cancel("abort please"));
    assert!(CancelFormAction::wants_cancel("quit"));
    assert!(CancelFormAction::wants_cancel("exit now"));
    assert!(CancelFormAction::wants_cancel("nevermind"));
    assert!(CancelFormAction::wants_cancel("never mind"));
    assert!(CancelFormAction::wants_cancel("I don't want to do this"));

    assert!(!CancelFormAction::wants_cancel("continue"));
    assert!(!CancelFormAction::wants_cancel("submit"));
}

#[test]
fn test_action_examples() {
    let actions = get_actions();

    for action in &actions {
        let examples = action.examples();
        assert!(
            !examples.is_empty(),
            "Action {} should have examples",
            action.name()
        );
    }
}

// ============================================================
// Provider Tests
// ============================================================

#[test]
fn test_get_all_providers() {
    let providers = get_providers();
    assert_eq!(providers.len(), 1);
    assert_eq!(providers[0].name(), "FORMS_CONTEXT");
}

#[test]
fn test_forms_context_provider_properties() {
    let provider = FormsContextProvider;

    assert_eq!(provider.name(), "FORMS_CONTEXT");
    assert!(provider.dynamic());
    assert_eq!(provider.position(), 50);
    assert!(!provider.description().is_empty());
}

#[test]
fn test_forms_context_provider_empty() {
    let result = FormsContextProvider::generate_context(&[]);

    assert!(result.text.is_empty());
    assert!(result.values.is_empty());
    assert!(result.data.is_empty());
}

#[test]
fn test_forms_context_provider_with_form() {
    use chrono::Utc;
    use elizaos_plugin_forms::Form;
    use uuid::Uuid;

    let form = Form {
        id: Uuid::new_v4(),
        name: "test_form".to_string(),
        description: Some("Test form".to_string()),
        steps: vec![FormStep::new(
            "step1",
            "Step 1",
            vec![
                FormField {
                    id: "name".to_string(),
                    label: "Name".to_string(),
                    field_type: FormFieldType::Text,
                    description: Some("Your name".to_string()),
                    criteria: None,
                    optional: false,
                    secret: false,
                    value: Some(FieldValue::String("John".to_string())),
                    error: None,
                    metadata: None,
                },
                FormField {
                    id: "email".to_string(),
                    label: "Email".to_string(),
                    field_type: FormFieldType::Email,
                    description: None,
                    criteria: None,
                    optional: false,
                    secret: false,
                    value: None,
                    error: None,
                    metadata: None,
                },
            ],
        )],
        current_step_index: 0,
        status: FormStatus::Active,
        created_at: Utc::now(),
        updated_at: Utc::now(),
        completed_at: None,
        agent_id: Uuid::new_v4(),
        metadata: None,
    };

    let result = FormsContextProvider::generate_context(&[&form]);

    // Check text contains expected content
    assert!(result.text.contains("[FORMS]"));
    assert!(result.text.contains("test_form"));
    assert!(result.text.contains("Step 1"));
    assert!(result.text.contains("John")); // Completed field value
    assert!(result.text.contains("Email")); // Remaining required field

    // Check values
    assert!(result.values.contains_key("activeFormsCount"));

    // Check data
    assert!(result.data.contains_key("forms"));
}
