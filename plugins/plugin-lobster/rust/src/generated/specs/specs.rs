//! Action specs for plugin-lobster

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
        "LOBSTER_RUN",
        ActionSpec {
            name: "LOBSTER_RUN",
            description: "Run a Lobster pipeline. Lobster is a workflow runtime for executing multi-step pipelines with approval checkpoints.",
            similes: vec!["RUN_PIPELINE", "START_LOBSTER", "EXECUTE_PIPELINE", "LOBSTER_EXECUTE"],
            examples: vec![
                vec![
                    ("user", "Run the deploy pipeline"),
                    ("assistant", "Starting the deploy pipeline with Lobster..."),
                ],
                vec![
                    ("user", "lobster run build-workflow"),
                    ("assistant", "Executing the build-workflow pipeline..."),
                ],
            ],
        },
    );

    map.insert(
        "LOBSTER_RESUME",
        ActionSpec {
            name: "LOBSTER_RESUME",
            description: "Resume a paused Lobster pipeline by approving or rejecting the pending step.",
            similes: vec!["APPROVE_PIPELINE", "RESUME_PIPELINE", "CONTINUE_LOBSTER", "LOBSTER_APPROVE"],
            examples: vec![
                vec![
                    ("user", "Yes, approve it"),
                    ("assistant", "Approving the pending step and resuming the pipeline..."),
                ],
                vec![
                    ("user", "No, cancel the deployment"),
                    ("assistant", "Rejecting the step and cancelling the pipeline..."),
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
