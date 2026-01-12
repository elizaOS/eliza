use crate::types::{Form, FormStatus};
use std::collections::HashMap;

pub trait Provider: Send + Sync {
    fn name(&self) -> &'static str;
    fn description(&self) -> &'static str;
    fn dynamic(&self) -> bool;
    fn position(&self) -> i32;
}

#[derive(Debug, Clone, Default)]
pub struct ProviderResult {
    pub text: String,
    pub values: HashMap<String, serde_json::Value>,
    pub data: HashMap<String, serde_json::Value>,
}

impl ProviderResult {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_text(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            values: HashMap::new(),
            data: HashMap::new(),
        }
    }
}

pub struct FormsContextProvider;

impl FormsContextProvider {
    pub fn generate_context(forms: &[&Form]) -> ProviderResult {
        if forms.is_empty() {
            return ProviderResult::new();
        }

        let mut context_text = String::from("[FORMS]\n");
        let mut serialized_forms = Vec::new();

        for form in forms {
            let current_step = &form.steps[form.current_step_index];
            context_text.push_str(&format!("\nActive Form: {} (ID: {})\n", form.name, form.id));
            context_text.push_str(&format!(
                "Current Step: {}\n",
                if current_step.name.is_empty() {
                    &current_step.id
                } else {
                    &current_step.name
                }
            ));

            let completed_fields: Vec<_> = current_step
                .fields
                .iter()
                .filter(|f| f.value.is_some())
                .collect();

            if !completed_fields.is_empty() {
                context_text.push_str("Completed fields:\n");
                for field in &completed_fields {
                    let display_value = if field.secret {
                        "[SECRET]".to_string()
                    } else {
                        format!("{:?}", field.value.as_ref().unwrap())
                    };
                    context_text.push_str(&format!("  - {}: {}\n", field.label, display_value));
                }
            }

            let remaining_required: Vec<_> = current_step
                .fields
                .iter()
                .filter(|f| !f.optional && f.value.is_none())
                .collect();

            if !remaining_required.is_empty() {
                context_text.push_str("Required fields:\n");
                for field in &remaining_required {
                    let desc = field
                        .description
                        .as_ref()
                        .map(|d| format!(" ({})", d))
                        .unwrap_or_default();
                    context_text.push_str(&format!("  - {}{}\n", field.label, desc));
                }
            }

            let optional_fields: Vec<_> = current_step
                .fields
                .iter()
                .filter(|f| f.optional && f.value.is_none())
                .collect();

            if !optional_fields.is_empty() {
                context_text.push_str("Optional fields:\n");
                for field in &optional_fields {
                    let desc = field
                        .description
                        .as_ref()
                        .map(|d| format!(" ({})", d))
                        .unwrap_or_default();
                    context_text.push_str(&format!("  - {}{}\n", field.label, desc));
                }
            }

            context_text.push_str(&format!(
                "Progress: Step {} of {}\n",
                form.current_step_index + 1,
                form.steps.len()
            ));

            let serialized = serde_json::json!({
                "id": form.id.to_string(),
                "name": form.name,
                "description": form.description,
                "status": match form.status {
                    FormStatus::Active => "active",
                    FormStatus::Completed => "completed",
                    FormStatus::Cancelled => "cancelled",
                },
                "currentStepIndex": form.current_step_index,
                "stepsCount": form.steps.len(),
                "createdAt": form.created_at.to_rfc3339(),
                "updatedAt": form.updated_at.to_rfc3339(),
            });
            serialized_forms.push(serialized);
        }

        let mut values = HashMap::new();
        values.insert(
            "activeFormsCount".to_string(),
            serde_json::Value::Number(forms.len().into()),
        );

        let mut data = HashMap::new();
        data.insert(
            "forms".to_string(),
            serde_json::Value::Array(serialized_forms),
        );

        ProviderResult {
            text: context_text,
            values,
            data,
        }
    }
}

impl Provider for FormsContextProvider {
    fn name(&self) -> &'static str {
        "FORMS_CONTEXT"
    }

    fn description(&self) -> &'static str {
        "Provides context about active forms and their current state"
    }

    fn dynamic(&self) -> bool {
        true
    }

    fn position(&self) -> i32 {
        50
    }
}

pub fn get_providers() -> Vec<Box<dyn Provider>> {
    vec![Box::new(FormsContextProvider)]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{FieldValue, FormField, FormFieldType, FormStep};
    use chrono::Utc;
    use uuid::Uuid;

    fn create_test_form() -> Form {
        Form {
            id: Uuid::new_v4(),
            name: "test_form".to_string(),
            description: Some("Test form".to_string()),
            steps: vec![FormStep {
                id: "step1".to_string(),
                name: "Step 1".to_string(),
                fields: vec![
                    FormField {
                        id: "name".to_string(),
                        label: "Name".to_string(),
                        field_type: FormFieldType::Text,
                        description: Some("Your full name".to_string()),
                        criteria: None,
                        optional: false,
                        secret: false,
                        value: Some(FieldValue::String("John Doe".to_string())),
                        error: None,
                        metadata: None,
                    },
                    FormField {
                        id: "email".to_string(),
                        label: "Email".to_string(),
                        field_type: FormFieldType::Email,
                        description: Some("Your email".to_string()),
                        criteria: None,
                        optional: false,
                        secret: false,
                        value: None,
                        error: None,
                        metadata: None,
                    },
                    FormField {
                        id: "password".to_string(),
                        label: "Password".to_string(),
                        field_type: FormFieldType::Text,
                        description: None,
                        criteria: None,
                        optional: false,
                        secret: true,
                        value: Some(FieldValue::String("secret123".to_string())),
                        error: None,
                        metadata: None,
                    },
                ],
                completed: false,
            }],
            current_step_index: 0,
            status: FormStatus::Active,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            completed_at: None,
            agent_id: Uuid::new_v4(),
            metadata: None,
        }
    }

    #[test]
    fn test_forms_context_provider_properties() {
        let provider = FormsContextProvider;
        assert_eq!(provider.name(), "FORMS_CONTEXT");
        assert!(provider.dynamic());
        assert_eq!(provider.position(), 50);
    }

    #[test]
    fn test_generate_context_empty() {
        let result = FormsContextProvider::generate_context(&[]);
        assert!(result.text.is_empty());
        assert!(result.values.is_empty());
        assert!(result.data.is_empty());
    }

    #[test]
    fn test_generate_context_with_forms() {
        let form = create_test_form();
        let result = FormsContextProvider::generate_context(&[&form]);

        // Check text contains expected content
        assert!(result.text.contains("[FORMS]"));
        assert!(result.text.contains("test_form"));
        assert!(result.text.contains("Step 1"));
        assert!(result.text.contains("John Doe"));
        assert!(result.text.contains("[SECRET]")); // Password should be masked
        assert!(result.text.contains("Email")); // Required field

        // Check values
        assert_eq!(
            result.values.get("activeFormsCount"),
            Some(&serde_json::Value::Number(1.into()))
        );

        // Check data contains forms array
        assert!(result.data.contains_key("forms"));
        if let Some(serde_json::Value::Array(forms)) = result.data.get("forms") {
            assert_eq!(forms.len(), 1);
        } else {
            panic!("Expected forms array in data");
        }
    }

    #[test]
    fn test_get_providers() {
        let providers = get_providers();
        assert_eq!(providers.len(), 1);
        assert_eq!(providers[0].name(), "FORMS_CONTEXT");
    }
}
