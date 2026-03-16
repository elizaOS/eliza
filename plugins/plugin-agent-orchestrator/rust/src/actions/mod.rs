//! Task management actions for the Agent Orchestrator plugin.

use regex::Regex;

/// Action definition
#[derive(Debug, Clone, Copy)]
pub struct ActionDef {
    pub name: &'static str,
    pub similes: &'static [&'static str],
    pub description: &'static str,
}

/// Extract search query from text by removing common action words
pub fn extract_query(text: &str) -> String {
    let text = text.to_lowercase();

    // Remove action words
    let action_words = Regex::new(
        r"\b(switch|select|go|change|search|find|pause|stop|halt|resume|restart|continue|start|run|begin|cancel|delete|remove|list|show|view)\b"
    ).unwrap();
    let text = action_words.replace_all(&text, "");

    // Remove filler words
    let filler_words =
        Regex::new(r"\b(about|for|named|called|with|to|my|your|our|this|current)\b").unwrap();
    let text = filler_words.replace_all(&text, "");

    // Remove task-related words
    let task_words = Regex::new(r"\b(task|tasks|the|a|an)\b").unwrap();
    let text = task_words.replace_all(&text, "");

    // Normalize whitespace
    let whitespace = Regex::new(r"\s+").unwrap();
    whitespace.replace_all(&text, " ").trim().to_string()
}

/// Action definitions
pub mod actions {
    use super::ActionDef;

    /// CREATE_TASK action
    pub const CREATE_TASK: ActionDef = ActionDef {
        name: "CREATE_TASK",
        similes: &["START_TASK", "SPAWN_TASK", "NEW_TASK", "BEGIN_TASK"],
        description: "Create an orchestrated background task to be executed by a selected agent provider.",
    };

    /// LIST_TASKS action
    pub const LIST_TASKS: ActionDef = ActionDef {
        name: "LIST_TASKS",
        similes: &["SHOW_TASKS", "GET_TASKS", "TASKS", "VIEW_TASKS"],
        description: "List tasks managed by the orchestrator.",
    };

    /// SWITCH_TASK action
    pub const SWITCH_TASK: ActionDef = ActionDef {
        name: "SWITCH_TASK",
        similes: &["SELECT_TASK", "SET_TASK", "CHANGE_TASK", "GO_TO_TASK"],
        description: "Switch the current task context to a different task.",
    };

    /// SEARCH_TASKS action
    pub const SEARCH_TASKS: ActionDef = ActionDef {
        name: "SEARCH_TASKS",
        similes: &["FIND_TASK", "LOOKUP_TASK"],
        description: "Search tasks by query.",
    };

    /// PAUSE_TASK action
    pub const PAUSE_TASK: ActionDef = ActionDef {
        name: "PAUSE_TASK",
        similes: &["STOP_TASK", "HALT_TASK"],
        description: "Pause a running task.",
    };

    /// RESUME_TASK action
    pub const RESUME_TASK: ActionDef = ActionDef {
        name: "RESUME_TASK",
        similes: &["CONTINUE_TASK", "RESTART_TASK", "RUN_TASK"],
        description: "Resume a paused task.",
    };

    /// CANCEL_TASK action
    pub const CANCEL_TASK: ActionDef = ActionDef {
        name: "CANCEL_TASK",
        similes: &["DELETE_TASK", "REMOVE_TASK", "ABORT_TASK"],
        description: "Cancel a task.",
    };
}

/// Validate CREATE_TASK action
pub fn validate_create_task(text: &str) -> bool {
    let text = text.to_lowercase();
    let has_explicit = text.contains("create task")
        || text.contains("new task")
        || text.contains("start a task");
    let has_intent = ["implement", "build", "create", "develop", "refactor", "fix", "add"]
        .iter()
        .any(|w| text.contains(w));
    has_explicit || has_intent
}

/// Validate LIST_TASKS action
pub fn validate_list_tasks(text: &str) -> bool {
    let text = text.to_lowercase();
    text.contains("list task")
        || text.contains("show task")
        || text == "tasks"
        || text.contains("my task")
}

/// Validate SWITCH_TASK action
pub fn validate_switch_task(text: &str) -> bool {
    let text = text.to_lowercase();
    text.contains("switch to task")
        || text.contains("select task")
        || (text.contains("task") && text.contains("switch"))
}

/// Validate SEARCH_TASKS action
pub fn validate_search_tasks(text: &str) -> bool {
    let text = text.to_lowercase();
    text.contains("search task")
        || text.contains("find task")
        || text.contains("look for task")
}

/// Validate PAUSE_TASK action
pub fn validate_pause_task(text: &str) -> bool {
    let text = text.to_lowercase();
    (text.contains("pause") || text.contains("stop") || text.contains("halt"))
        && text.contains("task")
}

/// Validate RESUME_TASK action
pub fn validate_resume_task(text: &str) -> bool {
    let text = text.to_lowercase();
    text.contains("task")
        && (text.contains("resume") || text.contains("restart") || text.contains("continue"))
}

/// Validate CANCEL_TASK action
pub fn validate_cancel_task(text: &str) -> bool {
    let text = text.to_lowercase();
    (text.contains("cancel") || text.contains("delete") || text.contains("remove"))
        && text.contains("task")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_query() {
        assert_eq!(extract_query("switch to task foo"), "foo");
        assert_eq!(extract_query("find my tasks about authentication"), "authentication");
        assert_eq!(extract_query("  pause   the   task  "), "");
    }

    #[test]
    fn test_validate_create_task() {
        assert!(validate_create_task("create task for login"));
        assert!(validate_create_task("implement user authentication"));
        assert!(!validate_create_task("what is the weather"));
    }

    #[test]
    fn test_validate_list_tasks() {
        assert!(validate_list_tasks("list tasks"));
        assert!(validate_list_tasks("show my tasks"));
        assert!(!validate_list_tasks("create a task"));
    }
}
