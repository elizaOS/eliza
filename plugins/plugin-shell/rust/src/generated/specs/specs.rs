//! Auto-generated canonical action/provider/evaluator docs for plugin-shell.
//! DO NOT EDIT - Generated from prompts/specs/**.

pub const CORE_ACTION_DOCS_JSON: &str = r#"{
  "version": "1.0.0",
  "actions": [
    {
      "name": "CLEAR_SHELL_HISTORY",
      "description": "Clears the recorded history of shell commands for the current conversation",
      "similes": [
        "RESET_SHELL",
        "CLEAR_TERMINAL",
        "CLEAR_HISTORY",
        "RESET_HISTORY"
      ],
      "parameters": []
    },
    {
      "name": "EXECUTE_COMMAND",
      "description": "Execute shell commands including brew install, npm install, apt-get, system commands, file operations, directory navigation, and scripts.",
      "similes": [
        "RUN_COMMAND",
        "SHELL_COMMAND",
        "TERMINAL_COMMAND",
        "EXEC",
        "RUN",
        "EXECUTE",
        "CREATE_FILE",
        "WRITE_FILE",
        "MAKE_FILE",
        "INSTALL",
        "BREW_INSTALL",
        "NPM_INSTALL",
        "APT_INSTALL"
      ],
      "parameters": []
    }
  ]
}"#;
pub const ALL_ACTION_DOCS_JSON: &str = r#"{
  "version": "1.0.0",
  "actions": [
    {
      "name": "CLEAR_SHELL_HISTORY",
      "description": "Clears the recorded history of shell commands for the current conversation",
      "similes": [
        "RESET_SHELL",
        "CLEAR_TERMINAL",
        "CLEAR_HISTORY",
        "RESET_HISTORY"
      ],
      "parameters": []
    },
    {
      "name": "EXECUTE_COMMAND",
      "description": "Execute shell commands including brew install, npm install, apt-get, system commands, file operations, directory navigation, and scripts.",
      "similes": [
        "RUN_COMMAND",
        "SHELL_COMMAND",
        "TERMINAL_COMMAND",
        "EXEC",
        "RUN",
        "EXECUTE",
        "CREATE_FILE",
        "WRITE_FILE",
        "MAKE_FILE",
        "INSTALL",
        "BREW_INSTALL",
        "NPM_INSTALL",
        "APT_INSTALL"
      ],
      "parameters": []
    }
  ]
}"#;
pub const CORE_PROVIDER_DOCS_JSON: &str = r#"{
  "version": "1.0.0",
  "providers": [
    {
      "name": "SHELL_HISTORY",
      "description": "Provides recent shell command history, current working directory, and file operations within the restricted environment",
      "dynamic": true
    }
  ]
}"#;
pub const ALL_PROVIDER_DOCS_JSON: &str = r#"{
  "version": "1.0.0",
  "providers": [
    {
      "name": "SHELL_HISTORY",
      "description": "Provides recent shell command history, current working directory, and file operations within the restricted environment",
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
