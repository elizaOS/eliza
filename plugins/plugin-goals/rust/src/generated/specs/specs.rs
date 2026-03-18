//! Auto-generated canonical action/provider/evaluator docs for plugin-goals.
//! DO NOT EDIT - Generated from prompts/specs/**.

pub const CORE_ACTION_DOCS_JSON: &str = r#"{
  "version": "1.0.0",
  "actions": [
    {
      "name": "CANCEL_GOAL",
      "description": "Cancels and removes a goal from tracking.",
      "similes": [
        "DELETE_GOAL",
        "REMOVE_GOAL",
        "DROP_GOAL",
        "STOP_TRACKING"
      ],
      "parameters": [],
      "examples": [
        [
          {
            "name": "Alice",
            "content": {
              "text": "Cancel my goal to learn guitar",
              "source": "user"
            }
          },
          {
            "name": "Agent",
            "content": {
              "text": "Cancelled goal: \"Learn guitar\"",
              "actions": [
                "CANCEL_GOAL"
              ]
            }
          }
        ]
      ]
    },
    {
      "name": "CREATE_GOAL",
      "description": "Creates a new long-term achievable goal for the agent or a user.",
      "similes": [
        "ADD_GOAL",
        "NEW_GOAL",
        "SET_GOAL",
        "TRACK_GOAL"
      ],
      "parameters": [],
      "examples": [
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "I want to set a goal to learn French fluently"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "New goal created: \"Learn French fluently\"",
              "actions": [
                "CREATE_GOAL_SUCCESS"
              ]
            }
          }
        ],
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "Add a goal for me to run a marathon"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "New goal created: \"Run a marathon\"",
              "actions": [
                "CREATE_GOAL_SUCCESS"
              ]
            }
          }
        ]
      ]
    },
    {
      "name": "UPDATE_GOAL",
      "description": "Updates an existing goal's name or description.",
      "similes": [
        "EDIT_GOAL",
        "MODIFY_GOAL",
        "CHANGE_GOAL",
        "RENAME_GOAL"
      ],
      "parameters": [],
      "examples": [
        [
          {
            "name": "Alice",
            "content": {
              "text": "Rename my reading goal to 'Read 30 books this year'",
              "source": "user"
            }
          },
          {
            "name": "Agent",
            "content": {
              "text": "Updated goal: \"Read 30 books this year\"",
              "actions": [
                "UPDATE_GOAL"
              ]
            }
          }
        ],
        [
          {
            "name": "Bob",
            "content": {
              "text": "Change my exercise goal description to include swimming",
              "source": "user"
            }
          },
          {
            "name": "Agent",
            "content": {
              "text": "Updated goal description.",
              "actions": [
                "UPDATE_GOAL"
              ]
            }
          }
        ]
      ]
    },
    {
      "name": "CONFIRM_GOAL",
      "description": "Confirms or cancels a pending goal creation after user review.",
      "similes": [
        "CONFIRM_TASK",
        "APPROVE_GOAL",
        "APPROVE_TASK",
        "GOAL_CONFIRM"
      ],
      "parameters": [],
      "examples": [
        [
          {
            "name": "User",
            "content": {
              "text": "Yes, that looks good",
              "source": "user"
            }
          },
          {
            "name": "Agent",
            "content": {
              "text": "Created task: 'Finish taxes'",
              "actions": [
                "CONFIRM_GOAL_SUCCESS"
              ]
            }
          }
        ]
      ]
    },
    {
      "name": "COMPLETE_GOAL",
      "description": "Marks a goal as completed/achieved.",
      "similes": [
        "ACHIEVE_GOAL",
        "FINISH_GOAL",
        "CHECK_OFF_GOAL",
        "ACCOMPLISH_GOAL"
      ],
      "parameters": [],
      "examples": [
        [
          {
            "name": "Alice",
            "content": {
              "text": "I've completed my goal of learning French fluently!",
              "source": "user"
            }
          },
          {
            "name": "Agent",
            "content": {
              "text": "Congratulations! User goal achieved: \"Learn French fluently\"!",
              "actions": [
                "COMPLETE_GOAL"
              ]
            }
          }
        ],
        [
          {
            "name": "Bob",
            "content": {
              "text": "I finally achieved my marathon goal!",
              "source": "user"
            }
          },
          {
            "name": "Agent",
            "content": {
              "text": "Congratulations! User goal achieved: \"Run a marathon\"!",
              "actions": [
                "COMPLETE_GOAL"
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
      "name": "CANCEL_GOAL",
      "description": "Cancels and removes a goal from tracking.",
      "similes": [
        "DELETE_GOAL",
        "REMOVE_GOAL",
        "DROP_GOAL",
        "STOP_TRACKING"
      ],
      "parameters": [],
      "examples": [
        [
          {
            "name": "Alice",
            "content": {
              "text": "Cancel my goal to learn guitar",
              "source": "user"
            }
          },
          {
            "name": "Agent",
            "content": {
              "text": "Cancelled goal: \"Learn guitar\"",
              "actions": [
                "CANCEL_GOAL"
              ]
            }
          }
        ]
      ]
    },
    {
      "name": "CREATE_GOAL",
      "description": "Creates a new long-term achievable goal for the agent or a user.",
      "similes": [
        "ADD_GOAL",
        "NEW_GOAL",
        "SET_GOAL",
        "TRACK_GOAL"
      ],
      "parameters": [],
      "examples": [
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "I want to set a goal to learn French fluently"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "New goal created: \"Learn French fluently\"",
              "actions": [
                "CREATE_GOAL_SUCCESS"
              ]
            }
          }
        ],
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "Add a goal for me to run a marathon"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "New goal created: \"Run a marathon\"",
              "actions": [
                "CREATE_GOAL_SUCCESS"
              ]
            }
          }
        ]
      ]
    },
    {
      "name": "UPDATE_GOAL",
      "description": "Updates an existing goal's name or description.",
      "similes": [
        "EDIT_GOAL",
        "MODIFY_GOAL",
        "CHANGE_GOAL",
        "RENAME_GOAL"
      ],
      "parameters": [],
      "examples": [
        [
          {
            "name": "Alice",
            "content": {
              "text": "Rename my reading goal to 'Read 30 books this year'",
              "source": "user"
            }
          },
          {
            "name": "Agent",
            "content": {
              "text": "Updated goal: \"Read 30 books this year\"",
              "actions": [
                "UPDATE_GOAL"
              ]
            }
          }
        ],
        [
          {
            "name": "Bob",
            "content": {
              "text": "Change my exercise goal description to include swimming",
              "source": "user"
            }
          },
          {
            "name": "Agent",
            "content": {
              "text": "Updated goal description.",
              "actions": [
                "UPDATE_GOAL"
              ]
            }
          }
        ]
      ]
    },
    {
      "name": "CONFIRM_GOAL",
      "description": "Confirms or cancels a pending goal creation after user review.",
      "similes": [
        "CONFIRM_TASK",
        "APPROVE_GOAL",
        "APPROVE_TASK",
        "GOAL_CONFIRM"
      ],
      "parameters": [],
      "examples": [
        [
          {
            "name": "User",
            "content": {
              "text": "Yes, that looks good",
              "source": "user"
            }
          },
          {
            "name": "Agent",
            "content": {
              "text": "Created task: 'Finish taxes'",
              "actions": [
                "CONFIRM_GOAL_SUCCESS"
              ]
            }
          }
        ]
      ]
    },
    {
      "name": "COMPLETE_GOAL",
      "description": "Marks a goal as completed/achieved.",
      "similes": [
        "ACHIEVE_GOAL",
        "FINISH_GOAL",
        "CHECK_OFF_GOAL",
        "ACCOMPLISH_GOAL"
      ],
      "parameters": [],
      "examples": [
        [
          {
            "name": "Alice",
            "content": {
              "text": "I've completed my goal of learning French fluently!",
              "source": "user"
            }
          },
          {
            "name": "Agent",
            "content": {
              "text": "Congratulations! User goal achieved: \"Learn French fluently\"!",
              "actions": [
                "COMPLETE_GOAL"
              ]
            }
          }
        ],
        [
          {
            "name": "Bob",
            "content": {
              "text": "I finally achieved my marathon goal!",
              "source": "user"
            }
          },
          {
            "name": "Agent",
            "content": {
              "text": "Congratulations! User goal achieved: \"Run a marathon\"!",
              "actions": [
                "COMPLETE_GOAL"
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
      "name": "GOALS",
      "description": "Provides information about active goals and recent achievements",
      "dynamic": true
    }
  ]
}"#;
pub const ALL_PROVIDER_DOCS_JSON: &str = r#"{
  "version": "1.0.0",
  "providers": [
    {
      "name": "GOALS",
      "description": "Provides information about active goals and recent achievements",
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
