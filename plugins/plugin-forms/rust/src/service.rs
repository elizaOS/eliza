#![allow(missing_docs)]

use async_trait::async_trait;
use chrono::Utc;
use regex::Regex;
use std::collections::HashMap;
use uuid::Uuid;

use crate::error::{FormsError, FormsResult};
use crate::prompts::{build_extraction_prompt, FieldInfo};
use crate::types::*;

#[async_trait]
pub trait Runtime: Send + Sync {
    fn agent_id(&self) -> Uuid;
    async fn use_model(
        &self,
        model_type: &str,
        params: &HashMap<String, serde_json::Value>,
    ) -> FormsResult<String>;
}

pub fn parse_key_value_xml(text: &str) -> Option<HashMap<String, String>> {
    // Try to extract content from <response>...</response> first
    let response_re = Regex::new(r"<response>([\s\S]*?)</response>").ok()?;
    let xml_content = if let Some(caps) = response_re.captures(text) {
        caps.get(1)?.as_str()
    } else {
        // Fall back to finding any root element
        // Note: Rust's regex crate doesn't support backreferences (\1), so we match
        // opening tag, content, and closing tag separately
        let root_re = Regex::new(r"<(\w+)>([\s\S]*?)</(\w+)>").ok()?;
        let caps = root_re.captures(text)?;
        // Verify opening and closing tags match
        let open_tag = caps.get(1)?.as_str();
        let close_tag = caps.get(3)?.as_str();
        if open_tag != close_tag {
            return None;
        }
        caps.get(2)?.as_str()
    };

    // Match simple XML elements: <tag>content</tag>
    // Note: We capture both opening and closing tag names and verify they match
    let child_re = Regex::new(r"<(\w+)>([^<]*)</(\w+)>").ok()?;
    let mut result = HashMap::new();

    for caps in child_re.captures_iter(xml_content) {
        if let (Some(open_match), Some(value_match), Some(close_match)) =
            (caps.get(1), caps.get(2), caps.get(3))
        {
            // Only accept if opening and closing tags match
            if open_match.as_str() != close_match.as_str() {
                continue;
            }

            let key = open_match.as_str().to_string();
            let mut value = value_match.as_str().trim().to_string();

            value = value
                .replace("&lt;", "<")
                .replace("&gt;", ">")
                .replace("&amp;", "&")
                .replace("&quot;", "\"")
                .replace("&apos;", "'");

            result.insert(key, value);
        }
    }

    if result.is_empty() {
        None
    } else {
        Some(result)
    }
}

pub struct FormsService<R: Runtime> {
    runtime: R,
    forms: HashMap<Uuid, Form>,
    templates: HashMap<String, FormTemplate>,
}

impl<R: Runtime> FormsService<R> {
    pub fn new(runtime: R) -> Self {
        let mut service = Self {
            runtime,
            forms: HashMap::new(),
            templates: HashMap::new(),
        };
        service.register_default_templates();
        service
    }

    fn register_default_templates(&mut self) {
        // Basic contact form template
        let contact = FormTemplate::new(
            "contact",
            vec![FormStep::new(
                "basic-info",
                "Basic Information",
                vec![
                    FormField::new("name", "Name", FormFieldType::Text)
                        .with_description("Your full name")
                        .with_criteria("First and last name"),
                    FormField::new("email", "Email", FormFieldType::Email)
                        .with_description("Your email address")
                        .with_criteria("Valid email format"),
                    FormField::new("message", "Message", FormFieldType::Textarea)
                        .with_description("Your message")
                        .optional(),
                ],
            )],
        )
        .with_description("Basic contact information form");

        self.templates.insert("contact".to_string(), contact);
    }

    pub fn create_form_from_template(
        &mut self,
        template_name: &str,
        metadata: Option<HashMap<String, serde_json::Value>>,
    ) -> FormsResult<Form> {
        let template = self
            .templates
            .get(template_name)
            .ok_or_else(|| FormsError::TemplateNotFound(template_name.to_string()))?
            .clone();

        let form = Form {
            id: Uuid::new_v4(),
            name: template.name,
            description: template.description,
            steps: template
                .steps
                .into_iter()
                .map(|mut step| {
                    step.completed = false;
                    step
                })
                .collect(),
            current_step_index: 0,
            status: FormStatus::Active,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            completed_at: None,
            agent_id: self.runtime.agent_id(),
            metadata,
        };

        self.forms.insert(form.id, form.clone());
        Ok(form)
    }

