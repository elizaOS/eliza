//! Auto-generated canonical action/provider/evaluator docs for plugin-experience.
//! DO NOT EDIT - Generated from prompts/specs/**.

pub const CORE_ACTION_DOCS_JSON: &str = r#"{
  "version": "1.0.0",
  "actions": [
    {
      "name": "RECORD_EXPERIENCE",
      "description": "Record a learning or experience for future reference. Use this when the user explicitly asks you to remember something or when you've learned something important.",
      "similes": [
        "REMEMBER",
        "LEARN",
        "STORE_EXPERIENCE",
        "SAVE_EXPERIENCE",
        "RECORD_LEARNING"
      ],
      "parameters": [],
      "examples": [
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "Remember that installing dependencies is required for Python scripts"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "I'll record that experience. Learning: Need to install dependencies before running Python scripts.",
              "actions": [
                "RECORD_EXPERIENCE"
              ]
            }
          }
        ],
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "Remember that users prefer shorter responses"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "I'll remember that preference.",
              "actions": [
                "RECORD_EXPERIENCE"
              ]
            }
          }
        ],
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "What's 2+2?"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "2+2 equals 4."
            }
          }
        ],
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "Can you help me with math?"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "Of course! What math problem do you need help with?"
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
      "name": "RECORD_EXPERIENCE",
      "description": "Record a learning or experience for future reference. Use this when the user explicitly asks you to remember something or when you've learned something important.",
      "similes": [
        "REMEMBER",
        "LEARN",
        "STORE_EXPERIENCE",
        "SAVE_EXPERIENCE",
        "RECORD_LEARNING"
      ],
      "parameters": [],
      "examples": [
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "Remember that installing dependencies is required for Python scripts"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "I'll record that experience. Learning: Need to install dependencies before running Python scripts.",
              "actions": [
                "RECORD_EXPERIENCE"
              ]
            }
          }
        ],
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "Remember that users prefer shorter responses"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "I'll remember that preference.",
              "actions": [
                "RECORD_EXPERIENCE"
              ]
            }
          }
        ],
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "What's 2+2?"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "2+2 equals 4."
            }
          }
        ],
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "Can you help me with math?"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "Of course! What math problem do you need help with?"
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
      "name": "experienceProvider",
      "description": "Provides relevant past experiences and learnings for the current context",
      "dynamic": true
    }
  ]
}"#;
pub const ALL_PROVIDER_DOCS_JSON: &str = r#"{
  "version": "1.0.0",
  "providers": [
    {
      "name": "experienceProvider",
      "description": "Provides relevant past experiences and learnings for the current context",
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
