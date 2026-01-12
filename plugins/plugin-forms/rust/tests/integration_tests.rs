//! Integration tests for forms plugin.

use elizaos_plugin_forms::{
    FormField, FormFieldType, FormStatus, FormStep, FormTemplate,
    FieldValue, FieldError, FormUpdateResult,
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
    assert_eq!(field.criteria, Some("Must be at least 8 characters".to_string()));
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
    
    let template = FormTemplate::new("Contact Form", steps)
        .with_description("A simple contact form");
    
    assert_eq!(template.name, "Contact Form");
    assert_eq!(template.description, Some("A simple contact form".to_string()));
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
