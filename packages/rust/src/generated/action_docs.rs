//! Auto-generated canonical action/evaluator docs.
//! DO NOT EDIT - Generated from packages/prompts/specs/**.

pub const CORE_ACTION_DOCS_JSON: &str = r#"{
  "version": "1.0.0",
  "actions": [
    {
      "name": "REPLY",
      "description": "Send a text response back to the current conversation.",
      "similes": [
        "RESPOND",
        "ANSWER"
      ],
      "parameters": []
    },
    {
      "name": "IGNORE",
      "description": "Do not respond and do not take any further action.",
      "similes": [
        "NO_RESPONSE",
        "SILENT"
      ],
      "parameters": []
    },
    {
      "name": "NONE",
      "description": "Explicitly take no action. Use when an action list is required but nothing should be done.",
      "similes": [
        "NOOP"
      ],
      "parameters": []
    },
    {
      "name": "SEND_MESSAGE",
      "description": "Send a message to a user or room other than the current one.",
      "similes": [
        "DM",
        "MESSAGE",
        "SEND_DM",
        "POST_MESSAGE"
      ],
      "parameters": [
        {
          "name": "targetType",
          "description": "Whether the message target is a user or a room.",
          "required": true,
          "schema": {
            "type": "string",
            "enum": [
              "user",
              "room"
            ]
          },
          "examples": [
            "user",
            "room"
          ]
        },
        {
          "name": "source",
          "description": "The platform/source to send the message on (e.g. telegram, discord, x).",
          "required": false,
          "schema": {
            "type": "string"
          },
          "examples": [
            "telegram",
            "discord"
          ]
        },
        {
          "name": "target",
          "description": "Identifier of the target. For user targets, a name/handle/id; for room targets, a room name/id.",
          "required": true,
          "schema": {
            "type": "string"
          },
          "examples": [
            "dev_guru",
            "announcements"
          ]
        },
        {
          "name": "text",
          "description": "The message content to send.",
          "required": true,
          "schema": {
            "type": "string"
          },
          "examples": [
            "Hello!",
            "Important announcement!"
          ]
        }
      ],
      "exampleCalls": [
        {
          "user": "Send a message to @dev_guru on telegram saying \"Hello!\"",
          "actions": [
            "REPLY",
            "SEND_MESSAGE"
          ],
          "params": {
            "SEND_MESSAGE": {
              "targetType": "user",
              "source": "telegram",
              "target": "dev_guru",
              "text": "Hello!"
            }
          }
        }
      ]
    },
    {
      "name": "ADD_CONTACT",
      "description": "Add a new contact to the rolodex with basic details and notes.",
      "similes": [
        "CREATE_CONTACT",
        "NEW_CONTACT",
        "SAVE_CONTACT"
      ],
      "parameters": [
        {
          "name": "name",
          "description": "The contact's primary name.",
          "required": true,
          "schema": {
            "type": "string"
          },
          "examples": [
            "Sarah Chen"
          ]
        },
        {
          "name": "notes",
          "description": "Optional notes about the contact (short summary, context, or preferences).",
          "required": false,
          "schema": {
            "type": "string"
          },
          "examples": [
            "Met at the AI meetup; interested in agents"
          ]
        }
      ]
    },
    {
      "name": "UPDATE_CONTACT",
      "description": "Update an existing contact's details in the rolodex.",
      "similes": [
        "EDIT_CONTACT",
        "MODIFY_CONTACT"
      ],
      "parameters": [
        {
          "name": "name",
          "description": "The contact name to update (must match an existing contact).",
          "required": true,
          "schema": {
            "type": "string"
          },
          "examples": [
            "Sarah Chen"
          ]
        },
        {
          "name": "updates",
          "description": "A JSON object of fields to update (stringified JSON).",
          "required": true,
          "schema": {
            "type": "string"
          },
          "examples": [
            "{\"notes\":\"prefers email\",\"tags\":[\"friend\"]}"
          ]
        }
      ]
    },
    {
      "name": "REMOVE_CONTACT",
      "description": "Remove a contact from the rolodex.",
      "similes": [
        "DELETE_CONTACT"
      ],
      "parameters": [
        {
          "name": "name",
          "description": "The contact name to remove.",
          "required": true,
          "schema": {
            "type": "string"
          },
          "examples": [
            "Sarah Chen"
          ]
        }
      ]
    },
    {
      "name": "SEARCH_CONTACTS",
      "description": "Search contacts in the rolodex by name or query.",
      "similes": [
        "FIND_CONTACTS",
        "LOOKUP_CONTACTS"
      ],
      "parameters": [
        {
          "name": "query",
          "description": "Search query (name, handle, or free-text).",
          "required": true,
          "schema": {
            "type": "string"
          },
          "examples": [
            "sarah",
            "AI meetup"
          ]
        }
      ]
    },
    {
      "name": "SCHEDULE_FOLLOW_UP",
      "description": "Schedule a follow-up reminder for a contact.",
      "similes": [
        "REMIND_ME",
        "FOLLOW_UP"
      ],
      "parameters": [
        {
          "name": "name",
          "description": "Contact name to follow up with.",
          "required": true,
          "schema": {
            "type": "string"
          },
          "examples": [
            "Sarah Chen"
          ]
        },
        {
          "name": "when",
          "description": "When to follow up. Use an ISO-8601 datetime string.",
          "required": true,
          "schema": {
            "type": "string"
          },
          "examples": [
            "2026-02-01T09:00:00Z"
          ]
        },
        {
          "name": "reason",
          "description": "Optional reason/context for the follow-up.",
          "required": false,
          "schema": {
            "type": "string"
          },
          "examples": [
            "Check in about the agent framework demo"
          ]
        }
      ]
    },
    {
      "name": "CHOOSE_OPTION",
      "description": "Select an option for a pending task that has multiple options.",
      "similes": [
        "SELECT_OPTION",
        "PICK_OPTION"
      ],
      "parameters": [
        {
          "name": "taskId",
          "description": "The pending task id.",
          "required": true,
          "schema": {
            "type": "string"
          },
          "examples": [
            "c0a8012e"
          ]
        },
        {
          "name": "option",
          "description": "The selected option name exactly as listed.",
          "required": true,
          "schema": {
            "type": "string"
          },
          "examples": [
            "APPROVE",
            "ABORT"
          ]
        }
      ]
    },
    {
      "name": "FOLLOW_ROOM",
      "description": "Follow a room so the agent receives and processes messages from it.",
      "similes": [
        "SUBSCRIBE_ROOM"
      ],
      "parameters": [
        {
          "name": "roomId",
          "description": "The target room id to follow.",
          "required": true,
          "schema": {
            "type": "string"
          },
          "examples": [
            "00000000-0000-0000-0000-000000000000"
          ]
        }
      ]
    },
    {
      "name": "UNFOLLOW_ROOM",
      "description": "Unfollow a room so the agent stops receiving messages from it.",
      "similes": [
        "UNSUBSCRIBE_ROOM"
      ],
      "parameters": [
        {
          "name": "roomId",
          "description": "The target room id to unfollow.",
          "required": true,
          "schema": {
            "type": "string"
          },
          "examples": [
            "00000000-0000-0000-0000-000000000000"
          ]
        }
      ]
    },
    {
      "name": "MUTE_ROOM",
      "description": "Mute a room so the agent will not respond there.",
      "similes": [
        "SILENCE_ROOM"
      ],
      "parameters": [
        {
          "name": "roomId",
          "description": "The room id to mute.",
          "required": true,
          "schema": {
            "type": "string"
          },
          "examples": [
            "00000000-0000-0000-0000-000000000000"
          ]
        }
      ]
    },
    {
      "name": "UNMUTE_ROOM",
      "description": "Unmute a room so the agent may respond there again.",
      "similes": [
        "UNSILENCE_ROOM"
      ],
      "parameters": [
        {
          "name": "roomId",
          "description": "The room id to unmute.",
          "required": true,
          "schema": {
            "type": "string"
          },
          "examples": [
            "00000000-0000-0000-0000-000000000000"
          ]
        }
      ]
    },
    {
      "name": "UPDATE_SETTINGS",
      "description": "Update agent settings by applying explicit key/value updates.",
      "similes": [
        "SET_SETTINGS",
        "CHANGE_SETTINGS"
      ],
      "parameters": [
        {
          "name": "updates",
          "description": "A JSON array of {\"key\": string, \"value\": string} updates (stringified JSON).",
          "required": true,
          "schema": {
            "type": "string"
          },
          "examples": [
            "[{\"key\":\"model\",\"value\":\"gpt-5\"}]"
          ]
        }
      ]
    },
    {
      "name": "UPDATE_ROLE",
      "description": "Update a user's role.",
      "similes": [
        "SET_ROLE",
        "CHANGE_ROLE"
      ],
      "parameters": [
        {
          "name": "entityId",
          "description": "The entity id to update.",
          "required": true,
          "schema": {
            "type": "string"
          },
          "examples": [
            "00000000-0000-0000-0000-000000000000"
          ]
        },
        {
          "name": "role",
          "description": "The new role to assign.",
          "required": true,
          "schema": {
            "type": "string"
          },
          "examples": [
            "admin",
            "member"
          ]
        }
      ]
    },
    {
      "name": "UPDATE_ENTITY",
      "description": "Update stored entity information by applying explicit field updates.",
      "similes": [
        "EDIT_ENTITY",
        "MODIFY_ENTITY"
      ],
      "parameters": [
        {
          "name": "entityId",
          "description": "The entity id to update.",
          "required": true,
          "schema": {
            "type": "string"
          },
          "examples": [
            "00000000-0000-0000-0000-000000000000"
          ]
        },
        {
          "name": "updates",
          "description": "A JSON array of {\"name\": string, \"value\": string} field updates (stringified JSON).",
          "required": true,
          "schema": {
            "type": "string"
          },
          "examples": [
            "[{\"name\":\"bio\",\"value\":\"Loves Rust\"}]"
          ]
        }
      ]
    },
    {
      "name": "GENERATE_IMAGE",
      "description": "Generate an image based on the given prompt.",
      "similes": [
        "IMAGE",
        "DRAW",
        "CREATE_IMAGE"
      ],
      "parameters": [
        {
          "name": "prompt",
          "description": "Image generation prompt.",
          "required": true,
          "schema": {
            "type": "string"
          },
          "examples": [
            "A futuristic cityscape at sunset, cinematic lighting"
          ]
        }
      ]
    }
  ]
}"#;
pub const ALL_ACTION_DOCS_JSON: &str = r#"{
  "version": "1.0.0",
  "actions": [
    {
      "name": "REPLY",
      "description": "Send a text response back to the current conversation.",
      "similes": [
        "RESPOND",
        "ANSWER"
      ],
      "parameters": []
    },
    {
      "name": "IGNORE",
      "description": "Do not respond and do not take any further action.",
      "similes": [
        "NO_RESPONSE",
        "SILENT"
      ],
      "parameters": []
    },
    {
      "name": "NONE",
      "description": "Explicitly take no action. Use when an action list is required but nothing should be done.",
      "similes": [
        "NOOP"
      ],
      "parameters": []
    },
    {
      "name": "SEND_MESSAGE",
      "description": "Send a message to a user or room other than the current one.",
      "similes": [
        "DM",
        "MESSAGE",
        "SEND_DM",
        "POST_MESSAGE"
      ],
      "parameters": [
        {
          "name": "targetType",
          "description": "Whether the message target is a user or a room.",
          "required": true,
          "schema": {
            "type": "string",
            "enum": [
              "user",
              "room"
            ]
          },
          "examples": [
            "user",
            "room"
          ]
        },
        {
          "name": "source",
          "description": "The platform/source to send the message on (e.g. telegram, discord, x).",
          "required": false,
          "schema": {
            "type": "string"
          },
          "examples": [
            "telegram",
            "discord"
          ]
        },
        {
          "name": "target",
          "description": "Identifier of the target. For user targets, a name/handle/id; for room targets, a room name/id.",
          "required": true,
          "schema": {
            "type": "string"
          },
          "examples": [
            "dev_guru",
            "announcements"
          ]
        },
        {
          "name": "text",
          "description": "The message content to send.",
          "required": true,
          "schema": {
            "type": "string"
          },
          "examples": [
            "Hello!",
            "Important announcement!"
          ]
        }
      ],
      "exampleCalls": [
        {
          "user": "Send a message to @dev_guru on telegram saying \"Hello!\"",
          "actions": [
            "REPLY",
            "SEND_MESSAGE"
          ],
          "params": {
            "SEND_MESSAGE": {
              "targetType": "user",
              "source": "telegram",
              "target": "dev_guru",
              "text": "Hello!"
            }
          }
        }
      ]
    },
    {
      "name": "ADD_CONTACT",
      "description": "Add a new contact to the rolodex with basic details and notes.",
      "similes": [
        "CREATE_CONTACT",
        "NEW_CONTACT",
        "SAVE_CONTACT"
      ],
      "parameters": [
        {
          "name": "name",
          "description": "The contact's primary name.",
          "required": true,
          "schema": {
            "type": "string"
          },
          "examples": [
            "Sarah Chen"
          ]
        },
        {
          "name": "notes",
          "description": "Optional notes about the contact (short summary, context, or preferences).",
          "required": false,
          "schema": {
            "type": "string"
          },
          "examples": [
            "Met at the AI meetup; interested in agents"
          ]
        }
      ]
    },
    {
      "name": "UPDATE_CONTACT",
      "description": "Update an existing contact's details in the rolodex.",
      "similes": [
        "EDIT_CONTACT",
        "MODIFY_CONTACT"
      ],
      "parameters": [
        {
          "name": "name",
          "description": "The contact name to update (must match an existing contact).",
          "required": true,
          "schema": {
            "type": "string"
          },
          "examples": [
            "Sarah Chen"
          ]
        },
        {
          "name": "updates",
          "description": "A JSON object of fields to update (stringified JSON).",
          "required": true,
          "schema": {
            "type": "string"
          },
          "examples": [
            "{\"notes\":\"prefers email\",\"tags\":[\"friend\"]}"
          ]
        }
      ]
    },
    {
      "name": "REMOVE_CONTACT",
      "description": "Remove a contact from the rolodex.",
      "similes": [
        "DELETE_CONTACT"
      ],
      "parameters": [
        {
          "name": "name",
          "description": "The contact name to remove.",
          "required": true,
          "schema": {
            "type": "string"
          },
          "examples": [
            "Sarah Chen"
          ]
        }
      ]
    },
    {
      "name": "SEARCH_CONTACTS",
      "description": "Search contacts in the rolodex by name or query.",
      "similes": [
        "FIND_CONTACTS",
        "LOOKUP_CONTACTS"
      ],
      "parameters": [
        {
          "name": "query",
          "description": "Search query (name, handle, or free-text).",
          "required": true,
          "schema": {
            "type": "string"
          },
          "examples": [
            "sarah",
            "AI meetup"
          ]
        }
      ]
    },
    {
      "name": "SCHEDULE_FOLLOW_UP",
      "description": "Schedule a follow-up reminder for a contact.",
      "similes": [
        "REMIND_ME",
        "FOLLOW_UP"
      ],
      "parameters": [
        {
          "name": "name",
          "description": "Contact name to follow up with.",
          "required": true,
          "schema": {
            "type": "string"
          },
          "examples": [
            "Sarah Chen"
          ]
        },
        {
          "name": "when",
          "description": "When to follow up. Use an ISO-8601 datetime string.",
          "required": true,
          "schema": {
            "type": "string"
          },
          "examples": [
            "2026-02-01T09:00:00Z"
          ]
        },
        {
          "name": "reason",
          "description": "Optional reason/context for the follow-up.",
          "required": false,
          "schema": {
            "type": "string"
          },
          "examples": [
            "Check in about the agent framework demo"
          ]
        }
      ]
    },
    {
      "name": "CHOOSE_OPTION",
      "description": "Select an option for a pending task that has multiple options.",
      "similes": [
        "SELECT_OPTION",
        "PICK_OPTION"
      ],
      "parameters": [
        {
          "name": "taskId",
          "description": "The pending task id.",
          "required": true,
          "schema": {
            "type": "string"
          },
          "examples": [
            "c0a8012e"
          ]
        },
        {
          "name": "option",
          "description": "The selected option name exactly as listed.",
          "required": true,
          "schema": {
            "type": "string"
          },
          "examples": [
            "APPROVE",
            "ABORT"
          ]
        }
      ]
    },
    {
      "name": "FOLLOW_ROOM",
      "description": "Follow a room so the agent receives and processes messages from it.",
      "similes": [
        "SUBSCRIBE_ROOM"
      ],
      "parameters": [
        {
          "name": "roomId",
          "description": "The target room id to follow.",
          "required": true,
          "schema": {
            "type": "string"
          },
          "examples": [
            "00000000-0000-0000-0000-000000000000"
          ]
        }
      ]
    },
    {
      "name": "UNFOLLOW_ROOM",
      "description": "Unfollow a room so the agent stops receiving messages from it.",
      "similes": [
        "UNSUBSCRIBE_ROOM"
      ],
      "parameters": [
        {
          "name": "roomId",
          "description": "The target room id to unfollow.",
          "required": true,
          "schema": {
            "type": "string"
          },
          "examples": [
            "00000000-0000-0000-0000-000000000000"
          ]
        }
      ]
    },
    {
      "name": "MUTE_ROOM",
      "description": "Mute a room so the agent will not respond there.",
      "similes": [
        "SILENCE_ROOM"
      ],
      "parameters": [
        {
          "name": "roomId",
          "description": "The room id to mute.",
          "required": true,
          "schema": {
            "type": "string"
          },
          "examples": [
            "00000000-0000-0000-0000-000000000000"
          ]
        }
      ]
    },
    {
      "name": "UNMUTE_ROOM",
      "description": "Unmute a room so the agent may respond there again.",
      "similes": [
        "UNSILENCE_ROOM"
      ],
      "parameters": [
        {
          "name": "roomId",
          "description": "The room id to unmute.",
          "required": true,
          "schema": {
            "type": "string"
          },
          "examples": [
            "00000000-0000-0000-0000-000000000000"
          ]
        }
      ]
    },
    {
      "name": "UPDATE_SETTINGS",
      "description": "Update agent settings by applying explicit key/value updates.",
      "similes": [
        "SET_SETTINGS",
        "CHANGE_SETTINGS"
      ],
      "parameters": [
        {
          "name": "updates",
          "description": "A JSON array of {\"key\": string, \"value\": string} updates (stringified JSON).",
          "required": true,
          "schema": {
            "type": "string"
          },
          "examples": [
            "[{\"key\":\"model\",\"value\":\"gpt-5\"}]"
          ]
        }
      ]
    },
    {
      "name": "UPDATE_ROLE",
      "description": "Update a user's role.",
      "similes": [
        "SET_ROLE",
        "CHANGE_ROLE"
      ],
      "parameters": [
        {
          "name": "entityId",
          "description": "The entity id to update.",
          "required": true,
          "schema": {
            "type": "string"
          },
          "examples": [
            "00000000-0000-0000-0000-000000000000"
          ]
        },
        {
          "name": "role",
          "description": "The new role to assign.",
          "required": true,
          "schema": {
            "type": "string"
          },
          "examples": [
            "admin",
            "member"
          ]
        }
      ]
    },
    {
      "name": "UPDATE_ENTITY",
      "description": "Update stored entity information by applying explicit field updates.",
      "similes": [
        "EDIT_ENTITY",
        "MODIFY_ENTITY"
      ],
      "parameters": [
        {
          "name": "entityId",
          "description": "The entity id to update.",
          "required": true,
          "schema": {
            "type": "string"
          },
          "examples": [
            "00000000-0000-0000-0000-000000000000"
          ]
        },
        {
          "name": "updates",
          "description": "A JSON array of {\"name\": string, \"value\": string} field updates (stringified JSON).",
          "required": true,
          "schema": {
            "type": "string"
          },
          "examples": [
            "[{\"name\":\"bio\",\"value\":\"Loves Rust\"}]"
          ]
        }
      ]
    },
    {
      "name": "GENERATE_IMAGE",
      "description": "Generate an image based on the given prompt.",
      "similes": [
        "IMAGE",
        "DRAW",
        "CREATE_IMAGE"
      ],
      "parameters": [
        {
          "name": "prompt",
          "description": "Image generation prompt.",
          "required": true,
          "schema": {
            "type": "string"
          },
          "examples": [
            "A futuristic cityscape at sunset, cinematic lighting"
          ]
        }
      ]
    }
  ]
}"#;
pub const CORE_EVALUATOR_DOCS_JSON: &str = r#"{
  "version": "1.0.0",
  "evaluators": [
    {
      "name": "REFLECTION",
      "description": "Reflects on agent behavior and provides feedback for improvement.",
      "similes": [
        "REFLECT",
        "SELF_REFLECT",
        "EVALUATE_INTERACTION",
        "ASSESS_SITUATION"
      ],
      "examples": [
        {
          "prompt": "Agent Name: Sarah\nAgent Role: Community Manager\nRoom Type: group\nCurrent Room: general-chat\nMessage Sender: John (user-123)",
          "messages": [
            {
              "name": "John",
              "content": {
                "text": "Hey everyone, I'm new here!"
              }
            },
            {
              "name": "Sarah",
              "content": {
                "text": "Welcome John! How did you find our community?"
              }
            }
          ],
          "outcome": "<response>\n  <thought>I'm engaging appropriately with a new community member, maintaining a welcoming and professional tone.</thought>\n  <quality_score>85</quality_score>\n  <strengths>Welcoming tone and helpful follow-up question.</strengths>\n  <improvements>Ask a slightly more specific question to learn John's goals.</improvements>\n  <learnings>Balance warmth with clarity and next steps.</learnings>\n</response>"
        }
      ]
    },
    {
      "name": "RELATIONSHIP_EXTRACTION",
      "description": "Passively extracts and updates relationship information from conversations.",
      "similes": [
        "RELATIONSHIP_ANALYZER",
        "SOCIAL_GRAPH_BUILDER",
        "CONTACT_EXTRACTOR"
      ],
      "examples": [
        {
          "prompt": "User introduces themselves with social media",
          "messages": [
            {
              "name": "{{name1}}",
              "content": {
                "type": "text",
                "text": "Hi, I'm Sarah Chen. You can find me on X @sarahchen_dev"
              }
            }
          ],
          "outcome": "Extracts X handle and creates/updates the entity with a platform identity."
        }
      ]
    }
  ]
}"#;
pub const ALL_EVALUATOR_DOCS_JSON: &str = r#"{
  "version": "1.0.0",
  "evaluators": [
    {
      "name": "REFLECTION",
      "description": "Reflects on agent behavior and provides feedback for improvement.",
      "similes": [
        "REFLECT",
        "SELF_REFLECT",
        "EVALUATE_INTERACTION",
        "ASSESS_SITUATION"
      ],
      "examples": [
        {
          "prompt": "Agent Name: Sarah\nAgent Role: Community Manager\nRoom Type: group\nCurrent Room: general-chat\nMessage Sender: John (user-123)",
          "messages": [
            {
              "name": "John",
              "content": {
                "text": "Hey everyone, I'm new here!"
              }
            },
            {
              "name": "Sarah",
              "content": {
                "text": "Welcome John! How did you find our community?"
              }
            }
          ],
          "outcome": "<response>\n  <thought>I'm engaging appropriately with a new community member, maintaining a welcoming and professional tone.</thought>\n  <quality_score>85</quality_score>\n  <strengths>Welcoming tone and helpful follow-up question.</strengths>\n  <improvements>Ask a slightly more specific question to learn John's goals.</improvements>\n  <learnings>Balance warmth with clarity and next steps.</learnings>\n</response>"
        }
      ]
    },
    {
      "name": "RELATIONSHIP_EXTRACTION",
      "description": "Passively extracts and updates relationship information from conversations.",
      "similes": [
        "RELATIONSHIP_ANALYZER",
        "SOCIAL_GRAPH_BUILDER",
        "CONTACT_EXTRACTOR"
      ],
      "examples": [
        {
          "prompt": "User introduces themselves with social media",
          "messages": [
            {
              "name": "{{name1}}",
              "content": {
                "type": "text",
                "text": "Hi, I'm Sarah Chen. You can find me on X @sarahchen_dev"
              }
            }
          ],
          "outcome": "Extracts X handle and creates/updates the entity with a platform identity."
        }
      ]
    }
  ]
}"#;
