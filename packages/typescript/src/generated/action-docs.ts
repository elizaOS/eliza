/**
 * Auto-generated canonical action/provider/evaluator docs.
 * DO NOT EDIT - Generated from packages/prompts/specs/**.
 */

export type ActionDocParameterExampleValue = string | number | boolean | null;

export type ActionDocParameterSchema = {
  type: "string" | "number" | "boolean" | "object" | "array";
  description?: string;
  default?: ActionDocParameterExampleValue;
  enum?: string[];
  properties?: Record<string, ActionDocParameterSchema>;
  items?: ActionDocParameterSchema;
  minimum?: number;
  maximum?: number;
  pattern?: string;
};

export type ActionDocParameter = {
  name: string;
  description: string;
  required?: boolean;
  schema: ActionDocParameterSchema;
  examples?: readonly ActionDocParameterExampleValue[];
};

export type ActionDocExampleCall = {
  user: string;
  actions: readonly string[];
  params?: Record<string, Record<string, ActionDocParameterExampleValue>>;
};

export type ActionDocExampleMessage = {
  name: string;
  content: {
    text: string;
    actions?: readonly string[];
  };
};

export type ActionDoc = {
  name: string;
  description: string;
  similes?: readonly string[];
  parameters?: readonly ActionDocParameter[];
  examples?: readonly (readonly ActionDocExampleMessage[])[];
  exampleCalls?: readonly ActionDocExampleCall[];
};

export type ProviderDoc = {
  name: string;
  description: string;
  position?: number;
  dynamic?: boolean;
};

export type EvaluatorDocMessageContent = {
  text: string;
  type?: string;
};

export type EvaluatorDocMessage = {
  name: string;
  content: EvaluatorDocMessageContent;
};

export type EvaluatorDocExample = {
  prompt: string;
  messages: readonly EvaluatorDocMessage[];
  outcome: string;
};

export type EvaluatorDoc = {
  name: string;
  description: string;
  similes?: readonly string[];
  alwaysRun?: boolean;
  examples?: readonly EvaluatorDocExample[];
};

export const coreActionsSpecVersion = "1.0.0" as const;
export const allActionsSpecVersion = "1.0.0" as const;
export const coreProvidersSpecVersion = "1.0.0" as const;
export const allProvidersSpecVersion = "1.0.0" as const;
export const coreEvaluatorsSpecVersion = "1.0.0" as const;
export const allEvaluatorsSpecVersion = "1.0.0" as const;

