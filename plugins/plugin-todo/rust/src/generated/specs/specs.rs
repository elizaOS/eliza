//! Auto-generated canonical action/provider/evaluator docs for plugin-todo.
//! DO NOT EDIT - Generated from prompts/specs/**.

pub const CORE_ACTION_DOCS_JSON: &str = r#"{
  "version": "1.0.0",
  "actions": [
    {
      "name": "CANCEL_TODO",
      "description": "Cancels and deletes a todo item from the user",
      "similes": [
        "DELETE_TODO",
        "REMOVE_TASK",
        "DELETE_TASK",
        "REMOVE_TODO"
      ],
      "parameters": []
    },
    {
      "name": "COMPLETE_TODO",
      "description": "Marks a todo item as completed.",
      "similes": [
        "MARK_COMPLETE",
        "FINISH_TASK",
        "DONE",
        "TASK_DONE",
        "TASK_COMPLETED"
      ],
      "parameters": []
    },
    {
      "name": "CONFIRM_TODO",
      "description": "Confirms or cancels a pending todo creation after user review.",
      "similes": [
        "CONFIRM_TASK",
        "APPROVE_TODO",
        "APPROVE_TASK",
        "TODO_CONFIRM"
      ],
      "parameters": []
    },
    {
      "name": "CREATE_TODO",
      "description": "Creates a new todo item from a user description (daily, one-off, or aspirational) immediately.",
      "similes": [
        "ADD_TODO",
        "NEW_TASK",
        "ADD_TASK",
        "CREATE_TASK"
      ],
      "parameters": []
    },
    {
      "name": "UPDATE_TODO",
      "description": "Updates an existing todo item immediately based on user description.",
      "similes": [
        "EDIT_TODO",
        "MODIFY_TASK",
        "CHANGE_TASK",
        "MODIFY_TODO",
        "EDIT_TASK"
      ],
      "parameters": []
    }
  ]
}"#;
pub const ALL_ACTION_DOCS_JSON: &str = r#"{
  "version": "1.0.0",
  "actions": [
    {
      "name": "CANCEL_TODO",
      "description": "Cancels and deletes a todo item from the user",
      "similes": [
        "DELETE_TODO",
        "REMOVE_TASK",
        "DELETE_TASK",
        "REMOVE_TODO"
      ],
      "parameters": []
    },
    {
      "name": "COMPLETE_TODO",
      "description": "Marks a todo item as completed.",
      "similes": [
        "MARK_COMPLETE",
        "FINISH_TASK",
        "DONE",
        "TASK_DONE",
        "TASK_COMPLETED"
      ],
      "parameters": []
    },
    {
      "name": "CONFIRM_TODO",
      "description": "Confirms or cancels a pending todo creation after user review.",
      "similes": [
        "CONFIRM_TASK",
        "APPROVE_TODO",
        "APPROVE_TASK",
        "TODO_CONFIRM"
      ],
      "parameters": []
    },
    {
      "name": "CREATE_TODO",
      "description": "Creates a new todo item from a user description (daily, one-off, or aspirational) immediately.",
      "similes": [
        "ADD_TODO",
        "NEW_TASK",
        "ADD_TASK",
        "CREATE_TASK"
      ],
      "parameters": []
    },
    {
      "name": "UPDATE_TODO",
      "description": "Updates an existing todo item immediately based on user description.",
      "similes": [
        "EDIT_TODO",
        "MODIFY_TASK",
        "CHANGE_TASK",
        "MODIFY_TODO",
        "EDIT_TASK"
      ],
      "parameters": []
    }
  ]
}"#;
pub const CORE_PROVIDER_DOCS_JSON: &str = r#"{
  "version": "1.0.0",
  "providers": [
    {
      "name": "TODOS",
      "description": "Information about the user",
      "dynamic": true
    }
  ]
}"#;
pub const ALL_PROVIDER_DOCS_JSON: &str = r#"{
  "version": "1.0.0",
  "providers": [
    {
      "name": "TODOS",
      "description": "Information about the user",
      "dynamic": true
    }
  ]
}"#;
pub const CORE_EVALUATOR_DOCS_JSON: &str = r#"{
  "version": "1.0.0",
  "evaluators": []
}"#;
pub const ALL_EVALUATOR_DOCS_JSON: &str = r#"{
  "version": "1.0.0",
  "evaluators": []
}"#;
