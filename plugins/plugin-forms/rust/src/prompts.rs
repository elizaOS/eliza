//! Shared XML prompts for the elizaOS Forms Plugin.
//!
//! These prompts are auto-generated from prompts/*.txt files.
//! DO NOT EDIT - Generated from ../../typescript/generated/prompts/rust/prompts.rs
//!
//! To modify prompts, edit the .txt files in prompts/ and run:
//!   npm run build:prompts
//!
//! The generated prompts.rs file should be copied to this location during build.

// Include the generated prompts module
mod generated;

// Re-export the generated prompts
pub use generated::prompts::*;

// Re-export for backwards compatibility  
pub use FORM_EXTRACTION_TEMPLATE as FORM_EXTRACTION_PROMPT;
pub use FORM_CREATION_TEMPLATE as FORM_CREATION_PROMPT;

/// Field information for prompt building.
pub struct FieldInfo<'a> {
    pub id: &'a str,
    pub field_type: &'a str,
    pub label: &'a str,
    pub description: Option<&'a str>,
    pub criteria: Option<&'a str>,
}

/// Build the form extraction prompt with the given user message and fields.
pub fn build_extraction_prompt(user_message: &str, fields: &[FieldInfo<'_>]) -> String {
    let field_descriptions: String = fields
        .iter()
        .map(|f| {
            let criteria_attr = f.criteria.map(|c| format!(r#" criteria="{}""#, c)).unwrap_or_default();
            let desc = f.description.unwrap_or("");
            format!(
                r#"  <field id="{}" type="{}" label="{}"{}>{}  </field>"#,
                f.id, f.field_type, f.label, criteria_attr, desc
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    let field_templates: String = fields
        .iter()
        .map(|f| format!("  <{}>extracted value or omit if not found</{}>", f.id, f.id))
        .collect::<Vec<_>>()
        .join("\n");

    FORM_EXTRACTION_TEMPLATE
        .replace("{{user_message}}", user_message)
        .replace("{{field_descriptions}}", &field_descriptions)
        .replace("{{field_templates}}", &field_templates)
}

/// Build the form creation prompt with available form types.
pub fn build_creation_prompt(user_message: &str, available_types: &[&str]) -> String {
    let types_list: String = available_types
        .iter()
        .map(|t| format!("  <type>{}</type>", t))
        .collect::<Vec<_>>()
        .join("\n");

    FORM_CREATION_TEMPLATE
        .replace("{{user_message}}", user_message)
        .replace("{{available_types}}", &types_list)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_extraction_prompt() {
        let fields = vec![
            FieldInfo {
                id: "name",
                field_type: "text",
                label: "Name",
                description: Some("Your full name"),
                criteria: Some("First and last name"),
            },
            FieldInfo {
                id: "email",
                field_type: "email",
                label: "Email",
                description: Some("Your email address"),
                criteria: None,
            },
        ];

        let prompt = build_extraction_prompt("My name is John Doe", &fields);
        
        assert!(prompt.contains("My name is John Doe"));
        assert!(prompt.contains("name"));
        assert!(prompt.contains("email"));
        assert!(prompt.contains("First and last name"));
    }

    #[test]
    fn test_build_creation_prompt() {
        let types = vec!["contact", "feedback", "survey"];
        let prompt = build_creation_prompt("I need a contact form", &types);
        
        assert!(prompt.contains("I need a contact form"));
        assert!(prompt.contains("contact"));
        assert!(prompt.contains("feedback"));
        assert!(prompt.contains("survey"));
    }
}

