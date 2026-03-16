//! Action specs for plugin-prose

use std::collections::HashMap;
use std::sync::LazyLock;

/// Action specification
#[derive(Debug, Clone)]
pub struct ActionSpec {
    pub name: &'static str,
    pub description: &'static str,
    pub similes: Vec<&'static str>,
    pub examples: Vec<Vec<(&'static str, &'static str)>>,
}

pub static ACTION_SPECS: LazyLock<HashMap<&'static str, ActionSpec>> = LazyLock::new(|| {
    let mut map = HashMap::new();

    map.insert(
        "PROSE_RUN",
        ActionSpec {
            name: "PROSE_RUN",
            description: "Run an OpenProse program (.prose file). OpenProse is a programming language for AI sessions that orchestrates multi-agent workflows.",
            similes: vec!["RUN_PROSE", "EXECUTE_PROSE", "PROSE_EXECUTE", "RUN_WORKFLOW", "ORCHESTRATE"],
            examples: vec![
                vec![
                    ("user", "Run the hello world prose program"),
                    ("assistant", "Loading the OpenProse VM and executing hello-world.prose..."),
                ],
                vec![
                    ("user", "prose run examples/37-the-forge.prose"),
                    ("assistant", "Starting The Forge - this program will orchestrate building a web browser from scratch."),
                ],
            ],
        },
    );

    map.insert(
        "PROSE_COMPILE",
        ActionSpec {
            name: "PROSE_COMPILE",
            description: "Validate an OpenProse program without executing it. Checks syntax and structure.",
            similes: vec!["VALIDATE_PROSE", "CHECK_PROSE", "PROSE_VALIDATE", "PROSE_CHECK"],
            examples: vec![
                vec![
                    ("user", "Check if my workflow.prose file is valid"),
                    ("assistant", "Validating workflow.prose... The program is syntactically correct."),
                ],
            ],
        },
    );

    map.insert(
        "PROSE_HELP",
        ActionSpec {
            name: "PROSE_HELP",
            description: "Get help with OpenProse syntax, commands, and examples. Shows available programs and guidance.",
            similes: vec!["PROSE_EXAMPLES", "PROSE_SYNTAX", "PROSE_DOCS", "HELP_PROSE"],
            examples: vec![
                vec![
                    ("user", "How do I write a prose program?"),
                    ("assistant", "OpenProse programs use sessions to spawn AI agents. Here's the basic syntax..."),
                ],
            ],
        },
    );

    map
});

/// Get an action spec by name, panicking if not found
pub fn require_action_spec(name: &str) -> &'static ActionSpec {
    ACTION_SPECS
        .get(name)
        .unwrap_or_else(|| panic!("Action spec not found: {}", name))
}