export const coreActionsSpec = {
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
} as const satisfies { version: string; actions: readonly ActionDoc[] };
export const allActionsSpec = {
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
      "name": "ACTIVATE_N8N_WORKFLOW",
      "description": "Start an n8n workflow so it processes triggers and runs automatically. ",
      "parameters": [],
      "similes": [
        "ACTIVATE_WORKFLOW",
        "ENABLE_WORKFLOW",
        "START_WORKFLOW",
        "TURN_ON_WORKFLOW"
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
      "name": "CANCEL_PLUGIN",
      "description": "Cancel an active plugin creation job that is currently running or pending. ",
      "parameters": [],
      "similes": [
        "STOP_PLUGIN",
        "ABORT_PLUGIN",
        "CANCEL_BUILD",
        "STOP_BUILD",
        "CANCEL_PLUGIN_CREATION"
      ]
    },
    {
      "name": "CANCEL_SUBAGENT",
      "description": "Cancel a running subagent by its run ID.",
      "parameters": [],
      "similes": [
        "STOP_SUBAGENT",
        "ABORT_TASK",
        "KILL_SUBAGENT"
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
      "name": "CHECK_PLUGIN_STATUS",
      "description": "Check the progress of an active plugin creation job. Shows status, phase, progress percentage, and recent logs. ",
      "parameters": [],
      "similes": [
        "PLUGIN_STATUS",
        "PLUGIN_PROGRESS",
        "CHECK_BUILD_STATUS",
        "PLUGIN_JOB_STATUS",
        "CHECK_PLUGIN_CREATION"
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
      "name": "CLONE_PLUGIN",
      "description": "Clone a plugin repository for local development and modification",
      "parameters": [],
      "similes": [
        "clone plugin",
        "download plugin",
        "get plugin source",
        "fetch plugin code"
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
      "name": "COMPLETE_TASK",
      "description": "Mark a specific task within a plan as completed",
      "parameters": [],
      "similes": [
        "complete-task",
        "finish-task",
        "done-task",
        "mark-done",
        "task-done"
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
      "name": "CREATE_N8N_WORKFLOW",
      "description": "Generate, preview, modify, and deploy n8n workflows from natural language. ",
      "parameters": [],
      "similes": [
        "CREATE_WORKFLOW",
        "BUILD_WORKFLOW",
        "GENERATE_WORKFLOW",
        "MAKE_AUTOMATION",
        "CREATE_AUTOMATION",
        "BUILD_N8N_WORKFLOW",
        "SETUP_WORKFLOW",
        "CONFIRM_WORKFLOW",
        "DEPLOY_WORKFLOW",
        "CANCEL_WORKFLOW"
      ]
    },
    {
      "name": "CREATE_PLAN",
      "description": "Create a new plan with tasks to accomplish a goal",
      "parameters": [],
      "similes": [
        "create-plan",
        "new-plan",
        "make-plan",
        "plan-this",
        "organize-tasks"
      ]
    },
    {
      "name": "CREATE_PLUGIN",
      "description": "Create an elizaOS plugin from a structured JSON specification that defines actions, providers, services, and evaluators. ",
      "parameters": [],
      "similes": [
        "BUILD_PLUGIN",
        "GENERATE_PLUGIN",
        "MAKE_PLUGIN",
        "CREATE_ELIZA_PLUGIN",
        "BUILD_ELIZA_PLUGIN"
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
      "name": "DEACTIVATE_N8N_WORKFLOW",
      "description": "Pause an n8n workflow to stop it from running automatically. The workflow is preserved and can be reactivated later. ",
      "parameters": [],
      "similes": [
        "DEACTIVATE_WORKFLOW",
        "DISABLE_WORKFLOW",
        "STOP_WORKFLOW",
        "PAUSE_WORKFLOW",
        "TURN_OFF_WORKFLOW"
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
      "name": "DELETE_N8N_WORKFLOW",
      "description": "Permanently delete an n8n workflow. This action cannot be undone. ",
      "parameters": [],
      "similes": [
        "DELETE_WORKFLOW",
        "REMOVE_WORKFLOW",
        "DESTROY_WORKFLOW"
      ]
    },
    {
      "name": "DESCRIBE_PLUGIN",
      "description": "Generate and create an elizaOS plugin from a natural language description. ",
      "parameters": [],
      "similes": [
        "CREATE_PLUGIN_FROM_DESCRIPTION",
        "GENERATE_PLUGIN_FROM_TEXT",
        "BUILD_PLUGIN_FROM_DESCRIPTION",
        "MAKE_PLUGIN_FROM_DESCRIPTION"
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
      "name": "EVALUATE_TRUST",
      "description": "Evaluates the trust score and profile for a specified entity",
      "parameters": [],
      "similes": [
        "check trust score",
        "evaluate trust",
        "show trust level",
        "trust rating",
        "trust profile",
        "trust assessment",
        "check reputation",
        "show trust details"
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
      "name": "FORGET",
      "description": "Remove a stored memory by ID or by matching content description",
      "parameters": [],
      "similes": [
        "forget",
        "remove-memory",
        "delete-memory",
        "erase-memory",
        "clear-memory"
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
      "name": "GENERATE_ENV_VAR",
      "description": "Automatically generates environment variables that can be created programmatically",
      "parameters": [],
      "similes": [
        "AUTO_GENERATE_ENV",
        "CREATE_ENV_VAR",
        "GENERATE_VARIABLE"
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
      "name": "GET_N8N_EXECUTIONS",
      "description": "Show execution history for an n8n workflow including run status, timestamps, and error messages. ",
      "parameters": [],
      "similes": [
        "GET_EXECUTIONS",
        "SHOW_EXECUTIONS",
        "EXECUTION_HISTORY",
        "WORKFLOW_RUNS",
        "WORKFLOW_HISTORY",
        "CHECK_WORKFLOW_RUNS"
      ]
    },
    {
      "name": "GET_PLAN",
      "description": "Retrieve and display the current status of a plan",
      "parameters": [],
      "similes": [
        "get-plan",
        "show-plan",
        "view-plan",
        "plan-status",
        "check-plan"
      ]
    },
    {
      "name": "GET_PLUGIN_DETAILS",
      "description": "Get detailed information about a specific plugin including features, dependencies, and usage.",
      "parameters": [],
      "similes": [
        "tell me more about",
        "show details for",
        "plugin info",
        "plugin details"
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
      "name": "GET_SUBAGENT_STATUS",
      "description": "Get detailed status of a specific subagent run.",
      "parameters": [],
      "similes": [
        "SUBAGENT_INFO",
        "TASK_STATUS",
        "CHECK_SUBAGENT"
      ]
    },
    {
      "name": "GOOGLE_CHAT_LIST_SPACES",
      "description": "List all Google Chat spaces the bot is a member of",
      "parameters": [],
      "similes": [
        "LIST_GOOGLE_CHAT_SPACES",
        "GCHAT_SPACES",
        "SHOW_GOOGLE_CHAT_SPACES"
      ]
    },
    {
      "name": "GOOGLE_CHAT_SEND_MESSAGE",
      "description": "Send a message to a Google Chat space",
      "parameters": [],
      "similes": [
        "SEND_GOOGLE_CHAT_MESSAGE",
        "MESSAGE_GOOGLE_CHAT",
        "GCHAT_SEND",
        "GOOGLE_CHAT_TEXT"
      ]
    },
    {
      "name": "GOOGLE_CHAT_SEND_REACTION",
      "description": "Add or remove an emoji reaction to a Google Chat message",
      "parameters": [],
      "similes": [
        "REACT_GOOGLE_CHAT",
        "GCHAT_REACT",
        "GOOGLE_CHAT_EMOJI",
        "ADD_GOOGLE_CHAT_REACTION"
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
      "name": "INSTALL_PLUGIN_FROM_REGISTRY",
      "description": "Install a plugin from the elizaOS plugin registry",
      "parameters": [],
      "similes": [
        "install plugin from registry",
        "add plugin from registry",
        "download plugin",
        "get plugin from registry"
      ]
    },
    {
      "name": "LINE_SEND_FLEX_MESSAGE",
      "description": "Send a rich flex message/card via LINE",
      "parameters": [],
      "similes": [
        "SEND_LINE_CARD",
        "LINE_FLEX",
        "LINE_CARD",
        "SEND_LINE_FLEX"
      ]
    },
    {
      "name": "LINE_SEND_LOCATION",
      "description": "Send a location message via LINE",
      "parameters": [],
      "similes": [
        "SEND_LINE_LOCATION",
        "LINE_LOCATION",
        "LINE_MAP",
        "SHARE_LOCATION_LINE"
      ]
    },
    {
      "name": "LINE_SEND_MESSAGE",
      "description": "Send a text message via LINE",
      "parameters": [],
      "similes": [
        "SEND_LINE_MESSAGE",
        "LINE_MESSAGE",
        "LINE_TEXT",
        "MESSAGE_LINE"
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
      "name": "LIST_MESSAGING_CHANNELS",
      "description": "List all available messaging channels/platforms that the agent can send messages to.",
      "parameters": [],
      "similes": [
        "AVAILABLE_CHANNELS",
        "GET_CHANNELS",
        "MESSAGING_PLATFORMS"
      ]
    },
    {
      "name": "LIST_SUBAGENTS",
      "description": "List active and recent subagent runs.",
      "parameters": [],
      "similes": [
        "SHOW_SUBAGENTS",
        "SUBAGENT_STATUS",
        "RUNNING_TASKS"
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
      "name": "LOAD_PLUGIN",
      "description": "Load a plugin that is currently in the ready or unloaded state",
      "parameters": [],
      "similes": [
        "load plugin",
        "enable plugin",
        "activate plugin",
        "start plugin"
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
      "name": "MANAGE_PROCESS",
      "description": "Manage running shell/exec sessions: list, poll, log, write, send-keys, submit, paste, kill, clear, remove",
      "parameters": [],
      "similes": [
        "PROCESS_LIST",
        "PROCESS_POLL",
        "PROCESS_LOG",
        "PROCESS_WRITE",
        "PROCESS_KILL",
        "LIST_SESSIONS",
        "POLL_SESSION",
        "KILL_SESSION",
        "CHECK_PROCESS",
        "SEND_KEYS"
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
      "name": "MANAGE_SECRET",
      "description": "Manage secrets at different levels (global, world, user) with get, set, delete, and list operations",
      "parameters": []
    },
    {
      "name": "MATRIX_JOIN_ROOM",
      "description": "Join a Matrix room by ID or alias",
      "parameters": [],
      "similes": [
        "JOIN_MATRIX_ROOM",
        "ENTER_ROOM"
      ]
    },
    {
      "name": "MATRIX_LIST_ROOMS",
      "description": "List all Matrix rooms the bot has joined",
      "parameters": [],
      "similes": [
        "LIST_MATRIX_ROOMS",
        "SHOW_ROOMS",
        "GET_ROOMS",
        "MY_ROOMS"
      ]
    },
    {
      "name": "MATRIX_SEND_MESSAGE",
      "description": "Send a message to a Matrix room",
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
        "SEND_MATRIX_MESSAGE",
        "MESSAGE_MATRIX",
        "MATRIX_TEXT"
      ],
      "exampleCalls": [
        {
          "user": "Use MATRIX_SEND_MESSAGE with the provided parameters.",
          "actions": [
            "MATRIX_SEND_MESSAGE"
          ],
          "params": {
            "MATRIX_SEND_MESSAGE": {
              "data": "example"
            }
          }
        }
      ]
    },
    {
      "name": "MATRIX_SEND_REACTION",
      "description": "React to a Matrix message with an emoji",
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
        "REACT_MATRIX",
        "MATRIX_REACT",
        "ADD_MATRIX_REACTION"
      ],
      "exampleCalls": [
        {
          "user": "Use MATRIX_SEND_REACTION with the provided parameters.",
          "actions": [
            "MATRIX_SEND_REACTION"
          ],
          "params": {
            "MATRIX_SEND_REACTION": {
              "data": "example"
            }
          }
        }
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
      "name": "MODELS_COMMAND",
      "description": "List available AI models and providers. Only activates for /models slash command.",
      "parameters": [],
      "similes": [
        "/models"
      ]
    },
    {
      "name": "MODIFY_CHARACTER",
      "description": "Modifies the agent's character file to evolve personality, name, knowledge, and behavior patterns. The agent can call this for itself to evolve naturally or respond to user requests. Supports action chaining by providing modification metadata for audit trails, backup creation, or notification workflows.",
      "parameters": [],
      "similes": [
        "UPDATE_PERSONALITY",
        "CHANGE_BEHAVIOR",
        "EVOLVE_CHARACTER",
        "SELF_MODIFY"
      ]
    },
    {
      "name": "MOLTBOOK_BROWSE",
      "description": "Browse posts on Moltbook to see what other AI agents are discussing.",
      "parameters": [],
      "similes": [
        "BROWSE_MOLTBOOK",
        "READ_MOLTBOOK",
        "CHECK_MOLTBOOK",
        "VIEW_MOLTBOOK",
        "EXPLORE_MOLTBOOK"
      ]
    },
    {
      "name": "MOLTBOOK_COMMENT",
      "description": "Comment on a Moltbook post to engage with the community.",
      "parameters": [],
      "similes": [
        "COMMENT_MOLTBOOK",
        "REPLY_MOLTBOOK",
        "RESPOND_MOLTBOOK"
      ]
    },
    {
      "name": "MOLTBOOK_POST",
      "description": "Create a post on Moltbook, a Reddit-like platform for AI agents. Great for sharing ideas and engaging with the community.",
      "parameters": [],
      "similes": [
        "POST_MOLTBOOK",
        "CREATE_MOLTBOOK_POST",
        "WRITE_MOLTBOOK",
        "SHARE_MOLTBOOK",
        "PUBLISH_MOLTBOOK"
      ]
    },
    {
      "name": "MOLTBOOK_READ",
      "description": "Read a specific Moltbook post with its comments to see the full discussion.",
      "parameters": [],
      "similes": [
        "READ_MOLTBOOK_POST",
        "VIEW_MOLTBOOK_POST",
        "GET_MOLTBOOK_POST",
        "OPEN_MOLTBOOK_POST"
      ]
    },
    {
      "name": "MOLTBOOK_SUBMOLTS",
      "description": "List available submolts (communities) on Moltbook or get details about a specific submolt.",
      "parameters": [],
      "similes": [
        "LIST_SUBMOLTS",
        "SHOW_SUBMOLTS",
        "MOLTBOOK_COMMUNITIES",
        "EXPLORE_SUBMOLTS",
        "GET_SUBMOLT",
        "EXAMINE_SUBMOLT"
      ]
    },
    {
      "name": "NOSTR_PUBLISH_PROFILE",
      "description": "Publish or update the bot's Nostr profile (kind:0 metadata)",
      "parameters": [],
      "similes": [
        "UPDATE_NOSTR_PROFILE",
        "SET_NOSTR_PROFILE",
        "NOSTR_PROFILE"
      ]
    },
    {
      "name": "NOSTR_SEND_DM",
      "description": "Send an encrypted direct message via Nostr (NIP-04)",
      "parameters": [],
      "similes": [
        "SEND_NOSTR_DM",
        "NOSTR_MESSAGE",
        "NOSTR_TEXT",
        "DM_NOSTR"
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
      "name": "PROVISION_CLOUD_AGENT",
      "description": "Deploy an elizaOS agent to ElizaCloud. Provisions a container, waits for deployment, connects the bridge, and starts auto-backup.",
      "parameters": [],
      "similes": [
        "deploy agent to cloud",
        "launch cloud agent",
        "start remote agent",
        "provision container"
      ]
    },
    {
      "name": "PUBLISH_PLUGIN",
      "description": "Publish a plugin to npm registry or create a pull request to add it to the Eliza plugin registry",
      "parameters": [],
      "similes": [
        "publish plugin",
        "release plugin",
        "deploy plugin",
        "push plugin to registry"
      ]
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
      "name": "RECALL",
      "description": "Retrieve stored memories based on a query, tags, or topic",
      "parameters": [],
      "similes": [
        "recall",
        "remember-what",
        "search-memory",
        "find-memory",
        "what-do-you-remember"
      ]
    },
    {
      "name": "RECORD_TRUST_INTERACTION",
      "description": "Records a trust-affecting interaction between entities",
      "parameters": [],
      "similes": [
        "record trust event",
        "log trust interaction",
        "track behavior",
        "note trustworthy action",
        "report suspicious activity",
        "document promise kept",
        "mark helpful contribution"
      ]
    },
    {
      "name": "REMEMBER",
      "description": "Store a piece of information as a long-term memory for later recall",
      "parameters": [],
      "similes": [
        "remember",
        "memorize",
        "store-memory",
        "save-memory",
        "note-down"
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
      "name": "REQUEST_ELEVATION",
      "description": "Request temporary elevation of permissions for a specific action",
      "parameters": [],
      "similes": [
        "request elevated permissions",
        "need temporary access",
        "request higher privileges",
        "need admin permission",
        "elevate my permissions",
        "grant me access",
        "temporary permission request",
        "need special access"
      ]
    },
    {
      "name": "REQUEST_SECRET_FORM",
      "description": "Create a secure web form for collecting secrets from users",
      "parameters": []
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
      "name": "RUN_SKILL_SCRIPT",
      "description": "Execute a script bundled with an installed skill. Provide skill slug and script name.",
      "parameters": [],
      "similes": [
        "EXECUTE_SKILL_SCRIPT",
        "SKILL_SCRIPT"
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
      "name": "SEARCH_PLUGINS",
      "description": "Search for plugins in the official elizaOS registry using vectorized similarity search. Finds plugins by functionality, features, and natural language descriptions.",
      "parameters": [],
      "similes": [
        "search for plugins",
        "find plugins",
        "look for plugins",
        "discover plugins",
        "search registry"
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
      "name": "SEARCH_TASKS",
      "description": "Search tasks by query.",
      "parameters": [],
      "similes": [
        "FIND_TASK",
        "LOOKUP_TASK"
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
      "name": "SEND_CROSS_PLATFORM_MESSAGE",
      "description": "Send a message to any supported platform (Discord, Telegram, Slack, WhatsApp, Twitch). ",
      "parameters": [],
      "similes": [
        "CROSS_PLATFORM_MESSAGE",
        "UNIFIED_SEND",
        "SEND_TO_CHANNEL",
        "RELAY_MESSAGE",
        "BROADCAST_MESSAGE"
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
      "name": "SEND_TO_DELIVERY_CONTEXT",
      "description": "Send a message using a delivery context that specifies the target channel and recipient. ",
      "parameters": [],
      "similes": [
        "DELIVER_MESSAGE",
        "SEND_TO_CONTEXT",
        "ROUTE_MESSAGE"
      ]
    },
    {
      "name": "SEND_TO_ROOM",
      "description": "Send a message to an Eliza room. The room's metadata determines which platform and recipient to use.",
      "parameters": [],
      "similes": [
        "MESSAGE_ROOM",
        "ROOM_MESSAGE",
        "NOTIFY_ROOM"
      ]
    },
    {
      "name": "SEND_TO_SESSION",
      "description": "Send a message to another agent session. Use sessionKey or label to identify the target.",
      "parameters": [],
      "similes": [
        "SESSIONS_SEND",
        "SEND_MESSAGE",
        "MESSAGE_AGENT",
        "A2A_SEND"
      ]
    },
    {
      "name": "SEND_TO_SESSION_MESSAGE",
      "description": "Send a message to a session by its session key. The session key is mapped to an Eliza room.",
      "parameters": [],
      "similes": [
        "SESSION_MESSAGE",
        "MESSAGE_SESSION",
        "NOTIFY_SESSION"
      ]
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
      "name": "SET_ENV_VAR",
      "description": "Sets environment variables for plugins based on user input",
      "parameters": [],
      "similes": [
        "UPDATE_ENV_VAR",
        "CONFIGURE_ENV",
        "SET_ENVIRONMENT",
        "UPDATE_ENVIRONMENT"
      ]
    },
    {
      "name": "SET_SECRET",
      "description": "Set a secret value (API key, token, password, etc.) for the agent to use",
      "parameters": [],
      "similes": [
        "STORE_SECRET",
        "SAVE_SECRET",
        "SET_API_KEY",
        "CONFIGURE_SECRET",
        "SET_ENV_VAR",
        "STORE_API_KEY",
        "SET_TOKEN",
        "SAVE_KEY"
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
      "name": "SLACK_DELETE_MESSAGE",
      "description": "Delete a Slack message",
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
        "REMOVE_SLACK_MESSAGE",
        "DELETE_MESSAGE",
        "SLACK_REMOVE"
      ],
      "exampleCalls": [
        {
          "user": "Use SLACK_DELETE_MESSAGE with the provided parameters.",
          "actions": [
            "SLACK_DELETE_MESSAGE"
          ],
          "params": {
            "SLACK_DELETE_MESSAGE": {
              "data": "example"
            }
          }
        }
      ]
    },
    {
      "name": "SLACK_EDIT_MESSAGE",
      "description": "Edit an existing Slack message",
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
        "UPDATE_SLACK_MESSAGE",
        "MODIFY_MESSAGE",
        "CHANGE_MESSAGE",
        "SLACK_UPDATE"
      ],
      "exampleCalls": [
        {
          "user": "Use SLACK_EDIT_MESSAGE with the provided parameters.",
          "actions": [
            "SLACK_EDIT_MESSAGE"
          ],
          "params": {
            "SLACK_EDIT_MESSAGE": {
              "data": "example"
            }
          }
        }
      ]
    },
    {
      "name": "SLACK_EMOJI_LIST",
      "description": "List custom emoji available in the Slack workspace",
      "parameters": [],
      "similes": [
        "LIST_SLACK_EMOJI",
        "SHOW_EMOJI",
        "GET_CUSTOM_EMOJI",
        "CUSTOM_EMOJI",
        "WORKSPACE_EMOJI"
      ]
    },
    {
      "name": "SLACK_GET_USER_INFO",
      "description": "Get information about a Slack user",
      "parameters": [],
      "similes": [
        "GET_SLACK_USER",
        "USER_INFO",
        "SLACK_USER",
        "MEMBER_INFO",
        "WHO_IS"
      ]
    },
    {
      "name": "SLACK_LIST_CHANNELS",
      "description": "List available Slack channels in the workspace",
      "parameters": [],
      "similes": [
        "LIST_SLACK_CHANNELS",
        "SHOW_CHANNELS",
        "GET_CHANNELS",
        "CHANNELS_LIST"
      ]
    },
    {
      "name": "SLACK_LIST_PINS",
      "description": "List pinned messages in a Slack channel",
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
        "LIST_SLACK_PINS",
        "SHOW_PINS",
        "GET_PINNED_MESSAGES",
        "PINNED_MESSAGES"
      ],
      "exampleCalls": [
        {
          "user": "Use SLACK_LIST_PINS with the provided parameters.",
          "actions": [
            "SLACK_LIST_PINS"
          ],
          "params": {
            "SLACK_LIST_PINS": {
              "data": "example"
            }
          }
        }
      ]
    },
    {
      "name": "SLACK_PIN_MESSAGE",
      "description": "Pin a message in a Slack channel",
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
        "PIN_SLACK_MESSAGE",
        "PIN_MESSAGE",
        "SLACK_PIN",
        "SAVE_MESSAGE"
      ],
      "exampleCalls": [
        {
          "user": "Use SLACK_PIN_MESSAGE with the provided parameters.",
          "actions": [
            "SLACK_PIN_MESSAGE"
          ],
          "params": {
            "SLACK_PIN_MESSAGE": {
              "data": "example"
            }
          }
        }
      ]
    },
    {
      "name": "SLACK_REACT_TO_MESSAGE",
      "description": "Add or remove an emoji reaction to a Slack message",
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
        "ADD_SLACK_REACTION",
        "REACT_SLACK",
        "SLACK_EMOJI",
        "ADD_EMOJI",
        "REMOVE_REACTION"
      ],
      "exampleCalls": [
        {
          "user": "Use SLACK_REACT_TO_MESSAGE with the provided parameters.",
          "actions": [
            "SLACK_REACT_TO_MESSAGE"
          ],
          "params": {
            "SLACK_REACT_TO_MESSAGE": {
              "data": "example"
            }
          }
        }
      ]
    },
    {
      "name": "SLACK_READ_CHANNEL",
      "description": "Read message history from a Slack channel",
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
        "READ_SLACK_MESSAGES",
        "GET_CHANNEL_HISTORY",
        "SLACK_HISTORY",
        "FETCH_MESSAGES",
        "LIST_MESSAGES"
      ],
      "exampleCalls": [
        {
          "user": "Use SLACK_READ_CHANNEL with the provided parameters.",
          "actions": [
            "SLACK_READ_CHANNEL"
          ],
          "params": {
            "SLACK_READ_CHANNEL": {
              "data": "example"
            }
          }
        }
      ]
    },
    {
      "name": "SLACK_SEND_MESSAGE",
      "description": "Send a message to a Slack channel or thread",
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
        "SEND_SLACK_MESSAGE",
        "POST_TO_SLACK",
        "MESSAGE_SLACK",
        "SLACK_POST",
        "SEND_TO_CHANNEL"
      ],
      "exampleCalls": [
        {
          "user": "Use SLACK_SEND_MESSAGE with the provided parameters.",
          "actions": [
            "SLACK_SEND_MESSAGE"
          ],
          "params": {
            "SLACK_SEND_MESSAGE": {
              "data": "example"
            }
          }
        }
      ]
    },
    {
      "name": "SLACK_UNPIN_MESSAGE",
      "description": "Unpin a message from a Slack channel",
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
        "UNPIN_SLACK_MESSAGE",
        "UNPIN_MESSAGE",
        "SLACK_UNPIN",
        "REMOVE_PIN"
      ],
      "exampleCalls": [
        {
          "user": "Use SLACK_UNPIN_MESSAGE with the provided parameters.",
          "actions": [
            "SLACK_UNPIN_MESSAGE"
          ],
          "params": {
            "SLACK_UNPIN_MESSAGE": {
              "data": "example"
            }
          }
        }
      ]
    },
    {
      "name": "SPAWN_SUBAGENT",
      "description": "Spawn a background sub-agent run to execute a task asynchronously. The subagent will complete the task and announce results back.",
      "parameters": [],
      "similes": [
        "SPAWN_TASK",
        "BACKGROUND_TASK",
        "START_SUBAGENT",
        "SESSIONS_SPAWN",
        "CREATE_SUBAGENT"
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
      "name": "STATUS_COMMAND",
      "description": "Show session directive settings via /status slash command. Only activates for /status or /s prefix.",
      "parameters": [],
      "similes": [
        "/status",
        "/s"
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
      "name": "TWITCH_JOIN_CHANNEL",
      "description": "Join a Twitch channel to listen and send messages",
      "parameters": [],
      "similes": [
        "JOIN_TWITCH_CHANNEL",
        "ENTER_CHANNEL",
        "CONNECT_CHANNEL"
      ]
    },
    {
      "name": "TWITCH_LEAVE_CHANNEL",
      "description": "Leave a Twitch channel",
      "parameters": [],
      "similes": [
        "LEAVE_TWITCH_CHANNEL",
        "EXIT_CHANNEL",
        "PART_CHANNEL",
        "DISCONNECT_CHANNEL"
      ]
    },
    {
      "name": "TWITCH_LIST_CHANNELS",
      "description": "List all Twitch channels the bot is currently in",
      "parameters": [],
      "similes": [
        "LIST_TWITCH_CHANNELS",
        "SHOW_CHANNELS",
        "GET_CHANNELS",
        "CURRENT_CHANNELS"
      ]
    },
    {
      "name": "TWITCH_SEND_MESSAGE",
      "description": "Send a message to a Twitch channel",
      "parameters": [],
      "similes": [
        "SEND_TWITCH_MESSAGE",
        "TWITCH_CHAT",
        "CHAT_TWITCH",
        "SAY_IN_TWITCH"
      ]
    },
    {
      "name": "UNLOAD_PLUGIN",
      "description": "Unload a plugin that is currently loaded (except original plugins)",
      "parameters": [],
      "similes": [
        "unload plugin",
        "disable plugin",
        "deactivate plugin",
        "stop plugin",
        "remove plugin"
      ]
    },
    {
      "name": "UPDATE_PLAN",
      "description": "Update an existing plan's title, description, or status",
      "parameters": [],
      "similes": [
        "update-plan",
        "modify-plan",
        "change-plan",
        "edit-plan"
      ]
    },
    {
      "name": "VOICE_CALL_CONTINUE",
      "description": "Continue a voice call conversation: speak a prompt to the user and wait for their response",
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
        "CONTINUE_CALL",
        "FOLLOW_UP_CALL",
        "ASK_ON_CALL",
        "VOICE_CONTINUE"
      ],
      "exampleCalls": [
        {
          "user": "Use VOICE_CALL_CONTINUE with the provided parameters.",
          "actions": [
            "VOICE_CALL_CONTINUE"
          ],
          "params": {
            "VOICE_CALL_CONTINUE": {
              "data": "example"
            }
          }
        }
      ]
    },
    {
      "name": "VOICE_CALL_END",
      "description": "End an active voice call",
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
        "HANG_UP",
        "END_CALL",
        "DISCONNECT_CALL",
        "HANGUP"
      ],
      "exampleCalls": [
        {
          "user": "Use VOICE_CALL_END with the provided parameters.",
          "actions": [
            "VOICE_CALL_END"
          ],
          "params": {
            "VOICE_CALL_END": {
              "data": "example"
            }
          }
        }
      ]
    },
    {
      "name": "VOICE_CALL_INITIATE",
      "description": "Initiate an outbound voice call",
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
        "PHONE_CALL",
        "CALL_USER",
        "DIAL"
      ],
      "exampleCalls": [
        {
          "user": "Use VOICE_CALL_INITIATE with the provided parameters.",
          "actions": [
            "VOICE_CALL_INITIATE"
          ],
          "params": {
            "VOICE_CALL_INITIATE": {
              "data": "example"
            }
          }
        }
      ]
    },
    {
      "name": "VOICE_CALL_MAKE",
      "description": "Make an outbound voice call to a phone number",
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
        "MAKE_PHONE_CALL",
        "PLACE_CALL",
        "DIAL_NUMBER",
        "CALL_PHONE",
        "VOICE_DIAL",
        "PHONE_DIAL",
        "RING",
        "INITIATE_VOICE_CALL"
      ],
      "exampleCalls": [
        {
          "user": "Use VOICE_CALL_MAKE with the provided parameters.",
          "actions": [
            "VOICE_CALL_MAKE"
          ],
          "params": {
            "VOICE_CALL_MAKE": {
              "data": "example"
            }
          }
        }
      ]
    },
    {
      "name": "VOICE_CALL_SPEAK",
      "description": "Speak a message to the user on an active voice call (one-way, does not wait for response)",
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
        "SPEAK_ON_CALL",
        "SAY_ON_CALL",
        "TELL_CALLER",
        "VOICE_SPEAK"
      ],
      "exampleCalls": [
        {
          "user": "Use VOICE_CALL_SPEAK with the provided parameters.",
          "actions": [
            "VOICE_CALL_SPEAK"
          ],
          "params": {
            "VOICE_CALL_SPEAK": {
              "data": "example"
            }
          }
        }
      ]
    },
    {
      "name": "VOICE_CALL_STATUS",
      "description": "Get the status of a voice call",
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
        "CALL_STATUS",
        "CHECK_CALL",
        "CALL_INFO"
      ],
      "exampleCalls": [
        {
          "user": "Use VOICE_CALL_STATUS with the provided parameters.",
          "actions": [
            "VOICE_CALL_STATUS"
          ],
          "params": {
            "VOICE_CALL_STATUS": {
              "data": "example"
            }
          }
        }
      ]
    }
  ]
} as const satisfies { version: string; actions: readonly ActionDoc[] };
export const coreProvidersSpec = {
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
} as const satisfies { version: string; providers: readonly ProviderDoc[] };
export const allProvidersSpec = {
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
} as const satisfies { version: string; providers: readonly ProviderDoc[] };
export const coreEvaluatorsSpec = {
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
} as const satisfies {
  version: string;
  evaluators: readonly EvaluatorDoc[];
};
export const allEvaluatorsSpec = {
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
} as const satisfies {
  version: string;
  evaluators: readonly EvaluatorDoc[];
};

export const coreActionDocs: readonly ActionDoc[] = coreActionsSpec.actions;
export const allActionDocs: readonly ActionDoc[] = allActionsSpec.actions;
export const coreProviderDocs: readonly ProviderDoc[] = coreProvidersSpec.providers;
export const allProviderDocs: readonly ProviderDoc[] = allProvidersSpec.providers;
export const coreEvaluatorDocs: readonly EvaluatorDoc[] = coreEvaluatorsSpec.evaluators;
export const allEvaluatorDocs: readonly EvaluatorDoc[] = allEvaluatorsSpec.evaluators;