    pub async fn update_form(
        &mut self,
        form_id: Uuid,
        message_text: &str,
    ) -> FormsResult<FormUpdateResult> {
        let fields_to_extract: Vec<FormField> = {
            let form = self
                .forms
                .get(&form_id)
                .ok_or_else(|| FormsError::FormNotFound(form_id.to_string()))?;

            if form.status != FormStatus::Active {
                return Ok(FormUpdateResult::failure("Form is not active"));
            }

            let current_step = &form.steps[form.current_step_index];
            let required_fields: Vec<FormField> = current_step
                .fields
                .iter()
                .filter(|f| f.value.is_none() && !f.optional)
                .cloned()
                .collect();

            if !required_fields.is_empty() {
                required_fields
            } else {
                current_step
                    .fields
                    .iter()
                    .filter(|f| f.value.is_none())
                    .cloned()
                    .collect()
            }
        };

        let field_refs: Vec<&FormField> = fields_to_extract.iter().collect();
        let extracted = self.extract_form_values(message_text, &field_refs).await?;

        let form = self
            .forms
            .get_mut(&form_id)
            .ok_or_else(|| FormsError::FormNotFound(form_id.to_string()))?;

        let mut updated_fields = Vec::new();
        let mut errors = Vec::new();

        let current_step = &mut form.steps[form.current_step_index];

        let mut field_validations: Vec<(String, Result<FieldValue, String>)> = Vec::new();
        for field in &current_step.fields {
            if let Some(value) = extracted.get(&field.id) {
                let field_type = field.field_type;
                let validation_result = Self::validate_field_value_static(value, &field_type);
                field_validations.push((field.id.clone(), validation_result));
            }
        }

        for (field_id, validation_result) in field_validations {
            if let Some(field) = current_step.fields.iter_mut().find(|f| f.id == field_id) {
                match validation_result {
                    Ok(validated) => {
                        field.value = Some(validated);
                        field.error = None;
                        updated_fields.push(field_id);
                    }
                    Err(error) => {
                        field.error = Some(error.clone());
                        errors.push(FieldError {
                            field_id: field_id.clone(),
                            message: error,
                        });
                    }
                }
            }
        }

        let required_fields: Vec<_> = current_step.fields.iter().filter(|f| !f.optional).collect();
        let filled_required: Vec<_> = required_fields
            .iter()
            .filter(|f| f.value.is_some())
            .collect();
        let step_completed = filled_required.len() == required_fields.len();

        let mut form_completed = false;
        let message;

        if step_completed {
            current_step.completed = true;
            let completed_step_name = current_step.name.clone();

            if form.current_step_index < form.steps.len() - 1 {
                form.current_step_index += 1;
                let next_step_name = form.steps[form.current_step_index].name.clone();
                message = format!(
                    "Step \"{}\" completed. Moving to step \"{}\".",
                    completed_step_name, next_step_name
                );
            } else {
                form.status = FormStatus::Completed;
                form.completed_at = Some(Utc::now());
                form_completed = true;
                message = "Form completed successfully!".to_string();
            }
        } else {
            let missing: Vec<_> = required_fields
                .iter()
                .filter(|f| f.value.is_none())
                .map(|f| f.label.as_str())
                .collect();
            message = if missing.is_empty() {
                String::new()
            } else {
                format!("Please provide: {}", missing.join(", "))
            };
        }

        form.updated_at = Utc::now();
        let form_clone = form.clone();

        Ok(FormUpdateResult {
            success: true,
            form: Some(form_clone),
            updated_fields: Some(updated_fields),
            errors: if errors.is_empty() {
                None
            } else {
                Some(errors)
            },
            step_completed: Some(step_completed),
            form_completed: Some(form_completed),
            current_step: None,
            message: Some(message),
        })
    }

