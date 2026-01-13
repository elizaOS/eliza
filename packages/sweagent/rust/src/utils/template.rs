//! Template rendering utilities for SWE-agent

use crate::exceptions::{Result, SWEAgentError};
use handlebars::Handlebars;
use serde::Serialize;
use std::collections::HashMap;

/// Render a simple template with variable substitution
pub fn render_template(template: &str, vars: &HashMap<String, String>) -> Result<String> {
    let mut result = template.to_string();

    for (key, value) in vars {
        // Replace {{key}} with value
        let pattern = format!("{{{{{}}}}}", key);
        result = result.replace(&pattern, value);

        // Also replace {{ key }} (with spaces)
        let pattern_spaced = format!("{{{{ {} }}}}", key);
        result = result.replace(&pattern_spaced, value);
    }

    Ok(result)
}

/// Render an advanced template using Handlebars
pub fn render_advanced_template<T: Serialize>(template: &str, data: &T) -> Result<String> {
    let mut handlebars = Handlebars::new();
    handlebars.set_strict_mode(false);

    // Register custom helpers
    register_custom_helpers(&mut handlebars);

    handlebars
        .render_template(template, data)
        .map_err(|e| SWEAgentError::TemplateError(e.to_string()))
}

/// Register custom Handlebars helpers
fn register_custom_helpers(handlebars: &mut Handlebars) {
    // Helper for slicing strings: {{slice observation 0 100}}
    handlebars.register_helper(
        "slice",
        Box::new(
            |h: &handlebars::Helper,
             _: &Handlebars,
             _: &handlebars::Context,
             _: &mut handlebars::RenderContext,
             out: &mut dyn handlebars::Output|
             -> handlebars::HelperResult {
                let value = h.param(0).and_then(|v| v.value().as_str()).unwrap_or("");
                let start: usize =
                    h.param(1).and_then(|v| v.value().as_u64()).unwrap_or(0) as usize;
                let end: usize = h
                    .param(2)
                    .and_then(|v| v.value().as_u64())
                    .map(|v| v as usize)
                    .unwrap_or(value.len());

                let sliced = &value[start.min(value.len())..end.min(value.len())];
                out.write(sliced)?;
                Ok(())
            },
        ),
    );

    // Helper for length: {{len observation}}
    handlebars.register_helper(
        "len",
        Box::new(
            |h: &handlebars::Helper,
             _: &Handlebars,
             _: &handlebars::Context,
             _: &mut handlebars::RenderContext,
             out: &mut dyn handlebars::Output|
             -> handlebars::HelperResult {
                let value = h.param(0).and_then(|v| v.value().as_str()).unwrap_or("");
                out.write(&value.len().to_string())?;
                Ok(())
            },
        ),
    );

    // Helper for subtraction: {{sub a b}}
    handlebars.register_helper(
        "sub",
        Box::new(
            |h: &handlebars::Helper,
             _: &Handlebars,
             _: &handlebars::Context,
             _: &mut handlebars::RenderContext,
             out: &mut dyn handlebars::Output|
             -> handlebars::HelperResult {
                let a: i64 = h.param(0).and_then(|v| v.value().as_i64()).unwrap_or(0);
                let b: i64 = h.param(1).and_then(|v| v.value().as_i64()).unwrap_or(0);
                out.write(&(a - b).to_string())?;
                Ok(())
            },
        ),
    );
}

/// Create a Handlebars instance with all registered helpers
pub fn create_handlebars() -> Handlebars<'static> {
    let mut handlebars = Handlebars::new();
    handlebars.set_strict_mode(false);
    register_custom_helpers(&mut handlebars);
    handlebars
}

/// Warn about probably wrong Jinja syntax in template
pub fn warn_probably_wrong_jinja_syntax(template: &str) -> Vec<String> {
    let mut warnings = Vec::new();

    // Check for Python-style string formatting
    if template.contains("{{") && template.contains("[:") {
        warnings.push(
            "Template contains Python-style slicing syntax. Use Handlebars slice helper instead."
                .to_string(),
        );
    }

    // Check for % formatting
    if template.contains("%(") && template.contains(")s") {
        warnings.push(
            "Template contains Python-style % formatting. Use Handlebars syntax.".to_string(),
        );
    }

    // Check for .format() style
    if template.contains("{0}") || template.contains("{1}") {
        warnings.push("Template contains Python .format() style placeholders.".to_string());
    }

    warnings
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_render_template() {
        let mut vars = HashMap::new();
        vars.insert("name".to_string(), "world".to_string());

        let result = render_template("Hello, {{name}}!", &vars).unwrap();
        assert_eq!(result, "Hello, world!");
    }

    #[test]
    fn test_render_advanced_template() {
        #[derive(Serialize)]
        struct Data {
            observation: String,
        }

        let data = Data {
            observation: "test output".to_string(),
        };

        let result = render_advanced_template("Result: {{observation}}", &data).unwrap();
        assert_eq!(result, "Result: test output");
    }

    #[test]
    fn test_warn_jinja_syntax() {
        let warnings = warn_probably_wrong_jinja_syntax("{{observation[:100]}}");
        assert!(!warnings.is_empty());

        let no_warnings = warn_probably_wrong_jinja_syntax("{{observation}}");
        assert!(no_warnings.is_empty());
    }
}
