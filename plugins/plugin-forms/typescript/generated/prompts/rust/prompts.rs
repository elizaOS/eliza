//! Auto-generated prompt templates
//! DO NOT EDIT - Generated from ../../../../prompts/*.txt
//!
//! These prompts use Handlebars-style template syntax:
//! - {{variableName}} for simple substitution
//! - {{#each items}}...{{/each}} for iteration
//! - {{#if condition}}...{{/if}} for conditionals

pub const FORM_CREATION_TEMPLATE: &str = r#"# Task: Identify Form Type

## User Message
<user_message>
{{user_message}}
</user_message>

## Available Form Types
<form_types>
{{available_types}}
</form_types>

## Instructions
Analyze the user's message and determine which form type they want to create.
If the request doesn't match any available type, suggest the closest match.

Return your response in XML format:
<response>
  <form_type>the matched form type name</form_type>
  <confidence>high, medium, or low</confidence>
  <reasoning>brief explanation of why this type was selected</reasoning>
</response>"#;

pub const FORM_EXTRACTION_TEMPLATE: &str = r#"# Task: Extract Form Field Values

## User Message
<user_message>
{{user_message}}
</user_message>

## Fields to Extract
<fields>
{{field_descriptions}}
</fields>

## Instructions
Parse the user's message and extract values for the listed form fields.
Only extract values that are explicitly stated in the message.
If a value cannot be found, omit that field from the response.

Return your response in XML format:
<response>
{{field_templates}}
</response>

Be precise and extract only what is explicitly stated."#;

