//! Auto-generated canonical action/provider/evaluator docs for plugin-n8n.
//! DO NOT EDIT - Generated from prompts/specs/**.

pub const CORE_ACTION_DOCS_JSON: &str = r#"{
  "version": "1.0.0",
  "actions": [
    {
      "name": "CREATE_PLUGIN",
      "description": "Create an elizaOS plugin from a structured JSON specification. Use this when the user provides a complete plugin spec as JSON. Do NOT use for n8n workflow creation.",
      "similes": [
        "create plugin",
        "build plugin",
        "generate plugin"
      ],
      "parameters": [],
      "examples": [
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "Create a plugin for managing user preferences"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "I'll create a user preferences management plugin for you.",
              "actions": [
                "CREATE_PLUGIN"
              ]
            }
          }
        ]
      ]
    },
    {
      "name": "CHECK_PLUGIN_STATUS",
      "description": "Check the progress of an active plugin creation job. Do NOT use for n8n workflow status.",
      "similes": [
        "plugin status",
        "check plugin progress",
        "plugin creation status",
        "get plugin status"
      ],
      "parameters": [],
      "examples": [
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "What's the status of my plugin creation?"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "Let me check the status of your plugin creation job...",
              "actions": [
                "CHECK_PLUGIN_STATUS"
              ]
            }
          }
        ]
      ]
    },
    {
      "name": "CANCEL_PLUGIN",
      "description": "Cancel an active plugin creation job. Do NOT use to cancel n8n workflow drafts.",
      "similes": [
        "stop plugin creation",
        "abort plugin creation",
        "cancel plugin"
      ],
      "parameters": [],
      "examples": [
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "Cancel the plugin creation"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "I'll cancel the current plugin creation job.",
              "actions": [
                "CANCEL_PLUGIN"
              ]
            }
          }
        ]
      ]
    },
    {
      "name": "DESCRIBE_PLUGIN",
      "description": "Generate and create an elizaOS plugin from a natural language description. Do NOT use for n8n workflow creation.",
      "similes": [
        "describe plugin",
        "plugin from description",
        "explain plugin",
        "I need a plugin that"
      ],
      "parameters": [],
      "examples": [
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "I need a plugin that helps manage todo lists with add, remove, and list functionality"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "I'll create a todo list management plugin based on your description.",
              "actions": [
                "DESCRIBE_PLUGIN"
              ]
            }
          }
        ]
      ]
    }
  ]
}"#;
pub const ALL_ACTION_DOCS_JSON: &str = r#"{
  "version": "1.0.0",
  "actions": [
    {
      "name": "CREATE_PLUGIN",
      "description": "Create an elizaOS plugin from a structured JSON specification. Use this when the user provides a complete plugin spec as JSON. Do NOT use for n8n workflow creation.",
      "similes": [
        "create plugin",
        "build plugin",
        "generate plugin"
      ],
      "parameters": [],
      "examples": [
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "Create a plugin for managing user preferences"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "I'll create a user preferences management plugin for you.",
              "actions": [
                "CREATE_PLUGIN"
              ]
            }
          }
        ]
      ]
    },
    {
      "name": "CHECK_PLUGIN_STATUS",
      "description": "Check the progress of an active plugin creation job. Do NOT use for n8n workflow status.",
      "similes": [
        "plugin status",
        "check plugin progress",
        "plugin creation status",
        "get plugin status"
      ],
      "parameters": [],
      "examples": [
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "What's the status of my plugin creation?"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "Let me check the status of your plugin creation job...",
              "actions": [
                "CHECK_PLUGIN_STATUS"
              ]
            }
          }
        ]
      ]
    },
    {
      "name": "CANCEL_PLUGIN",
      "description": "Cancel an active plugin creation job. Do NOT use to cancel n8n workflow drafts.",
      "similes": [
        "stop plugin creation",
        "abort plugin creation",
        "cancel plugin"
      ],
      "parameters": [],
      "examples": [
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "Cancel the plugin creation"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "I'll cancel the current plugin creation job.",
              "actions": [
                "CANCEL_PLUGIN"
              ]
            }
          }
        ]
      ]
    },
    {
      "name": "DESCRIBE_PLUGIN",
      "description": "Generate and create an elizaOS plugin from a natural language description. Do NOT use for n8n workflow creation.",
      "similes": [
        "describe plugin",
        "plugin from description",
        "explain plugin",
        "I need a plugin that"
      ],
      "parameters": [],
      "examples": [
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "I need a plugin that helps manage todo lists with add, remove, and list functionality"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "I'll create a todo list management plugin based on your description.",
              "actions": [
                "DESCRIBE_PLUGIN"
              ]
            }
          }
        ]
      ]
    }
  ]
}"#;
pub const CORE_PROVIDER_DOCS_JSON: &str = r#"{
  "version": "1.0.0",
  "providers": [
    {
      "name": "n8n_plugin_status",
      "description": "Provides status of active plugin creation jobs",
      "dynamic": true
    },
    {
      "name": "n8n_plugin_registry",
      "description": "Provides information about all created plugins in the current session",
      "dynamic": true
    }
  ]
}"#;
pub const ALL_PROVIDER_DOCS_JSON: &str = r#"{
  "version": "1.0.0",
  "providers": [
    {
      "name": "n8n_plugin_status",
      "description": "Provides status of active plugin creation jobs",
      "dynamic": true
    },
    {
      "name": "n8n_plugin_registry",
      "description": "Provides information about all created plugins in the current session",
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