    async fn extract_form_values(
        &self,
        text: &str,
        fields: &[&FormField],
    ) -> FormsResult<HashMap<String, String>> {
        if fields.is_empty() {
            return Ok(HashMap::new());
        }

        let field_infos: Vec<FieldInfo<'_>> = fields
            .iter()
            .map(|f| FieldInfo {
                id: &f.id,
                field_type: match f.field_type {
                    FormFieldType::Text => "text",
                    FormFieldType::Number => "number",
                    FormFieldType::Email => "email",
                    FormFieldType::Tel => "tel",
                    FormFieldType::Url => "url",
                    FormFieldType::Textarea => "textarea",
                    FormFieldType::Choice => "choice",
                    FormFieldType::Checkbox => "checkbox",
                    FormFieldType::Date => "date",
                    FormFieldType::Time => "time",
                    FormFieldType::Datetime => "datetime",
                },
                label: &f.label,
                description: f.description.as_deref(),
                criteria: f.criteria.as_deref(),
            })
            .collect();

        let prompt = build_extraction_prompt(text, &field_infos);

        let mut params = HashMap::new();
        params.insert("prompt".to_string(), serde_json::Value::String(prompt));

        let response = self.runtime.use_model("TEXT_SMALL", &params).await?;

        parse_key_value_xml(&response)
            .ok_or_else(|| FormsError::ParseError("Failed to parse XML response".to_string()))
    }

    fn validate_field_value_static(
        value: &str,
        field_type: &FormFieldType,
    ) -> Result<FieldValue, String> {
        match field_type {
            FormFieldType::Number => value
                .parse::<f64>()
                .map(FieldValue::Number)
                .map_err(|_| "Must be a valid number".to_string()),
            FormFieldType::Email => {
                let val = value.trim();
                if val.contains('@') && val.contains('.') {
                    Ok(FieldValue::String(val.to_string()))
                } else {
                    Err("Must be a valid email address".to_string())
                }
            }
            FormFieldType::Url => {
                let val = value.trim();
                if val.starts_with("http://") || val.starts_with("https://") {
                    Ok(FieldValue::String(val.to_string()))
                } else {
                    Err("Must be a valid URL".to_string())
                }
            }
            FormFieldType::Tel => {
                let val = value.trim();
                if val.len() >= 7 {
                    Ok(FieldValue::String(val.to_string()))
                } else {
                    Err("Must be a valid phone number".to_string())
                }
            }
            FormFieldType::Checkbox => {
                let lower = value.to_lowercase();
                Ok(FieldValue::Boolean(
                    lower == "true" || lower == "1" || lower == "yes",
                ))
            }
            _ => Ok(FieldValue::String(value.trim().to_string())),
        }
    }

    pub fn list_forms(&self, status: Option<FormStatus>) -> Vec<&Form> {
        self.forms
            .values()
            .filter(|f| f.agent_id == self.runtime.agent_id())
            .filter(|f| status.is_none_or(|s| f.status == s))
            .collect()
    }

    /// Get a specific form by ID.
    pub fn get_form(&self, form_id: Uuid) -> Option<&Form> {
        self.forms
            .get(&form_id)
            .filter(|f| f.agent_id == self.runtime.agent_id())
    }

    pub fn cancel_form(&mut self, form_id: Uuid) -> bool {
        if let Some(form) = self.forms.get_mut(&form_id) {
            if form.agent_id == self.runtime.agent_id() {
                form.status = FormStatus::Cancelled;
                form.updated_at = Utc::now();
                return true;
            }
        }
        false
    }

    pub fn register_template(&mut self, template: FormTemplate) {
        self.templates.insert(template.name.clone(), template);
    }

    pub fn get_templates(&self) -> Vec<&FormTemplate> {
        self.templates.values().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_key_value_xml() {
        let xml = r#"<response>
            <name>John Doe</name>
            <email>john@example.com</email>
        </response>"#;

        let result = parse_key_value_xml(xml).unwrap();
        assert_eq!(result.get("name"), Some(&"John Doe".to_string()));
        assert_eq!(result.get("email"), Some(&"john@example.com".to_string()));
    }

    #[test]
    fn test_parse_key_value_xml_with_entities() {
        let xml = r#"<response>
            <text>Hello &amp; World</text>
        </response>"#;

        let result = parse_key_value_xml(xml).unwrap();
        assert_eq!(result.get("text"), Some(&"Hello & World".to_string()));
    }
}
