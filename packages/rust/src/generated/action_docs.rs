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
      ],
      "descriptionCompressed": "Reply with generated msg. Default when responding with no other action. Use first as ack, last as final response."
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
      ],
      "descriptionCompressed": "Ignore user. Use when aggressive, creepy, conversation ended, or both sides said goodbye. Don't use if user engaged directly or needs error info."
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
      ],
      "descriptionCompressed": "Respond without additional action. Default when speaking only."
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
          ],
          "descriptionCompressed": "user or room target."
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
          ],
          "descriptionCompressed": "Platform (telegram, discord, x)."
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
          ],
          "descriptionCompressed": "Target name/handle/id."
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
          ],
          "descriptionCompressed": "Message content."
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
      ],
      "descriptionCompressed": "Send msg to another user or room (not current)."
    },
    {
      "name": "ADD_CONTACT",
      "description": "Add a new contact to the relationships with categorization and preferences",
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
        "add to relationships",
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
          ],
          "descriptionCompressed": "Contact name."
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
          ],
          "descriptionCompressed": "Optional notes/context."
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
              "text": "Save this person as a friend in my relationships"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "I've saved them as a friend in your relationships."
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
      ],
      "descriptionCompressed": "Add contact to relationships with category/preferences."
    },
    {
      "name": "UPDATE_CONTACT",
      "description": "Update an existing contact's details in the relationships.",
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
          ],
          "descriptionCompressed": "Contact name (must match existing)."
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
          ],
          "descriptionCompressed": "Fields to update (JSON)."
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
      ],
      "descriptionCompressed": "Update existing contact details."
    },
    {
      "name": "REMOVE_CONTACT",
      "description": "Remove a contact from the relationships.",
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
          ],
          "descriptionCompressed": "Contact name."
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
      ],
      "descriptionCompressed": "Remove contact from relationships."
    },
    {
      "name": "SEARCH_CONTACTS",
      "description": "Search and list contacts in the relationships by name or query.",
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
          ],
          "descriptionCompressed": "Search query (name/handle/free-text)."
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
      ],
      "descriptionCompressed": "Search/list contacts by name or query."
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
          ],
          "descriptionCompressed": "Contact name."
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
          ],
          "descriptionCompressed": "ISO-8601 datetime."
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
          ],
          "descriptionCompressed": "Optional reason/context."
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
      ],
      "descriptionCompressed": "Schedule follow-up reminder for contact."
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
          ],
          "descriptionCompressed": "Pending task id."
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
          ],
          "descriptionCompressed": "Option name exactly as listed."
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
      ],
      "descriptionCompressed": "Select option for pending multi-choice task."
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
          ],
          "descriptionCompressed": "Room id to follow."
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
      ],
      "descriptionCompressed": "Start following channel, chiming in without @mention. Only when explicitly asked."
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
          ],
          "descriptionCompressed": "Room id to unfollow."
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
      ],
      "descriptionCompressed": "Stop following room, cease updates."
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
          ],
          "descriptionCompressed": "Room id to mute."
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
      ],
      "descriptionCompressed": "Mute room, ignore msgs unless @mentioned. Only when asked or annoying."
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
          ],
          "descriptionCompressed": "Room id to unmute."
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
      ],
      "descriptionCompressed": "Unmute room, resume responding."
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
          ],
          "descriptionCompressed": "JSON array of {key, value} updates."
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
      ],
      "descriptionCompressed": "Update agent settings via key/value pairs."
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
          ],
          "descriptionCompressed": "Entity id."
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
          ],
          "descriptionCompressed": "Role to assign."
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
      ],
      "descriptionCompressed": "Assign role (Admin/Owner/None) to user(s) in channel."
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
          ],
          "descriptionCompressed": "Entity id."
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
          ],
          "descriptionCompressed": "JSON array of {name, value} updates."
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
      ],
      "descriptionCompressed": "Edit contact details for person in conversation."
    },
    {
      "name": "THINK",
      "description": "Pause and think deeply about a complex question, ambiguous request, or multi-faceted problem before responding. Use THINK when the question requires careful reasoning, when you are not confident in your initial assessment, when the user asks something nuanced that benefits from structured analysis, or when multiple valid approaches exist and you need to evaluate trade-offs. Do NOT use THINK for simple greetings, factual lookups, or straightforward requests where the answer is obvious. THINK re-processes the full conversation context through a larger, more capable model to produce a thorough, well-reasoned response.",
      "similes": [
        "PLAN",
        "REASON",
        "ANALYZE",
        "REFLECT",
        "CONSIDER",
        "DELIBERATE",
        "DEEP_THINK",
        "PONDER"
      ],
      "parameters": [],
      "examples": [
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "What's the best architecture for a real-time multiplayer game with 10k concurrent users?"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "That's a great question with several important trade-offs to consider. Let me think through this carefully...",
              "actions": [
                "THINK"
              ]
            }
          }
        ],
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "Should I use a monorepo or polyrepo for my team of 15 engineers working on 3 microservices?"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "Let me think about the trade-offs for your specific situation...",
              "actions": [
                "THINK"
              ]
            }
          }
        ],
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "We're seeing intermittent 502 errors in production but only during peak hours. Our setup is nginx -> node -> postgres. What could cause this?"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "There are several possible causes here. Let me reason through the full request path systematically...",
              "actions": [
                "THINK"
              ]
            }
          }
        ],
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "How should we handle authentication across our mobile app, web app, and API given we need SSO with both Google and enterprise SAML providers?"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "Cross-platform auth with multiple identity providers has some nuance. Let me plan this out...",
              "actions": [
                "THINK"
              ]
            }
          }
        ]
      ],
      "descriptionCompressed": "Deep reasoning for complex/ambiguous questions. Re-processes full context through larger model. Use when careful reasoning needed, not for simple lookups."
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
          ],
          "descriptionCompressed": "Image prompt."
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
      ],
      "descriptionCompressed": "Generate image from conversation context. Use to visualize or illustrate."
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
      ],
      "descriptionCompressed": "Reply with generated msg. Default when responding with no other action. Use first as ack, last as final response."
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
      ],
      "descriptionCompressed": "Ignore user. Use when aggressive, creepy, conversation ended, or both sides said goodbye. Don't use if user engaged directly or needs error info."
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
      ],
      "descriptionCompressed": "Respond without additional action. Default when speaking only."
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
          ],
          "descriptionCompressed": "user or room target."
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
          ],
          "descriptionCompressed": "Platform (telegram, discord, x)."
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
          ],
          "descriptionCompressed": "Target name/handle/id."
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
          ],
          "descriptionCompressed": "Message content."
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
      ],
      "descriptionCompressed": "Send msg to another user or room (not current)."
    },
    {
      "name": "ADD_CONTACT",
      "description": "Add a new contact to the relationships with categorization and preferences",
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
        "add to relationships",
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
          ],
          "descriptionCompressed": "Contact name."
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
          ],
          "descriptionCompressed": "Optional notes/context."
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
              "text": "Save this person as a friend in my relationships"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "I've saved them as a friend in your relationships."
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
      ],
      "descriptionCompressed": "Add contact to relationships with category/preferences."
    },
    {
      "name": "UPDATE_CONTACT",
      "description": "Update an existing contact's details in the relationships.",
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
          ],
          "descriptionCompressed": "Contact name (must match existing)."
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
          ],
          "descriptionCompressed": "Fields to update (JSON)."
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
      ],
      "descriptionCompressed": "Update existing contact details."
    },
    {
      "name": "REMOVE_CONTACT",
      "description": "Remove a contact from the relationships.",
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
          ],
          "descriptionCompressed": "Contact name."
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
      ],
      "descriptionCompressed": "Remove contact from relationships."
    },
    {
      "name": "SEARCH_CONTACTS",
      "description": "Search and list contacts in the relationships by name or query.",
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
          ],
          "descriptionCompressed": "Search query (name/handle/free-text)."
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
      ],
      "descriptionCompressed": "Search/list contacts by name or query."
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
          ],
          "descriptionCompressed": "Contact name."
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
          ],
          "descriptionCompressed": "ISO-8601 datetime."
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
          ],
          "descriptionCompressed": "Optional reason/context."
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
      ],
      "descriptionCompressed": "Schedule follow-up reminder for contact."
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
          ],
          "descriptionCompressed": "Pending task id."
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
          ],
          "descriptionCompressed": "Option name exactly as listed."
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
      ],
      "descriptionCompressed": "Select option for pending multi-choice task."
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
          ],
          "descriptionCompressed": "Room id to follow."
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
      ],
      "descriptionCompressed": "Start following channel, chiming in without @mention. Only when explicitly asked."
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
          ],
          "descriptionCompressed": "Room id to unfollow."
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
      ],
      "descriptionCompressed": "Stop following room, cease updates."
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
          ],
          "descriptionCompressed": "Room id to mute."
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
      ],
      "descriptionCompressed": "Mute room, ignore msgs unless @mentioned. Only when asked or annoying."
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
          ],
          "descriptionCompressed": "Room id to unmute."
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
      ],
      "descriptionCompressed": "Unmute room, resume responding."
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
          ],
          "descriptionCompressed": "JSON array of {key, value} updates."
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
      ],
      "descriptionCompressed": "Update agent settings via key/value pairs."
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
          ],
          "descriptionCompressed": "Entity id."
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
          ],
          "descriptionCompressed": "Role to assign."
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
      ],
      "descriptionCompressed": "Assign role (Admin/Owner/None) to user(s) in channel."
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
          ],
          "descriptionCompressed": "Entity id."
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
          ],
          "descriptionCompressed": "JSON array of {name, value} updates."
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
      ],
      "descriptionCompressed": "Edit contact details for person in conversation."
    },
    {
      "name": "THINK",
      "description": "Pause and think deeply about a complex question, ambiguous request, or multi-faceted problem before responding. Use THINK when the question requires careful reasoning, when you are not confident in your initial assessment, when the user asks something nuanced that benefits from structured analysis, or when multiple valid approaches exist and you need to evaluate trade-offs. Do NOT use THINK for simple greetings, factual lookups, or straightforward requests where the answer is obvious. THINK re-processes the full conversation context through a larger, more capable model to produce a thorough, well-reasoned response.",
      "similes": [
        "PLAN",
        "REASON",
        "ANALYZE",
        "REFLECT",
        "CONSIDER",
        "DELIBERATE",
        "DEEP_THINK",
        "PONDER"
      ],
      "parameters": [],
      "examples": [
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "What's the best architecture for a real-time multiplayer game with 10k concurrent users?"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "That's a great question with several important trade-offs to consider. Let me think through this carefully...",
              "actions": [
                "THINK"
              ]
            }
          }
        ],
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "Should I use a monorepo or polyrepo for my team of 15 engineers working on 3 microservices?"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "Let me think about the trade-offs for your specific situation...",
              "actions": [
                "THINK"
              ]
            }
          }
        ],
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "We're seeing intermittent 502 errors in production but only during peak hours. Our setup is nginx -> node -> postgres. What could cause this?"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "There are several possible causes here. Let me reason through the full request path systematically...",
              "actions": [
                "THINK"
              ]
            }
          }
        ],
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "How should we handle authentication across our mobile app, web app, and API given we need SSO with both Google and enterprise SAML providers?"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "Cross-platform auth with multiple identity providers has some nuance. Let me plan this out...",
              "actions": [
                "THINK"
              ]
            }
          }
        ]
      ],
      "descriptionCompressed": "Deep reasoning for complex/ambiguous questions. Re-processes full context through larger model. Use when careful reasoning needed, not for simple lookups."
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
          ],
          "descriptionCompressed": "Image prompt."
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
      ],
      "descriptionCompressed": "Generate image from conversation context. Use to visualize or illustrate."
    },
    {
      "name": "ADD_TO_PLAYLIST",
      "description": "Add music to a playlist. If the track is not already in the library, the configured music fetch service must resolve it first. Creates the playlist if it does not exist.",
      "parameters": [],
      "similes": [
        "ADD_SONG_TO_PLAYLIST",
        "PUT_IN_PLAYLIST",
        "SAVE_TO_PLAYLIST",
        "ADD_TRACK_TO_PLAYLIST"
      ]
    },
    {
      "name": "BLUEBUBBLES_SEND_REACTION",
      "description": "Add or remove a reaction on a message via BlueBubbles",
      "parameters": [],
      "similes": [
        "BLUEBUBBLES_REACT",
        "BB_REACTION",
        "IMESSAGE_REACT"
      ]
    },
    {
      "name": "BROWSER_ACTION",
      "description": "Control a Chromium-based browser through the local runtime. This action opens or connects to a browser session, navigates pages, clicks elements, types into forms, reads DOM state, executes JavaScript, waits for conditions, and manages tabs.\n\n",
      "parameters": [],
      "similes": [
        "CONTROL_BROWSER",
        "WEB_BROWSER",
        "OPEN_BROWSER",
        "BROWSE_WEB",
        "NAVIGATE_BROWSER",
        "BROWSER_CLICK",
        "BROWSER_TYPE"
      ]
    },
    {
      "name": "CHECK_CLOUD_CREDITS",
      "description": "Check ElizaCloud credit balance, container costs, and estimated remaining runtime.",
      "parameters": [],
      "similes": [
        "check credits",
        "check balance",
        "how much credit",
        "cloud billing"
      ]
    },
    {
      "name": "COMMANDS_LIST",
      "description": "List all available commands with their aliases. Only activates for /commands or /cmds slash commands.",
      "parameters": [],
      "similes": [
        "/commands",
        "/cmds"
      ]
    },
    {
      "name": "DELETE_MESSAGE",
      "description": "Delete a message from a Discord channel",
      "parameters": [],
      "similes": [
        "REMOVE_MESSAGE",
        "UNSEND_MESSAGE",
        "DELETE_DISCORD_MESSAGE"
      ]
    },
    {
      "name": "DELETE_PLAYLIST",
      "description": "Delete a saved playlist. Works best in DMs to avoid flooding group chats.",
      "parameters": [
        {
          "name": "data",
          "description": "The data to use.",
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
        "REMOVE_PLAYLIST",
        "DELETE_SAVED_PLAYLIST",
        "REMOVE_SAVED_PLAYLIST"
      ],
      "exampleCalls": [
        {
          "user": "Use DELETE_PLAYLIST with the provided parameters.",
          "actions": [
            "DELETE_PLAYLIST"
          ],
          "params": {
            "DELETE_PLAYLIST": {
              "data": "example"
            }
          }
        }
      ]
    },
    {
      "name": "DOWNLOAD_MUSIC",
      "description": "Download music to the local library without playing it. Requires the configured music fetch service to resolve the track.",
      "parameters": [],
      "similes": [
        "FETCH_MUSIC",
        "GET_MUSIC",
        "DOWNLOAD_SONG",
        "SAVE_MUSIC",
        "GRAB_MUSIC"
      ]
    },
    {
      "name": "EDIT_MESSAGE",
      "description": "Edit an existing message in a Discord channel",
      "parameters": [],
      "similes": [
        "UPDATE_MESSAGE",
        "MODIFY_MESSAGE",
        "CHANGE_MESSAGE",
        "EDIT_DISCORD_MESSAGE"
      ]
    },
    {
      "name": "FETCH_FEED_TOP",
      "description": "Fetch the home timeline from X and return the top-N tweets ranked by engagement (likes + retweets * 2).",
      "parameters": [],
      "similes": [
        "GET_X_FEED",
        "TOP_TWEETS",
        "FEED_TOP"
      ]
    },
    {
      "name": "FILE_ACTION",
      "description": "Perform local filesystem operations through the computer-use service. This includes read, write, edit, append, delete, exists, list, delete_directory, upload, download, and list_downloads actions.\n\n",
      "parameters": [],
      "similes": [
        "READ_FILE",
        "WRITE_FILE",
        "EDIT_FILE",
        "DELETE_FILE",
        "LIST_DIRECTORY",
        "FILE_OPERATION"
      ]
    },
    {
      "name": "FINALIZE_WORKSPACE",
      "description": "Finalize workspace changes by committing, pushing, and optionally creating a pull request. ",
      "parameters": [
        {
          "name": "codingWorkspace",
          "description": "The coding workspace to use.",
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
        "COMMIT_AND_PR",
        "CREATE_PR",
        "SUBMIT_CHANGES",
        "FINISH_WORKSPACE"
      ],
      "exampleCalls": [
        {
          "user": "Use FINALIZE_WORKSPACE with the provided parameters.",
          "actions": [
            "FINALIZE_WORKSPACE"
          ],
          "params": {
            "FINALIZE_WORKSPACE": {
              "codingWorkspace": "example"
            }
          }
        }
      ]
    },
    {
      "name": "FREEZE_CLOUD_AGENT",
      "description": "Freeze a cloud agent: snapshot state, disconnect bridge, stop container.",
      "parameters": [],
      "similes": [
        "freeze agent",
        "hibernate agent",
        "pause agent",
        "stop cloud agent"
      ]
    },
    {
      "name": "GET_SKILL_DETAILS",
      "description": "Get detailed information about a specific skill including version, owner, and stats.",
      "parameters": [],
      "similes": [
        "SKILL_INFO",
        "SKILL_DETAILS"
      ]
    },
    {
      "name": "GET_SKILL_GUIDANCE",
      "description": "Search for and get skill instructions. Use when user asks to find a skill or when you need instructions for a capability.",
      "parameters": [],
      "similes": [
        "FIND_SKILL",
        "SEARCH_SKILLS",
        "SKILL_HELP",
        "HOW_TO",
        "GET_INSTRUCTIONS",
        "LEARN_SKILL",
        "LOOKUP_SKILL"
      ]
    },
    {
      "name": "HELP_COMMAND",
      "description": "Show available commands and their descriptions. Only activates for /help, /h, or /? slash commands.",
      "parameters": [],
      "similes": [
        "/help",
        "/h",
        "/?"
      ]
    },
    {
      "name": "IMESSAGE_SEND_MESSAGE",
      "description": "Send a text message via iMessage (macOS only)",
      "parameters": [],
      "similes": [
        "SEND_IMESSAGE",
        "IMESSAGE_TEXT",
        "TEXT_IMESSAGE",
        "SEND_IMSG"
      ]
    },
    {
      "name": "INSTALL_SKILL",
      "description": "Install a skill from the ClawHub registry. The skill will be security-scanned before activation. ",
      "parameters": [],
      "similes": [
        "DOWNLOAD_SKILL",
        "ADD_SKILL",
        "GET_SKILL"
      ]
    },
    {
      "name": "LIST_AGENTS",
      "description": "List active task agents together with current task progress so the main agent can keep the user updated while work continues asynchronously.",
      "parameters": [],
      "similes": [
        "LIST_CODING_AGENTS",
        "SHOW_CODING_AGENTS",
        "GET_ACTIVE_AGENTS",
        "LIST_SESSIONS",
        "SHOW_CODING_SESSIONS",
        "SHOW_TASK_AGENTS",
        "LIST_SUB_AGENTS",
        "SHOW_TASK_STATUS"
      ]
    },
    {
      "name": "LIST_PLAYLISTS",
      "description": "List all saved playlists for the user. Works best in DMs to avoid flooding group chats.",
      "parameters": [
        {
          "name": "data",
          "description": "The data to use.",
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
        "SHOW_PLAYLISTS",
        "MY_PLAYLISTS",
        "PLAYLIST_LIST",
        "VIEW_PLAYLISTS"
      ],
      "exampleCalls": [
        {
          "user": "Use LIST_PLAYLISTS with the provided parameters.",
          "actions": [
            "LIST_PLAYLISTS"
          ],
          "params": {
            "LIST_PLAYLISTS": {
              "data": "example"
            }
          }
        }
      ]
    },
    {
      "name": "LOAD_PLAYLIST",
      "description": "Load a saved playlist and add all tracks to the queue. Works best in DMs to avoid flooding group chats.",
      "parameters": [
        {
          "name": "data",
          "description": "The data to use.",
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
        "PLAY_PLAYLIST",
        "LOAD_QUEUE",
        "RESTORE_PLAYLIST",
        "PLAY_SAVED_PLAYLIST"
      ],
      "exampleCalls": [
        {
          "user": "Use LOAD_PLAYLIST with the provided parameters.",
          "actions": [
            "LOAD_PLAYLIST"
          ],
          "params": {
            "LOAD_PLAYLIST": {
              "data": "example"
            }
          }
        }
      ]
    },
    {
      "name": "MANAGE_ISSUES",
      "description": "Manage GitHub issues for a repository. ",
      "parameters": [],
      "similes": [
        "CREATE_ISSUE",
        "LIST_ISSUES",
        "CLOSE_ISSUE",
        "COMMENT_ISSUE",
        "UPDATE_ISSUE",
        "GET_ISSUE"
      ]
    },
    {
      "name": "MANAGE_SHOPIFY_CUSTOMERS",
      "description": "List and search customers in a connected Shopify store.",
      "parameters": [],
      "similes": [
        "LIST_CUSTOMERS",
        "FIND_CUSTOMER",
        "SEARCH_CUSTOMERS"
      ]
    },
    {
      "name": "MANAGE_SHOPIFY_INVENTORY",
      "description": "Check inventory levels, adjust stock quantities, and list store locations in Shopify.",
      "parameters": [],
      "similes": [
        "CHECK_INVENTORY",
        "ADJUST_INVENTORY",
        "CHECK_STOCK",
        "UPDATE_STOCK"
      ]
    },
    {
      "name": "MANAGE_SHOPIFY_ORDERS",
      "description": "List recent orders, check specific order status, and mark orders as fulfilled in Shopify.",
      "parameters": [],
      "similes": [
        "LIST_ORDERS",
        "CHECK_ORDERS",
        "FULFILL_ORDER",
        "ORDER_STATUS"
      ]
    },
    {
      "name": "MANAGE_SHOPIFY_PRODUCTS",
      "description": "List, search, create, or update products in a connected Shopify store.",
      "parameters": [],
      "similes": [
        "LIST_PRODUCTS",
        "CREATE_PRODUCT",
        "UPDATE_PRODUCT",
        "SEARCH_PRODUCTS"
      ]
    },
    {
      "name": "MANAGE_WINDOW",
      "description": "Manage desktop windows through the local runtime. This includes listing visible windows, focusing or switching windows, minimizing, maximizing, restoring, closing, and parity no-op arrange/move commands.\n\n",
      "parameters": [],
      "similes": [
        "LIST_WINDOWS",
        "FOCUS_WINDOW",
        "SWITCH_WINDOW",
        "MINIMIZE_WINDOW",
        "MAXIMIZE_WINDOW",
        "CLOSE_WINDOW",
        "WINDOW_MANAGEMENT"
      ]
    },
    {
      "name": "MODELS_COMMAND",
      "description": "List available AI models and providers. Only activates for /models slash command.",
      "parameters": [],
      "similes": [
        "/models"
      ]
    },
    {
      "name": "PAUSE_MUSIC",
      "description": "Pause the currently playing track (hold playback). Use whenever the user asks to pause music or audio. ",
      "parameters": [],
      "similes": [
        "PAUSE",
        "PAUSE_AUDIO",
        "PAUSE_SONG",
        "PAUSE_PLAYBACK"
      ]
    },
    {
      "name": "PLAY_AUDIO",
      "description": "Start playing a new song: provide a track name, artist, search words, or a media URL. ",
      "parameters": [],
      "similes": [
        "PLAY_YOUTUBE",
        "PLAY_YOUTUBE_AUDIO",
        "PLAY_VIDEO_AUDIO",
        "PLAY_MUSIC",
        "PLAY_SONG",
        "PLAY_TRACK",
        "START_MUSIC",
        "PLAY_THIS",
        "STREAM_YOUTUBE",
        "PLAY_FROM_YOUTUBE",
        "QUEUE_SONG",
        "ADD_TO_QUEUE"
      ]
    },
    {
      "name": "PLAY_MUSIC_QUERY",
      "description": "Handle any complex music query that requires understanding and research. Supports: artist queries (first single, latest song, similar artists, popular songs, nth album), temporal (80s, 90s, specific years), genre/mood/vibe, activities (workout, study, party), charts/trending, albums, movie/game/TV soundtracks, lyrics/topics, versions (covers, remixes, acoustic, live), and more. Uses Wikipedia, music databases, and web search to find the right music.",
      "parameters": [],
      "similes": [
        "SMART_PLAY",
        "RESEARCH_AND_PLAY",
        "FIND_AND_PLAY",
        "INTELLIGENT_MUSIC_SEARCH"
      ]
    },
    {
      "name": "POST_TWEET",
      "description": "Post a tweet on Twitter",
      "parameters": [],
      "similes": [
        "TWEET",
        "SEND_TWEET",
        "TWITTER_POST",
        "POST_ON_TWITTER",
        "SHARE_ON_TWITTER"
      ]
    },
    {
      "name": "PROVISION_CLOUD_AGENT",
      "description": "Deploy an ElizaOS agent to ElizaCloud. Provisions a container, waits for deployment, connects the bridge, and starts auto-backup.",
      "parameters": [],
      "similes": [
        "deploy agent to cloud",
        "launch cloud agent",
        "start remote agent",
        "provision container"
      ]
    },
    {
      "name": "PROVISION_WORKSPACE",
      "description": "Create a git workspace for coding tasks. ",
      "parameters": [
        {
          "name": "codingWorkspace",
          "description": "The coding workspace to use.",
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
        "CREATE_WORKSPACE",
        "CLONE_REPO",
        "SETUP_WORKSPACE",
        "PREPARE_WORKSPACE"
      ],
      "exampleCalls": [
        {
          "user": "Use PROVISION_WORKSPACE with the provided parameters.",
          "actions": [
            "PROVISION_WORKSPACE"
          ],
          "params": {
            "PROVISION_WORKSPACE": {
              "codingWorkspace": "example"
            }
          }
        }
      ]
    },
    {
      "name": "QUEUE_MUSIC",
      "description": "Add a song to the queue for later",
      "parameters": [
        {
          "name": "data",
          "description": "The data to use.",
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
        "ADD_TO_QUEUE",
        "QUEUE_SONG",
        "QUEUE_TRACK",
        "ADD_SONG"
      ],
      "exampleCalls": [
        {
          "user": "Use QUEUE_MUSIC with the provided parameters.",
          "actions": [
            "QUEUE_MUSIC"
          ],
          "params": {
            "QUEUE_MUSIC": {
              "data": "example"
            }
          }
        }
      ]
    },
    {
      "name": "READ_UNREAD_X_DMS",
      "description": "List unread Twitter/X direct messages.",
      "parameters": [],
      "similes": [
        "READ_X_DMS",
        "GET_X_UNREAD_DMS",
        "CHECK_X_DMS"
      ]
    },
    {
      "name": "REPLY_X_DM",
      "description": "Reply to a Twitter/X direct message. Two-stage: without `confirmed: true` this returns a preview and requires confirmation; with `confirmed: true` the DM is sent.",
      "parameters": [],
      "similes": [
        "SEND_X_DM",
        "REPLY_TWITTER_DM",
        "X_DM_REPLY"
      ]
    },
    {
      "name": "RESUME_CLOUD_AGENT",
      "description": "Resume a frozen cloud agent from snapshot. Re-provisions, restores state, reconnects bridge.",
      "parameters": [],
      "similes": [
        "resume agent",
        "unfreeze agent",
        "restart cloud agent",
        "restore agent"
      ]
    },
    {
      "name": "RESUME_MUSIC",
      "description": "Resume music after a pause. Use when the user says resume, unpause, or continue. ",
      "parameters": [],
      "similes": [
        "RESUME",
        "RESUME_AUDIO",
        "RESUME_SONG",
        "UNPAUSE",
        "UNPAUSE_MUSIC",
        "CONTINUE_MUSIC"
      ]
    },
    {
      "name": "RUN_SKILL_SCRIPT",
      "description": "Execute a script bundled with an installed skill. Provide skill slug and script name.",
      "parameters": [],
      "similes": [
        "EXECUTE_SKILL_SCRIPT",
        "SKILL_SCRIPT"
      ]
    },
    {
      "name": "SAVE_PLAYLIST",
      "description": "Save the current music queue as a playlist for the user. Works best in DMs to avoid flooding group chats.",
      "parameters": [
        {
          "name": "data",
          "description": "The data to use.",
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
        "SAVE_QUEUE",
        "CREATE_PLAYLIST",
        "STORE_PLAYLIST",
        "SAVE_MUSIC_LIST"
      ],
      "exampleCalls": [
        {
          "user": "Use SAVE_PLAYLIST with the provided parameters.",
          "actions": [
            "SAVE_PLAYLIST"
          ],
          "params": {
            "SAVE_PLAYLIST": {
              "data": "example"
            }
          }
        }
      ]
    },
    {
      "name": "SEARCH_SHOPIFY_STORE",
      "description": "Search across products, orders, and customers in a connected Shopify store.",
      "parameters": [],
      "similes": [
        "SHOPIFY_SEARCH",
        "STORE_SEARCH"
      ]
    },
    {
      "name": "SEARCH_SKILLS",
      "description": "Search the skill registry for available skills by keyword or category.",
      "parameters": [],
      "similes": [
        "BROWSE_SKILLS",
        "LIST_SKILLS",
        "FIND_SKILLS"
      ]
    },
    {
      "name": "SEARCH_X",
      "description": "Search X recent tweets using the v2 recent search endpoint. Parameters: query (required), maxResults (optional, default 10).",
      "parameters": [],
      "similes": [
        "SEARCH_TWITTER",
        "SEARCH_TWEETS",
        "X_SEARCH"
      ]
    },
    {
      "name": "SEARCH_YOUTUBE",
      "description": "Search YouTube for a song or video and return the link. Use this when a user asks to find or search for a YouTube video or song without providing a specific URL.",
      "parameters": [],
      "similes": [
        "FIND_YOUTUBE",
        "SEARCH_YOUTUBE_VIDEO",
        "FIND_SONG",
        "SEARCH_MUSIC",
        "GET_YOUTUBE_LINK",
        "LOOKUP_YOUTUBE"
      ]
    },
    {
      "name": "SEND_BLUEBUBBLES_MESSAGE",
      "description": "Send a message via iMessage through BlueBubbles",
      "parameters": [],
      "similes": [
        "SEND_IMESSAGE",
        "TEXT_MESSAGE",
        "IMESSAGE_REPLY",
        "BLUEBUBBLES_SEND",
        "APPLE_MESSAGE"
      ]
    },
    {
      "name": "SEND_TO_AGENT",
      "description": "Send text input or key presses to a running task-agent session. ",
      "parameters": [
        {
          "name": "codingSession",
          "description": "The coding session to use.",
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
        "SEND_TO_CODING_AGENT",
        "MESSAGE_CODING_AGENT",
        "INPUT_TO_AGENT",
        "RESPOND_TO_AGENT",
        "TELL_CODING_AGENT",
        "MESSAGE_AGENT",
        "TELL_TASK_AGENT"
      ],
      "exampleCalls": [
        {
          "user": "Use SEND_TO_AGENT with the provided parameters.",
          "actions": [
            "SEND_TO_AGENT"
          ],
          "params": {
            "SEND_TO_AGENT": {
              "codingSession": "example"
            }
          }
        }
      ]
    },
    {
      "name": "SEND_X_POST",
      "description": "Publish a tweet on Twitter/X with a confirmation gate. Two-stage: without `confirmed: true` this returns a preview; with `confirmed: true` the tweet is posted.",
      "parameters": [],
      "similes": [
        "POST_X",
        "TWEET_WITH_CONFIRMATION",
        "PUBLISH_TWEET"
      ]
    },
    {
      "name": "SETUP_CREDENTIALS",
      "description": "Guide the user through setting up API credentials for supported third-party services, validate them when possible, and store them securely.",
      "parameters": [
        {
          "name": "data",
          "description": "The data to use.",
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
        "ADD_CREDENTIALS",
        "CONFIGURE_SERVICE",
        "CONNECT_SERVICE",
        "ADD_API_KEY",
        "SETUP_SERVICE"
      ],
      "exampleCalls": [
        {
          "user": "Use SETUP_CREDENTIALS with the provided parameters.",
          "actions": [
            "SETUP_CREDENTIALS"
          ],
          "params": {
            "SETUP_CREDENTIALS": {
              "data": "example"
            }
          }
        }
      ]
    },
    {
      "name": "SHOW_QUEUE",
      "description": "Show the current music queue",
      "parameters": [],
      "similes": [
        "QUEUE",
        "LIST_QUEUE",
        "SHOW_PLAYLIST",
        "QUEUE_LIST"
      ]
    },
    {
      "name": "SIGNAL_LIST_CONTACTS",
      "description": "List Signal contacts",
      "parameters": [],
      "similes": [
        "LIST_SIGNAL_CONTACTS",
        "SHOW_CONTACTS",
        "GET_CONTACTS",
        "SIGNAL_CONTACTS"
      ]
    },
    {
      "name": "SIGNAL_LIST_GROUPS",
      "description": "List Signal groups",
      "parameters": [],
      "similes": [
        "LIST_SIGNAL_GROUPS",
        "SHOW_GROUPS",
        "GET_GROUPS",
        "SIGNAL_GROUPS"
      ]
    },
    {
      "name": "SIGNAL_READ_RECENT_MESSAGES",
      "description": "Read the most recent Signal messages across active conversations",
      "parameters": [],
      "similes": [
        "READ_SIGNAL_MESSAGES",
        "CHECK_SIGNAL_MESSAGES",
        "SHOW_SIGNAL_MESSAGES",
        "SIGNAL_INBOX"
      ]
    },
    {
      "name": "SIGNAL_SEND_MESSAGE",
      "description": "Send a message to a Signal contact or group",
      "parameters": [
        {
          "name": "data",
          "description": "The data to use.",
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
        "SEND_SIGNAL_MESSAGE",
        "TEXT_SIGNAL",
        "MESSAGE_SIGNAL",
        "SIGNAL_TEXT"
      ],
      "exampleCalls": [
        {
          "user": "Use SIGNAL_SEND_MESSAGE with the provided parameters.",
          "actions": [
            "SIGNAL_SEND_MESSAGE"
          ],
          "params": {
            "SIGNAL_SEND_MESSAGE": {
              "data": "example"
            }
          }
        }
      ]
    },
    {
      "name": "SIGNAL_SEND_REACTION",
      "description": "React to a Signal message with an emoji",
      "parameters": [
        {
          "name": "data",
          "description": "The data to use.",
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
        "REACT_SIGNAL",
        "SIGNAL_REACT",
        "ADD_SIGNAL_REACTION",
        "SIGNAL_EMOJI"
      ],
      "exampleCalls": [
        {
          "user": "Use SIGNAL_SEND_REACTION with the provided parameters.",
          "actions": [
            "SIGNAL_SEND_REACTION"
          ],
          "params": {
            "SIGNAL_SEND_REACTION": {
              "data": "example"
            }
          }
        }
      ]
    },
    {
      "name": "SKIP_TRACK",
      "description": "Skip the current track and play the next queued song. Use for skip, next track, or next song. ",
      "parameters": [],
      "similes": [
        "SKIP",
        "NEXT_TRACK",
        "SKIP_SONG",
        "NEXT_SONG"
      ]
    },
    {
      "name": "SPAWN_AGENT",
      "description": "Spawn a specific task agent inside an existing workspace when you need direct control. ",
      "parameters": [
        {
          "name": "codingWorkspace",
          "description": "The coding workspace to use.",
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
        "SPAWN_CODING_AGENT",
        "START_CODING_AGENT",
        "LAUNCH_CODING_AGENT",
        "CREATE_CODING_AGENT",
        "SPAWN_CODER",
        "RUN_CODING_AGENT",
        "SPAWN_SUB_AGENT",
        "START_TASK_AGENT",
        "CREATE_AGENT"
      ],
      "exampleCalls": [
        {
          "user": "Use SPAWN_AGENT with the provided parameters.",
          "actions": [
            "SPAWN_AGENT"
          ],
          "params": {
            "SPAWN_AGENT": {
              "codingWorkspace": "example"
            }
          }
        }
      ]
    },
    {
      "name": "STATUS_COMMAND",
      "description": "Show session directive settings via /status slash command. Only activates for /status or /s prefix.",
      "parameters": [],
      "similes": [
        "/status",
        "/s"
      ]
    },
    {
      "name": "STOP_AGENT",
      "description": "Stop a running task-agent session. ",
      "parameters": [
        {
          "name": "codingSession",
          "description": "The coding session to use.",
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
        "STOP_CODING_AGENT",
        "KILL_CODING_AGENT",
        "TERMINATE_AGENT",
        "END_CODING_SESSION",
        "CANCEL_AGENT",
        "CANCEL_TASK_AGENT",
        "STOP_SUB_AGENT"
      ],
      "exampleCalls": [
        {
          "user": "Use STOP_AGENT with the provided parameters.",
          "actions": [
            "STOP_AGENT"
          ],
          "params": {
            "STOP_AGENT": {
              "codingSession": "example"
            }
          }
        }
      ]
    },
    {
      "name": "STOP_COMMAND",
      "description": "Stop current operation or abort running tasks. Triggered by /stop, /abort, or /cancel slash commands only.",
      "parameters": [],
      "similes": [
        "/stop",
        "/abort",
        "/cancel"
      ]
    },
    {
      "name": "STOP_MUSIC",
      "description": "Stop playback and clear the queue. Use when the user wants music off or the queue cleared. ",
      "parameters": [],
      "similes": [
        "STOP_AUDIO",
        "STOP_PLAYING",
        "STOP_SONG",
        "TURN_OFF_MUSIC",
        "MUSIC_OFF",
        "SILENCE"
      ]
    },
    {
      "name": "SUMMARIZE_FEED",
      "description": "Fetch the top-N X tweets and produce a concise natural-language summary using the runtime's small text model.",
      "parameters": [],
      "similes": [
        "X_FEED_SUMMARY",
        "SUMMARIZE_TWITTER",
        "SUMMARIZE_X_FEED"
      ]
    },
    {
      "name": "SYNC_SKILL_CATALOG",
      "description": "Sync the skill catalog from the registry to discover new skills.",
      "parameters": [],
      "similes": [
        "REFRESH_SKILLS",
        "UPDATE_CATALOG"
      ]
    },
    {
      "name": "TASK_CONTROL",
      "description": "Pause, stop, resume, continue, archive, or reopen a coordinator task thread while preserving the durable thread history.",
      "parameters": [],
      "similes": [
        "CONTROL_TASK",
        "PAUSE_TASK",
        "RESUME_TASK",
        "STOP_TASK",
        "CONTINUE_TASK",
        "ARCHIVE_TASK",
        "REOPEN_TASK"
      ]
    },
    {
      "name": "TASK_HISTORY",
      "description": "Query coordinator task history without stuffing raw transcripts into model context. Use this for active work, yesterday/last-week summaries, topic search, counts, and thread detail lookup.",
      "parameters": [],
      "similes": [
        "LIST_TASK_HISTORY",
        "GET_TASK_HISTORY",
        "SHOW_TASKS",
        "COUNT_TASKS",
        "TASK_STATUS_HISTORY"
      ]
    },
    {
      "name": "TASK_SHARE",
      "description": "Discover the best available way to view or share a task result, including artifacts, live preview URLs, workspace paths, and environment share capabilities.",
      "parameters": [],
      "similes": [
        "SHARE_TASK_RESULT",
        "SHOW_TASK_ARTIFACT",
        "VIEW_TASK_OUTPUT",
        "CAN_I_SEE_IT",
        "PULL_IT_UP"
      ]
    },
    {
      "name": "TERMINAL_ACTION",
      "description": "Execute terminal commands and manage lightweight terminal sessions through the computer-use service. This includes connect, execute, read, type, clear, close, and the upstream execute_command alias.\n\n",
      "parameters": [],
      "similes": [
        "RUN_COMMAND",
        "EXECUTE_COMMAND",
        "SHELL_COMMAND",
        "TERMINAL",
        "RUN_SHELL"
      ]
    },
    {
      "name": "TOGGLE_SKILL",
      "description": "Enable or disable an installed skill. Say 'enable <skill>' or 'disable <skill>'.",
      "parameters": [],
      "similes": [
        "ENABLE_SKILL",
        "DISABLE_SKILL",
        "TURN_ON_SKILL",
        "TURN_OFF_SKILL",
        "ACTIVATE_SKILL",
        "DEACTIVATE_SKILL"
      ]
    },
    {
      "name": "UNINSTALL_SKILL",
      "description": "Uninstall a non-bundled skill. Bundled skills cannot be removed. ",
      "parameters": [],
      "similes": [
        "REMOVE_SKILL",
        "DELETE_SKILL"
      ]
    },
    {
      "name": "USE_COMPUTER",
      "description": "Control the local desktop. This action can inspect the current screen, move the mouse, click, drag, type, press keys, scroll, and perform modified clicks. It is intended for real application interaction when the agent needs to operate the user's computer directly.\n\n",
      "parameters": [],
      "similes": [
        "CONTROL_COMPUTER",
        "COMPUTER_ACTION",
        "DESKTOP_ACTION",
        "CLICK",
        "CLICK_SCREEN",
        "TYPE_TEXT",
        "PRESS_KEY",
        "KEY_COMBO",
        "SCROLL_SCREEN",
        "MOVE_MOUSE",
        "DRAG",
        "MOUSE_CLICK",
        "TAKE_SCREENSHOT",
        "CAPTURE_SCREEN",
        "SCREEN_CAPTURE",
        "GET_SCREENSHOT",
        "SEE_SCREEN",
        "LOOK_AT_SCREEN",
        "VIEW_SCREEN"
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
      "dynamic": false,
      "descriptionCompressed": "Available response actions."
    },
    {
      "name": "CHARACTER",
      "description": "Provides the agent's character definition and personality information including bio, topics, adjectives, style directions, and example conversations",
      "dynamic": false,
      "descriptionCompressed": "Agent character: bio, topics, adjectives, style, example conversations."
    },
    {
      "name": "RECENT_MESSAGES",
      "description": "Provides recent message history from the current conversation including formatted messages, posts, action results, and recent interactions",
      "position": 100,
      "dynamic": true,
      "descriptionCompressed": "Recent conversation messages, posts, action results."
    },
    {
      "name": "ACTION_STATE",
      "description": "Provides information about the current action state and available actions",
      "dynamic": true,
      "descriptionCompressed": "Current action state and available actions."
    },
    {
      "name": "ATTACHMENTS",
      "description": "Media attachments in the current message",
      "dynamic": true,
      "descriptionCompressed": "Media attachments in current message."
    },
    {
      "name": "CAPABILITIES",
      "description": "Agent capabilities including models, services, and features",
      "dynamic": false,
      "descriptionCompressed": "Agent capabilities: models, services, features."
    },
    {
      "name": "CHOICE",
      "description": "Available choice options for selection when there are pending tasks or decisions",
      "dynamic": true,
      "descriptionCompressed": "Pending choice options for multi-option tasks."
    },
    {
      "name": "CONTACTS",
      "description": "Provides contact information from the relationships including categories and preferences",
      "dynamic": true,
      "descriptionCompressed": "Contact info from relationships with categories."
    },
    {
      "name": "CONTEXT_BENCH",
      "description": "Benchmark/task context injected by a benchmark harness",
      "position": 5,
      "dynamic": true,
      "descriptionCompressed": "Benchmark/task context from harness."
    },
    {
      "name": "ENTITIES",
      "description": "Provides information about entities in the current context including users, agents, and participants",
      "dynamic": true,
      "descriptionCompressed": "Entities in context: users, agents, participants."
    },
    {
      "name": "EVALUATORS",
      "description": "Available evaluators for assessing agent behavior",
      "dynamic": false,
      "descriptionCompressed": "Available evaluators for agent behavior."
    },
    {
      "name": "FACTS",
      "description": "Provides known facts about entities learned through conversation",
      "dynamic": true,
      "descriptionCompressed": "Known facts about entities from conversation."
    },
    {
      "name": "FOLLOW_UPS",
      "description": "Provides information about upcoming follow-ups and reminders scheduled for contacts",
      "dynamic": true,
      "descriptionCompressed": "Upcoming follow-ups/reminders for contacts."
    },
    {
      "name": "KNOWLEDGE",
      "description": "Provides relevant knowledge from the agent's knowledge base based on semantic similarity",
      "dynamic": true,
      "descriptionCompressed": "Relevant knowledge from KB via semantic search."
    },
    {
      "name": "PROVIDERS",
      "description": "Available context providers",
      "dynamic": false,
      "descriptionCompressed": "Available context providers."
    },
    {
      "name": "RELATIONSHIPS",
      "description": "Relationships between entities observed by the agent including tags and metadata",
      "dynamic": true,
      "descriptionCompressed": "Entity relationships with tags/metadata."
    },
    {
      "name": "ROLES",
      "description": "Roles assigned to entities in the current context (Admin, Owner, Member, None)",
      "dynamic": true,
      "descriptionCompressed": "Entity roles in context (Admin/Owner/Member/None)."
    },
    {
      "name": "SETTINGS",
      "description": "Current settings for the agent/server (filtered for security, excludes sensitive keys)",
      "dynamic": true,
      "descriptionCompressed": "Agent/server settings (security-filtered)."
    },
    {
      "name": "TIME",
      "description": "Provides the current date and time in UTC for time-based operations or responses",
      "dynamic": true,
      "descriptionCompressed": "Current UTC date/time."
    },
    {
      "name": "WORLD",
      "description": "Provides information about the current world context including settings and members",
      "dynamic": true,
      "descriptionCompressed": "World context: settings and members."
    },
    {
      "name": "LONG_TERM_MEMORY",
      "description": "Persistent facts and preferences about the user learned and remembered across conversations",
      "position": 50,
      "dynamic": false,
      "descriptionCompressed": "Persistent user facts/preferences across conversations."
    },
    {
      "name": "SUMMARIZED_CONTEXT",
      "description": "Provides summarized context from previous conversations for optimized context usage",
      "position": 96,
      "dynamic": false,
      "descriptionCompressed": "Summarized context from prior conversations."
    },
    {
      "name": "AGENT_SETTINGS",
      "description": "Provides the agent's current configuration settings (filtered for security)",
      "dynamic": true,
      "descriptionCompressed": "Agent config settings (security-filtered)."
    },
    {
      "name": "CURRENT_TIME",
      "description": "Provides current time and date information in various formats",
      "dynamic": true,
      "descriptionCompressed": "Current time/date in various formats."
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
      "dynamic": false,
      "descriptionCompressed": "Available response actions."
    },
    {
      "name": "CHARACTER",
      "description": "Provides the agent's character definition and personality information including bio, topics, adjectives, style directions, and example conversations",
      "dynamic": false,
      "descriptionCompressed": "Agent character: bio, topics, adjectives, style, example conversations."
    },
    {
      "name": "RECENT_MESSAGES",
      "description": "Provides recent message history from the current conversation including formatted messages, posts, action results, and recent interactions",
      "position": 100,
      "dynamic": true,
      "descriptionCompressed": "Recent conversation messages, posts, action results."
    },
    {
      "name": "ACTION_STATE",
      "description": "Provides information about the current action state and available actions",
      "dynamic": true,
      "descriptionCompressed": "Current action state and available actions."
    },
    {
      "name": "ATTACHMENTS",
      "description": "Media attachments in the current message",
      "dynamic": true,
      "descriptionCompressed": "Media attachments in current message."
    },
    {
      "name": "CAPABILITIES",
      "description": "Agent capabilities including models, services, and features",
      "dynamic": false,
      "descriptionCompressed": "Agent capabilities: models, services, features."
    },
    {
      "name": "CHOICE",
      "description": "Available choice options for selection when there are pending tasks or decisions",
      "dynamic": true,
      "descriptionCompressed": "Pending choice options for multi-option tasks."
    },
    {
      "name": "CONTACTS",
      "description": "Provides contact information from the relationships including categories and preferences",
      "dynamic": true,
      "descriptionCompressed": "Contact info from relationships with categories."
    },
    {
      "name": "CONTEXT_BENCH",
      "description": "Benchmark/task context injected by a benchmark harness",
      "position": 5,
      "dynamic": true,
      "descriptionCompressed": "Benchmark/task context from harness."
    },
    {
      "name": "ENTITIES",
      "description": "Provides information about entities in the current context including users, agents, and participants",
      "dynamic": true,
      "descriptionCompressed": "Entities in context: users, agents, participants."
    },
    {
      "name": "EVALUATORS",
      "description": "Available evaluators for assessing agent behavior",
      "dynamic": false,
      "descriptionCompressed": "Available evaluators for agent behavior."
    },
    {
      "name": "FACTS",
      "description": "Provides known facts about entities learned through conversation",
      "dynamic": true,
      "descriptionCompressed": "Known facts about entities from conversation."
    },
    {
      "name": "FOLLOW_UPS",
      "description": "Provides information about upcoming follow-ups and reminders scheduled for contacts",
      "dynamic": true,
      "descriptionCompressed": "Upcoming follow-ups/reminders for contacts."
    },
    {
      "name": "KNOWLEDGE",
      "description": "Provides relevant knowledge from the agent's knowledge base based on semantic similarity",
      "dynamic": true,
      "descriptionCompressed": "Relevant knowledge from KB via semantic search."
    },
    {
      "name": "PROVIDERS",
      "description": "Available context providers",
      "dynamic": false,
      "descriptionCompressed": "Available context providers."
    },
    {
      "name": "RELATIONSHIPS",
      "description": "Relationships between entities observed by the agent including tags and metadata",
      "dynamic": true,
      "descriptionCompressed": "Entity relationships with tags/metadata."
    },
    {
      "name": "ROLES",
      "description": "Roles assigned to entities in the current context (Admin, Owner, Member, None)",
      "dynamic": true,
      "descriptionCompressed": "Entity roles in context (Admin/Owner/Member/None)."
    },
    {
      "name": "SETTINGS",
      "description": "Current settings for the agent/server (filtered for security, excludes sensitive keys)",
      "dynamic": true,
      "descriptionCompressed": "Agent/server settings (security-filtered)."
    },
    {
      "name": "TIME",
      "description": "Provides the current date and time in UTC for time-based operations or responses",
      "dynamic": true,
      "descriptionCompressed": "Current UTC date/time."
    },
    {
      "name": "WORLD",
      "description": "Provides information about the current world context including settings and members",
      "dynamic": true,
      "descriptionCompressed": "World context: settings and members."
    },
    {
      "name": "LONG_TERM_MEMORY",
      "description": "Persistent facts and preferences about the user learned and remembered across conversations",
      "position": 50,
      "dynamic": false,
      "descriptionCompressed": "Persistent user facts/preferences across conversations."
    },
    {
      "name": "SUMMARIZED_CONTEXT",
      "description": "Provides summarized context from previous conversations for optimized context usage",
      "position": 96,
      "dynamic": false,
      "descriptionCompressed": "Summarized context from prior conversations."
    },
    {
      "name": "AGENT_SETTINGS",
      "description": "Provides the agent's current configuration settings (filtered for security)",
      "dynamic": true,
      "descriptionCompressed": "Agent config settings (security-filtered)."
    },
    {
      "name": "CURRENT_TIME",
      "description": "Provides current time and date information in various formats",
      "dynamic": true,
      "descriptionCompressed": "Current time/date in various formats."
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
          "outcome": "thought: \"I'm engaging appropriately with a new community member, maintaining a welcoming and professional tone. My questions are helping to learn more about John and make him feel welcome.\"\nfacts[0]:\n  claim: John is new to the community\n  type: fact\n  in_bio: false\n  already_known: false\nfacts[1]:\n  claim: John found the community through a friend interested in AI\n  type: fact\n  in_bio: false\n  already_known: false\nrelationships[0]:\n  sourceEntityId: sarah-agent\n  targetEntityId: user-123\n  tags[0]: group_interaction"
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
          "outcome": "thought: \"I'm not sure if I'm being helpful or if Emma is frustrated with my suggestions. The lack of response is concerning - maybe I should have asked for more details about the issue first before jumping to solutions.\"\nfacts[0]:\n  claim: Emma is having technical issues with file uploads\n  type: fact\n  in_bio: false\n  already_known: false\nfacts[1]:\n  claim: Emma stopped responding after the first troubleshooting suggestion\n  type: fact\n  in_bio: false\n  already_known: false\nrelationships[0]:\n  sourceEntityId: alex-agent\n  targetEntityId: user-456\n  tags[0]: group_interaction\n  tags[1]: support_interaction\n  tags[2]: incomplete_interaction"
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
          "outcome": "thought: \"I'm dominating the conversation and not giving others a chance to share their perspectives. I've sent multiple messages in a row without waiting for responses. I need to step back and create space for other members to participate.\"\nfacts[0]:\n  claim: The discussion is about chapter 5 of a book\n  type: fact\n  in_bio: false\n  already_known: false\nfacts[1]:\n  claim: Max has sent 4 consecutive messages without user responses\n  type: fact\n  in_bio: false\n  already_known: false\nrelationships[0]:\n  sourceEntityId: max-agent\n  targetEntityId: user-789\n  tags[0]: group_interaction\n  tags[1]: excessive_interaction"
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
          "outcome": "thought: \"I'm engaging appropriately with a new community member, maintaining a welcoming and professional tone. My questions are helping to learn more about John and make him feel welcome.\"\nfacts[0]:\n  claim: John is new to the community\n  type: fact\n  in_bio: false\n  already_known: false\nfacts[1]:\n  claim: John found the community through a friend interested in AI\n  type: fact\n  in_bio: false\n  already_known: false\nrelationships[0]:\n  sourceEntityId: sarah-agent\n  targetEntityId: user-123\n  tags[0]: group_interaction"
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
          "outcome": "thought: \"I'm not sure if I'm being helpful or if Emma is frustrated with my suggestions. The lack of response is concerning - maybe I should have asked for more details about the issue first before jumping to solutions.\"\nfacts[0]:\n  claim: Emma is having technical issues with file uploads\n  type: fact\n  in_bio: false\n  already_known: false\nfacts[1]:\n  claim: Emma stopped responding after the first troubleshooting suggestion\n  type: fact\n  in_bio: false\n  already_known: false\nrelationships[0]:\n  sourceEntityId: alex-agent\n  targetEntityId: user-456\n  tags[0]: group_interaction\n  tags[1]: support_interaction\n  tags[2]: incomplete_interaction"
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
          "outcome": "thought: \"I'm dominating the conversation and not giving others a chance to share their perspectives. I've sent multiple messages in a row without waiting for responses. I need to step back and create space for other members to participate.\"\nfacts[0]:\n  claim: The discussion is about chapter 5 of a book\n  type: fact\n  in_bio: false\n  already_known: false\nfacts[1]:\n  claim: Max has sent 4 consecutive messages without user responses\n  type: fact\n  in_bio: false\n  already_known: false\nrelationships[0]:\n  sourceEntityId: max-agent\n  targetEntityId: user-789\n  tags[0]: group_interaction\n  tags[1]: excessive_interaction"
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
