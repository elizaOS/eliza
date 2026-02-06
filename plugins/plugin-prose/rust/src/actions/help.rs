//! PROSE_HELP action for getting OpenProse help and examples

use async_trait::async_trait;
use serde_json::{json, Value};
use tracing::info;

use crate::generated::specs::require_action_spec;
use crate::services::ProseService;
use crate::{Action, ActionExample, ActionResult};

const QUICK_REFERENCE: &str = r#"# OpenProse Quick Reference

OpenProse is a programming language for AI sessions. Programs define agents and sessions
that coordinate multi-agent workflows.

## Basic Syntax

```prose
# Program composition
program "name" version "1.0" {
    description "..."
    required_capabilities [capability1, capability2]
    
    define Agent researcher {
        system_prompt """..."""
        tools [browse, search]
    }
    
    session main(inputs) -> outputs {
        // Use agents to perform tasks
        result <- researcher.complete("Research this topic")
        return { summary: result }
    }
}
```

## Commands

- `prose run <file.prose>` - Execute a program
- `prose compile <file.prose>` - Validate without running
- `prose help` - Show this help
- `prose examples` - List available examples

## Session Primitives

- `agent.complete(prompt)` - Run agent to completion
- `agent.stream(prompt)` - Stream agent response
- `session.spawn(inputs)` - Fork a subsession
- `await session_ref` - Wait for session result

## State Management

Programs can use different state backends:
- **filesystem** (default) - State stored in .prose/runs/
- **in-context** - State in conversation memory
- **sqlite** - SQLite database
- **postgres** - PostgreSQL database

## More Information

Use `prose examples` to see available example programs.
Each example demonstrates different OpenProse features.
"#;

/// Action to get help with OpenProse
pub struct ProseHelpAction {
    name: &'static str,
    description: &'static str,
    similes: Vec<&'static str>,
    examples: Vec<ActionExample>,
}

impl ProseHelpAction {
    pub fn new() -> Self {
        let spec = require_action_spec("PROSE_HELP");
        Self {
            name: spec.name,
            description: spec.description,
            similes: spec.similes.clone(),
            examples: spec
                .examples
                .iter()
                .map(|ex| ActionExample {
                    user_message: ex[0].1.to_string(),
                    agent_response: ex[1].1.to_string(),
                })
                .collect(),
        }
    }
}

impl Default for ProseHelpAction {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Action for ProseHelpAction {
    fn name(&self) -> &str {
        self.name
    }

    fn similes(&self) -> Vec<&str> {
        self.similes.clone()
    }

    fn description(&self) -> &str {
        self.description
    }

    async fn validate(&self, message: &Value, _state: &Value) -> bool {
        let content = message
            .get("content")
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("");

        let lower = content.to_lowercase();

        lower.contains("prose help")
            || lower.contains("prose examples")
            || lower.contains("prose syntax")
            || (lower.contains("how do i write") && lower.contains("prose"))
            || lower.contains("what is openprose")
            || lower.contains("openprose tutorial")
    }

    async fn handler(
        &self,
        message: &Value,
        _state: &Value,
        service: Option<&mut ProseService>,
    ) -> ActionResult {
        let content = message
            .get("content")
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("");

        let lower = content.to_lowercase();

        let is_examples_request = lower.contains("examples");
        let is_syntax_request = lower.contains("syntax");
        let is_guidance_request =
            lower.contains("how do i write") || lower.contains("tutorial") || lower.contains("patterns");

        let mut parts = Vec::new();

        // Always include quick reference (unless examples only)
        if !is_examples_request {
            if let Some(svc) = &service {
                let help_doc = svc.get_help();
                if let Some(help) = help_doc {
                    if is_syntax_request || is_guidance_request {
                        parts.push(help);
                    } else {
                        parts.push(QUICK_REFERENCE.to_string());
                    }
                } else {
                    parts.push(QUICK_REFERENCE.to_string());
                }
            } else {
                parts.push(QUICK_REFERENCE.to_string());
            }
        }

        // Include authoring guidance if requested
        if is_guidance_request {
            if let Some(svc) = &service {
                let (patterns, antipatterns) = svc.get_authoring_guidance();
                if let Some(p) = patterns {
                    parts.push("\n## Authoring Patterns\n".to_string());
                    parts.push(p);
                }
                if let Some(ap) = antipatterns {
                    parts.push("\n## Antipatterns to Avoid\n".to_string());
                    parts.push(ap);
                }
            }
        }

        // List examples
        if is_examples_request {
            parts.push("# Available OpenProse Examples\n".to_string());

            if let Some(svc) = service {
                let examples = svc.list_examples().await;

                if !examples.is_empty() {
                    parts.push("The following example programs are available:\n".to_string());
                    for ex in &examples {
                        parts.push(format!("- `{}`", ex));
                    }
                    parts.push("\nRun an example with: `prose run examples/<name>`".to_string());
                } else {
                    parts.push("No example programs found in the skills directory.".to_string());
                    parts.push(
                        "\nExamples should be placed in the `examples/` subdirectory of the prose skill."
                            .to_string(),
                    );
                }
            }

            // Add some inline examples
            parts.push("\n## Example Programs\n".to_string());
            parts.push("Here are some example patterns you can use:\n".to_string());

            parts.push("### Hello World\n".to_string());
            parts.push(
                r#"```prose
program "hello" version "1.0" {
    description "A simple hello world program"
    
    define Agent greeter {
        system_prompt "You are a friendly greeter."
    }
    
    session main() -> result {
        greeting <- greeter.complete("Say hello to the user")
        return { message: greeting }
    }
}
```
"#
                .to_string(),
            );

            parts.push("### Multi-Agent Research\n".to_string());
            parts.push(
                r#"```prose
program "research" version "1.0" {
    description "Multi-agent research workflow"
    required_capabilities [browse, search]
    
    define Agent researcher {
        system_prompt "You research topics thoroughly."
        tools [search, browse]
    }
    
    define Agent writer {
        system_prompt "You write clear summaries."
    }
    
    session main(topic: string) -> report {
        findings <- researcher.complete("Research: " + topic)
        summary <- writer.complete("Summarize: " + findings)
        return { topic: topic, summary: summary }
    }
}
```
"#
                .to_string(),
            );
        }

        info!("Provided help for: {}", lower);

        ActionResult {
            success: true,
            text: parts.join("\n"),
            data: Some(json!({})),
            error: None,
        }
    }

    fn examples(&self) -> Vec<ActionExample> {
        self.examples.clone()
    }
}
