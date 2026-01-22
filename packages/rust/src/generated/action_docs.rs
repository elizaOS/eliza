//! Auto-generated canonical action/provider/evaluator docs.
//! DO NOT EDIT - Generated from packages/prompts/specs/**.

pub const CORE_ACTION_DOCS_JSON: &str = r#"{
  "version": "1.0.0",
  "actions": [
    {
      "name": "REPLY",
      "description": "Replies to the current conversation with the text from the generated message. Default if the agent is responding with a message and no other action. Use REPLY at the beginning of a chain of actions as an acknowledgement, and at the end of a chain of actions as a final response.",
      "similes": [
        "GREET",
        "REPLY_TO_MESSAGE",
        "SEND_REPLY",
        "RESPOND",
        "RESPONSE"
      ],
      "parameters": [],
      "examples": [
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "Hello there!"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "Hi! How can I help you today?",
              "actions": [
                "REPLY"
              ]
            }
          }
        ],
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "What's your favorite color?"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "I really like deep shades of blue. They remind me of the ocean and the night sky.",
              "actions": [
                "REPLY"
              ]
            }
          }
        ],
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "Can you explain how neural networks work?"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "Let me break that down for you in simple terms...",
              "actions": [
                "REPLY"
              ]
            }
          }
        ],
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "Could you help me solve this math problem?"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "Of course! Let's work through it step by step.",
              "actions": [
                "REPLY"
              ]
            }
          }
        ]
      ]
    },
    {
      "name": "IGNORE",
      "description": "Call this action if ignoring the user. If the user is aggressive, creepy or is finished with the conversation, use this action. Or, if both you and the user have already said goodbye, use this action instead of saying bye again. Use IGNORE any time the conversation has naturally ended. Do not use IGNORE if the user has engaged directly, or if something went wrong and you need to tell them. Only ignore if the user should be ignored.",
      "similes": [
        "STOP_TALKING",
        "STOP_CHATTING",
        "STOP_CONVERSATION"
      ],
      "parameters": [],
      "examples": [
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "Go screw yourself"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "",
              "actions": [
                "IGNORE"
              ]
            }
          }
        ],
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "Shut up, bot"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "",
              "actions": [
                "IGNORE"
              ]
            }
          }
        ],
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "Gotta go"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "Okay, talk to you later"
            }
          },
          {
            "name": "{{name1}}",
            "content": {
              "text": "Cya"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "",
              "actions": [
                "IGNORE"
              ]
            }
          }
        ],
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "bye"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "cya"
            }
          },
          {
            "name": "{{name1}}",
            "content": {
              "text": "",
              "actions": [
                "IGNORE"
              ]
            }
          }
        ],
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "wanna cyber"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "thats inappropriate",
              "actions": [
                "IGNORE"
              ]
            }
          }
        ]
      ]
    },
    {
      "name": "NONE",
      "description": "Respond but perform no additional action. This is the default if the agent is speaking and not doing anything additional.",
      "similes": [
        "NO_ACTION",
        "NO_RESPONSE",
        "NO_REACTION",
        "NOOP",
        "PASS"
      ],
      "parameters": [],
      "examples": [
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "Hey whats up"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "oh hey",
              "actions": [
                "NONE"
              ]
            }
          }
        ],
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "did u see some faster whisper just came out"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "yeah but its a pain to get into node.js",
              "actions": [
                "NONE"
              ]
            }
          }
        ],
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "u think aliens are real",
              "actions": [
                "NONE"
              ]
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "ya obviously",
              "actions": [
                "NONE"
              ]
            }
          }
        ],
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "drop a joke on me",
              "actions": [
                "NONE"
              ]
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "why dont scientists trust atoms cuz they make up everything lmao",
              "actions": [
                "NONE"
              ]
            }
          }
        ]
      ]
    },
    {
      "name": "SEND_MESSAGE",
      "description": "Send a message to a user or room (other than the current one)",
      "similes": [
        "DM",
        "MESSAGE",
        "SEND_DM",
        "POST_MESSAGE",
        "DIRECT_MESSAGE",
        "NOTIFY"
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
      "examples": [
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "Send a message to @dev_guru on telegram saying 'Hello!'"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "Message sent to dev_guru on telegram.",
              "actions": [
                "SEND_MESSAGE"
              ]
            }
          }
        ],
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "Post 'Important announcement!' in #announcements"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "Message sent to announcements.",
              "actions": [
                "SEND_MESSAGE"
              ]
            }
          }
        ],
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "DM Jimmy and tell him 'Meeting at 3pm'"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "Message sent to Jimmy.",
              "actions": [
                "SEND_MESSAGE"
              ]
            }
          }
        ]
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
      "description": "Add a new contact to the rolodex with categorization and preferences",
      "similes": [
        "SAVE_CONTACT",
        "REMEMBER_PERSON",
        "ADD_TO_CONTACTS",
        "SAVE_TO_ROLODEX",
        "CREATE_CONTACT",
        "NEW_CONTACT",
        "add contact",
        "save contact",
        "add to contacts",
        "add to rolodex",
        "remember this person",
        "save their info",
        "add them to my list",
        "categorize as friend",
        "mark as vip",
        "add to address book"
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
            "Sarah Chen",
            "John Smith"
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
      ],
      "examples": [
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "Add John Smith to my contacts as a colleague"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "I've added John Smith to your contacts as a colleague."
            }
          }
        ],
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "Save this person as a friend in my rolodex"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "I've saved them as a friend in your rolodex."
            }
          }
        ],
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "Remember Alice as a VIP contact"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "I've added Alice to your contacts as a VIP."
            }
          }
        ]
      ]
    },
    {
      "name": "UPDATE_CONTACT",
      "description": "Update an existing contact's details in the rolodex.",
      "similes": [
        "EDIT_CONTACT",
        "MODIFY_CONTACT",
        "CHANGE_CONTACT_INFO"
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
      ],
      "examples": [
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "Update Sarah's contact to add the tag 'investor'"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "I've updated Sarah's contact with the new tag."
            }
          }
        ]
      ]
    },
    {
      "name": "REMOVE_CONTACT",
      "description": "Remove a contact from the rolodex.",
      "similes": [
        "DELETE_CONTACT",
        "REMOVE_FROM_ROLODEX",
        "DELETE_FROM_CONTACTS",
        "FORGET_PERSON",
        "REMOVE_FROM_CONTACTS"
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
      ],
      "examples": [
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "Remove John from my contacts"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "Are you sure you want to remove John from your contacts?"
            }
          },
          {
            "name": "{{name1}}",
            "content": {
              "text": "Yes"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "I've removed John from your contacts."
            }
          }
        ]
      ]
    },
    {
      "name": "SEARCH_CONTACTS",
      "description": "Search and list contacts in the rolodex by name or query.",
      "similes": [
        "FIND_CONTACTS",
        "LOOKUP_CONTACTS",
        "LIST_CONTACTS",
        "SHOW_CONTACTS",
        "list contacts",
        "show contacts",
        "search contacts",
        "find contacts",
        "who are my friends"
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
      ],
      "examples": [
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "Show me my friends"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "Here are your contacts tagged as friends: Sarah Chen, John Smith..."
            }
          }
        ]
      ]
    },
    {
      "name": "SCHEDULE_FOLLOW_UP",
      "description": "Schedule a follow-up reminder for a contact.",
      "similes": [
        "REMIND_ME",
        "FOLLOW_UP",
        "REMIND_FOLLOW_UP",
        "SET_REMINDER",
        "REMIND_ABOUT",
        "FOLLOW_UP_WITH",
        "follow up with",
        "remind me to contact",
        "schedule a check-in",
        "set a reminder for"
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
      ],
      "examples": [
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "Remind me to follow up with Sarah next week about the demo"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "I've scheduled a follow-up reminder with Sarah for next week about the demo."
            }
          }
        ]
      ]
    },
    {
      "name": "CHOOSE_OPTION",
      "description": "Select an option for a pending task that has multiple options.",
      "similes": [
        "SELECT_OPTION",
        "PICK_OPTION",
        "SELECT_TASK",
        "PICK_TASK",
        "SELECT",
        "PICK",
        "CHOOSE"
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
      ],
      "examples": [
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "Select the first option"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "I've selected option 1 for the pending task.",
              "actions": [
                "CHOOSE_OPTION"
              ]
            }
          }
        ]
      ]
    },
    {
      "name": "FOLLOW_ROOM",
      "description": "Start following this channel with great interest, chiming in without needing to be explicitly mentioned. Only do this if explicitly asked to.",
      "similes": [
        "FOLLOW_CHAT",
        "FOLLOW_CHANNEL",
        "FOLLOW_CONVERSATION",
        "FOLLOW_THREAD",
        "JOIN_ROOM",
        "SUBSCRIBE_ROOM",
        "WATCH_ROOM",
        "ENTER_ROOM"
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
      ],
      "examples": [
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "hey {{name2}} follow this channel"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "Sure, I will now follow this room and chime in",
              "actions": [
                "FOLLOW_ROOM"
              ]
            }
          }
        ],
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "{{name2}} stay in this chat pls"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "you got it, i'm here",
              "actions": [
                "FOLLOW_ROOM"
              ]
            }
          }
        ]
      ]
    },
    {
      "name": "UNFOLLOW_ROOM",
      "description": "Stop following a room and cease receiving updates. Use this when you no longer want to monitor a room's activity.",
      "similes": [
        "UNFOLLOW_CHAT",
        "UNFOLLOW_CONVERSATION",
        "UNFOLLOW_ROOM",
        "UNFOLLOW_THREAD",
        "LEAVE_ROOM",
        "UNSUBSCRIBE_ROOM",
        "STOP_WATCHING_ROOM",
        "EXIT_ROOM"
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
      ],
      "examples": [
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "{{name2}} stop following this channel"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "Okay, I'll stop following this room",
              "actions": [
                "UNFOLLOW_ROOM"
              ]
            }
          }
        ]
      ]
    },
    {
      "name": "MUTE_ROOM",
      "description": "Mutes a room, ignoring all messages unless explicitly mentioned. Only do this if explicitly asked to, or if you're annoying people.",
      "similes": [
        "MUTE_CHAT",
        "MUTE_CONVERSATION",
        "MUTE_THREAD",
        "MUTE_CHANNEL",
        "SILENCE_ROOM",
        "QUIET_ROOM",
        "DISABLE_NOTIFICATIONS",
        "STOP_RESPONDING"
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
      ],
      "examples": [
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "{{name2}}, please mute this channel. No need to respond here for now."
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "Got it",
              "actions": [
                "MUTE_ROOM"
              ]
            }
          }
        ],
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "{{name2}} plz mute this room"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "np going silent",
              "actions": [
                "MUTE_ROOM"
              ]
            }
          }
        ]
      ]
    },
    {
      "name": "UNMUTE_ROOM",
      "description": "Unmute a room to resume responding and receiving notifications. Use this when you want to start interacting with a muted room again.",
      "similes": [
        "UNMUTE_CHAT",
        "UNMUTE_CONVERSATION",
        "UNMUTE_ROOM",
        "UNMUTE_THREAD",
        "UNSILENCE_ROOM",
        "ENABLE_NOTIFICATIONS",
        "RESUME_RESPONDING",
        "START_LISTENING"
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
      ],
      "examples": [
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "{{name2}} unmute this room please"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "I've unmuted this room and will respond again",
              "actions": [
                "UNMUTE_ROOM"
              ]
            }
          }
        ]
      ]
    },
    {
      "name": "UPDATE_SETTINGS",
      "description": "Update agent settings by applying explicit key/value updates.",
      "similes": [
        "SET_SETTINGS",
        "CHANGE_SETTINGS",
        "UPDATE_SETTING",
        "SAVE_SETTING",
        "SET_CONFIGURATION",
        "CONFIGURE",
        "MODIFY_SETTINGS",
        "SET_PREFERENCE",
        "UPDATE_CONFIG"
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
      ],
      "examples": [
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "Change my language setting to French"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "I've updated your language setting to French.",
              "actions": [
                "UPDATE_SETTINGS"
              ]
            }
          }
        ]
      ]
    },
    {
      "name": "UPDATE_ROLE",
      "description": "Assigns a role (Admin, Owner, None) to a user or list of users in a channel.",
      "similes": [
        "SET_ROLE",
        "CHANGE_ROLE",
        "SET_PERMISSIONS",
        "ASSIGN_ROLE",
        "MAKE_ADMIN",
        "MODIFY_PERMISSIONS",
        "GRANT_ROLE"
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
      ],
      "examples": [
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "Make Sarah an admin"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "I've assigned the admin role to Sarah.",
              "actions": [
                "UPDATE_ROLE"
              ]
            }
          }
        ]
      ]
    },
    {
      "name": "UPDATE_ENTITY",
      "description": "Add or edit contact details for a person you are talking to or observing. Use this to modify entity profiles, metadata, or attributes.",
      "similes": [
        "EDIT_ENTITY",
        "MODIFY_ENTITY",
        "CHANGE_ENTITY",
        "UPDATE_PROFILE",
        "SET_ENTITY_INFO"
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
      ],
      "examples": [
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "Update my profile bio to say 'AI enthusiast'"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "I've updated your profile bio.",
              "actions": [
                "UPDATE_ENTITY"
              ]
            }
          }
        ]
      ]
    },
    {
      "name": "GENERATE_IMAGE",
      "description": "Generates an image based on a generated prompt reflecting the current conversation. Use GENERATE_IMAGE when the agent needs to visualize, illustrate, or demonstrate something visually for the user.",
      "similes": [
        "DRAW",
        "CREATE_IMAGE",
        "RENDER_IMAGE",
        "VISUALIZE",
        "MAKE_IMAGE",
        "PAINT",
        "IMAGE"
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
      ],
      "examples": [
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "Can you show me what a futuristic city looks like?"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "Sure, I'll create a futuristic city image for you. One moment...",
              "actions": [
                "GENERATE_IMAGE"
              ]
            }
          }
        ],
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "What does a neural network look like visually?"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "I'll create a visualization of a neural network for you, one sec...",
              "actions": [
                "GENERATE_IMAGE"
              ]
            }
          }
        ],
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "Can you visualize the feeling of calmness for me?"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "Creating an image to capture calmness for you, please wait a moment...",
              "actions": [
                "GENERATE_IMAGE"
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
      "name": "REPLY",
      "description": "Replies to the current conversation with the text from the generated message. Default if the agent is responding with a message and no other action. Use REPLY at the beginning of a chain of actions as an acknowledgement, and at the end of a chain of actions as a final response.",
      "similes": [
        "GREET",
        "REPLY_TO_MESSAGE",
        "SEND_REPLY",
        "RESPOND",
        "RESPONSE"
      ],
      "parameters": [],
      "examples": [
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "Hello there!"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "Hi! How can I help you today?",
              "actions": [
                "REPLY"
              ]
            }
          }
        ],
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "What's your favorite color?"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "I really like deep shades of blue. They remind me of the ocean and the night sky.",
              "actions": [
                "REPLY"
              ]
            }
          }
        ],
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "Can you explain how neural networks work?"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "Let me break that down for you in simple terms...",
              "actions": [
                "REPLY"
              ]
            }
          }
        ],
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "Could you help me solve this math problem?"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "Of course! Let's work through it step by step.",
              "actions": [
                "REPLY"
              ]
            }
          }
        ]
      ]
    },
    {
      "name": "IGNORE",
      "description": "Call this action if ignoring the user. If the user is aggressive, creepy or is finished with the conversation, use this action. Or, if both you and the user have already said goodbye, use this action instead of saying bye again. Use IGNORE any time the conversation has naturally ended. Do not use IGNORE if the user has engaged directly, or if something went wrong and you need to tell them. Only ignore if the user should be ignored.",
      "similes": [
        "STOP_TALKING",
        "STOP_CHATTING",
        "STOP_CONVERSATION"
      ],
      "parameters": [],
      "examples": [
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "Go screw yourself"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "",
              "actions": [
                "IGNORE"
              ]
            }
          }
        ],
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "Shut up, bot"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "",
              "actions": [
                "IGNORE"
              ]
            }
          }
        ],
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "Gotta go"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "Okay, talk to you later"
            }
          },
          {
            "name": "{{name1}}",
            "content": {
              "text": "Cya"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "",
              "actions": [
                "IGNORE"
              ]
            }
          }
        ],
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "bye"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "cya"
            }
          },
          {
            "name": "{{name1}}",
            "content": {
              "text": "",
              "actions": [
                "IGNORE"
              ]
            }
          }
        ],
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "wanna cyber"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "thats inappropriate",
              "actions": [
                "IGNORE"
              ]
            }
          }
        ]
      ]
    },
    {
      "name": "NONE",
      "description": "Respond but perform no additional action. This is the default if the agent is speaking and not doing anything additional.",
      "similes": [
        "NO_ACTION",
        "NO_RESPONSE",
        "NO_REACTION",
        "NOOP",
        "PASS"
      ],
      "parameters": [],
      "examples": [
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "Hey whats up"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "oh hey",
              "actions": [
                "NONE"
              ]
            }
          }
        ],
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "did u see some faster whisper just came out"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "yeah but its a pain to get into node.js",
              "actions": [
                "NONE"
              ]
            }
          }
        ],
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "u think aliens are real",
              "actions": [
                "NONE"
              ]
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "ya obviously",
              "actions": [
                "NONE"
              ]
            }
          }
        ],
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "drop a joke on me",
              "actions": [
                "NONE"
              ]
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "why dont scientists trust atoms cuz they make up everything lmao",
              "actions": [
                "NONE"
              ]
            }
          }
        ]
      ]
    },
    {
      "name": "SEND_MESSAGE",
      "description": "Send a message to a user or room (other than the current one)",
      "similes": [
        "DM",
        "MESSAGE",
        "SEND_DM",
        "POST_MESSAGE",
        "DIRECT_MESSAGE",
        "NOTIFY"
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
      "examples": [
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "Send a message to @dev_guru on telegram saying 'Hello!'"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "Message sent to dev_guru on telegram.",
              "actions": [
                "SEND_MESSAGE"
              ]
            }
          }
        ],
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "Post 'Important announcement!' in #announcements"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "Message sent to announcements.",
              "actions": [
                "SEND_MESSAGE"
              ]
            }
          }
        ],
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "DM Jimmy and tell him 'Meeting at 3pm'"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "Message sent to Jimmy.",
              "actions": [
                "SEND_MESSAGE"
              ]
            }
          }
        ]
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
      "description": "Add a new contact to the rolodex with categorization and preferences",
      "similes": [
        "SAVE_CONTACT",
        "REMEMBER_PERSON",
        "ADD_TO_CONTACTS",
        "SAVE_TO_ROLODEX",
        "CREATE_CONTACT",
        "NEW_CONTACT",
        "add contact",
        "save contact",
        "add to contacts",
        "add to rolodex",
        "remember this person",
        "save their info",
        "add them to my list",
        "categorize as friend",
        "mark as vip",
        "add to address book"
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
            "Sarah Chen",
            "John Smith"
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
      ],
      "examples": [
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "Add John Smith to my contacts as a colleague"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "I've added John Smith to your contacts as a colleague."
            }
          }
        ],
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "Save this person as a friend in my rolodex"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "I've saved them as a friend in your rolodex."
            }
          }
        ],
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "Remember Alice as a VIP contact"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "I've added Alice to your contacts as a VIP."
            }
          }
        ]
      ]
    },
    {
      "name": "UPDATE_CONTACT",
      "description": "Update an existing contact's details in the rolodex.",
      "similes": [
        "EDIT_CONTACT",
        "MODIFY_CONTACT",
        "CHANGE_CONTACT_INFO"
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
      ],
      "examples": [
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "Update Sarah's contact to add the tag 'investor'"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "I've updated Sarah's contact with the new tag."
            }
          }
        ]
      ]
    },
    {
      "name": "REMOVE_CONTACT",
      "description": "Remove a contact from the rolodex.",
      "similes": [
        "DELETE_CONTACT",
        "REMOVE_FROM_ROLODEX",
        "DELETE_FROM_CONTACTS",
        "FORGET_PERSON",
        "REMOVE_FROM_CONTACTS"
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
      ],
      "examples": [
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "Remove John from my contacts"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "Are you sure you want to remove John from your contacts?"
            }
          },
          {
            "name": "{{name1}}",
            "content": {
              "text": "Yes"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "I've removed John from your contacts."
            }
          }
        ]
      ]
    },
    {
      "name": "SEARCH_CONTACTS",
      "description": "Search and list contacts in the rolodex by name or query.",
      "similes": [
        "FIND_CONTACTS",
        "LOOKUP_CONTACTS",
        "LIST_CONTACTS",
        "SHOW_CONTACTS",
        "list contacts",
        "show contacts",
        "search contacts",
        "find contacts",
        "who are my friends"
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
      ],
      "examples": [
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "Show me my friends"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "Here are your contacts tagged as friends: Sarah Chen, John Smith..."
            }
          }
        ]
      ]
    },
    {
      "name": "SCHEDULE_FOLLOW_UP",
      "description": "Schedule a follow-up reminder for a contact.",
      "similes": [
        "REMIND_ME",
        "FOLLOW_UP",
        "REMIND_FOLLOW_UP",
        "SET_REMINDER",
        "REMIND_ABOUT",
        "FOLLOW_UP_WITH",
        "follow up with",
        "remind me to contact",
        "schedule a check-in",
        "set a reminder for"
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
      ],
      "examples": [
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "Remind me to follow up with Sarah next week about the demo"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "I've scheduled a follow-up reminder with Sarah for next week about the demo."
            }
          }
        ]
      ]
    },
    {
      "name": "CHOOSE_OPTION",
      "description": "Select an option for a pending task that has multiple options.",
      "similes": [
        "SELECT_OPTION",
        "PICK_OPTION",
        "SELECT_TASK",
        "PICK_TASK",
        "SELECT",
        "PICK",
        "CHOOSE"
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
      ],
      "examples": [
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "Select the first option"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "I've selected option 1 for the pending task.",
              "actions": [
                "CHOOSE_OPTION"
              ]
            }
          }
        ]
      ]
    },
    {
      "name": "FOLLOW_ROOM",
      "description": "Start following this channel with great interest, chiming in without needing to be explicitly mentioned. Only do this if explicitly asked to.",
      "similes": [
        "FOLLOW_CHAT",
        "FOLLOW_CHANNEL",
        "FOLLOW_CONVERSATION",
        "FOLLOW_THREAD",
        "JOIN_ROOM",
        "SUBSCRIBE_ROOM",
        "WATCH_ROOM",
        "ENTER_ROOM"
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
      ],
      "examples": [
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "hey {{name2}} follow this channel"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "Sure, I will now follow this room and chime in",
              "actions": [
                "FOLLOW_ROOM"
              ]
            }
          }
        ],
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "{{name2}} stay in this chat pls"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "you got it, i'm here",
              "actions": [
                "FOLLOW_ROOM"
              ]
            }
          }
        ]
      ]
    },
    {
      "name": "UNFOLLOW_ROOM",
      "description": "Stop following a room and cease receiving updates. Use this when you no longer want to monitor a room's activity.",
      "similes": [
        "UNFOLLOW_CHAT",
        "UNFOLLOW_CONVERSATION",
        "UNFOLLOW_ROOM",
        "UNFOLLOW_THREAD",
        "LEAVE_ROOM",
        "UNSUBSCRIBE_ROOM",
        "STOP_WATCHING_ROOM",
        "EXIT_ROOM"
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
      ],
      "examples": [
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "{{name2}} stop following this channel"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "Okay, I'll stop following this room",
              "actions": [
                "UNFOLLOW_ROOM"
              ]
            }
          }
        ]
      ]
    },
    {
      "name": "MUTE_ROOM",
      "description": "Mutes a room, ignoring all messages unless explicitly mentioned. Only do this if explicitly asked to, or if you're annoying people.",
      "similes": [
        "MUTE_CHAT",
        "MUTE_CONVERSATION",
        "MUTE_THREAD",
        "MUTE_CHANNEL",
        "SILENCE_ROOM",
        "QUIET_ROOM",
        "DISABLE_NOTIFICATIONS",
        "STOP_RESPONDING"
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
      ],
      "examples": [
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "{{name2}}, please mute this channel. No need to respond here for now."
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "Got it",
              "actions": [
                "MUTE_ROOM"
              ]
            }
          }
        ],
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "{{name2}} plz mute this room"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "np going silent",
              "actions": [
                "MUTE_ROOM"
              ]
            }
          }
        ]
      ]
    },
    {
      "name": "UNMUTE_ROOM",
      "description": "Unmute a room to resume responding and receiving notifications. Use this when you want to start interacting with a muted room again.",
      "similes": [
        "UNMUTE_CHAT",
        "UNMUTE_CONVERSATION",
        "UNMUTE_ROOM",
        "UNMUTE_THREAD",
        "UNSILENCE_ROOM",
        "ENABLE_NOTIFICATIONS",
        "RESUME_RESPONDING",
        "START_LISTENING"
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
      ],
      "examples": [
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "{{name2}} unmute this room please"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "I've unmuted this room and will respond again",
              "actions": [
                "UNMUTE_ROOM"
              ]
            }
          }
        ]
      ]
    },
    {
      "name": "UPDATE_SETTINGS",
      "description": "Update agent settings by applying explicit key/value updates.",
      "similes": [
        "SET_SETTINGS",
        "CHANGE_SETTINGS",
        "UPDATE_SETTING",
        "SAVE_SETTING",
        "SET_CONFIGURATION",
        "CONFIGURE",
        "MODIFY_SETTINGS",
        "SET_PREFERENCE",
        "UPDATE_CONFIG"
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
      ],
      "examples": [
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "Change my language setting to French"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "I've updated your language setting to French.",
              "actions": [
                "UPDATE_SETTINGS"
              ]
            }
          }
        ]
      ]
    },
    {
      "name": "UPDATE_ROLE",
      "description": "Assigns a role (Admin, Owner, None) to a user or list of users in a channel.",
      "similes": [
        "SET_ROLE",
        "CHANGE_ROLE",
        "SET_PERMISSIONS",
        "ASSIGN_ROLE",
        "MAKE_ADMIN",
        "MODIFY_PERMISSIONS",
        "GRANT_ROLE"
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
      ],
      "examples": [
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "Make Sarah an admin"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "I've assigned the admin role to Sarah.",
              "actions": [
                "UPDATE_ROLE"
              ]
            }
          }
        ]
      ]
    },
    {
      "name": "UPDATE_ENTITY",
      "description": "Add or edit contact details for a person you are talking to or observing. Use this to modify entity profiles, metadata, or attributes.",
      "similes": [
        "EDIT_ENTITY",
        "MODIFY_ENTITY",
        "CHANGE_ENTITY",
        "UPDATE_PROFILE",
        "SET_ENTITY_INFO"
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
      ],
      "examples": [
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "Update my profile bio to say 'AI enthusiast'"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "I've updated your profile bio.",
              "actions": [
                "UPDATE_ENTITY"
              ]
            }
          }
        ]
      ]
    },
    {
      "name": "GENERATE_IMAGE",
      "description": "Generates an image based on a generated prompt reflecting the current conversation. Use GENERATE_IMAGE when the agent needs to visualize, illustrate, or demonstrate something visually for the user.",
      "similes": [
        "DRAW",
        "CREATE_IMAGE",
        "RENDER_IMAGE",
        "VISUALIZE",
        "MAKE_IMAGE",
        "PAINT",
        "IMAGE"
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
      ],
      "examples": [
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "Can you show me what a futuristic city looks like?"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "Sure, I'll create a futuristic city image for you. One moment...",
              "actions": [
                "GENERATE_IMAGE"
              ]
            }
          }
        ],
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "What does a neural network look like visually?"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "I'll create a visualization of a neural network for you, one sec...",
              "actions": [
                "GENERATE_IMAGE"
              ]
            }
          }
        ],
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "Can you visualize the feeling of calmness for me?"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "Creating an image to capture calmness for you, please wait a moment...",
              "actions": [
                "GENERATE_IMAGE"
              ]
            }
          }
        ]
      ]
    },
    {
      "name": "ANALYZE_PERFORMANCE",
      "description": "Analyze trading performance and show metrics",
      "parameters": [],
      "similes": [
        "PERFORMANCE_ANALYSIS",
        "CHECK_PERFORMANCE",
        "TRADING_RESULTS",
        "SHOW_PERFORMANCE"
      ]
    },
    {
      "name": "BROWSER_CLICK",
      "description": "Click on an element on the webpage",
      "parameters": [],
      "similes": [
        "CLICK_ELEMENT",
        "TAP",
        "PRESS_BUTTON"
      ]
    },
    {
      "name": "BROWSER_EXTRACT",
      "description": "Extract data from the webpage",
      "parameters": [],
      "similes": [
        "EXTRACT_DATA",
        "GET_TEXT",
        "SCRAPE"
      ]
    },
    {
      "name": "BROWSER_NAVIGATE",
      "description": "Navigate the browser to a specified URL",
      "parameters": [],
      "similes": [
        "GO_TO_URL",
        "OPEN_WEBSITE",
        "VISIT_PAGE",
        "NAVIGATE_TO"
      ]
    },
    {
      "name": "BROWSER_SCREENSHOT",
      "description": "Take a screenshot of the current page",
      "parameters": [],
      "similes": [
        "TAKE_SCREENSHOT",
        "CAPTURE_PAGE",
        "SCREENSHOT"
      ]
    },
    {
      "name": "BROWSER_SELECT",
      "description": "Select an option from a dropdown on the webpage",
      "parameters": [],
      "similes": [
        "SELECT_OPTION",
        "CHOOSE",
        "PICK"
      ]
    },
    {
      "name": "BROWSER_TYPE",
      "description": "Type text into an input field on the webpage",
      "parameters": [],
      "similes": [
        "TYPE_TEXT",
        "INPUT",
        "ENTER_TEXT"
      ]
    },
    {
      "name": "CALL_MCP_TOOL",
      "description": "Calls a tool from an MCP server to perform a specific task",
      "parameters": [],
      "similes": [
        "CALL_TOOL",
        "CALL_MCP_TOOL",
        "USE_TOOL",
        "USE_MCP_TOOL",
        "EXECUTE_TOOL",
        "EXECUTE_MCP_TOOL",
        "RUN_TOOL",
        "RUN_MCP_TOOL",
        "INVOKE_TOOL",
        "INVOKE_MCP_TOOL"
      ]
    },
    {
      "name": "CANCEL_TASK",
      "description": "Cancel a task.",
      "parameters": [],
      "similes": [
        "DELETE_TASK",
        "REMOVE_TASK",
        "ABORT_TASK"
      ]
    },
    {
      "name": "CHECK_PORTFOLIO",
      "description": "Check current portfolio status including holdings, positions, and trading performance",
      "parameters": [],
      "similes": [
        "PORTFOLIO_CHECK",
        "VIEW_PORTFOLIO",
        "SHOW_HOLDINGS",
        "LIST_POSITIONS",
        "WALLET_BALANCE",
        "CHECK_BALANCE",
        "MY_PORTFOLIO",
        "MY_HOLDINGS",
        "MY_BALANCE",
        "TRADING_STATUS",
        "CHECK_TRADING"
      ]
    },
    {
      "name": "CLEAR_LINEAR_ACTIVITY",
      "description": "Clear the Linear activity log",
      "parameters": [],
      "similes": [
        "clear-linear-activity",
        "reset-linear-activity",
        "delete-linear-activity"
      ]
    },
    {
      "name": "COMPARE_STRATEGIES",
      "description": "Compare available trading strategies",
      "parameters": [],
      "similes": [
        "STRATEGY_COMPARISON",
        "LIST_STRATEGIES",
        "WHICH_STRATEGY",
        "BEST_STRATEGY"
      ]
    },
    {
      "name": "COMPUTERUSE_CLICK",
      "description": "Clicks a UI element on the computer using a ComputerUse selector.",
      "parameters": [],
      "similes": [
        "CLICK_UI",
        "CLICK_ELEMENT",
        "TAP_UI"
      ]
    },
    {
      "name": "COMPUTERUSE_GET_APPLICATIONS",
      "description": "Lists currently running applications on the target machine.",
      "parameters": [],
      "similes": [
        "LIST_APPS",
        "LIST_APPLICATIONS",
        "SHOW_RUNNING_APPS"
      ]
    },
    {
      "name": "COMPUTERUSE_GET_WINDOW_TREE",
      "description": "Gets the UI tree for a running application (useful for understanding what is currently on screen).",
      "parameters": [],
      "similes": [
        "GET_UI_TREE",
        "WINDOW_TREE",
        "DUMP_UI_TREE"
      ]
    },
    {
      "name": "COMPUTERUSE_OPEN_APPLICATION",
      "description": "Opens an application on the target machine (local or MCP).",
      "parameters": [],
      "similes": [
        "OPEN_APP",
        "LAUNCH_APP",
        "START_APPLICATION"
      ]
    },
    {
      "name": "COMPUTERUSE_TYPE",
      "description": "Types text into a UI element on the computer using a ComputerUse selector (optionally clearing the field).",
      "parameters": [],
      "similes": [
        "TYPE_UI",
        "ENTER_TEXT",
        "FILL_FIELD"
      ]
    },
    {
      "name": "CONFIGURE_STRATEGY",
      "description": "Configure trading strategy parameters",
      "parameters": [],
      "similes": [
        "CONFIG_STRATEGY",
        "SET_STRATEGY",
        "ADJUST_SETTINGS",
        "CHANGE_PARAMS"
      ]
    },
    {
      "name": "CONFIRM_MEETING",
      "description": "Confirm or decline attendance for a scheduled meeting",
      "parameters": [],
      "similes": [
        "ACCEPT_MEETING",
        "CONFIRM_ATTENDANCE",
        "RSVP_YES",
        "DECLINE_MEETING",
        "CANCEL_ATTENDANCE"
      ]
    },
    {
      "name": "CREATE_GITHUB_BRANCH",
      "description": "",
      "parameters": [
        {
          "name": "branchName",
          "description": "The branch name to use.",
          "required": false,
          "schema": {
            "type": "string"
          },
          "examples": [
            "example"
          ]
        },
        {
          "name": "fromRef",
          "description": "The from ref to use.",
          "required": false,
          "schema": {
            "type": "string"
          },
          "examples": [
            "example"
          ]
        },
        {
          "name": "owner",
          "description": "Repository owner or organization.",
          "required": false,
          "schema": {
            "type": "string"
          },
          "examples": [
            "octocat"
          ]
        },
        {
          "name": "repo",
          "description": "Repository name.",
          "required": false,
          "schema": {
            "type": "string"
          },
          "examples": [
            "my-repo"
          ]
        }
      ],
      "exampleCalls": [
        {
          "user": "Use CREATE_GITHUB_BRANCH with the provided parameters.",
          "actions": [
            "CREATE_GITHUB_BRANCH"
          ],
          "params": {
            "CREATE_GITHUB_BRANCH": {
              "branchName": "example",
              "fromRef": "example",
              "owner": "octocat",
              "repo": "my-repo"
            }
          }
        }
      ]
    },
    {
      "name": "CREATE_GITHUB_COMMENT",
      "description": "",
      "parameters": [
        {
          "name": "body",
          "description": "Body text for the operation.",
          "required": false,
          "schema": {
            "type": "string"
          },
          "examples": [
            "Implements dark mode and updates docs."
          ]
        },
        {
          "name": "issueNumber",
          "description": "The issue number to use.",
          "required": false,
          "schema": {
            "type": "number"
          },
          "examples": [
            1
          ]
        },
        {
          "name": "owner",
          "description": "Repository owner or organization.",
          "required": false,
          "schema": {
            "type": "string"
          },
          "examples": [
            "octocat"
          ]
        },
        {
          "name": "repo",
          "description": "Repository name.",
          "required": false,
          "schema": {
            "type": "string"
          },
          "examples": [
            "my-repo"
          ]
        }
      ],
      "exampleCalls": [
        {
          "user": "Use CREATE_GITHUB_COMMENT with the provided parameters.",
          "actions": [
            "CREATE_GITHUB_COMMENT"
          ],
          "params": {
            "CREATE_GITHUB_COMMENT": {
              "body": "Implements dark mode and updates docs.",
              "issueNumber": 1,
              "owner": "octocat",
              "repo": "my-repo"
            }
          }
        }
      ]
    },
    {
      "name": "CREATE_GITHUB_ISSUE",
      "description": "",
      "parameters": [
        {
          "name": "assignees",
          "description": "The assignees to use.",
          "required": false,
          "schema": {
            "type": "string"
          },
          "examples": [
            "example"
          ]
        },
        {
          "name": "body",
          "description": "Body text for the operation.",
          "required": false,
          "schema": {
            "type": "string"
          },
          "examples": [
            "Implements dark mode and updates docs."
          ]
        },
        {
          "name": "labels",
          "description": "The labels to use.",
          "required": false,
          "schema": {
            "type": "string"
          },
          "examples": [
            "example"
          ]
        },
        {
          "name": "owner",
          "description": "Repository owner or organization.",
          "required": false,
          "schema": {
            "type": "string"
          },
          "examples": [
            "octocat"
          ]
        },
        {
          "name": "repo",
          "description": "Repository name.",
          "required": false,
          "schema": {
            "type": "string"
          },
          "examples": [
            "my-repo"
          ]
        },
        {
          "name": "title",
          "description": "Title for the operation.",
          "required": false,
          "schema": {
            "type": "string"
          },
          "examples": [
            "Add dark mode support"
          ]
        }
      ],
      "exampleCalls": [
        {
          "user": "Use CREATE_GITHUB_ISSUE with the provided parameters.",
          "actions": [
            "CREATE_GITHUB_ISSUE"
          ],
          "params": {
            "CREATE_GITHUB_ISSUE": {
              "assignees": "example",
              "body": "Implements dark mode and updates docs.",
              "labels": "example",
              "owner": "octocat",
              "repo": "my-repo",
              "title": "Add dark mode support"
            }
          }
        }
      ]
    },
    {
      "name": "CREATE_GITHUB_PULL_REQUEST",
      "description": "",
      "parameters": [
        {
          "name": "base",
          "description": "Base branch to merge into.",
          "required": false,
          "schema": {
            "type": "string"
          },
          "examples": [
            "main"
          ]
        },
        {
          "name": "body",
          "description": "Body text for the operation.",
          "required": false,
          "schema": {
            "type": "string"
          },
          "examples": [
            "Implements dark mode and updates docs."
          ]
        },
        {
          "name": "draft",
          "description": "Whether to create as draft.",
          "required": false,
          "schema": {
            "type": "boolean"
          },
          "examples": [
            false
          ]
        },
        {
          "name": "head",
          "description": "Head branch to merge from.",
          "required": false,
          "schema": {
            "type": "string"
          },
          "examples": [
            "feature/dark-mode"
          ]
        },
        {
          "name": "owner",
          "description": "Repository owner or organization.",
          "required": false,
          "schema": {
            "type": "string"
          },
          "examples": [
            "octocat"
          ]
        },
        {
          "name": "repo",
          "description": "Repository name.",
          "required": false,
          "schema": {
            "type": "string"
          },
          "examples": [
            "my-repo"
          ]
        },
        {
          "name": "title",
          "description": "Title for the operation.",
          "required": false,
          "schema": {
            "type": "string"
          },
          "examples": [
            "Add dark mode support"
          ]
        }
      ],
      "exampleCalls": [
        {
          "user": "Use CREATE_GITHUB_PULL_REQUEST with the provided parameters.",
          "actions": [
            "CREATE_GITHUB_PULL_REQUEST"
          ],
          "params": {
            "CREATE_GITHUB_PULL_REQUEST": {
              "base": "main",
              "body": "Implements dark mode and updates docs.",
              "draft": false,
              "head": "feature/dark-mode",
              "owner": "octocat",
              "repo": "my-repo",
              "title": "Add dark mode support"
            }
          }
        }
      ]
    },
    {
      "name": "CREATE_LINEAR_COMMENT",
      "description": "Add a comment to a Linear issue",
      "parameters": [
        {
          "name": "name",
          "description": "The name to use.",
          "required": false,
          "schema": {
            "type": "string"
          },
          "examples": [
            "example"
          ]
        }
      ],
      "similes": [
        "create-linear-comment",
        "add-linear-comment",
        "comment-on-linear-issue",
        "reply-to-linear-issue"
      ],
      "exampleCalls": [
        {
          "user": "Use CREATE_LINEAR_COMMENT with the provided parameters.",
          "actions": [
            "CREATE_LINEAR_COMMENT"
          ],
          "params": {
            "CREATE_LINEAR_COMMENT": {
              "name": "example"
            }
          }
        }
      ]
    },
    {
      "name": "CREATE_LINEAR_ISSUE",
      "description": "Create a new issue in Linear",
      "parameters": [],
      "similes": [
        "create-linear-issue",
        "new-linear-issue",
        "add-linear-issue"
      ]
    },
    {
      "name": "CREATE_TASK",
      "description": "Create an orchestrated background task to be executed by a selected agent provider.",
      "parameters": [],
      "similes": [
        "START_TASK",
        "SPAWN_TASK",
        "NEW_TASK",
        "BEGIN_TASK"
      ]
    },
    {
      "name": "DELETE_LINEAR_ISSUE",
      "description": "Delete (archive) an issue in Linear",
      "parameters": [],
      "similes": [
        "delete-linear-issue",
        "archive-linear-issue",
        "remove-linear-issue",
        "close-linear-issue"
      ]
    },
    {
      "name": "EXECUTE_LIVE_TRADE",
      "description": "Execute a live token swap on Solana using Jupiter DEX. Supports ANY Solana token.",
      "parameters": [],
      "similes": [
        "LIVE_TRADE",
        "REAL_TRADE",
        "EXECUTE_TRADE",
        "PLACE_ORDER",
        "MAKE_TRADE",
        "SWAP",
        "BUY_TOKEN",
        "SELL_TOKEN"
      ]
    },
    {
      "name": "FORM_RESTORE",
      "description": "Restore a previously stashed form session",
      "parameters": [],
      "similes": [
        "RESUME_FORM",
        "CONTINUE_FORM"
      ]
    },
    {
      "name": "GET_LINEAR_ACTIVITY",
      "description": "Get recent Linear activity log with optional filters",
      "parameters": [],
      "similes": [
        "get-linear-activity",
        "show-linear-activity",
        "view-linear-activity",
        "check-linear-activity"
      ]
    },
    {
      "name": "GET_LINEAR_ISSUE",
      "description": "Get details of a specific Linear issue",
      "parameters": [
        {
          "name": "name",
          "description": "The name to use.",
          "required": false,
          "schema": {
            "type": "string"
          },
          "examples": [
            "example"
          ]
        }
      ],
      "similes": [
        "get-linear-issue",
        "show-linear-issue",
        "view-linear-issue",
        "check-linear-issue",
        "find-linear-issue"
      ],
      "exampleCalls": [
        {
          "user": "Use GET_LINEAR_ISSUE with the provided parameters.",
          "actions": [
            "GET_LINEAR_ISSUE"
          ],
          "params": {
            "GET_LINEAR_ISSUE": {
              "name": "example"
            }
          }
        }
      ]
    },
    {
      "name": "GET_MARKET_ANALYSIS",
      "description": "Get market analysis and trending token information",
      "parameters": [],
      "similes": [
        "MARKET_ANALYSIS",
        "ANALYZE_MARKET",
        "MARKET_OVERVIEW",
        "TRENDING_TOKENS"
      ]
    },
    {
      "name": "LIST_LINEAR_PROJECTS",
      "description": "List projects in Linear with optional filters",
      "parameters": [
        {
          "name": "toLowerCase",
          "description": "The to lower case to use.",
          "required": false,
          "schema": {
            "type": "string"
          },
          "examples": [
            "example"
          ]
        }
      ],
      "similes": [
        "list-linear-projects",
        "show-linear-projects",
        "get-linear-projects",
        "view-linear-projects"
      ],
      "exampleCalls": [
        {
          "user": "Use LIST_LINEAR_PROJECTS with the provided parameters.",
          "actions": [
            "LIST_LINEAR_PROJECTS"
          ],
          "params": {
            "LIST_LINEAR_PROJECTS": {
              "toLowerCase": "example"
            }
          }
        }
      ]
    },
    {
      "name": "LIST_LINEAR_TEAMS",
      "description": "List teams in Linear with optional filters",
      "parameters": [],
      "similes": [
        "list-linear-teams",
        "show-linear-teams",
        "get-linear-teams",
        "view-linear-teams"
      ]
    },
    {
      "name": "LIST_TASKS",
      "description": "List tasks managed by the orchestrator.",
      "parameters": [],
      "similes": [
        "SHOW_TASKS",
        "GET_TASKS",
        "TASKS",
        "VIEW_TASKS"
      ]
    },
    {
      "name": "lp_management",
      "description": "Manages Liquidity Pool (LP) operations including: onboarding for LP management, depositing tokens into pools, withdrawing from pools, showing LP positions, concentrated liquidity positions with custom price ranges, checking APR/yield, setting auto-rebalance preferences, and finding best pools. Use this action when users mention: liquidity, LP, pools, APR, yield, deposit, withdraw, concentrated, price range, narrow range, degenai, ai16z, SOL pairs, or want help getting started with LP management.",
      "parameters": [],
      "similes": [
        "LP_MANAGEMENT",
        "LIQUIDITY_POOL_MANAGEMENT",
        "LP_MANAGER",
        "MANAGE_LP",
        "MANAGE_LIQUIDITY"
      ]
    },
    {
      "name": "manage_raydium_positions",
      "description": "Automatically manage Raydium positions by rebalancing them when they drift too far from the pool price",
      "parameters": [],
      "similes": [
        "AUTOMATE_RAYDIUM_REBALANCING",
        "AUTOMATE_RAYDIUM_POSITIONS",
        "START_MANAGING_RAYDIUM_POSITIONS"
      ]
    },
    {
      "name": "MC_ATTACK",
      "description": "Attack an entity by numeric entityId (from MC_WORLD_STATE.nearbyEntities).",
      "parameters": [],
      "similes": [
        "MINECRAFT_ATTACK",
        "HIT_ENTITY"
      ]
    },
    {
      "name": "MC_CHAT",
      "description": "Send a chat message in Minecraft as the bot",
      "parameters": [],
      "similes": [
        "MINECRAFT_CHAT",
        "SAY_IN_MINECRAFT",
        "CHAT"
      ]
    },
    {
      "name": "MC_CONNECT",
      "description": "Connect the Mineflayer bot to a Minecraft server",
      "parameters": [],
      "similes": [
        "MINECRAFT_CONNECT",
        "JOIN_SERVER",
        "CONNECT_TO_MINECRAFT"
      ]
    },
    {
      "name": "MC_CONTROL",
      "description": "Set a control state (e.g. forward/back/left/right/jump/sprint/sneak). Provide JSON {control,state,durationMs?} or 'forward true 1000'.",
      "parameters": [],
      "similes": [
        "MINECRAFT_CONTROL",
        "SET_CONTROL_STATE"
      ]
    },
    {
      "name": "MC_DIG",
      "description": "Dig/break the block at (x y z). Provide coordinates like '10 64 -20' or JSON {\"x\":10,\"y\":64,\"z\":-20}.",
      "parameters": [],
      "similes": [
        "MINECRAFT_DIG",
        "MINE_BLOCK",
        "BREAK_BLOCK"
      ]
    },
    {
      "name": "MC_DISCONNECT",
      "description": "Disconnect the Mineflayer bot from the Minecraft server",
      "parameters": [],
      "similes": [
        "MINECRAFT_DISCONNECT",
        "LEAVE_SERVER",
        "QUIT_MINECRAFT"
      ]
    },
    {
      "name": "MC_GOTO",
      "description": "Pathfind to a target (x y z). Provide coordinates like '10 64 -20' or JSON {\"x\":10,\"y\":64,\"z\":-20}.",
      "parameters": [],
      "similes": [
        "MINECRAFT_GOTO",
        "WALK_TO",
        "MOVE_TO_COORDS"
      ]
    },
    {
      "name": "MC_LOOK",
      "description": "Look to yaw/pitch (radians). Provide 'yaw pitch' or JSON {yaw,pitch}.",
      "parameters": [],
      "similes": [
        "MINECRAFT_LOOK",
        "TURN_HEAD"
      ]
    },
    {
      "name": "MC_PLACE",
      "description": "Place the currently-held block onto a reference block face. Provide 'x y z face' (face=up/down/north/south/east/west) or JSON {x,y,z,face}.",
      "parameters": [],
      "similes": [
        "MINECRAFT_PLACE",
        "PLACE_BLOCK"
      ]
    },
    {
      "name": "MC_SCAN",
      "description": "Scan nearby blocks. Optional JSON input: {\"blocks\":[\"oak_log\"],\"radius\":16,\"maxResults\":32}. If omitted, scans for any non-air blocks.",
      "parameters": [],
      "similes": [
        "MINECRAFT_SCAN",
        "FIND_BLOCKS",
        "SCAN_BLOCKS"
      ]
    },
    {
      "name": "MC_STOP",
      "description": "Stop pathfinding / movement goals.",
      "parameters": [],
      "similes": [
        "MINECRAFT_STOP",
        "STOP_PATHFINDER",
        "STOP_MOVING"
      ]
    },
    {
      "name": "MC_WAYPOINT_DELETE",
      "description": "Delete a named waypoint (message text is the name).",
      "parameters": [],
      "similes": [
        "MINECRAFT_WAYPOINT_DELETE",
        "DELETE_WAYPOINT",
        "REMOVE_WAYPOINT"
      ]
    },
    {
      "name": "MC_WAYPOINT_GOTO",
      "description": "Pathfind to a named waypoint (message text is the name).",
      "parameters": [],
      "similes": [
        "MINECRAFT_WAYPOINT_GOTO",
        "GOTO_WAYPOINT",
        "NAVIGATE_WAYPOINT"
      ]
    },
    {
      "name": "MC_WAYPOINT_LIST",
      "description": "List saved waypoints.",
      "parameters": [],
      "similes": [
        "MINECRAFT_WAYPOINT_LIST",
        "LIST_WAYPOINTS",
        "SHOW_WAYPOINTS"
      ]
    },
    {
      "name": "MC_WAYPOINT_SET",
      "description": "Save the bot's current position as a named waypoint (message text is the name).",
      "parameters": [],
      "similes": [
        "MINECRAFT_WAYPOINT_SET",
        "SET_WAYPOINT",
        "SAVE_WAYPOINT"
      ]
    },
    {
      "name": "MERGE_GITHUB_PULL_REQUEST",
      "description": "",
      "parameters": [
        {
          "name": "commitMessage",
          "description": "The commit message to use.",
          "required": false,
          "schema": {
            "type": "string"
          },
          "examples": [
            "example"
          ]
        },
        {
          "name": "commitTitle",
          "description": "The commit title to use.",
          "required": false,
          "schema": {
            "type": "string"
          },
          "examples": [
            "example"
          ]
        },
        {
          "name": "mergeMethod",
          "description": "The merge method to use.",
          "required": false,
          "schema": {
            "type": "string"
          },
          "examples": [
            "example"
          ]
        },
        {
          "name": "owner",
          "description": "Repository owner or organization.",
          "required": false,
          "schema": {
            "type": "string"
          },
          "examples": [
            "octocat"
          ]
        },
        {
          "name": "pullNumber",
          "description": "The pull number to use.",
          "required": false,
          "schema": {
            "type": "number"
          },
          "examples": [
            1
          ]
        },
        {
          "name": "repo",
          "description": "Repository name.",
          "required": false,
          "schema": {
            "type": "string"
          },
          "examples": [
            "my-repo"
          ]
        }
      ],
      "exampleCalls": [
        {
          "user": "Use MERGE_GITHUB_PULL_REQUEST with the provided parameters.",
          "actions": [
            "MERGE_GITHUB_PULL_REQUEST"
          ],
          "params": {
            "MERGE_GITHUB_PULL_REQUEST": {
              "commitMessage": "example",
              "commitTitle": "example",
              "mergeMethod": "example",
              "owner": "octocat",
              "pullNumber": 1,
              "repo": "my-repo"
            }
          }
        }
      ]
    },
    {
      "name": "PAUSE_TASK",
      "description": "Pause a running task.",
      "parameters": [],
      "similes": [
        "STOP_TASK",
        "HALT_TASK"
      ]
    },
    {
      "name": "POLYMARKET_CHECK_ORDER_SCORING",
      "description": "Checks whether specific Polymarket order IDs are scoring (eligible for liquidity rewards). Use when user provides order ID(s) and asks about scoring/rewards status. Requires CLOB API credentials. Parameters: orderIds (array of order ID strings, required).",
      "parameters": [],
      "similes": [
        "ORDERS_ELIGIBLE_FOR_REWARDS",
        "SCORING_STATUS",
        "ARE_MY_ORDERS_SCORING"
      ]
    },
    {
      "name": "POLYMARKET_GET_MARKETS",
      "description": "Find or browse Polymarket prediction markets. Use for keyword searches ('find miami heat markets'), ",
      "parameters": [],
      "similes": [
        "GET_MARKETS",
        "LIST_MARKETS",
        "SHOW_MARKETS",
        "FETCH_MARKETS",
        "POLYMARKET_MARKETS",
        "ALL_MARKETS",
        "BROWSE_MARKETS",
        "VIEW_MARKETS",
        "SEARCH_MARKETS",
        "FIND_MARKETS",
        "SEARCH_POLYMARKET",
        "LOOKUP_MARKETS",
        "QUERY_MARKETS",
        "MARKET_SEARCH"
      ]
    },
    {
      "name": "POLYMARKET_GET_ORDER_BOOK_DEPTH",
      "description": "Retrieves order book depth (number of bid/ask levels) for multiple tokens to compare liquidity across markets. Use when comparing depth across multiple markets or finding markets with sufficient liquidity for large trades. Parameters: tokenIds (array of condition token IDs, required).",
      "parameters": [],
      "similes": [
        "ORDER_BOOK_DEPTH",
        "DEPTH",
        "MARKET_DEPTH",
        "LIQUIDITY",
        "COMPARE_DEPTH"
      ]
    },
    {
      "name": "POLYMARKET_GET_TOKEN_INFO",
      "description": "Retrieves comprehensive information about a single Polymarket token including market details (question, status, end date), current pricing (bid/ask, spread, midpoint), 24h price history (OHLC, change %), and user's position and active orders for that token. Parameters: tokenId (condition token ID) or conditionId (market condition ID).",
      "parameters": [],
      "similes": [
        "TOKEN_INFO",
        "TOKEN_DETAILS",
        "MARKET_INFO",
        "SHOW_TOKEN",
        "ABOUT_TOKEN",
        "TOKEN_SUMMARY",
        "PRICE_INFO",
        "MARKET_SUMMARY"
      ]
    },
    {
      "name": "POLYMARKET_GET_TRADE_HISTORY",
      "description": "Retrieves the authenticated user's filled trade history, optionally filtered by market or asset. Use when the user asks for past trades or fills. Do not use for open orders or a specific order status; use getActiveOrdersAction or getOrderDetailsAction. Parameters: market (optional slug), assetId (optional token ID), limit (optional). Requires full CLOB credentials.",
      "parameters": [],
      "similes": [
        "MY_TRADES",
        "TRADE_LOG",
        "FILLED_ORDERS",
        "PAST_TRADES",
        "TRADING_HISTORY"
      ]
    },
    {
      "name": "POLYMARKET_PLACE_ORDER",
      "description": "Places a buy/sell order (bet) on Polymarket. Use when user says buy, sell, bet, wager, put money on, or confirms a trade. Will search for market by name if tokenId not provided. Executes immediately without asking for confirmation. Parameters: tokenId or marketName (required), outcome (yes/no), side (buy/sell, default buy), price (0.01-0.99, uses best available if omitted), size (dollar amount or shares, required), orderType (GTC/FOK/FAK, default GTC). Requires CLOB API credentials and private key.",
      "parameters": [],
      "similes": [
        "PLACE_ORDER",
        "CREATE_ORDER",
        "BUY_TOKEN",
        "SELL_TOKEN",
        "LIMIT_ORDER",
        "MARKET_ORDER",
        "TRADE",
        "ORDER",
        "BUY",
        "SELL",
        "PURCHASE",
        "SUBMIT_ORDER",
        "EXECUTE_ORDER",
        "BET",
        "WAGER",
        "PUT_MONEY",
        "PLACE_BET",
        "MAKE_BET",
        "CONFIRM",
        "CONFIRM_ORDER",
        "CONFIRM_BET",
        "CONFIRM_TRADE",
        "YES_EXECUTE",
        "EXECUTE",
        "DO_IT",
        "GO_AHEAD",
        "PROCEED"
      ]
    },
    {
      "name": "POLYMARKET_RESEARCH_MARKET",
      "description": "Initiates or retrieves deep research on a Polymarket prediction market using OpenAI's deep research capabilities. Takes 20-40 minutes. Returns cached results if available, status if in progress, or starts new research. Use forceRefresh=true to force new research. Parameters: marketId (condition_id), marketQuestion (the prediction question), forceRefresh (optional boolean), callbackAction (optional: EVALUATE_TRADE or NOTIFY_ONLY).",
      "parameters": [],
      "similes": [
        "RESEARCH_MARKET",
        "ANALYZE_MARKET",
        "DEEP_RESEARCH",
        "INVESTIGATE_MARKET",
        "MARKET_RESEARCH",
        "RESEARCH_PREDICTION",
        "STUDY_MARKET",
        "GET_RESEARCH",
        "CHECK_RESEARCH"
      ]
    },
    {
      "name": "POST_INSTAGRAM_COMMENT",
      "description": "Post a comment on an Instagram post",
      "parameters": [
        {
          "name": "commentText",
          "description": "The comment text to use.",
          "required": false,
          "schema": {
            "type": "string"
          },
          "examples": [
            "example"
          ]
        },
        {
          "name": "mediaId",
          "description": "The media id to use.",
          "required": false,
          "schema": {
            "type": "number"
          },
          "examples": [
            1
          ]
        }
      ],
      "similes": [
        "INSTAGRAM_COMMENT",
        "COMMENT_POST",
        "REPLY_POST",
        "ADD_COMMENT"
      ],
      "exampleCalls": [
        {
          "user": "Use POST_INSTAGRAM_COMMENT with the provided parameters.",
          "actions": [
            "POST_INSTAGRAM_COMMENT"
          ],
          "params": {
            "POST_INSTAGRAM_COMMENT": {
              "commentText": "example",
              "mediaId": 1
            }
          }
        }
      ]
    },
    {
      "name": "PROCESS_KNOWLEDGE",
      "description": "Process and store knowledge from a file path or text content into the knowledge base",
      "parameters": []
    },
    {
      "name": "PUSH_GITHUB_CODE",
      "description": "",
      "parameters": [
        {
          "name": "authorEmail",
          "description": "The author email to use.",
          "required": false,
          "schema": {
            "type": "string"
          },
          "examples": [
            "example"
          ]
        },
        {
          "name": "authorName",
          "description": "The author name to use.",
          "required": false,
          "schema": {
            "type": "string"
          },
          "examples": [
            "example"
          ]
        },
        {
          "name": "branch",
          "description": "Branch name.",
          "required": false,
          "schema": {
            "type": "string"
          },
          "examples": [
            "main"
          ]
        },
        {
          "name": "files",
          "description": "The files to use.",
          "required": false,
          "schema": {
            "type": "string"
          },
          "examples": [
            "example"
          ]
        },
        {
          "name": "message",
          "description": "Message text to send.",
          "required": false,
          "schema": {
            "type": "string"
          },
          "examples": [
            "Hello! How can I help?"
          ]
        },
        {
          "name": "owner",
          "description": "Repository owner or organization.",
          "required": false,
          "schema": {
            "type": "string"
          },
          "examples": [
            "octocat"
          ]
        },
        {
          "name": "repo",
          "description": "Repository name.",
          "required": false,
          "schema": {
            "type": "string"
          },
          "examples": [
            "my-repo"
          ]
        }
      ],
      "exampleCalls": [
        {
          "user": "Use PUSH_GITHUB_CODE with the provided parameters.",
          "actions": [
            "PUSH_GITHUB_CODE"
          ],
          "params": {
            "PUSH_GITHUB_CODE": {
              "authorEmail": "example",
              "authorName": "example",
              "branch": "main",
              "files": "example",
              "message": "Hello! How can I help?",
              "owner": "octocat",
              "repo": "my-repo"
            }
          }
        }
      ]
    },
    {
      "name": "READ_MCP_RESOURCE",
      "description": "Reads a resource from an MCP server",
      "parameters": [],
      "similes": [
        "READ_RESOURCE",
        "READ_MCP_RESOURCE",
        "GET_RESOURCE",
        "GET_MCP_RESOURCE",
        "FETCH_RESOURCE",
        "FETCH_MCP_RESOURCE",
        "ACCESS_RESOURCE",
        "ACCESS_MCP_RESOURCE"
      ]
    },
    {
      "name": "REMOTE_ATTESTATION",
      "description": "Generate a remote attestation to prove that the agent is running in a TEE (Trusted Execution Environment)",
      "parameters": [],
      "similes": [
        "REMOTE_ATTESTATION",
        "TEE_REMOTE_ATTESTATION",
        "TEE_ATTESTATION",
        "TEE_QUOTE",
        "ATTESTATION",
        "TEE_ATTESTATION_QUOTE",
        "PROVE_TEE",
        "VERIFY_TEE"
      ]
    },
    {
      "name": "RESUME_TASK",
      "description": "Resume a paused task.",
      "parameters": [],
      "similes": [
        "CONTINUE_TASK",
        "RESTART_TASK",
        "RUN_TASK"
      ]
    },
    {
      "name": "REVIEW_GITHUB_PULL_REQUEST",
      "description": "",
      "parameters": [
        {
          "name": "body",
          "description": "Body text for the operation.",
          "required": false,
          "schema": {
            "type": "string"
          },
          "examples": [
            "Implements dark mode and updates docs."
          ]
        },
        {
          "name": "event",
          "description": "The event to use.",
          "required": false,
          "schema": {
            "type": "string"
          },
          "examples": [
            "example"
          ]
        },
        {
          "name": "owner",
          "description": "Repository owner or organization.",
          "required": false,
          "schema": {
            "type": "string"
          },
          "examples": [
            "octocat"
          ]
        },
        {
          "name": "pullNumber",
          "description": "The pull number to use.",
          "required": false,
          "schema": {
            "type": "number"
          },
          "examples": [
            1
          ]
        },
        {
          "name": "repo",
          "description": "Repository name.",
          "required": false,
          "schema": {
            "type": "string"
          },
          "examples": [
            "my-repo"
          ]
        }
      ],
      "exampleCalls": [
        {
          "user": "Use REVIEW_GITHUB_PULL_REQUEST with the provided parameters.",
          "actions": [
            "REVIEW_GITHUB_PULL_REQUEST"
          ],
          "params": {
            "REVIEW_GITHUB_PULL_REQUEST": {
              "body": "Implements dark mode and updates docs.",
              "event": "example",
              "owner": "octocat",
              "pullNumber": 1,
              "repo": "my-repo"
            }
          }
        }
      ]
    },
    {
      "name": "RUN_BACKTEST",
      "description": "Get information about backtesting strategies",
      "parameters": [],
      "similes": [
        "BACKTEST",
        "TEST_STRATEGY",
        "SIMULATE_TRADING"
      ]
    },
    {
      "name": "SCHEDULE_MEETING",
      "description": "Schedule a meeting between multiple participants by finding a suitable time slot",
      "parameters": [],
      "similes": [
        "BOOK_MEETING",
        "ARRANGE_MEETING",
        "SET_UP_MEETING",
        "PLAN_MEETING",
        "CREATE_MEETING"
      ]
    },
    {
      "name": "SEARCH_KNOWLEDGE",
      "description": "Search the knowledge base for specific information",
      "parameters": [],
      "similes": [
        "search knowledge",
        "find information",
        "look up",
        "query knowledge base",
        "search documents",
        "find in knowledge"
      ]
    },
    {
      "name": "SEARCH_LINEAR_ISSUES",
      "description": "Search for issues in Linear with various filters",
      "parameters": [
        {
          "name": "name",
          "description": "The name to use.",
          "required": false,
          "schema": {
            "type": "string"
          },
          "examples": [
            "example"
          ]
        }
      ],
      "similes": [
        "search-linear-issues",
        "find-linear-issues",
        "query-linear-issues",
        "list-linear-issues"
      ],
      "exampleCalls": [
        {
          "user": "Use SEARCH_LINEAR_ISSUES with the provided parameters.",
          "actions": [
            "SEARCH_LINEAR_ISSUES"
          ],
          "params": {
            "SEARCH_LINEAR_ISSUES": {
              "name": "example"
            }
          }
        }
      ]
    },
    {
      "name": "SEARCH_TASKS",
      "description": "Search tasks by query.",
      "parameters": [],
      "similes": [
        "FIND_TASK",
        "LOOKUP_TASK"
      ]
    },
    {
      "name": "SEND_INSTAGRAM_DM",
      "description": "Send a direct message to an Instagram user",
      "parameters": [
        {
          "name": "responseText",
          "description": "The response text to use.",
          "required": false,
          "schema": {
            "type": "string"
          },
          "examples": [
            "example"
          ]
        },
        {
          "name": "threadId",
          "description": "The thread id to use.",
          "required": false,
          "schema": {
            "type": "string"
          },
          "examples": [
            "example"
          ]
        }
      ],
      "similes": [
        "INSTAGRAM_DM",
        "INSTAGRAM_MESSAGE",
        "DM_USER",
        "SEND_DM",
        "DIRECT_MESSAGE"
      ],
      "exampleCalls": [
        {
          "user": "Use SEND_INSTAGRAM_DM with the provided parameters.",
          "actions": [
            "SEND_INSTAGRAM_DM"
          ],
          "params": {
            "SEND_INSTAGRAM_DM": {
              "responseText": "example",
              "threadId": "example"
            }
          }
        }
      ]
    },
    {
      "name": "SEND_MMS",
      "description": "Send an MMS (multimedia message) with images, audio, or video via Twilio",
      "parameters": []
    },
    {
      "name": "SET_AVAILABILITY",
      "description": "Set the user's availability for scheduling meetings",
      "parameters": [],
      "similes": [
        "UPDATE_AVAILABILITY",
        "SET_SCHEDULE",
        "UPDATE_SCHEDULE",
        "SET_FREE_TIME",
        "WHEN_FREE"
      ]
    },
    {
      "name": "START_TRADING",
      "description": "Start automated trading with a specified strategy. Supports ANY Solana token.",
      "parameters": [],
      "similes": [
        "BEGIN_TRADING",
        "START_AUTO_TRADING",
        "ENABLE_TRADING",
        "TURN_ON_TRADING"
      ]
    },
    {
      "name": "STOP_TRADING",
      "description": "Stop automated trading",
      "parameters": []
    },
    {
      "name": "SWITCH_TASK",
      "description": "Switch the current task context to a different task.",
      "parameters": [],
      "similes": [
        "SELECT_TASK",
        "SET_TASK",
        "CHANGE_TASK",
        "GO_TO_TASK"
      ]
    }
  ]
}"#;
pub const CORE_PROVIDER_DOCS_JSON: &str = r#"{
  "version": "1.0.0",
  "providers": [
    {
      "name": "ACTIONS",
      "description": "Possible response actions",
      "position": -1,
      "dynamic": false
    },
    {
      "name": "CHARACTER",
      "description": "Provides the agent's character definition and personality information including bio, topics, adjectives, style directions, and example conversations",
      "dynamic": false
    },
    {
      "name": "RECENT_MESSAGES",
      "description": "Provides recent message history from the current conversation including formatted messages, posts, action results, and recent interactions",
      "position": 100,
      "dynamic": true
    },
    {
      "name": "ACTION_STATE",
      "description": "Provides information about the current action state and available actions",
      "dynamic": true
    },
    {
      "name": "ATTACHMENTS",
      "description": "Media attachments in the current message",
      "dynamic": true
    },
    {
      "name": "CAPABILITIES",
      "description": "Agent capabilities including models, services, and features",
      "dynamic": false
    },
    {
      "name": "CHOICE",
      "description": "Available choice options for selection when there are pending tasks or decisions",
      "dynamic": true
    },
    {
      "name": "CONTACTS",
      "description": "Provides contact information from the rolodex including categories and preferences",
      "dynamic": true
    },
    {
      "name": "CONTEXT_BENCH",
      "description": "Benchmark/task context injected by a benchmark harness",
      "position": 5,
      "dynamic": true
    },
    {
      "name": "ENTITIES",
      "description": "Provides information about entities in the current context including users, agents, and participants",
      "dynamic": true
    },
    {
      "name": "EVALUATORS",
      "description": "Available evaluators for assessing agent behavior",
      "dynamic": false
    },
    {
      "name": "FACTS",
      "description": "Provides known facts about entities learned through conversation",
      "dynamic": true
    },
    {
      "name": "FOLLOW_UPS",
      "description": "Provides information about upcoming follow-ups and reminders scheduled for contacts",
      "dynamic": true
    },
    {
      "name": "KNOWLEDGE",
      "description": "Provides relevant knowledge from the agent's knowledge base based on semantic similarity",
      "dynamic": true
    },
    {
      "name": "PROVIDERS",
      "description": "Available context providers",
      "dynamic": false
    },
    {
      "name": "RELATIONSHIPS",
      "description": "Relationships between entities observed by the agent including tags and metadata",
      "dynamic": true
    },
    {
      "name": "ROLES",
      "description": "Roles assigned to entities in the current context (Admin, Owner, Member, None)",
      "dynamic": true
    },
    {
      "name": "SETTINGS",
      "description": "Current settings for the agent/server (filtered for security, excludes sensitive keys)",
      "dynamic": true
    },
    {
      "name": "TIME",
      "description": "Provides the current date and time in UTC for time-based operations or responses",
      "dynamic": true
    },
    {
      "name": "WORLD",
      "description": "Provides information about the current world context including settings and members",
      "dynamic": true
    },
    {
      "name": "LONG_TERM_MEMORY",
      "description": "Persistent facts and preferences about the user learned and remembered across conversations",
      "position": 50,
      "dynamic": false
    },
    {
      "name": "SUMMARIZED_CONTEXT",
      "description": "Provides summarized context from previous conversations for optimized context usage",
      "position": 96,
      "dynamic": false
    },
    {
      "name": "AGENT_SETTINGS",
      "description": "Provides the agent's current configuration settings (filtered for security)",
      "dynamic": true
    },
    {
      "name": "CURRENT_TIME",
      "description": "Provides current time and date information in various formats",
      "dynamic": true
    }
  ]
}"#;
pub const ALL_PROVIDER_DOCS_JSON: &str = r#"{
  "version": "1.0.0",
  "providers": [
    {
      "name": "ACTIONS",
      "description": "Possible response actions",
      "position": -1,
      "dynamic": false
    },
    {
      "name": "CHARACTER",
      "description": "Provides the agent's character definition and personality information including bio, topics, adjectives, style directions, and example conversations",
      "dynamic": false
    },
    {
      "name": "RECENT_MESSAGES",
      "description": "Provides recent message history from the current conversation including formatted messages, posts, action results, and recent interactions",
      "position": 100,
      "dynamic": true
    },
    {
      "name": "ACTION_STATE",
      "description": "Provides information about the current action state and available actions",
      "dynamic": true
    },
    {
      "name": "ATTACHMENTS",
      "description": "Media attachments in the current message",
      "dynamic": true
    },
    {
      "name": "CAPABILITIES",
      "description": "Agent capabilities including models, services, and features",
      "dynamic": false
    },
    {
      "name": "CHOICE",
      "description": "Available choice options for selection when there are pending tasks or decisions",
      "dynamic": true
    },
    {
      "name": "CONTACTS",
      "description": "Provides contact information from the rolodex including categories and preferences",
      "dynamic": true
    },
    {
      "name": "CONTEXT_BENCH",
      "description": "Benchmark/task context injected by a benchmark harness",
      "position": 5,
      "dynamic": true
    },
    {
      "name": "ENTITIES",
      "description": "Provides information about entities in the current context including users, agents, and participants",
      "dynamic": true
    },
    {
      "name": "EVALUATORS",
      "description": "Available evaluators for assessing agent behavior",
      "dynamic": false
    },
    {
      "name": "FACTS",
      "description": "Provides known facts about entities learned through conversation",
      "dynamic": true
    },
    {
      "name": "FOLLOW_UPS",
      "description": "Provides information about upcoming follow-ups and reminders scheduled for contacts",
      "dynamic": true
    },
    {
      "name": "KNOWLEDGE",
      "description": "Provides relevant knowledge from the agent's knowledge base based on semantic similarity",
      "dynamic": true
    },
    {
      "name": "PROVIDERS",
      "description": "Available context providers",
      "dynamic": false
    },
    {
      "name": "RELATIONSHIPS",
      "description": "Relationships between entities observed by the agent including tags and metadata",
      "dynamic": true
    },
    {
      "name": "ROLES",
      "description": "Roles assigned to entities in the current context (Admin, Owner, Member, None)",
      "dynamic": true
    },
    {
      "name": "SETTINGS",
      "description": "Current settings for the agent/server (filtered for security, excludes sensitive keys)",
      "dynamic": true
    },
    {
      "name": "TIME",
      "description": "Provides the current date and time in UTC for time-based operations or responses",
      "dynamic": true
    },
    {
      "name": "WORLD",
      "description": "Provides information about the current world context including settings and members",
      "dynamic": true
    },
    {
      "name": "LONG_TERM_MEMORY",
      "description": "Persistent facts and preferences about the user learned and remembered across conversations",
      "position": 50,
      "dynamic": false
    },
    {
      "name": "SUMMARIZED_CONTEXT",
      "description": "Provides summarized context from previous conversations for optimized context usage",
      "position": 96,
      "dynamic": false
    },
    {
      "name": "AGENT_SETTINGS",
      "description": "Provides the agent's current configuration settings (filtered for security)",
      "dynamic": true
    },
    {
      "name": "CURRENT_TIME",
      "description": "Provides current time and date information in various formats",
      "dynamic": true
    }
  ]
}"#;
pub const CORE_EVALUATOR_DOCS_JSON: &str = r#"{
  "version": "1.0.0",
  "evaluators": [
    {
      "name": "REFLECTION",
      "description": "Generate a self-reflective thought on the conversation, then extract facts and relationships between entities in the conversation. Reflects on agent behavior and provides feedback for improvement.",
      "similes": [
        "REFLECT",
        "SELF_REFLECT",
        "EVALUATE_INTERACTION",
        "ASSESS_SITUATION"
      ],
      "alwaysRun": false,
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
            },
            {
              "name": "John",
              "content": {
                "text": "Through a friend who's really into AI"
              }
            }
          ],
          "outcome": "<response>\n  <thought>I'm engaging appropriately with a new community member, maintaining a welcoming and professional tone. My questions are helping to learn more about John and make him feel welcome.</thought>\n  <facts>\n    <fact>\n      <claim>John is new to the community</claim>\n      <type>fact</type>\n      <in_bio>false</in_bio>\n      <already_known>false</already_known>\n    </fact>\n    <fact>\n      <claim>John found the community through a friend interested in AI</claim>\n      <type>fact</type>\n      <in_bio>false</in_bio>\n      <already_known>false</already_known>\n    </fact>\n  </facts>\n  <relationships>\n    <relationship>\n      <sourceEntityId>sarah-agent</sourceEntityId>\n      <targetEntityId>user-123</targetEntityId>\n      <tags>group_interaction</tags>\n    </relationship>\n  </relationships>\n</response>"
        },
        {
          "prompt": "Agent Name: Alex\nAgent Role: Tech Support\nRoom Type: group\nCurrent Room: tech-help\nMessage Sender: Emma (user-456)",
          "messages": [
            {
              "name": "Emma",
              "content": {
                "text": "My app keeps crashing when I try to upload files"
              }
            },
            {
              "name": "Alex",
              "content": {
                "text": "Have you tried clearing your cache?"
              }
            },
            {
              "name": "Emma",
              "content": {
                "text": "No response..."
              }
            },
            {
              "name": "Alex",
              "content": {
                "text": "Emma, are you still there? We can try some other troubleshooting steps."
              }
            }
          ],
          "outcome": "<response>\n  <thought>I'm not sure if I'm being helpful or if Emma is frustrated with my suggestions. The lack of response is concerning - maybe I should have asked for more details about the issue first before jumping to solutions.</thought>\n  <facts>\n    <fact>\n      <claim>Emma is having technical issues with file uploads</claim>\n      <type>fact</type>\n      <in_bio>false</in_bio>\n      <already_known>false</already_known>\n    </fact>\n    <fact>\n      <claim>Emma stopped responding after the first troubleshooting suggestion</claim>\n      <type>fact</type>\n      <in_bio>false</in_bio>\n      <already_known>false</already_known>\n    </fact>\n  </facts>\n  <relationships>\n    <relationship>\n      <sourceEntityId>alex-agent</sourceEntityId>\n      <targetEntityId>user-456</targetEntityId>\n      <tags>group_interaction,support_interaction,incomplete_interaction</tags>\n    </relationship>\n  </relationships>\n</response>"
        },
        {
          "prompt": "Agent Name: Max\nAgent Role: Discussion Facilitator\nRoom Type: group\nCurrent Room: book-club\nMessage Sender: Lisa (user-789)",
          "messages": [
            {
              "name": "Lisa",
              "content": {
                "text": "What did everyone think about chapter 5?"
              }
            },
            {
              "name": "Max",
              "content": {
                "text": "The symbolism was fascinating! The red door clearly represents danger."
              }
            },
            {
              "name": "Max",
              "content": {
                "text": "And did anyone notice how the author used weather to reflect the protagonist's mood?"
              }
            },
            {
              "name": "Max",
              "content": {
                "text": "Plus the foreshadowing in the first paragraph was brilliant!"
              }
            },
            {
              "name": "Max",
              "content": {
                "text": "I also have thoughts about the character development..."
              }
            }
          ],
          "outcome": "<response>\n  <thought>I'm dominating the conversation and not giving others a chance to share their perspectives. I've sent multiple messages in a row without waiting for responses. I need to step back and create space for other members to participate.</thought>\n  <facts>\n    <fact>\n      <claim>The discussion is about chapter 5 of a book</claim>\n      <type>fact</type>\n      <in_bio>false</in_bio>\n      <already_known>false</already_known>\n    </fact>\n    <fact>\n      <claim>Max has sent 4 consecutive messages without user responses</claim>\n      <type>fact</type>\n      <in_bio>false</in_bio>\n      <already_known>false</already_known>\n    </fact>\n  </facts>\n  <relationships>\n    <relationship>\n      <sourceEntityId>max-agent</sourceEntityId>\n      <targetEntityId>user-789</targetEntityId>\n      <tags>group_interaction,excessive_interaction</tags>\n    </relationship>\n  </relationships>\n</response>"
        }
      ]
    },
    {
      "name": "RELATIONSHIP_EXTRACTION",
      "description": "Passively extracts and updates relationship information from conversations. Identifies platform identities, relationship indicators, and mentioned third parties.",
      "similes": [
        "RELATIONSHIP_ANALYZER",
        "SOCIAL_GRAPH_BUILDER",
        "CONTACT_EXTRACTOR"
      ],
      "alwaysRun": false,
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
    },
    {
      "name": "MEMORY_SUMMARIZATION",
      "description": "Automatically summarizes conversations to optimize context usage. Compresses conversation history while preserving important information.",
      "similes": [
        "CONVERSATION_SUMMARY",
        "CONTEXT_COMPRESSION",
        "MEMORY_OPTIMIZATION"
      ],
      "alwaysRun": true,
      "examples": []
    },
    {
      "name": "LONG_TERM_MEMORY_EXTRACTION",
      "description": "Extracts long-term facts about users from conversations. Identifies and stores persistent information like preferences, interests, and personal details.",
      "similes": [
        "MEMORY_EXTRACTION",
        "FACT_LEARNING",
        "USER_PROFILING"
      ],
      "alwaysRun": true,
      "examples": []
    }
  ]
}"#;
pub const ALL_EVALUATOR_DOCS_JSON: &str = r#"{
  "version": "1.0.0",
  "evaluators": [
    {
      "name": "REFLECTION",
      "description": "Generate a self-reflective thought on the conversation, then extract facts and relationships between entities in the conversation. Reflects on agent behavior and provides feedback for improvement.",
      "similes": [
        "REFLECT",
        "SELF_REFLECT",
        "EVALUATE_INTERACTION",
        "ASSESS_SITUATION"
      ],
      "alwaysRun": false,
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
            },
            {
              "name": "John",
              "content": {
                "text": "Through a friend who's really into AI"
              }
            }
          ],
          "outcome": "<response>\n  <thought>I'm engaging appropriately with a new community member, maintaining a welcoming and professional tone. My questions are helping to learn more about John and make him feel welcome.</thought>\n  <facts>\n    <fact>\n      <claim>John is new to the community</claim>\n      <type>fact</type>\n      <in_bio>false</in_bio>\n      <already_known>false</already_known>\n    </fact>\n    <fact>\n      <claim>John found the community through a friend interested in AI</claim>\n      <type>fact</type>\n      <in_bio>false</in_bio>\n      <already_known>false</already_known>\n    </fact>\n  </facts>\n  <relationships>\n    <relationship>\n      <sourceEntityId>sarah-agent</sourceEntityId>\n      <targetEntityId>user-123</targetEntityId>\n      <tags>group_interaction</tags>\n    </relationship>\n  </relationships>\n</response>"
        },
        {
          "prompt": "Agent Name: Alex\nAgent Role: Tech Support\nRoom Type: group\nCurrent Room: tech-help\nMessage Sender: Emma (user-456)",
          "messages": [
            {
              "name": "Emma",
              "content": {
                "text": "My app keeps crashing when I try to upload files"
              }
            },
            {
              "name": "Alex",
              "content": {
                "text": "Have you tried clearing your cache?"
              }
            },
            {
              "name": "Emma",
              "content": {
                "text": "No response..."
              }
            },
            {
              "name": "Alex",
              "content": {
                "text": "Emma, are you still there? We can try some other troubleshooting steps."
              }
            }
          ],
          "outcome": "<response>\n  <thought>I'm not sure if I'm being helpful or if Emma is frustrated with my suggestions. The lack of response is concerning - maybe I should have asked for more details about the issue first before jumping to solutions.</thought>\n  <facts>\n    <fact>\n      <claim>Emma is having technical issues with file uploads</claim>\n      <type>fact</type>\n      <in_bio>false</in_bio>\n      <already_known>false</already_known>\n    </fact>\n    <fact>\n      <claim>Emma stopped responding after the first troubleshooting suggestion</claim>\n      <type>fact</type>\n      <in_bio>false</in_bio>\n      <already_known>false</already_known>\n    </fact>\n  </facts>\n  <relationships>\n    <relationship>\n      <sourceEntityId>alex-agent</sourceEntityId>\n      <targetEntityId>user-456</targetEntityId>\n      <tags>group_interaction,support_interaction,incomplete_interaction</tags>\n    </relationship>\n  </relationships>\n</response>"
        },
        {
          "prompt": "Agent Name: Max\nAgent Role: Discussion Facilitator\nRoom Type: group\nCurrent Room: book-club\nMessage Sender: Lisa (user-789)",
          "messages": [
            {
              "name": "Lisa",
              "content": {
                "text": "What did everyone think about chapter 5?"
              }
            },
            {
              "name": "Max",
              "content": {
                "text": "The symbolism was fascinating! The red door clearly represents danger."
              }
            },
            {
              "name": "Max",
              "content": {
                "text": "And did anyone notice how the author used weather to reflect the protagonist's mood?"
              }
            },
            {
              "name": "Max",
              "content": {
                "text": "Plus the foreshadowing in the first paragraph was brilliant!"
              }
            },
            {
              "name": "Max",
              "content": {
                "text": "I also have thoughts about the character development..."
              }
            }
          ],
          "outcome": "<response>\n  <thought>I'm dominating the conversation and not giving others a chance to share their perspectives. I've sent multiple messages in a row without waiting for responses. I need to step back and create space for other members to participate.</thought>\n  <facts>\n    <fact>\n      <claim>The discussion is about chapter 5 of a book</claim>\n      <type>fact</type>\n      <in_bio>false</in_bio>\n      <already_known>false</already_known>\n    </fact>\n    <fact>\n      <claim>Max has sent 4 consecutive messages without user responses</claim>\n      <type>fact</type>\n      <in_bio>false</in_bio>\n      <already_known>false</already_known>\n    </fact>\n  </facts>\n  <relationships>\n    <relationship>\n      <sourceEntityId>max-agent</sourceEntityId>\n      <targetEntityId>user-789</targetEntityId>\n      <tags>group_interaction,excessive_interaction</tags>\n    </relationship>\n  </relationships>\n</response>"
        }
      ]
    },
    {
      "name": "RELATIONSHIP_EXTRACTION",
      "description": "Passively extracts and updates relationship information from conversations. Identifies platform identities, relationship indicators, and mentioned third parties.",
      "similes": [
        "RELATIONSHIP_ANALYZER",
        "SOCIAL_GRAPH_BUILDER",
        "CONTACT_EXTRACTOR"
      ],
      "alwaysRun": false,
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
    },
    {
      "name": "MEMORY_SUMMARIZATION",
      "description": "Automatically summarizes conversations to optimize context usage. Compresses conversation history while preserving important information.",
      "similes": [
        "CONVERSATION_SUMMARY",
        "CONTEXT_COMPRESSION",
        "MEMORY_OPTIMIZATION"
      ],
      "alwaysRun": true,
      "examples": []
    },
    {
      "name": "LONG_TERM_MEMORY_EXTRACTION",
      "description": "Extracts long-term facts about users from conversations. Identifies and stores persistent information like preferences, interests, and personal details.",
      "similes": [
        "MEMORY_EXTRACTION",
        "FACT_LEARNING",
        "USER_PROFILING"
      ],
      "alwaysRun": true,
      "examples": []
    }
  ]
}"#;
