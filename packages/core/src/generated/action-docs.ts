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
	descriptionCompressed?: string;
	compressedDescription?: string;
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
	descriptionCompressed?: string;
	compressedDescription?: string;
	similes?: readonly string[];
	parameters?: readonly ActionDocParameter[];
	examples?: readonly (readonly ActionDocExampleMessage[])[];
	exampleCalls?: readonly ActionDocExampleCall[];
};

export type ProviderDoc = {
	name: string;
	description: string;
	descriptionCompressed?: string;
	compressedDescription?: string;
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
	descriptionCompressed?: string;
	compressedDescription?: string;
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
	version: "1.0.0",
	actions: [
		{
			name: "REPLY",
			description:
				"Send a direct chat reply in the current conversation/thread. Default if the agent is responding with a message and no other action. Use REPLY at the beginning of a chain of actions as an acknowledgement, and at the end of a chain of actions as a final response. This is not an email reply, inbox workflow, or external-channel send — use the dedicated connector actions for those surfaces.",
			similes: ["GREET", "RESPOND", "RESPONSE"],
			parameters: [],
			examples: [
				[
					{
						name: "{{name1}}",
						content: {
							text: "Hello there!",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "Hi! How can I help you today?",
							actions: ["REPLY"],
						},
					},
				],
				[
					{
						name: "{{name1}}",
						content: {
							text: "What's your favorite color?",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "I really like deep shades of blue. They remind me of the ocean and the night sky.",
							actions: ["REPLY"],
						},
					},
				],
				[
					{
						name: "{{name1}}",
						content: {
							text: "Can you explain how neural networks work?",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "Let me break that down for you in simple terms...",
							actions: ["REPLY"],
						},
					},
				],
				[
					{
						name: "{{name1}}",
						content: {
							text: "Could you help me solve this math problem?",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "Of course! Let's work through it step by step.",
							actions: ["REPLY"],
						},
					},
				],
			],
			descriptionCompressed:
				"Reply with generated msg. Default when responding with no other action. Use first as ack, last as final response.",
		},
		{
			name: "IGNORE",
			description:
				"Call this action if ignoring the user. If the user is aggressive, creepy or is finished with the conversation, use this action. In group conversations, use IGNORE when the latest message is addressed to someone else and not to the agent. Or, if both you and the user have already said goodbye, use this action instead of saying bye again. Use IGNORE any time the conversation has naturally ended. Do not use IGNORE if the user has engaged directly, or if something went wrong and you need to tell them. Only ignore if the user should be ignored.",
			similes: ["STOP_TALKING", "STOP_CHATTING", "STOP_CONVERSATION"],
			parameters: [],
			examples: [
				[
					{
						name: "{{name1}}",
						content: {
							text: "Go screw yourself",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "",
							actions: ["IGNORE"],
						},
					},
				],
				[
					{
						name: "{{name1}}",
						content: {
							text: "Shut up, bot",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "",
							actions: ["IGNORE"],
						},
					},
				],
				[
					{
						name: "{{name1}}",
						content: {
							text: "Gotta go",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "Okay, talk to you later",
						},
					},
					{
						name: "{{name1}}",
						content: {
							text: "Cya",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "",
							actions: ["IGNORE"],
						},
					},
				],
				[
					{
						name: "{{name1}}",
						content: {
							text: "bye",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "cya",
						},
					},
					{
						name: "{{name1}}",
						content: {
							text: "",
							actions: ["IGNORE"],
						},
					},
				],
				[
					{
						name: "{{name1}}",
						content: {
							text: "wanna cyber",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "thats inappropriate",
							actions: ["IGNORE"],
						},
					},
				],
			],
			descriptionCompressed:
				"Ignore user when aggressive/creepy, convo ended, group msg addressed elsewhere, or both said goodbye. Don't use if user engaged directly or needs error info.",
		},
		{
			name: "NONE",
			description:
				"Respond but perform no additional action. This is the default if the agent is speaking and not doing anything additional.",
			similes: ["NO_ACTION", "NO_RESPONSE", "NO_REACTION", "NOOP", "PASS"],
			parameters: [],
			examples: [
				[
					{
						name: "{{name1}}",
						content: {
							text: "Hey whats up",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "oh hey",
							actions: ["NONE"],
						},
					},
				],
				[
					{
						name: "{{name1}}",
						content: {
							text: "did u see some faster whisper just came out",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "yeah but its a pain to get into node.js",
							actions: ["NONE"],
						},
					},
				],
				[
					{
						name: "{{name1}}",
						content: {
							text: "u think aliens are real",
							actions: ["NONE"],
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "ya obviously",
							actions: ["NONE"],
						},
					},
				],
				[
					{
						name: "{{name1}}",
						content: {
							text: "drop a joke on me",
							actions: ["NONE"],
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "why dont scientists trust atoms cuz they make up everything lmao",
							actions: ["NONE"],
						},
					},
				],
			],
			descriptionCompressed:
				"Respond without additional action. Default when speaking only.",
		},
		{
			name: "SEND_MESSAGE",
			description:
				"Send a message to a user or room (other than the current one)",
			similes: [
				"DM",
				"MESSAGE",
				"SEND_DM",
				"POST_MESSAGE",
				"DIRECT_MESSAGE",
				"NOTIFY",
			],
			parameters: [
				{
					name: "targetType",
					description: "Whether the message target is a user or a room.",
					required: true,
					schema: {
						type: "string",
						enum: ["user", "room"],
					},
					examples: ["user", "room"],
					descriptionCompressed: "user or room target.",
				},
				{
					name: "source",
					description:
						"The platform/source to send the message on (e.g. telegram, discord, x).",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["telegram", "discord"],
					descriptionCompressed: "Platform (telegram, discord, x).",
				},
				{
					name: "target",
					description:
						"Identifier of the target. For user targets, a name/handle/id; for room targets, a room name/id.",
					required: true,
					schema: {
						type: "string",
					},
					examples: ["dev_guru", "announcements"],
					descriptionCompressed: "Target name/handle/id.",
				},
				{
					name: "text",
					description: "The message content to send.",
					required: true,
					schema: {
						type: "string",
					},
					examples: ["Hello!", "Important announcement!"],
					descriptionCompressed: "Message content.",
				},
			],
			examples: [
				[
					{
						name: "{{name1}}",
						content: {
							text: "Send a message to @dev_guru on telegram saying 'Hello!'",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "Message sent to dev_guru on telegram.",
							actions: ["SEND_MESSAGE"],
						},
					},
				],
				[
					{
						name: "{{name1}}",
						content: {
							text: "Post 'Important announcement!' in #announcements",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "Message sent to announcements.",
							actions: ["SEND_MESSAGE"],
						},
					},
				],
				[
					{
						name: "{{name1}}",
						content: {
							text: "DM Jimmy and tell him 'Meeting at 3pm'",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "Message sent to Jimmy.",
							actions: ["SEND_MESSAGE"],
						},
					},
				],
			],
			exampleCalls: [
				{
					user: 'Send a message to @dev_guru on telegram saying "Hello!"',
					actions: ["REPLY", "SEND_MESSAGE"],
					params: {
						SEND_MESSAGE: {
							targetType: "user",
							source: "telegram",
							target: "dev_guru",
							text: "Hello!",
						},
					},
				},
			],
			descriptionCompressed: "Send msg to another user or room (not current).",
		},
		{
			name: "ADD_CONTACT",
			description:
				"Add a new contact to the relationships with categorization and preferences",
			similes: [
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
				"add to address book",
			],
			parameters: [
				{
					name: "name",
					description: "The contact's primary name.",
					required: true,
					schema: {
						type: "string",
					},
					examples: ["Sarah Chen", "John Smith"],
					descriptionCompressed: "Contact name.",
				},
				{
					name: "notes",
					description:
						"Optional notes about the contact (short summary, context, or preferences).",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["Met at the AI meetup; interested in agents"],
					descriptionCompressed: "Optional notes/context.",
				},
			],
			examples: [
				[
					{
						name: "{{name1}}",
						content: {
							text: "Add John Smith to my contacts as a colleague",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "I've added John Smith to your contacts as a colleague.",
						},
					},
				],
				[
					{
						name: "{{name1}}",
						content: {
							text: "Save this person as a friend in my relationships",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "I've saved them as a friend in your relationships.",
						},
					},
				],
				[
					{
						name: "{{name1}}",
						content: {
							text: "Remember Alice as a VIP contact",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "I've added Alice to your contacts as a VIP.",
						},
					},
				],
			],
			descriptionCompressed:
				"Add contact to relationships with category/preferences.",
		},
		{
			name: "UPDATE_CONTACT",
			description: "Update an existing contact's details in the relationships.",
			similes: ["EDIT_CONTACT", "MODIFY_CONTACT", "CHANGE_CONTACT_INFO"],
			parameters: [
				{
					name: "name",
					description:
						"The contact name to update (must match an existing contact).",
					required: true,
					schema: {
						type: "string",
					},
					examples: ["Sarah Chen"],
					descriptionCompressed: "Contact name (must match existing).",
				},
				{
					name: "updates",
					description: "A JSON object of fields to update (stringified JSON).",
					required: true,
					schema: {
						type: "string",
					},
					examples: ['{"notes":"prefers email","tags":["friend"]}'],
					descriptionCompressed: "Fields to update (JSON).",
				},
			],
			examples: [
				[
					{
						name: "{{name1}}",
						content: {
							text: "Update Sarah's contact to add the tag 'investor'",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "I've updated Sarah's contact with the new tag.",
						},
					},
				],
			],
			descriptionCompressed: "Update existing contact details.",
		},
		{
			name: "REMOVE_CONTACT",
			description: "Remove a contact from the relationships.",
			similes: [
				"DELETE_CONTACT",
				"REMOVE_FROM_ROLODEX",
				"DELETE_FROM_CONTACTS",
				"FORGET_PERSON",
				"REMOVE_FROM_CONTACTS",
			],
			parameters: [
				{
					name: "name",
					description: "The contact name to remove.",
					required: true,
					schema: {
						type: "string",
					},
					examples: ["Sarah Chen"],
					descriptionCompressed: "Contact name.",
				},
			],
			examples: [
				[
					{
						name: "{{name1}}",
						content: {
							text: "Remove John from my contacts",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "Are you sure you want to remove John from your contacts?",
						},
					},
					{
						name: "{{name1}}",
						content: {
							text: "Yes",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "I've removed John from your contacts.",
						},
					},
				],
			],
			descriptionCompressed: "Remove contact from relationships.",
		},
		{
			name: "SEARCH_CONTACTS",
			description:
				"Search and list contacts in the relationships by name or query.",
			similes: [
				"FIND_CONTACTS",
				"LOOKUP_CONTACTS",
				"LIST_CONTACTS",
				"SHOW_CONTACTS",
				"list contacts",
				"show contacts",
				"search contacts",
				"find contacts",
				"who are my friends",
			],
			parameters: [
				{
					name: "query",
					description: "Search query (name, handle, or free-text).",
					required: true,
					schema: {
						type: "string",
					},
					examples: ["sarah", "AI meetup"],
					descriptionCompressed: "Search query (name/handle/free-text).",
				},
			],
			examples: [
				[
					{
						name: "{{name1}}",
						content: {
							text: "Show me my friends",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "Here are your contacts tagged as friends: Sarah Chen, John Smith...",
						},
					},
				],
			],
			descriptionCompressed: "Search/list contacts by name or query.",
		},
		{
			name: "SCHEDULE_FOLLOW_UP",
			description: "Schedule a follow-up reminder for a contact.",
			similes: [
				"REMIND_ME",
				"FOLLOW_UP",
				"REMIND_FOLLOW_UP",
				"SET_REMINDER",
				"REMIND_ABOUT",
				"FOLLOW_UP_WITH",
				"follow up with",
				"remind me to contact",
				"schedule a check-in",
				"set a reminder for",
			],
			parameters: [
				{
					name: "name",
					description: "Contact name to follow up with.",
					required: true,
					schema: {
						type: "string",
					},
					examples: ["Sarah Chen"],
					descriptionCompressed: "Contact name.",
				},
				{
					name: "when",
					description: "When to follow up. Use an ISO-8601 datetime string.",
					required: true,
					schema: {
						type: "string",
					},
					examples: ["2026-02-01T09:00:00Z"],
					descriptionCompressed: "ISO-8601 datetime.",
				},
				{
					name: "reason",
					description: "Optional reason/context for the follow-up.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["Check in about the agent framework demo"],
					descriptionCompressed: "Optional reason/context.",
				},
			],
			examples: [
				[
					{
						name: "{{name1}}",
						content: {
							text: "Remind me to follow up with Sarah next week about the demo",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "I've scheduled a follow-up reminder with Sarah for next week about the demo.",
						},
					},
				],
			],
			descriptionCompressed: "Schedule follow-up reminder for contact.",
		},
		{
			name: "CHOOSE_OPTION",
			description:
				"Select an option for a pending task that has multiple options.",
			similes: [
				"SELECT_OPTION",
				"PICK_OPTION",
				"SELECT_TASK",
				"PICK_TASK",
				"SELECT",
				"PICK",
				"CHOOSE",
			],
			parameters: [
				{
					name: "taskId",
					description: "The pending task id.",
					required: true,
					schema: {
						type: "string",
					},
					examples: ["c0a8012e"],
					descriptionCompressed: "Pending task id.",
				},
				{
					name: "option",
					description: "The selected option name exactly as listed.",
					required: true,
					schema: {
						type: "string",
					},
					examples: ["APPROVE", "ABORT"],
					descriptionCompressed: "Option name exactly as listed.",
				},
			],
			examples: [
				[
					{
						name: "{{name1}}",
						content: {
							text: "Select the first option",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "I've selected option 1 for the pending task.",
							actions: ["CHOOSE_OPTION"],
						},
					},
				],
			],
			descriptionCompressed: "Select option for pending multi-choice task.",
		},
		{
			name: "FOLLOW_ROOM",
			description:
				"Start following this channel with great interest, chiming in without needing to be explicitly mentioned. Only do this if explicitly asked to.",
			similes: [
				"FOLLOW_CHAT",
				"FOLLOW_CHANNEL",
				"FOLLOW_CONVERSATION",
				"FOLLOW_THREAD",
				"JOIN_ROOM",
				"SUBSCRIBE_ROOM",
				"WATCH_ROOM",
				"ENTER_ROOM",
			],
			parameters: [
				{
					name: "roomId",
					description: "The target room id to follow.",
					required: true,
					schema: {
						type: "string",
					},
					examples: ["00000000-0000-0000-0000-000000000000"],
					descriptionCompressed: "Room id to follow.",
				},
			],
			examples: [
				[
					{
						name: "{{name1}}",
						content: {
							text: "hey {{name2}} follow this channel",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "Sure, I will now follow this room and chime in",
							actions: ["FOLLOW_ROOM"],
						},
					},
				],
				[
					{
						name: "{{name1}}",
						content: {
							text: "{{name2}} stay in this chat pls",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "you got it, i'm here",
							actions: ["FOLLOW_ROOM"],
						},
					},
				],
			],
			descriptionCompressed:
				"Start following channel, chiming in without @mention. Only when explicitly asked.",
		},
		{
			name: "UNFOLLOW_ROOM",
			description:
				"Stop following a room and cease receiving updates. Use this when you no longer want to monitor a room's activity.",
			similes: [
				"UNFOLLOW_CHAT",
				"UNFOLLOW_CONVERSATION",
				"UNFOLLOW_ROOM",
				"UNFOLLOW_THREAD",
				"LEAVE_ROOM",
				"UNSUBSCRIBE_ROOM",
				"STOP_WATCHING_ROOM",
				"EXIT_ROOM",
			],
			parameters: [
				{
					name: "roomId",
					description: "The target room id to unfollow.",
					required: true,
					schema: {
						type: "string",
					},
					examples: ["00000000-0000-0000-0000-000000000000"],
					descriptionCompressed: "Room id to unfollow.",
				},
			],
			examples: [
				[
					{
						name: "{{name1}}",
						content: {
							text: "{{name2}} stop following this channel",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "Okay, I'll stop following this room",
							actions: ["UNFOLLOW_ROOM"],
						},
					},
				],
			],
			descriptionCompressed: "Stop following room, cease updates.",
		},
		{
			name: "MUTE_ROOM",
			description:
				"Mutes a room, ignoring all messages unless explicitly mentioned. Only do this if explicitly asked to, or if you're annoying people.",
			similes: [
				"MUTE_CHAT",
				"MUTE_CONVERSATION",
				"MUTE_THREAD",
				"MUTE_CHANNEL",
				"SILENCE_ROOM",
				"QUIET_ROOM",
				"DISABLE_NOTIFICATIONS",
				"STOP_RESPONDING",
			],
			parameters: [
				{
					name: "roomId",
					description: "The room id to mute.",
					required: true,
					schema: {
						type: "string",
					},
					examples: ["00000000-0000-0000-0000-000000000000"],
					descriptionCompressed: "Room id to mute.",
				},
			],
			examples: [
				[
					{
						name: "{{name1}}",
						content: {
							text: "{{name2}}, please mute this channel. No need to respond here for now.",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "Got it",
							actions: ["MUTE_ROOM"],
						},
					},
				],
				[
					{
						name: "{{name1}}",
						content: {
							text: "{{name2}} plz mute this room",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "np going silent",
							actions: ["MUTE_ROOM"],
						},
					},
				],
			],
			descriptionCompressed:
				"Mute room, ignore msgs unless @mentioned. Only when asked or annoying.",
		},
		{
			name: "UNMUTE_ROOM",
			description:
				"Unmute a room to resume responding and receiving notifications. Use this when you want to start interacting with a muted room again.",
			similes: [
				"UNMUTE_CHAT",
				"UNMUTE_CONVERSATION",
				"UNMUTE_ROOM",
				"UNMUTE_THREAD",
				"UNSILENCE_ROOM",
				"ENABLE_NOTIFICATIONS",
				"RESUME_RESPONDING",
				"START_LISTENING",
			],
			parameters: [
				{
					name: "roomId",
					description: "The room id to unmute.",
					required: true,
					schema: {
						type: "string",
					},
					examples: ["00000000-0000-0000-0000-000000000000"],
					descriptionCompressed: "Room id to unmute.",
				},
			],
			examples: [
				[
					{
						name: "{{name1}}",
						content: {
							text: "{{name2}} unmute this room please",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "I've unmuted this room and will respond again",
							actions: ["UNMUTE_ROOM"],
						},
					},
				],
			],
			descriptionCompressed: "Unmute room, resume responding.",
		},
		{
			name: "UPDATE_SETTINGS",
			description:
				"Update agent settings by applying explicit key/value updates.",
			similes: [
				"SET_SETTINGS",
				"CHANGE_SETTINGS",
				"UPDATE_SETTING",
				"SAVE_SETTING",
				"SET_CONFIGURATION",
				"CONFIGURE",
				"MODIFY_SETTINGS",
				"SET_PREFERENCE",
				"UPDATE_CONFIG",
			],
			parameters: [
				{
					name: "updates",
					description:
						'A JSON array of {"key": string, "value": string} updates (stringified JSON).',
					required: true,
					schema: {
						type: "string",
					},
					examples: ['[{"key":"model","value":"gpt-5"}]'],
					descriptionCompressed: "JSON array of {key, value} updates.",
				},
			],
			examples: [
				[
					{
						name: "{{name1}}",
						content: {
							text: "Change my language setting to French",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "I've updated your language setting to French.",
							actions: ["UPDATE_SETTINGS"],
						},
					},
				],
			],
			descriptionCompressed: "Update agent settings via key/value pairs.",
		},
		{
			name: "UPDATE_ROLE",
			description:
				"Assigns a role (Admin, Owner, None) to a user or list of users in a channel.",
			similes: [
				"SET_ROLE",
				"CHANGE_ROLE",
				"SET_PERMISSIONS",
				"ASSIGN_ROLE",
				"MAKE_ADMIN",
				"MODIFY_PERMISSIONS",
				"GRANT_ROLE",
			],
			parameters: [
				{
					name: "entityId",
					description: "The entity id to update.",
					required: true,
					schema: {
						type: "string",
					},
					examples: ["00000000-0000-0000-0000-000000000000"],
					descriptionCompressed: "Entity id.",
				},
				{
					name: "role",
					description: "The new role to assign.",
					required: true,
					schema: {
						type: "string",
					},
					examples: ["admin", "member"],
					descriptionCompressed: "Role to assign.",
				},
			],
			examples: [
				[
					{
						name: "{{name1}}",
						content: {
							text: "Make Sarah an admin",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "I've assigned the admin role to Sarah.",
							actions: ["UPDATE_ROLE"],
						},
					},
				],
			],
			descriptionCompressed:
				"Assign role (Admin/Owner/None) to user(s) in channel.",
		},
		{
			name: "UPDATE_ENTITY",
			description:
				"Add or edit contact details for a person you are talking to or observing. Use this to modify entity profiles, metadata, or attributes.",
			similes: [
				"EDIT_ENTITY",
				"MODIFY_ENTITY",
				"CHANGE_ENTITY",
				"UPDATE_PROFILE",
				"SET_ENTITY_INFO",
			],
			parameters: [
				{
					name: "entityId",
					description: "The entity id to update.",
					required: true,
					schema: {
						type: "string",
					},
					examples: ["00000000-0000-0000-0000-000000000000"],
					descriptionCompressed: "Entity id.",
				},
				{
					name: "updates",
					description:
						'A JSON array of {"name": string, "value": string} field updates (stringified JSON).',
					required: true,
					schema: {
						type: "string",
					},
					examples: ['[{"name":"bio","value":"Loves Rust"}]'],
					descriptionCompressed: "JSON array of {name, value} updates.",
				},
			],
			examples: [
				[
					{
						name: "{{name1}}",
						content: {
							text: "Update my profile bio to say 'AI enthusiast'",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "I've updated your profile bio.",
							actions: ["UPDATE_ENTITY"],
						},
					},
				],
			],
			descriptionCompressed: "Edit contact details for person in conversation.",
		},
		{
			name: "THINK",
			description:
				"Pause and think deeply about a complex question, ambiguous request, or multi-faceted problem before responding. Use THINK when the question requires careful reasoning, when you are not confident in your initial assessment, when the user asks something nuanced that benefits from structured analysis, or when multiple valid approaches exist and you need to evaluate trade-offs. Do NOT use THINK for simple greetings, factual lookups, or straightforward requests where the answer is obvious. THINK re-processes the full conversation context through a larger, more capable model to produce a thorough, well-reasoned response.",
			similes: [
				"PLAN",
				"REASON",
				"ANALYZE",
				"REFLECT",
				"CONSIDER",
				"DELIBERATE",
				"DEEP_THINK",
				"PONDER",
			],
			parameters: [],
			examples: [
				[
					{
						name: "{{name1}}",
						content: {
							text: "What's the best architecture for a real-time multiplayer game with 10k concurrent users?",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "That's a great question with several important trade-offs to consider. Let me think through this carefully...",
							actions: ["THINK"],
						},
					},
				],
				[
					{
						name: "{{name1}}",
						content: {
							text: "Should I use a monorepo or polyrepo for my team of 15 engineers working on 3 microservices?",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "Let me think about the trade-offs for your specific situation...",
							actions: ["THINK"],
						},
					},
				],
				[
					{
						name: "{{name1}}",
						content: {
							text: "We're seeing intermittent 502 errors in production but only during peak hours. Our setup is nginx -> node -> postgres. What could cause this?",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "There are several possible causes here. Let me reason through the full request path systematically...",
							actions: ["THINK"],
						},
					},
				],
				[
					{
						name: "{{name1}}",
						content: {
							text: "How should we handle authentication across our mobile app, web app, and API given we need SSO with both Google and enterprise SAML providers?",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "Cross-platform auth with multiple identity providers has some nuance. Let me plan this out...",
							actions: ["THINK"],
						},
					},
				],
			],
			descriptionCompressed:
				"Deep reasoning for complex/ambiguous questions. Re-processes full context through larger model. Use when careful reasoning needed, not for simple lookups.",
		},
		{
			name: "GENERATE_IMAGE",
			description:
				"Generates an image based on a generated prompt reflecting the current conversation. Use GENERATE_IMAGE when the agent needs to visualize, illustrate, or demonstrate something visually for the user.",
			similes: [
				"DRAW",
				"CREATE_IMAGE",
				"RENDER_IMAGE",
				"VISUALIZE",
				"MAKE_IMAGE",
				"PAINT",
				"IMAGE",
			],
			parameters: [
				{
					name: "prompt",
					description: "Image generation prompt.",
					required: true,
					schema: {
						type: "string",
					},
					examples: ["A futuristic cityscape at sunset, cinematic lighting"],
					descriptionCompressed: "Image prompt.",
				},
			],
			examples: [
				[
					{
						name: "{{name1}}",
						content: {
							text: "Can you show me what a futuristic city looks like?",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "Sure, I'll create a futuristic city image for you. One moment...",
							actions: ["GENERATE_IMAGE"],
						},
					},
				],
				[
					{
						name: "{{name1}}",
						content: {
							text: "What does a neural network look like visually?",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "I'll create a visualization of a neural network for you, one sec...",
							actions: ["GENERATE_IMAGE"],
						},
					},
				],
				[
					{
						name: "{{name1}}",
						content: {
							text: "Can you visualize the feeling of calmness for me?",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "Creating an image to capture calmness for you, please wait a moment...",
							actions: ["GENERATE_IMAGE"],
						},
					},
				],
			],
			descriptionCompressed:
				"Generate image from conversation context. Use to visualize or illustrate.",
		},
	],
} as const satisfies { version: string; actions: readonly ActionDoc[] };
export const allActionsSpec = {
	version: "1.0.0",
	actions: [
		{
			name: "REPLY",
			description:
				"Send a direct chat reply in the current conversation/thread. Default if the agent is responding with a message and no other action. Use REPLY at the beginning of a chain of actions as an acknowledgement, and at the end of a chain of actions as a final response. This is not an email reply, inbox workflow, or external-channel send — use the dedicated connector actions for those surfaces.",
			similes: ["GREET", "RESPOND", "RESPONSE"],
			parameters: [],
			examples: [
				[
					{
						name: "{{name1}}",
						content: {
							text: "Hello there!",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "Hi! How can I help you today?",
							actions: ["REPLY"],
						},
					},
				],
				[
					{
						name: "{{name1}}",
						content: {
							text: "What's your favorite color?",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "I really like deep shades of blue. They remind me of the ocean and the night sky.",
							actions: ["REPLY"],
						},
					},
				],
				[
					{
						name: "{{name1}}",
						content: {
							text: "Can you explain how neural networks work?",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "Let me break that down for you in simple terms...",
							actions: ["REPLY"],
						},
					},
				],
				[
					{
						name: "{{name1}}",
						content: {
							text: "Could you help me solve this math problem?",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "Of course! Let's work through it step by step.",
							actions: ["REPLY"],
						},
					},
				],
			],
			descriptionCompressed:
				"Reply with generated msg. Default when responding with no other action. Use first as ack, last as final response.",
		},
		{
			name: "IGNORE",
			description:
				"Call this action if ignoring the user. If the user is aggressive, creepy or is finished with the conversation, use this action. In group conversations, use IGNORE when the latest message is addressed to someone else and not to the agent. Or, if both you and the user have already said goodbye, use this action instead of saying bye again. Use IGNORE any time the conversation has naturally ended. Do not use IGNORE if the user has engaged directly, or if something went wrong and you need to tell them. Only ignore if the user should be ignored.",
			similes: ["STOP_TALKING", "STOP_CHATTING", "STOP_CONVERSATION"],
			parameters: [],
			examples: [
				[
					{
						name: "{{name1}}",
						content: {
							text: "Go screw yourself",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "",
							actions: ["IGNORE"],
						},
					},
				],
				[
					{
						name: "{{name1}}",
						content: {
							text: "Shut up, bot",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "",
							actions: ["IGNORE"],
						},
					},
				],
				[
					{
						name: "{{name1}}",
						content: {
							text: "Gotta go",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "Okay, talk to you later",
						},
					},
					{
						name: "{{name1}}",
						content: {
							text: "Cya",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "",
							actions: ["IGNORE"],
						},
					},
				],
				[
					{
						name: "{{name1}}",
						content: {
							text: "bye",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "cya",
						},
					},
					{
						name: "{{name1}}",
						content: {
							text: "",
							actions: ["IGNORE"],
						},
					},
				],
				[
					{
						name: "{{name1}}",
						content: {
							text: "wanna cyber",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "thats inappropriate",
							actions: ["IGNORE"],
						},
					},
				],
			],
			descriptionCompressed:
				"Ignore user when aggressive/creepy, convo ended, group msg addressed elsewhere, or both said goodbye. Don't use if user engaged directly or needs error info.",
		},
		{
			name: "NONE",
			description:
				"Respond but perform no additional action. This is the default if the agent is speaking and not doing anything additional.",
			similes: ["NO_ACTION", "NO_RESPONSE", "NO_REACTION", "NOOP", "PASS"],
			parameters: [],
			examples: [
				[
					{
						name: "{{name1}}",
						content: {
							text: "Hey whats up",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "oh hey",
							actions: ["NONE"],
						},
					},
				],
				[
					{
						name: "{{name1}}",
						content: {
							text: "did u see some faster whisper just came out",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "yeah but its a pain to get into node.js",
							actions: ["NONE"],
						},
					},
				],
				[
					{
						name: "{{name1}}",
						content: {
							text: "u think aliens are real",
							actions: ["NONE"],
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "ya obviously",
							actions: ["NONE"],
						},
					},
				],
				[
					{
						name: "{{name1}}",
						content: {
							text: "drop a joke on me",
							actions: ["NONE"],
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "why dont scientists trust atoms cuz they make up everything lmao",
							actions: ["NONE"],
						},
					},
				],
			],
			descriptionCompressed:
				"Respond without additional action. Default when speaking only.",
		},
		{
			name: "SEND_MESSAGE",
			description:
				"Send a message to a user or room (other than the current one)",
			similes: [
				"DM",
				"MESSAGE",
				"SEND_DM",
				"POST_MESSAGE",
				"DIRECT_MESSAGE",
				"NOTIFY",
			],
			parameters: [
				{
					name: "targetType",
					description: "Whether the message target is a user or a room.",
					required: true,
					schema: {
						type: "string",
						enum: ["user", "room"],
					},
					examples: ["user", "room"],
					descriptionCompressed: "user or room target.",
				},
				{
					name: "source",
					description:
						"The platform/source to send the message on (e.g. telegram, discord, x).",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["telegram", "discord"],
					descriptionCompressed: "Platform (telegram, discord, x).",
				},
				{
					name: "target",
					description:
						"Identifier of the target. For user targets, a name/handle/id; for room targets, a room name/id.",
					required: true,
					schema: {
						type: "string",
					},
					examples: ["dev_guru", "announcements"],
					descriptionCompressed: "Target name/handle/id.",
				},
				{
					name: "text",
					description: "The message content to send.",
					required: true,
					schema: {
						type: "string",
					},
					examples: ["Hello!", "Important announcement!"],
					descriptionCompressed: "Message content.",
				},
			],
			examples: [
				[
					{
						name: "{{name1}}",
						content: {
							text: "Send a message to @dev_guru on telegram saying 'Hello!'",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "Message sent to dev_guru on telegram.",
							actions: ["SEND_MESSAGE"],
						},
					},
				],
				[
					{
						name: "{{name1}}",
						content: {
							text: "Post 'Important announcement!' in #announcements",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "Message sent to announcements.",
							actions: ["SEND_MESSAGE"],
						},
					},
				],
				[
					{
						name: "{{name1}}",
						content: {
							text: "DM Jimmy and tell him 'Meeting at 3pm'",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "Message sent to Jimmy.",
							actions: ["SEND_MESSAGE"],
						},
					},
				],
			],
			exampleCalls: [
				{
					user: 'Send a message to @dev_guru on telegram saying "Hello!"',
					actions: ["REPLY", "SEND_MESSAGE"],
					params: {
						SEND_MESSAGE: {
							targetType: "user",
							source: "telegram",
							target: "dev_guru",
							text: "Hello!",
						},
					},
				},
			],
			descriptionCompressed: "Send msg to another user or room (not current).",
		},
		{
			name: "ADD_CONTACT",
			description:
				"Add a new contact to the relationships with categorization and preferences",
			similes: [
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
				"add to address book",
			],
			parameters: [
				{
					name: "name",
					description: "The contact's primary name.",
					required: true,
					schema: {
						type: "string",
					},
					examples: ["Sarah Chen", "John Smith"],
					descriptionCompressed: "Contact name.",
				},
				{
					name: "notes",
					description:
						"Optional notes about the contact (short summary, context, or preferences).",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["Met at the AI meetup; interested in agents"],
					descriptionCompressed: "Optional notes/context.",
				},
			],
			examples: [
				[
					{
						name: "{{name1}}",
						content: {
							text: "Add John Smith to my contacts as a colleague",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "I've added John Smith to your contacts as a colleague.",
						},
					},
				],
				[
					{
						name: "{{name1}}",
						content: {
							text: "Save this person as a friend in my relationships",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "I've saved them as a friend in your relationships.",
						},
					},
				],
				[
					{
						name: "{{name1}}",
						content: {
							text: "Remember Alice as a VIP contact",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "I've added Alice to your contacts as a VIP.",
						},
					},
				],
			],
			descriptionCompressed:
				"Add contact to relationships with category/preferences.",
		},
		{
			name: "UPDATE_CONTACT",
			description: "Update an existing contact's details in the relationships.",
			similes: ["EDIT_CONTACT", "MODIFY_CONTACT", "CHANGE_CONTACT_INFO"],
			parameters: [
				{
					name: "name",
					description:
						"The contact name to update (must match an existing contact).",
					required: true,
					schema: {
						type: "string",
					},
					examples: ["Sarah Chen"],
					descriptionCompressed: "Contact name (must match existing).",
				},
				{
					name: "updates",
					description: "A JSON object of fields to update (stringified JSON).",
					required: true,
					schema: {
						type: "string",
					},
					examples: ['{"notes":"prefers email","tags":["friend"]}'],
					descriptionCompressed: "Fields to update (JSON).",
				},
			],
			examples: [
				[
					{
						name: "{{name1}}",
						content: {
							text: "Update Sarah's contact to add the tag 'investor'",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "I've updated Sarah's contact with the new tag.",
						},
					},
				],
			],
			descriptionCompressed: "Update existing contact details.",
		},
		{
			name: "REMOVE_CONTACT",
			description: "Remove a contact from the relationships.",
			similes: [
				"DELETE_CONTACT",
				"REMOVE_FROM_ROLODEX",
				"DELETE_FROM_CONTACTS",
				"FORGET_PERSON",
				"REMOVE_FROM_CONTACTS",
			],
			parameters: [
				{
					name: "name",
					description: "The contact name to remove.",
					required: true,
					schema: {
						type: "string",
					},
					examples: ["Sarah Chen"],
					descriptionCompressed: "Contact name.",
				},
			],
			examples: [
				[
					{
						name: "{{name1}}",
						content: {
							text: "Remove John from my contacts",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "Are you sure you want to remove John from your contacts?",
						},
					},
					{
						name: "{{name1}}",
						content: {
							text: "Yes",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "I've removed John from your contacts.",
						},
					},
				],
			],
			descriptionCompressed: "Remove contact from relationships.",
		},
		{
			name: "SEARCH_CONTACTS",
			description:
				"Search and list contacts in the relationships by name or query.",
			similes: [
				"FIND_CONTACTS",
				"LOOKUP_CONTACTS",
				"LIST_CONTACTS",
				"SHOW_CONTACTS",
				"list contacts",
				"show contacts",
				"search contacts",
				"find contacts",
				"who are my friends",
			],
			parameters: [
				{
					name: "query",
					description: "Search query (name, handle, or free-text).",
					required: true,
					schema: {
						type: "string",
					},
					examples: ["sarah", "AI meetup"],
					descriptionCompressed: "Search query (name/handle/free-text).",
				},
			],
			examples: [
				[
					{
						name: "{{name1}}",
						content: {
							text: "Show me my friends",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "Here are your contacts tagged as friends: Sarah Chen, John Smith...",
						},
					},
				],
			],
			descriptionCompressed: "Search/list contacts by name or query.",
		},
		{
			name: "SCHEDULE_FOLLOW_UP",
			description: "Schedule a follow-up reminder for a contact.",
			similes: [
				"REMIND_ME",
				"FOLLOW_UP",
				"REMIND_FOLLOW_UP",
				"SET_REMINDER",
				"REMIND_ABOUT",
				"FOLLOW_UP_WITH",
				"follow up with",
				"remind me to contact",
				"schedule a check-in",
				"set a reminder for",
			],
			parameters: [
				{
					name: "name",
					description: "Contact name to follow up with.",
					required: true,
					schema: {
						type: "string",
					},
					examples: ["Sarah Chen"],
					descriptionCompressed: "Contact name.",
				},
				{
					name: "when",
					description: "When to follow up. Use an ISO-8601 datetime string.",
					required: true,
					schema: {
						type: "string",
					},
					examples: ["2026-02-01T09:00:00Z"],
					descriptionCompressed: "ISO-8601 datetime.",
				},
				{
					name: "reason",
					description: "Optional reason/context for the follow-up.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["Check in about the agent framework demo"],
					descriptionCompressed: "Optional reason/context.",
				},
			],
			examples: [
				[
					{
						name: "{{name1}}",
						content: {
							text: "Remind me to follow up with Sarah next week about the demo",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "I've scheduled a follow-up reminder with Sarah for next week about the demo.",
						},
					},
				],
			],
			descriptionCompressed: "Schedule follow-up reminder for contact.",
		},
		{
			name: "CHOOSE_OPTION",
			description:
				"Select an option for a pending task that has multiple options.",
			similes: [
				"SELECT_OPTION",
				"PICK_OPTION",
				"SELECT_TASK",
				"PICK_TASK",
				"SELECT",
				"PICK",
				"CHOOSE",
			],
			parameters: [
				{
					name: "taskId",
					description: "The pending task id.",
					required: true,
					schema: {
						type: "string",
					},
					examples: ["c0a8012e"],
					descriptionCompressed: "Pending task id.",
				},
				{
					name: "option",
					description: "The selected option name exactly as listed.",
					required: true,
					schema: {
						type: "string",
					},
					examples: ["APPROVE", "ABORT"],
					descriptionCompressed: "Option name exactly as listed.",
				},
			],
			examples: [
				[
					{
						name: "{{name1}}",
						content: {
							text: "Select the first option",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "I've selected option 1 for the pending task.",
							actions: ["CHOOSE_OPTION"],
						},
					},
				],
			],
			descriptionCompressed: "Select option for pending multi-choice task.",
		},
		{
			name: "FOLLOW_ROOM",
			description:
				"Start following this channel with great interest, chiming in without needing to be explicitly mentioned. Only do this if explicitly asked to.",
			similes: [
				"FOLLOW_CHAT",
				"FOLLOW_CHANNEL",
				"FOLLOW_CONVERSATION",
				"FOLLOW_THREAD",
				"JOIN_ROOM",
				"SUBSCRIBE_ROOM",
				"WATCH_ROOM",
				"ENTER_ROOM",
			],
			parameters: [
				{
					name: "roomId",
					description: "The target room id to follow.",
					required: true,
					schema: {
						type: "string",
					},
					examples: ["00000000-0000-0000-0000-000000000000"],
					descriptionCompressed: "Room id to follow.",
				},
			],
			examples: [
				[
					{
						name: "{{name1}}",
						content: {
							text: "hey {{name2}} follow this channel",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "Sure, I will now follow this room and chime in",
							actions: ["FOLLOW_ROOM"],
						},
					},
				],
				[
					{
						name: "{{name1}}",
						content: {
							text: "{{name2}} stay in this chat pls",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "you got it, i'm here",
							actions: ["FOLLOW_ROOM"],
						},
					},
				],
			],
			descriptionCompressed:
				"Start following channel, chiming in without @mention. Only when explicitly asked.",
		},
		{
			name: "UNFOLLOW_ROOM",
			description:
				"Stop following a room and cease receiving updates. Use this when you no longer want to monitor a room's activity.",
			similes: [
				"UNFOLLOW_CHAT",
				"UNFOLLOW_CONVERSATION",
				"UNFOLLOW_ROOM",
				"UNFOLLOW_THREAD",
				"LEAVE_ROOM",
				"UNSUBSCRIBE_ROOM",
				"STOP_WATCHING_ROOM",
				"EXIT_ROOM",
			],
			parameters: [
				{
					name: "roomId",
					description: "The target room id to unfollow.",
					required: true,
					schema: {
						type: "string",
					},
					examples: ["00000000-0000-0000-0000-000000000000"],
					descriptionCompressed: "Room id to unfollow.",
				},
			],
			examples: [
				[
					{
						name: "{{name1}}",
						content: {
							text: "{{name2}} stop following this channel",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "Okay, I'll stop following this room",
							actions: ["UNFOLLOW_ROOM"],
						},
					},
				],
			],
			descriptionCompressed: "Stop following room, cease updates.",
		},
		{
			name: "MUTE_ROOM",
			description:
				"Mutes a room, ignoring all messages unless explicitly mentioned. Only do this if explicitly asked to, or if you're annoying people.",
			similes: [
				"MUTE_CHAT",
				"MUTE_CONVERSATION",
				"MUTE_THREAD",
				"MUTE_CHANNEL",
				"SILENCE_ROOM",
				"QUIET_ROOM",
				"DISABLE_NOTIFICATIONS",
				"STOP_RESPONDING",
			],
			parameters: [
				{
					name: "roomId",
					description: "The room id to mute.",
					required: true,
					schema: {
						type: "string",
					},
					examples: ["00000000-0000-0000-0000-000000000000"],
					descriptionCompressed: "Room id to mute.",
				},
			],
			examples: [
				[
					{
						name: "{{name1}}",
						content: {
							text: "{{name2}}, please mute this channel. No need to respond here for now.",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "Got it",
							actions: ["MUTE_ROOM"],
						},
					},
				],
				[
					{
						name: "{{name1}}",
						content: {
							text: "{{name2}} plz mute this room",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "np going silent",
							actions: ["MUTE_ROOM"],
						},
					},
				],
			],
			descriptionCompressed:
				"Mute room, ignore msgs unless @mentioned. Only when asked or annoying.",
		},
		{
			name: "UNMUTE_ROOM",
			description:
				"Unmute a room to resume responding and receiving notifications. Use this when you want to start interacting with a muted room again.",
			similes: [
				"UNMUTE_CHAT",
				"UNMUTE_CONVERSATION",
				"UNMUTE_ROOM",
				"UNMUTE_THREAD",
				"UNSILENCE_ROOM",
				"ENABLE_NOTIFICATIONS",
				"RESUME_RESPONDING",
				"START_LISTENING",
			],
			parameters: [
				{
					name: "roomId",
					description: "The room id to unmute.",
					required: true,
					schema: {
						type: "string",
					},
					examples: ["00000000-0000-0000-0000-000000000000"],
					descriptionCompressed: "Room id to unmute.",
				},
			],
			examples: [
				[
					{
						name: "{{name1}}",
						content: {
							text: "{{name2}} unmute this room please",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "I've unmuted this room and will respond again",
							actions: ["UNMUTE_ROOM"],
						},
					},
				],
			],
			descriptionCompressed: "Unmute room, resume responding.",
		},
		{
			name: "UPDATE_SETTINGS",
			description:
				"Update agent settings by applying explicit key/value updates.",
			similes: [
				"SET_SETTINGS",
				"CHANGE_SETTINGS",
				"UPDATE_SETTING",
				"SAVE_SETTING",
				"SET_CONFIGURATION",
				"CONFIGURE",
				"MODIFY_SETTINGS",
				"SET_PREFERENCE",
				"UPDATE_CONFIG",
			],
			parameters: [
				{
					name: "updates",
					description:
						'A JSON array of {"key": string, "value": string} updates (stringified JSON).',
					required: true,
					schema: {
						type: "string",
					},
					examples: ['[{"key":"model","value":"gpt-5"}]'],
					descriptionCompressed: "JSON array of {key, value} updates.",
				},
			],
			examples: [
				[
					{
						name: "{{name1}}",
						content: {
							text: "Change my language setting to French",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "I've updated your language setting to French.",
							actions: ["UPDATE_SETTINGS"],
						},
					},
				],
			],
			descriptionCompressed: "Update agent settings via key/value pairs.",
		},
		{
			name: "UPDATE_ROLE",
			description:
				"Assigns a role (Admin, Owner, None) to a user or list of users in a channel.",
			similes: [
				"SET_ROLE",
				"CHANGE_ROLE",
				"SET_PERMISSIONS",
				"ASSIGN_ROLE",
				"MAKE_ADMIN",
				"MODIFY_PERMISSIONS",
				"GRANT_ROLE",
			],
			parameters: [
				{
					name: "entityId",
					description: "The entity id to update.",
					required: true,
					schema: {
						type: "string",
					},
					examples: ["00000000-0000-0000-0000-000000000000"],
					descriptionCompressed: "Entity id.",
				},
				{
					name: "role",
					description: "The new role to assign.",
					required: true,
					schema: {
						type: "string",
					},
					examples: ["admin", "member"],
					descriptionCompressed: "Role to assign.",
				},
			],
			examples: [
				[
					{
						name: "{{name1}}",
						content: {
							text: "Make Sarah an admin",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "I've assigned the admin role to Sarah.",
							actions: ["UPDATE_ROLE"],
						},
					},
				],
			],
			descriptionCompressed:
				"Assign role (Admin/Owner/None) to user(s) in channel.",
		},
		{
			name: "UPDATE_ENTITY",
			description:
				"Add or edit contact details for a person you are talking to or observing. Use this to modify entity profiles, metadata, or attributes.",
			similes: [
				"EDIT_ENTITY",
				"MODIFY_ENTITY",
				"CHANGE_ENTITY",
				"UPDATE_PROFILE",
				"SET_ENTITY_INFO",
			],
			parameters: [
				{
					name: "entityId",
					description: "The entity id to update.",
					required: true,
					schema: {
						type: "string",
					},
					examples: ["00000000-0000-0000-0000-000000000000"],
					descriptionCompressed: "Entity id.",
				},
				{
					name: "updates",
					description:
						'A JSON array of {"name": string, "value": string} field updates (stringified JSON).',
					required: true,
					schema: {
						type: "string",
					},
					examples: ['[{"name":"bio","value":"Loves Rust"}]'],
					descriptionCompressed: "JSON array of {name, value} updates.",
				},
			],
			examples: [
				[
					{
						name: "{{name1}}",
						content: {
							text: "Update my profile bio to say 'AI enthusiast'",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "I've updated your profile bio.",
							actions: ["UPDATE_ENTITY"],
						},
					},
				],
			],
			descriptionCompressed: "Edit contact details for person in conversation.",
		},
		{
			name: "THINK",
			description:
				"Pause and think deeply about a complex question, ambiguous request, or multi-faceted problem before responding. Use THINK when the question requires careful reasoning, when you are not confident in your initial assessment, when the user asks something nuanced that benefits from structured analysis, or when multiple valid approaches exist and you need to evaluate trade-offs. Do NOT use THINK for simple greetings, factual lookups, or straightforward requests where the answer is obvious. THINK re-processes the full conversation context through a larger, more capable model to produce a thorough, well-reasoned response.",
			similes: [
				"PLAN",
				"REASON",
				"ANALYZE",
				"REFLECT",
				"CONSIDER",
				"DELIBERATE",
				"DEEP_THINK",
				"PONDER",
			],
			parameters: [],
			examples: [
				[
					{
						name: "{{name1}}",
						content: {
							text: "What's the best architecture for a real-time multiplayer game with 10k concurrent users?",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "That's a great question with several important trade-offs to consider. Let me think through this carefully...",
							actions: ["THINK"],
						},
					},
				],
				[
					{
						name: "{{name1}}",
						content: {
							text: "Should I use a monorepo or polyrepo for my team of 15 engineers working on 3 microservices?",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "Let me think about the trade-offs for your specific situation...",
							actions: ["THINK"],
						},
					},
				],
				[
					{
						name: "{{name1}}",
						content: {
							text: "We're seeing intermittent 502 errors in production but only during peak hours. Our setup is nginx -> node -> postgres. What could cause this?",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "There are several possible causes here. Let me reason through the full request path systematically...",
							actions: ["THINK"],
						},
					},
				],
				[
					{
						name: "{{name1}}",
						content: {
							text: "How should we handle authentication across our mobile app, web app, and API given we need SSO with both Google and enterprise SAML providers?",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "Cross-platform auth with multiple identity providers has some nuance. Let me plan this out...",
							actions: ["THINK"],
						},
					},
				],
			],
			descriptionCompressed:
				"Deep reasoning for complex/ambiguous questions. Re-processes full context through larger model. Use when careful reasoning needed, not for simple lookups.",
		},
		{
			name: "GENERATE_IMAGE",
			description:
				"Generates an image based on a generated prompt reflecting the current conversation. Use GENERATE_IMAGE when the agent needs to visualize, illustrate, or demonstrate something visually for the user.",
			similes: [
				"DRAW",
				"CREATE_IMAGE",
				"RENDER_IMAGE",
				"VISUALIZE",
				"MAKE_IMAGE",
				"PAINT",
				"IMAGE",
			],
			parameters: [
				{
					name: "prompt",
					description: "Image generation prompt.",
					required: true,
					schema: {
						type: "string",
					},
					examples: ["A futuristic cityscape at sunset, cinematic lighting"],
					descriptionCompressed: "Image prompt.",
				},
			],
			examples: [
				[
					{
						name: "{{name1}}",
						content: {
							text: "Can you show me what a futuristic city looks like?",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "Sure, I'll create a futuristic city image for you. One moment...",
							actions: ["GENERATE_IMAGE"],
						},
					},
				],
				[
					{
						name: "{{name1}}",
						content: {
							text: "What does a neural network look like visually?",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "I'll create a visualization of a neural network for you, one sec...",
							actions: ["GENERATE_IMAGE"],
						},
					},
				],
				[
					{
						name: "{{name1}}",
						content: {
							text: "Can you visualize the feeling of calmness for me?",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "Creating an image to capture calmness for you, please wait a moment...",
							actions: ["GENERATE_IMAGE"],
						},
					},
				],
			],
			descriptionCompressed:
				"Generate image from conversation context. Use to visualize or illustrate.",
		},
		{
			name: "ACTIVATE_N8N_WORKFLOW",
			description:
				"Activate an n8n workflow to start processing triggers and running automatically. Identifies workflows by ID, name, or semantic description in any language.",
			parameters: [],
			similes: [
				"ACTIVATE_WORKFLOW",
				"ENABLE_WORKFLOW",
				"START_WORKFLOW",
				"TURN_ON_WORKFLOW",
			],
			descriptionCompressed:
				"Activate an n8n workflow to start processing triggers and running automatically. Identifies workflows by ID, name, or semantic description in any language.",
		},
		{
			name: "ADD_AUTOFILL_WHITELIST",
			description:
				"Add a domain to the autofill whitelist. Requires explicit user confirmation (confirmed: true). Persisted to the local profile store.",
			parameters: [],
			similes: ["TRUST_SITE_FOR_AUTOFILL", "APPROVE_AUTOFILL_DOMAIN"],
			descriptionCompressed:
				"Add a domain to the autofill whitelist. Requires explicit user confirmation (confirmed: true). Persisted to the local profile store.",
		},
		{
			name: "ADD_TO_PLAYLIST",
			description:
				"Add music to a playlist after confirmed:true. If the track is not already in the library, the configured music fetch service must resolve it first. Creates the playlist if it does not exist.",
			parameters: [],
			similes: [
				"ADD_SONG_TO_PLAYLIST",
				"PUT_IN_PLAYLIST",
				"SAVE_TO_PLAYLIST",
				"ADD_TRACK_TO_PLAYLIST",
			],
			descriptionCompressed:
				"Add music to a playlist after confirmed:true. If the track is not already in the library, the configured music fetch service must resolve it first. Creates...",
		},
		{
			name: "ASTROLOGY_READING",
			description:
				"Perform an astrological natal chart reading, progressively revealing planetary placements.",
			parameters: [],
			similes: [
				"BIRTH_CHART",
				"NATAL_CHART",
				"HOROSCOPE_READING",
				"ZODIAC_READING",
			],
			descriptionCompressed:
				"Perform an astrological natal chart reading, progressively revealing planetary placements.",
		},
		{
			name: "ATTACK_NPC",
			description: "Attack a nearby NPC by name",
			parameters: [],
			similes: ["FIGHT_NPC", "MELEE_NPC"],
			descriptionCompressed: "Attack a nearby NPC by name",
		},
		{
			name: "AUTHENTICATE_GOOGLE",
			description: "Authenticate with Google to access Meet API",
			parameters: [],
			similes: ["login to google", "google auth", "sign in", "authenticate"],
			descriptionCompressed: "Authenticate with Google to access Meet API",
		},
		{
			name: "BLOCK_UNTIL_TASK_COMPLETE",
			description:
				"Block websites until a specific todo is marked complete. Use this only when the unblock condition is finishing a task, workout, assignment, or todo, like 'block x.com until I finish my workout'. ",
			parameters: [],
			similes: [
				"BLOCK_SITES_UNTIL_TODO_DONE",
				"BLOCK_WEBSITE_UNTIL_TASK",
				"CONDITIONAL_WEBSITE_BLOCK",
				"BLOCK_UNTIL_DONE",
				"FOCUS_UNTIL_TASK_DONE",
			],
			descriptionCompressed:
				"Block websites until a specific todo is marked complete. Use this only when the unblock condition is finishing a task, workout, assignment, or todo, like...",
		},
		{
			name: "BLUEBUBBLES_SEND_REACTION",
			description: "Add or remove a reaction on a message via BlueBubbles",
			parameters: [],
			similes: ["BLUEBUBBLES_REACT", "BB_REACTION", "IMESSAGE_REACT"],
			descriptionCompressed:
				"Add or remove a reaction on a msg via BlueBubbles",
		},
		{
			name: "BROWSER_ACTION",
			description:
				"Control a Chromium-based browser through the local runtime. This action opens or connects to a browser session, navigates pages, clicks elements, types into forms, reads DOM state, executes JavaScript, waits for conditions, and manages tabs.\n\n",
			parameters: [],
			similes: [
				"CONTROL_BROWSER",
				"WEB_BROWSER",
				"OPEN_BROWSER",
				"BROWSE_WEB",
				"NAVIGATE_BROWSER",
				"BROWSER_CLICK",
				"BROWSER_TYPE",
			],
			descriptionCompressed:
				"Control a Chromium-based browser through the local runtime. This action opens or connects to a browser session, navigates pages, clicks elements, types into...",
		},
		{
			name: "BURN_LOGS",
			description: "Use tinderbox on logs in inventory to light a fire",
			parameters: [],
			similes: ["LIGHT_FIRE", "FIREMAKING"],
			descriptionCompressed:
				"Use tinderbox on logs in inventory to light a fire",
		},
		{
			name: "BUY_FROM_SHOP",
			description:
				"Buy an item from the currently open shop, optionally specifying a count (defaults to 1)",
			parameters: [],
			similes: ["PURCHASE_ITEM", "BUY_ITEM"],
			descriptionCompressed:
				"Buy an item from the open shop, optionally specifying a count (defaults to 1)",
		},
		{
			name: "CALL_MCP_TOOL",
			description: "Calls a tool from an MCP server to perform a specific task",
			parameters: [],
			similes: [
				"CALL_TOOL",
				"CALL_MCP_TOOL",
				"USE_TOOL",
				"USE_MCP_TOOL",
				"EXECUTE_TOOL",
				"EXECUTE_MCP_TOOL",
				"RUN_TOOL",
				"RUN_MCP_TOOL",
				"INVOKE_TOOL",
				"INVOKE_MCP_TOOL",
			],
			descriptionCompressed:
				"Calls a tool from an MCP server to perform a specific task",
		},
		{
			name: "CAST_SPELL",
			description: "Cast a spell by ID, optionally targeting an NPC",
			parameters: [],
			similes: ["USE_MAGIC", "CAST"],
			descriptionCompressed: "Cast a spell by ID, optionally targeting an NPC",
		},
		{
			name: "CHAT_PUBLIC",
			description:
				"Say something in public chat so nearby players and agents can see it. Use to narrate, socialize, or respond to operator prompts.",
			parameters: [],
			similes: ["SAY", "SPEAK", "TALK", "BROADCAST"],
			descriptionCompressed:
				"Say something in public chat so nearby players and agents can see it. Use to narrate, socialize, or respond to operator prompts.",
		},
		{
			name: "CHECK_AVAILABILITY",
			description:
				"Check whether the owner is free or busy across a specific ISO-8601 ",
			parameters: [],
			similes: ["AM_I_FREE", "AVAILABILITY_CHECK", "FREE_BUSY"],
			descriptionCompressed:
				"Check whether the owner is free or busy across a specific ISO-8601",
		},
		{
			name: "CHECK_BALANCE",
			description:
				"Check wallet balances across chains. Use this when a user asks about ",
			parameters: [],
			similes: [
				"GET_BALANCE",
				"WALLET_BALANCE",
				"CHECK_WALLET",
				"MY_BALANCE",
				"PORTFOLIO",
				"HOLDINGS",
			],
			descriptionCompressed:
				"Check wallet balances across chains. Use when a user asks about",
		},
		{
			name: "CHECK_CLOUD_CREDITS",
			description:
				"Check ElizaCloud credit balance, container costs, and estimated remaining runtime.",
			parameters: [],
			similes: [
				"check credits",
				"check balance",
				"how much credit",
				"cloud billing",
			],
			descriptionCompressed:
				"Check ElizaCloud credit balance, container costs, and estimated remaining runtime.",
		},
		{
			name: "CHECK_PAYMENT",
			description:
				"Check if payment has been received for the current reading session.",
			parameters: [],
			similes: ["VERIFY_PAYMENT", "PAYMENT_STATUS"],
			descriptionCompressed:
				"Check if payment has been received for the current reading session.",
		},
		{
			name: "CHOP_TREE",
			description:
				"Chop a nearby tree, optionally specifying the tree type (oak, willow, etc.)",
			parameters: [],
			similes: ["CUT_TREE", "WOODCUT"],
			descriptionCompressed:
				"Chop a nearby tree, optionally specifying the tree type (oak, willow, etc.)",
		},
		{
			name: "CLAUDE_CODE_WORKBENCH_LIST",
			description: "List available Claude Code workbench workflows.",
			parameters: [],
			similes: ["LIST_WORKBENCH_WORKFLOWS", "WORKBENCH_LIST", "CCW_LIST"],
			descriptionCompressed: "List available Claude Code workbench workflows.",
		},
		{
			name: "CLAUDE_CODE_WORKBENCH_RUN",
			description:
				"Run an allowlisted repo workflow through the Claude Code workbench service.",
			parameters: [],
			similes: ["RUN_WORKBENCH_WORKFLOW", "WORKBENCH_RUN", "CCW_RUN"],
			descriptionCompressed:
				"Run an allowlisted repo workflow through the Claude Code workbench service.",
		},
		{
			name: "CLEAR_GRAPH",
			description: "Clear all entities and relationships from the graph.",
			parameters: [],
			similes: ["RESET_GRAPH", "CLEAR_ALL", "DELETE_ALL"],
			descriptionCompressed:
				"Clear all entities and relationships from the graph.",
		},
		{
			name: "CLEAR_LINEAR_ACTIVITY",
			description: "Clear the Linear activity log",
			parameters: [],
			similes: [
				"clear-linear-activity",
				"reset-linear-activity",
				"delete-linear-activity",
			],
			descriptionCompressed: "Clear the Linear activity log",
		},
		{
			name: "CLOSE_BANK",
			description: "Close the bank interface",
			parameters: [],
			similes: ["EXIT_BANK"],
			descriptionCompressed: "Close the bank interface",
		},
		{
			name: "CLOSE_SHOP",
			description: "Close the shop interface",
			parameters: [],
			similes: ["EXIT_SHOP"],
			descriptionCompressed: "Close the shop interface",
		},
		{
			name: "COMMANDS_LIST",
			description:
				"List all available commands with their aliases. Only activates for /commands or /cmds slash commands.",
			parameters: [],
			similes: ["/commands", "/cmds"],
			descriptionCompressed:
				"List all available commands with their aliases. Only activates for /commands or /cmds slash commands.",
		},
		{
			name: "COMPLETE_GOAL",
			description:
				"Mark the active goal (or a specific goal id) as completed or abandoned. Use <status>completed|abandoned</status> and optional <notes>why</notes>.",
			parameters: [],
			similes: ["FINISH_GOAL", "ABANDON_GOAL", "CLOSE_GOAL"],
			descriptionCompressed:
				"Mark the active goal (or a specific goal id) as completed or abandoned. Use <status>completed|abandoned</status> and optional <notes>why</notes>.",
		},
		{
			name: "COOK_FOOD",
			description:
				"Cook raw food on a nearby fire or range, optionally specifying the food name",
			parameters: [],
			similes: ["COOK", "COOK_RAW_FOOD"],
			descriptionCompressed:
				"Cook raw food on a nearby fire or range, optionally specifying the food name",
		},
		{
			name: "COUNT_STATISTICS",
			description: "Get statistics about the current relational data graph.",
			parameters: [
				{
					name: "values",
					description: "The values to use.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["example"],
					descriptionCompressed: "The values to use.",
				},
			],
			similes: ["STATS", "STATISTICS", "COUNT"],
			exampleCalls: [
				{
					user: "Use COUNT_STATISTICS with the provided parameters.",
					actions: ["COUNT_STATISTICS"],
					params: {
						COUNT_STATISTICS: {
							values: "example",
						},
					},
				},
			],
			descriptionCompressed:
				"Get statistics about the current relational data graph.",
		},
		{
			name: "CRAFT_LEATHER",
			description:
				"Use a needle on leather in inventory to craft leather armour",
			parameters: [],
			similes: ["CRAFTING", "SEW_LEATHER"],
			descriptionCompressed:
				"Use a needle on leather in inventory to craft leather armour",
		},
		{
			name: "CREATE_ENTITY",
			description:
				"Create a new entity with a type and name. Entities are the nodes in our relational graph.",
			parameters: [
				{
					name: "values",
					description: "The values to use.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["example"],
					descriptionCompressed: "The values to use.",
				},
			],
			similes: ["NEW_ENTITY", "ADD_ENTITY", "MAKE_ENTITY"],
			exampleCalls: [
				{
					user: "Use CREATE_ENTITY with the provided parameters.",
					actions: ["CREATE_ENTITY"],
					params: {
						CREATE_ENTITY: {
							values: "example",
						},
					},
				},
			],
			descriptionCompressed:
				"Create a new entity with a type and name. Entities are the nodes in our relational graph.",
		},
		{
			name: "CREATE_LINEAR_COMMENT",
			description: "Add a comment to a Linear issue",
			parameters: [
				{
					name: "name",
					description: "The name to use.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["example"],
					descriptionCompressed: "The name to use.",
				},
			],
			similes: [
				"create-linear-comment",
				"add-linear-comment",
				"comment-on-linear-issue",
				"reply-to-linear-issue",
			],
			exampleCalls: [
				{
					user: "Use CREATE_LINEAR_COMMENT with the provided parameters.",
					actions: ["CREATE_LINEAR_COMMENT"],
					params: {
						CREATE_LINEAR_COMMENT: {
							name: "example",
						},
					},
				},
			],
			descriptionCompressed: "Add a comment to a Linear issue",
		},
		{
			name: "CREATE_LINEAR_ISSUE",
			description: "Create a new issue in Linear",
			parameters: [],
			similes: ["create-linear-issue", "new-linear-issue", "add-linear-issue"],
			descriptionCompressed: "Create a new issue in Linear",
		},
		{
			name: "CREATE_MEETING",
			description: "Create a new Google Meet meeting space",
			parameters: [],
			similes: [
				"start a meeting",
				"create a meet",
				"new meeting",
				"setup a call",
			],
			descriptionCompressed: "Create a new Google Meet meeting space",
		},
		{
			name: "CREATE_RELATIONSHIP",
			description:
				"Create a relationship between two entities. Relationships are the edges in our relational graph.",
			parameters: [
				{
					name: "values",
					description: "The values to use.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["example"],
					descriptionCompressed: "The values to use.",
				},
			],
			similes: ["LINK", "CONNECT", "RELATE"],
			exampleCalls: [
				{
					user: "Use CREATE_RELATIONSHIP with the provided parameters.",
					actions: ["CREATE_RELATIONSHIP"],
					params: {
						CREATE_RELATIONSHIP: {
							values: "example",
						},
					},
				},
			],
			descriptionCompressed:
				"Create a relationship between two entities. Relationships are the edges in our relational graph.",
		},
		{
			name: "CROSS_PLATFORM_GATEWAY",
			description:
				"Create a real cross-platform group handoff room or escalate a request back to the owner when direct user action is required. ",
			parameters: [],
			similes: [
				"GROUP_CHAT_HANDOFF",
				"CREATE_GROUP_CHAT",
				"ESCALATE_TO_USER",
				"CROSS_PLATFORM_HANDOFF",
			],
			descriptionCompressed:
				"Create a real cross-platform group handoff room or escalate a request back to the owner when direct user action is required.",
		},
		{
			name: "custom-generate-music",
			description: "Generate music with custom parameters using Suno AI",
			parameters: [],
			similes: [
				"CREATE_CUSTOM_MUSIC",
				"GENERATE_CUSTOM_AUDIO",
				"MAKE_CUSTOM_MUSIC",
				"COMPOSE_CUSTOM_MUSIC",
				"COMPOSE_MUSIC",
				"CREATE_MUSIC",
				"GENERATE_MUSIC",
			],
			descriptionCompressed: "Generate music with custom params using Suno AI",
		},
		{
			name: "DEACTIVATE_N8N_WORKFLOW",
			description:
				"Deactivate an n8n workflow to stop it from processing triggers and running automatically. Identifies workflows by ID, name, or semantic description in any language.",
			parameters: [],
			similes: [
				"DEACTIVATE_WORKFLOW",
				"DISABLE_WORKFLOW",
				"STOP_WORKFLOW",
				"PAUSE_WORKFLOW",
				"TURN_OFF_WORKFLOW",
			],
			descriptionCompressed:
				"Deactivate an n8n workflow to stop it from processing triggers and running automatically. Identifies workflows by ID, name, or semantic description in any...",
		},
		{
			name: "DEEPEN_READING",
			description:
				"Provide a deeper interpretation of a specific element in an active reading.",
			parameters: [],
			similes: [
				"EXPLAIN_MORE",
				"GO_DEEPER",
				"ELABORATE_READING",
				"READING_DETAIL",
			],
			descriptionCompressed:
				"Provide a deeper interpretation of a specific element in an active reading.",
		},
		{
			name: "DELETE_ENTITY",
			description: "Delete the current entity and all its relationships.",
			parameters: [
				{
					name: "values",
					description: "The values to use.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["example"],
					descriptionCompressed: "The values to use.",
				},
			],
			similes: ["REMOVE_ENTITY", "DESTROY_ENTITY"],
			exampleCalls: [
				{
					user: "Use DELETE_ENTITY with the provided parameters.",
					actions: ["DELETE_ENTITY"],
					params: {
						DELETE_ENTITY: {
							values: "example",
						},
					},
				},
			],
			descriptionCompressed:
				"Delete the current entity and all its relationships.",
		},
		{
			name: "DELETE_LINEAR_ISSUE",
			description: "Delete (archive) an issue in Linear",
			parameters: [],
			similes: [
				"delete-linear-issue",
				"archive-linear-issue",
				"remove-linear-issue",
				"close-linear-issue",
			],
			descriptionCompressed: "Delete (archive) an issue in Linear",
		},
		{
			name: "DELETE_MESSAGE",
			description: "Delete a message from a Discord channel",
			parameters: [],
			similes: ["REMOVE_MESSAGE", "UNSEND_MESSAGE", "DELETE_DISCORD_MESSAGE"],
			descriptionCompressed: "Delete a msg from a Discord channel",
		},
		{
			name: "DELETE_N8N_WORKFLOW",
			description:
				"Delete an n8n workflow permanently. This action cannot be undone. Identifies workflows by ID, name, or semantic description in any language.",
			parameters: [],
			similes: ["DELETE_WORKFLOW", "REMOVE_WORKFLOW", "DESTROY_WORKFLOW"],
			descriptionCompressed:
				"Delete an n8n workflow permanently. This action cannot be undone. Identifies workflows by ID, name, or semantic description in any language.",
		},
		{
			name: "DELETE_PLAYLIST",
			description:
				"Delete a saved playlist after confirmed:true. Works best in DMs to avoid flooding group chats.",
			parameters: [
				{
					name: "data",
					description: "The data to use.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["example"],
					descriptionCompressed: "The data to use.",
				},
			],
			similes: [
				"REMOVE_PLAYLIST",
				"DELETE_SAVED_PLAYLIST",
				"REMOVE_SAVED_PLAYLIST",
			],
			exampleCalls: [
				{
					user: "Use DELETE_PLAYLIST with the provided parameters.",
					actions: ["DELETE_PLAYLIST"],
					params: {
						DELETE_PLAYLIST: {
							data: "example",
						},
					},
				},
			],
			descriptionCompressed:
				"Delete a saved playlist after confirmed:true. Works best in DMs to avoid flooding group chats.",
		},
		{
			name: "DEPOSIT_ITEM",
			description:
				"Deposit an item into the bank by name, optionally specifying a count (defaults to all)",
			parameters: [],
			similes: ["BANK_ITEM", "STORE_ITEM"],
			descriptionCompressed:
				"Deposit an item into the bank by name, optionally specifying a count (defaults to all)",
		},
		{
			name: "DEXSCREENER_BOOSTED_TOKENS",
			description:
				"Get boosted (promoted/sponsored) tokens from DexScreener, showing tokens with paid promotional boosts",
			parameters: [],
			similes: ["promoted tokens", "sponsored tokens", "boosted coins"],
			descriptionCompressed:
				"Get boosted (promoted/sponsored) tokens from DexScreener, showing tokens with paid promotional boosts",
		},
		{
			name: "DEXSCREENER_CHAIN_PAIRS",
			description:
				"Get top trading pairs from a specific blockchain sorted by volume, liquidity, price change, or transaction count",
			parameters: [],
			similes: ["tokens on", "pairs on", "top on"],
			descriptionCompressed:
				"Get top trading pairs from a specific blockchain sorted by volume, liquidity, price change, or transaction count",
		},
		{
			name: "DEXSCREENER_NEW_PAIRS",
			description:
				"Get newly created trading pairs from DexScreener, showing recently launched tokens and their initial liquidity",
			parameters: [],
			similes: ["new listings", "latest pairs", "new tokens", "fresh pairs"],
			descriptionCompressed:
				"Get newly created trading pairs from DexScreener, showing recently launched tokens and their initial liquidity",
		},
		{
			name: "DEXSCREENER_SEARCH",
			description:
				"Search for tokens or trading pairs on DexScreener by name, symbol, or contract address",
			parameters: [],
			similes: ["find token", "look for", "search dexscreener"],
			descriptionCompressed:
				"Search for tokens or trading pairs on DexScreener by name, symbol, or contract address",
		},
		{
			name: "DEXSCREENER_TOKEN_INFO",
			description:
				"Get detailed information about a specific token including price, volume, liquidity, and trading pairs from DexScreener",
			parameters: [],
			similes: ["token details", "token price", "get token", "check token"],
			descriptionCompressed:
				"Get detailed info about a specific token including price, volume, liquidity, and trading pairs from DexScreener",
		},
		{
			name: "DEXSCREENER_TOKEN_PROFILES",
			description:
				"Get latest token profiles from DexScreener including social links, descriptions, and project information",
			parameters: [],
			similes: ["token profiles", "token details page"],
			descriptionCompressed:
				"Get latest token profiles from DexScreener including social links, descriptions, and project info",
		},
		{
			name: "DEXSCREENER_TRENDING",
			description:
				"Get trending tokens from DexScreener based on volume, price changes, and trading activity",
			parameters: [],
			similes: [
				"hot tokens",
				"popular coins",
				"top gainers",
				"what's trending",
			],
			descriptionCompressed:
				"Get trending tokens from DexScreener based on volume, price changes, and trading activity",
		},
		{
			name: "DOWNLOAD_MUSIC",
			description:
				"Download music to the local library without playing it. Requires confirmed:true before fetching and saving.",
			parameters: [],
			similes: [
				"FETCH_MUSIC",
				"GET_MUSIC",
				"DOWNLOAD_SONG",
				"SAVE_MUSIC",
				"GRAB_MUSIC",
			],
			descriptionCompressed:
				"Download music to the local library without playing it. Requires confirmed:true before fetching and saving.",
		},
		{
			name: "DROP_ITEM",
			description: "Drop an item from inventory by name",
			parameters: [],
			similes: ["DISCARD_ITEM", "THROW_AWAY"],
			descriptionCompressed: "Drop an item from inventory by name",
		},
		{
			name: "EAT_FOOD",
			description: "Eat the first food item found in inventory",
			parameters: [],
			similes: ["CONSUME_FOOD", "HEAL"],
			descriptionCompressed: "Eat the first food item found in inventory",
		},
		{
			name: "EDIT_MESSAGE",
			description: "Edit an existing message in a Discord channel",
			parameters: [],
			similes: [
				"UPDATE_MESSAGE",
				"MODIFY_MESSAGE",
				"CHANGE_MESSAGE",
				"EDIT_DISCORD_MESSAGE",
			],
			descriptionCompressed: "Edit an existing msg in a Discord channel",
		},
		{
			name: "EQUIP_ITEM",
			description: "Equip an item from inventory by name",
			parameters: [],
			similes: ["WEAR_ITEM", "WIELD_ITEM"],
			descriptionCompressed: "Equip an item from inventory by name",
		},
		{
			name: "EXECUTE_TRADE",
			description:
				"Execute a BSC token trade (buy or sell). Use this when a user asks to ",
			parameters: [],
			similes: ["BUY_TOKEN", "SELL_TOKEN", "SWAP", "TRADE", "BUY", "SELL"],
			descriptionCompressed:
				"Execute a BSC token trade (buy or sell). Use when a user asks to",
		},
		{
			name: "extend-audio",
			description: "Extend the duration of an existing audio generation",
			parameters: [],
			similes: [
				"LENGTHEN_AUDIO",
				"PROLONG_AUDIO",
				"INCREASE_DURATION",
				"MAKE_AUDIO_LONGER",
			],
			descriptionCompressed:
				"Extend the duration of an existing audio generation",
		},
		{
			name: "FETCH_FEED_TOP",
			description:
				"Fetch the home timeline from X and return the top-N tweets ranked by engagement (likes + retweets * 2).",
			parameters: [],
			similes: ["GET_X_FEED", "TOP_TWEETS", "FEED_TOP"],
			descriptionCompressed:
				"Fetch the home timeline from X and return the top-N tweets ranked by engagement (likes + retweets * 2).",
		},
		{
			name: "FILE_ACTION",
			description:
				"Perform local filesystem operations through the computer-use service. This includes read, write, edit, append, delete, exists, list, delete_directory, upload, download, and list_downloads actions.\n\n",
			parameters: [],
			similes: [
				"READ_FILE",
				"WRITE_FILE",
				"EDIT_FILE",
				"DELETE_FILE",
				"LIST_DIRECTORY",
				"FILE_OPERATION",
			],
			descriptionCompressed:
				"Perform local filesystem operations through the computer-use service. This includes read, write, edit, append, delete, exists, list, delete_directory...",
		},
		{
			name: "FINALIZE_WORKSPACE",
			description:
				"Finalize workspace changes by committing, pushing, and optionally creating a pull request. ",
			parameters: [
				{
					name: "codingWorkspace",
					description: "The coding workspace to use.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["example"],
					descriptionCompressed: "The coding workspace to use.",
				},
			],
			similes: [
				"COMMIT_AND_PR",
				"CREATE_PR",
				"SUBMIT_CHANGES",
				"FINISH_WORKSPACE",
			],
			exampleCalls: [
				{
					user: "Use FINALIZE_WORKSPACE with the provided parameters.",
					actions: ["FINALIZE_WORKSPACE"],
					params: {
						FINALIZE_WORKSPACE: {
							codingWorkspace: "example",
						},
					},
				},
			],
			descriptionCompressed:
				"Finalize workspace changes by committing, pushing, and optionally creating a pull request.",
		},
		{
			name: "FIND_PATH",
			description:
				"Find the shortest path between two entities in the relationship graph.",
			parameters: [
				{
					name: "values",
					description: "The values to use.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["example"],
					descriptionCompressed: "The values to use.",
				},
			],
			similes: ["PATH", "ROUTE", "CONNECTION_PATH"],
			exampleCalls: [
				{
					user: "Use FIND_PATH with the provided parameters.",
					actions: ["FIND_PATH"],
					params: {
						FIND_PATH: {
							values: "example",
						},
					},
				},
			],
			descriptionCompressed:
				"Find the shortest path between two entities in the relationship graph.",
		},
		{
			name: "FISH",
			description:
				"Fish at a nearby fishing spot, optionally specifying the spot type",
			parameters: [],
			similes: ["GO_FISHING", "CATCH_FISH"],
			descriptionCompressed:
				"Fish at a nearby fishing spot, optionally specifying the spot type",
		},
		{
			name: "FLETCH_LOGS",
			description: "Use a knife on logs in inventory to fletch them",
			parameters: [],
			similes: ["FLETCHING", "CARVE_LOGS"],
			descriptionCompressed: "Use a knife on logs in inventory to fletch them",
		},
		{
			name: "FORM_RESTORE",
			description: "Restore a previously stashed form session",
			parameters: [],
			similes: ["RESUME_FORM", "CONTINUE_FORM"],
			descriptionCompressed: "Restore a previously stashed form session",
		},
		{
			name: "FREEZE_CLOUD_AGENT",
			description:
				"Freeze a cloud agent: snapshot state, disconnect bridge, stop container.",
			parameters: [],
			similes: [
				"freeze agent",
				"hibernate agent",
				"pause agent",
				"stop cloud agent",
			],
			descriptionCompressed:
				"Freeze a cloud agent: snapshot state, disconnect bridge, stop container.",
		},
		{
			name: "GENERATE_REPORT",
			description:
				"Generate a comprehensive report from Google Meet artifacts (transcripts, recordings)",
			parameters: [],
			similes: [
				"create report",
				"meeting summary",
				"get transcript",
				"meeting notes",
			],
			descriptionCompressed:
				"Generate a comprehensive report from Google Meet artifacts (transcripts, recordings)",
		},
		{
			name: "generate-music",
			description: "Generate music using Suno AI",
			parameters: [],
			similes: [
				"CREATE_MUSIC",
				"MAKE_MUSIC",
				"COMPOSE_MUSIC",
				"GENERATE_AUDIO",
				"CREATE_SONG",
				"MAKE_SONG",
			],
			descriptionCompressed: "Generate music using Suno AI",
		},
		{
			name: "GET_ACTIVITY_REPORT",
			description:
				"Per-app time breakdown for the last N hours (default 24h). Returns noDataReason='macos-only' on non-Darwin platforms.",
			parameters: [],
			similes: [
				"ACTIVITY_REPORT",
				"WHAT_DID_I_WORK_ON",
				"TIME_TRACKING_REPORT",
			],
			descriptionCompressed:
				"Per-app time breakdown for the last N hours (default 24h). Returns noDataReason='macos-only' on non-Darwin platforms.",
		},
		{
			name: "GET_APP_BLOCK_STATUS",
			description:
				"Owner-only. Check whether an app block is currently active and when it ends.",
			parameters: [],
			similes: [
				"CHECK_APP_BLOCK_STATUS",
				"IS_APP_BLOCK_RUNNING",
				"APP_BLOCK_STATUS",
			],
			descriptionCompressed:
				"Owner-only. Check whether an app block is active and when it ends.",
		},
		{
			name: "GET_LINEAR_ACTIVITY",
			description: "Get recent Linear activity log with optional filters",
			parameters: [],
			similes: [
				"get-linear-activity",
				"show-linear-activity",
				"view-linear-activity",
				"check-linear-activity",
			],
			descriptionCompressed:
				"Get recent Linear activity log with optional filters",
		},
		{
			name: "GET_LINEAR_ISSUE",
			description: "Get details of a specific Linear issue",
			parameters: [
				{
					name: "name",
					description: "The name to use.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["example"],
					descriptionCompressed: "The name to use.",
				},
			],
			similes: [
				"get-linear-issue",
				"show-linear-issue",
				"view-linear-issue",
				"check-linear-issue",
				"find-linear-issue",
			],
			exampleCalls: [
				{
					user: "Use GET_LINEAR_ISSUE with the provided parameters.",
					actions: ["GET_LINEAR_ISSUE"],
					params: {
						GET_LINEAR_ISSUE: {
							name: "example",
						},
					},
				},
			],
			descriptionCompressed: "Get details of a specific Linear issue",
		},
		{
			name: "GET_MEETING_INFO",
			description: "Get information about a Google Meet meeting",
			parameters: [],
			similes: [
				"meeting info",
				"check meeting",
				"meeting status",
				"meeting details",
			],
			descriptionCompressed: "Get info about a Google Meet meeting",
		},
		{
			name: "GET_N8N_EXECUTIONS",
			description:
				"Get execution history for an n8n workflow. Shows status, start time, and error messages if any. Identifies workflows by ID, name, or semantic description in any language.",
			parameters: [],
			similes: [
				"GET_EXECUTIONS",
				"SHOW_EXECUTIONS",
				"EXECUTION_HISTORY",
				"WORKFLOW_RUNS",
				"WORKFLOW_EXECUTIONS",
			],
			descriptionCompressed:
				"Get execution history for an n8n workflow. Shows status, start time, and error msgs if any. Identifies workflows by ID, name, or semantic description in any...",
		},
		{
			name: "GET_PARTICIPANTS",
			description: "Get the list of participants in a Google Meet conference",
			parameters: [],
			similes: [
				"who's in the meeting",
				"list participants",
				"attendees",
				"who joined",
			],
			descriptionCompressed:
				"Get the list of participants in a Google Meet conference",
		},
		{
			name: "GET_RECEIVE_ADDRESS",
			description:
				"Return wallet receive addresses by chain. Use this when a user asks ",
			parameters: [],
			similes: [
				"RECEIVE_ADDRESS",
				"DEPOSIT_ADDRESS",
				"WALLET_ADDRESS",
				"MY_ADDRESS",
				"SHOW_ADDRESS",
			],
			descriptionCompressed:
				"Return wallet receive addresses by chain. Use when a user asks",
		},
		{
			name: "GET_SKILL_DETAILS",
			description:
				"Get detailed information about a specific skill including version, owner, and stats.",
			parameters: [],
			similes: ["SKILL_INFO", "SKILL_DETAILS"],
			descriptionCompressed:
				"Get detailed info about a specific skill including version, owner, and stats.",
		},
		{
			name: "GET_TAILSCALE_STATUS",
			description: "Get the current status of the Tailscale tunnel",
			parameters: [],
			similes: ["TAILSCALE_STATUS", "CHECK_TUNNEL", "TUNNEL_INFO"],
			descriptionCompressed: "Get the current status of the Tailscale tunnel",
		},
		{
			name: "GET_TIME_ON_APP",
			description:
				"Time spent on a specific app (matched by app name or bundle id) over the last N hours.",
			parameters: [],
			similes: ["TIME_IN_APP", "HOW_LONG_IN_APP"],
			descriptionCompressed:
				"Time spent on a specific app (matched by app name or bundle id) over the last N hours.",
		},
		{
			name: "GET_TIME_ON_SITE",
			description:
				"Time on a specific site based on browser activity reports pushed into the runtime store.",
			parameters: [],
			similes: ["TIME_ON_WEBSITE", "TIME_ON_DOMAIN"],
			descriptionCompressed:
				"Time on a specific site based on browser activity reports pushed into the runtime store.",
		},
		{
			name: "GET_WEBSITE_BLOCK_STATUS",
			description:
				"Owner-only. Check whether a local hosts-file website block is currently active and when it ends.",
			parameters: [],
			similes: [
				"SELFCONTROL_GET_BLOCK_STATUS",
				"CHECK_WEBSITE_BLOCK_STATUS",
				"CHECK_SELFCONTROL",
				"IS_BLOCK_RUNNING",
			],
			descriptionCompressed:
				"Owner-only. Check whether a local hosts-file website block is active and when it ends.",
		},
		{
			name: "GOOGLE_CHAT_LIST_SPACES",
			description: "List all Google Chat spaces the bot is a member of",
			parameters: [],
			similes: [
				"LIST_GOOGLE_CHAT_SPACES",
				"GCHAT_SPACES",
				"SHOW_GOOGLE_CHAT_SPACES",
			],
			descriptionCompressed:
				"List all Google Chat spaces the bot is a member of",
		},
		{
			name: "GOOGLE_CHAT_SEND_MESSAGE",
			description: "Send a message to a Google Chat space",
			parameters: [],
			similes: [
				"SEND_GOOGLE_CHAT_MESSAGE",
				"MESSAGE_GOOGLE_CHAT",
				"GCHAT_SEND",
				"GOOGLE_CHAT_TEXT",
			],
			descriptionCompressed: "Send a msg to a Google Chat space",
		},
		{
			name: "GOOGLE_CHAT_SEND_REACTION",
			description: "Add or remove an emoji reaction to a Google Chat message",
			parameters: [],
			similes: [
				"REACT_GOOGLE_CHAT",
				"GCHAT_REACT",
				"GOOGLE_CHAT_EMOJI",
				"ADD_GOOGLE_CHAT_REACTION",
			],
			descriptionCompressed:
				"Add or remove an emoji reaction to a Google Chat msg",
		},
		{
			name: "HEALTH",
			description:
				"Query health and fitness telemetry from HealthKit, Google Fit, Strava, Fitbit, Withings, or Oura — sleep ",
			parameters: [],
			similes: [
				"FITNESS",
				"HEALTHKIT",
				"GOOGLE_FIT",
				"STRAVA",
				"FITBIT",
				"WITHINGS",
				"OURA",
				"WELLNESS",
				"SLEEP",
				"SLEEP_DATA",
				"SLEEP_STATS",
				"STEPS",
				"STEP_COUNT",
				"HEART_RATE",
				"WORKOUT",
				"EXERCISE",
				"CALORIES",
				"ACTIVITY_METRICS",
			],
			descriptionCompressed:
				"Query health and fitness telemetry from HealthKit, Google Fit, Strava, Fitbit, Withings, or Oura - sleep",
		},
		{
			name: "HELP_COMMAND",
			description:
				"Show available commands and their descriptions. Only activates for /help, /h, or /? slash commands.",
			parameters: [],
			similes: ["/help", "/h", "/?"],
			descriptionCompressed:
				"Show available commands and their descriptions. Only activates for /help, /h, or /? slash commands.",
		},
		{
			name: "ICHING_READING",
			description:
				"Perform an I Ching divination reading by casting a hexagram and interpreting changing lines.",
			parameters: [],
			similes: [
				"CAST_HEXAGRAM",
				"CONSULT_ICHING",
				"THROW_COINS",
				"ORACLE_READING",
			],
			descriptionCompressed:
				"Perform an I Ching divination reading by casting a hexagram and interpreting changing lines.",
		},
		{
			name: "IMESSAGE_SEND_MESSAGE",
			description: "Send a text message via iMessage (macOS only)",
			parameters: [],
			similes: ["SEND_IMESSAGE", "IMESSAGE_TEXT", "TEXT_IMESSAGE", "SEND_IMSG"],
			descriptionCompressed: "Send a text msg via iMessage (macOS only)",
		},
		{
			name: "INBOX_TRIAGE_GMAIL",
			description:
				"Compatibility-only Gmail triage shim. Delegates to the cross-platform TRIAGE_MESSAGES action with sources=['gmail']; new planner-facing inbox/email routing should use OWNER_INBOX instead.",
			parameters: [],
			similes: ["TRIAGE_GMAIL", "GMAIL_TRIAGE", "CHECK_GMAIL"],
			descriptionCompressed:
				"Compatibility-only Gmail triage shim. Delegates to the cross-platform TRIAGE_MESSAGES action with sources=['gmail']. new planner-facing inbox/email routing...",
		},
		{
			name: "INSTALL_SKILL",
			description:
				"Install a skill from the ClawHub registry. The skill will be security-scanned before activation. ",
			parameters: [],
			similes: ["DOWNLOAD_SKILL", "ADD_SKILL", "GET_SKILL"],
			descriptionCompressed:
				"Install a skill from the ClawHub registry. The skill will be security-scanned before activation.",
		},
		{
			name: "INTERACT_OBJECT",
			description:
				"Interact with a world object by name, with an optional interaction option",
			parameters: [],
			similes: ["USE_OBJECT", "CLICK_OBJECT"],
			descriptionCompressed:
				"Interact with a world object by name, with optional interaction option",
		},
		{
			name: "LINE_SEND_FLEX_MESSAGE",
			description: "Send a rich flex message/card via LINE",
			parameters: [],
			similes: ["SEND_LINE_CARD", "LINE_FLEX", "LINE_CARD", "SEND_LINE_FLEX"],
			descriptionCompressed: "Send a rich flex msg/card via LINE",
		},
		{
			name: "LINE_SEND_LOCATION",
			description: "Send a location message via LINE",
			parameters: [],
			similes: [
				"SEND_LINE_LOCATION",
				"LINE_LOCATION",
				"LINE_MAP",
				"SHARE_LOCATION_LINE",
			],
			descriptionCompressed: "Send a location msg via LINE",
		},
		{
			name: "LINE_SEND_MESSAGE",
			description: "Send a text message via LINE",
			parameters: [],
			similes: [
				"SEND_LINE_MESSAGE",
				"LINE_MESSAGE",
				"LINE_TEXT",
				"MESSAGE_LINE",
			],
			descriptionCompressed: "Send a text msg via LINE",
		},
		{
			name: "LIST_ACTIVE_BLOCKS",
			description:
				"List the live website blocker status and any active managed website block rules, including their gate type and gate target. Only use this for website/app blocking status. Do not use it for inbox blockers, message priority, morning briefs, night briefs, operating pictures, end-of-day reviews, or general executive-assistant triage.",
			parameters: [],
			similes: [
				"LIST_BLOCK_RULES",
				"SHOW_ACTIVE_BLOCKS",
				"WEBSITE_BLOCKS_STATUS",
			],
			descriptionCompressed:
				"List the live website blocker status and any active managed website block rules, including their gate type and gate target. Only use this for website/app...",
		},
		{
			name: "LIST_AGENTS",
			description:
				"List active task agents together with current task progress so the main agent can keep the user updated while work continues asynchronously.",
			parameters: [],
			similes: [
				"LIST_CODING_AGENTS",
				"SHOW_CODING_AGENTS",
				"GET_ACTIVE_AGENTS",
				"LIST_SESSIONS",
				"SHOW_CODING_SESSIONS",
				"SHOW_TASK_AGENTS",
				"LIST_SUB_AGENTS",
				"SHOW_TASK_STATUS",
			],
			descriptionCompressed:
				"List active task agents together with current task progress so the main agent can keep user updated while work continues asynchronously.",
		},
		{
			name: "LIST_AUTOFILL_WHITELIST",
			description:
				"List effective autofill whitelist entries: the bundled defaults plus user-added entries.",
			parameters: [],
			similes: ["SHOW_AUTOFILL_WHITELIST", "GET_AUTOFILL_WHITELIST"],
			descriptionCompressed:
				"List effective autofill whitelist entries: the bundled defaults plus user-added entries.",
		},
		{
			name: "LIST_LINEAR_PROJECTS",
			description: "List projects in Linear with optional filters",
			parameters: [
				{
					name: "toLowerCase",
					description: "The to lower case to use.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["example"],
					descriptionCompressed: "The to lower case to use.",
				},
			],
			similes: [
				"list-linear-projects",
				"show-linear-projects",
				"get-linear-projects",
				"view-linear-projects",
			],
			exampleCalls: [
				{
					user: "Use LIST_LINEAR_PROJECTS with the provided parameters.",
					actions: ["LIST_LINEAR_PROJECTS"],
					params: {
						LIST_LINEAR_PROJECTS: {
							toLowerCase: "example",
						},
					},
				},
			],
			descriptionCompressed: "List projects in Linear with optional filters",
		},
		{
			name: "LIST_LINEAR_TEAMS",
			description: "List teams in Linear with optional filters",
			parameters: [],
			similes: [
				"list-linear-teams",
				"show-linear-teams",
				"get-linear-teams",
				"view-linear-teams",
			],
			descriptionCompressed: "List teams in Linear with optional filters",
		},
		{
			name: "LIST_OVERDUE_FOLLOWUPS",
			description:
				"List contacts whose last-contacted-at timestamp exceeds their follow-up threshold. ",
			parameters: [],
			similes: [
				"OVERDUE_FOLLOWUPS",
				"WHO_TO_FOLLOW_UP",
				"WHO_HAVEN_T_I_TALKED_TO",
				"LIST_FOLLOWUPS",
				"FOLLOWUP_LIST",
			],
			descriptionCompressed:
				"List contacts whose last-contacted-at timestamp exceeds their follow-up threshold.",
		},
		{
			name: "LIST_PLAYLISTS",
			description:
				"List all saved playlists for the user. Works best in DMs to avoid flooding group chats.",
			parameters: [
				{
					name: "data",
					description: "The data to use.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["example"],
					descriptionCompressed: "The data to use.",
				},
			],
			similes: [
				"SHOW_PLAYLISTS",
				"MY_PLAYLISTS",
				"PLAYLIST_LIST",
				"VIEW_PLAYLISTS",
			],
			exampleCalls: [
				{
					user: "Use LIST_PLAYLISTS with the provided parameters.",
					actions: ["LIST_PLAYLISTS"],
					params: {
						LIST_PLAYLISTS: {
							data: "example",
						},
					},
				},
			],
			descriptionCompressed:
				"List all saved playlists for user. Works best in DMs to avoid flooding group chats.",
		},
		{
			name: "LOAD_PLAYLIST",
			description:
				"Load a saved playlist and add all tracks to the queue after confirmed:true. Works best in DMs to avoid flooding group chats.",
			parameters: [
				{
					name: "data",
					description: "The data to use.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["example"],
					descriptionCompressed: "The data to use.",
				},
			],
			similes: [
				"PLAY_PLAYLIST",
				"LOAD_QUEUE",
				"RESTORE_PLAYLIST",
				"PLAY_SAVED_PLAYLIST",
			],
			exampleCalls: [
				{
					user: "Use LOAD_PLAYLIST with the provided parameters.",
					actions: ["LOAD_PLAYLIST"],
					params: {
						LOAD_PLAYLIST: {
							data: "example",
						},
					},
				},
			],
			descriptionCompressed:
				"Load a saved playlist and add all tracks to the queue after confirmed:true. Works best in DMs to avoid flooding group chats.",
		},
		{
			name: "lp_management",
			description:
				"Manages Liquidity Pool (LP) operations including: onboarding for LP management, depositing tokens into pools, withdrawing from pools, showing LP positions, concentrated liquidity positions with custom price ranges, checking APR/yield, setting auto-rebalance preferences, and finding best pools. Use this action when users mention: liquidity, LP, pools, APR, yield, deposit, withdraw, concentrated, price range, narrow range, degenai, ai16z, SOL pairs, or want help getting started with LP management.",
			parameters: [],
			similes: [
				"LP_MANAGEMENT",
				"LIQUIDITY_POOL_MANAGEMENT",
				"LP_MANAGER",
				"MANAGE_LP",
				"MANAGE_LIQUIDITY",
			],
			descriptionCompressed:
				"Manages Liquidity Pool (LP) operations including: onboarding for LP management, depositing tokens into pools, withdrawing from pools, showing LP positions...",
		},
		{
			name: "MANAGE_ISSUES",
			description: "Manage GitHub issues for a repository. ",
			parameters: [],
			similes: [
				"CREATE_ISSUE",
				"LIST_ISSUES",
				"CLOSE_ISSUE",
				"COMMENT_ISSUE",
				"UPDATE_ISSUE",
				"GET_ISSUE",
			],
			descriptionCompressed: "Manage GitHub issues for a repository.",
		},
		{
			name: "manage_raydium_positions",
			description:
				"Automatically manage Raydium positions by rebalancing them when they drift too far from the pool price",
			parameters: [],
			similes: [
				"AUTOMATE_RAYDIUM_REBALANCING",
				"AUTOMATE_RAYDIUM_POSITIONS",
				"START_MANAGING_RAYDIUM_POSITIONS",
			],
			descriptionCompressed:
				"Auto manage Raydium positions by rebalancing them when they drift too far from the pool price",
		},
		{
			name: "MANAGE_SHOPIFY_CUSTOMERS",
			description: "List and search customers in a connected Shopify store.",
			parameters: [],
			similes: ["LIST_CUSTOMERS", "FIND_CUSTOMER", "SEARCH_CUSTOMERS"],
			descriptionCompressed:
				"List and search customers in a connected Shopify store.",
		},
		{
			name: "MANAGE_SHOPIFY_INVENTORY",
			description:
				"Check inventory levels and list store locations. Stock adjustments require confirmed:true.",
			parameters: [],
			similes: [
				"CHECK_INVENTORY",
				"ADJUST_INVENTORY",
				"CHECK_STOCK",
				"UPDATE_STOCK",
			],
			descriptionCompressed:
				"Check inventory levels and list store locations. Stock adjustments require confirmed:true.",
		},
		{
			name: "MANAGE_SHOPIFY_ORDERS",
			description:
				"List recent orders and check order status. Fulfillment requires confirmed:true.",
			parameters: [],
			similes: ["LIST_ORDERS", "CHECK_ORDERS", "FULFILL_ORDER", "ORDER_STATUS"],
			descriptionCompressed:
				"List recent orders and check order status. Fulfillment requires confirmed:true.",
		},
		{
			name: "MANAGE_SHOPIFY_PRODUCTS",
			description:
				"List and search Shopify products. Product creation and updates require confirmed:true.",
			parameters: [],
			similes: [
				"LIST_PRODUCTS",
				"CREATE_PRODUCT",
				"UPDATE_PRODUCT",
				"SEARCH_PRODUCTS",
			],
			descriptionCompressed:
				"List and search Shopify products. Product creation and updates require confirmed:true.",
		},
		{
			name: "MANAGE_WINDOW",
			description:
				"Manage desktop windows — list all visible windows, bring a window to the front, ",
			parameters: [],
			similes: [
				"LIST_WINDOWS",
				"FOCUS_WINDOW",
				"SWITCH_WINDOW",
				"ARRANGE_WINDOWS",
				"MOVE_WINDOW",
				"MINIMIZE_WINDOW",
				"MAXIMIZE_WINDOW",
				"CLOSE_WINDOW",
				"WINDOW_MANAGEMENT",
			],
			descriptionCompressed:
				"Manage desktop windows - list all visible windows, bring a window to the front,",
		},
		{
			name: "MARK_FOLLOWUP_DONE",
			description:
				"Mark a contact as already followed-up-with (updates lastContactedAt to now). ",
			parameters: [],
			similes: [
				"FOLLOWED_UP",
				"FOLLOWUP_DONE",
				"CONTACTED",
				"MARK_CONTACTED",
				"RECORD_INTERACTION",
			],
			descriptionCompressed:
				"Mark a contact as already followed-up-with (updates lastContactedAt to now).",
		},
		{
			name: "MATH_CLEAR",
			description: "Clear all calculation buffers and reset to zero.",
			parameters: [],
			similes: ["CLEAR", "RESET", "CLEAR_ALL"],
			descriptionCompressed: "Clear all calculation buffers and reset to zero.",
		},
		{
			name: "MATH_RECALL",
			description: "Recall value from memory to input buffer.",
			parameters: [
				{
					name: "values",
					description: "The values to use.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["example"],
					descriptionCompressed: "The values to use.",
				},
			],
			similes: ["RECALL", "LOAD", "MEMORY_RECALL"],
			exampleCalls: [
				{
					user: "Use MATH_RECALL with the provided parameters.",
					actions: ["MATH_RECALL"],
					params: {
						MATH_RECALL: {
							values: "example",
						},
					},
				},
			],
			descriptionCompressed: "Recall value from memory to input buffer.",
		},
		{
			name: "MATH_STORE",
			description: "Store current accumulator value to memory.",
			parameters: [
				{
					name: "values",
					description: "The values to use.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["example"],
					descriptionCompressed: "The values to use.",
				},
			],
			similes: ["STORE", "SAVE", "MEMORY_STORE"],
			exampleCalls: [
				{
					user: "Use MATH_STORE with the provided parameters.",
					actions: ["MATH_STORE"],
					params: {
						MATH_STORE: {
							values: "example",
						},
					},
				},
			],
			descriptionCompressed: "Store current accumulator value to memory.",
		},
		{
			name: "MATRIX_JOIN_ROOM",
			description: "Join a Matrix room by ID or alias",
			parameters: [],
			similes: ["JOIN_MATRIX_ROOM", "ENTER_ROOM"],
			descriptionCompressed: "Join a Matrix room by ID or alias",
		},
		{
			name: "MATRIX_LIST_ROOMS",
			description: "List all Matrix rooms the bot has joined",
			parameters: [],
			similes: ["LIST_MATRIX_ROOMS", "SHOW_ROOMS", "GET_ROOMS", "MY_ROOMS"],
			descriptionCompressed: "List all Matrix rooms the bot has joined",
		},
		{
			name: "MATRIX_SEND_MESSAGE",
			description: "Send a message to a Matrix room",
			parameters: [
				{
					name: "data",
					description: "The data to use.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["example"],
					descriptionCompressed: "The data to use.",
				},
			],
			similes: ["SEND_MATRIX_MESSAGE", "MESSAGE_MATRIX", "MATRIX_TEXT"],
			exampleCalls: [
				{
					user: "Use MATRIX_SEND_MESSAGE with the provided parameters.",
					actions: ["MATRIX_SEND_MESSAGE"],
					params: {
						MATRIX_SEND_MESSAGE: {
							data: "example",
						},
					},
				},
			],
			descriptionCompressed: "Send a msg to a Matrix room",
		},
		{
			name: "MATRIX_SEND_REACTION",
			description: "React to a Matrix message with an emoji",
			parameters: [
				{
					name: "data",
					description: "The data to use.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["example"],
					descriptionCompressed: "The data to use.",
				},
			],
			similes: ["REACT_MATRIX", "MATRIX_REACT", "ADD_MATRIX_REACTION"],
			exampleCalls: [
				{
					user: "Use MATRIX_SEND_REACTION with the provided parameters.",
					actions: ["MATRIX_SEND_REACTION"],
					params: {
						MATRIX_SEND_REACTION: {
							data: "example",
						},
					},
				},
			],
			descriptionCompressed: "React to a Matrix msg with an emoji",
		},
		{
			name: "MC_ATTACK",
			description:
				"Attack an entity by numeric entityId (from MC_WORLD_STATE.nearbyEntities).",
			parameters: [],
			similes: ["MINECRAFT_ATTACK", "HIT_ENTITY"],
			descriptionCompressed:
				"Attack an entity by numeric entityId (from MC_WORLD_STATE. nearbyEntities).",
		},
		{
			name: "MC_CHAT",
			description: "Send a chat message in Minecraft as the bot",
			parameters: [],
			similes: ["MINECRAFT_CHAT", "SAY_IN_MINECRAFT", "CHAT"],
			descriptionCompressed: "Send a chat msg in Minecraft as the bot",
		},
		{
			name: "MC_CONNECT",
			description: "Connect the Mineflayer bot to a Minecraft server",
			parameters: [],
			similes: ["MINECRAFT_CONNECT", "JOIN_SERVER", "CONNECT_TO_MINECRAFT"],
			descriptionCompressed: "Connect the Mineflayer bot to a Minecraft server",
		},
		{
			name: "MC_CONTROL",
			description:
				"Set a control state (e.g. forward/back/left/right/jump/sprint/sneak). Provide JSON {control,state,durationMs?} or 'forward true 1000'.",
			parameters: [],
			similes: ["MINECRAFT_CONTROL", "SET_CONTROL_STATE"],
			descriptionCompressed:
				"Set a control state (e. g. forward/back/left/right/jump/sprint/sneak). Provide JSON {control, state, durationMs?} or 'forward true 1000'.",
		},
		{
			name: "MC_DIG",
			description:
				'Dig/break the block at (x y z). Provide coordinates like \'10 64 -20\' or JSON {"x":10,"y":64,"z":-20}.',
			parameters: [],
			similes: ["MINECRAFT_DIG", "MINE_BLOCK", "BREAK_BLOCK"],
			descriptionCompressed:
				'Dig/break the block at (x y z). Provide coordinates like \'10 64 -20\' or JSON {"x":10, "y":64, "z":-20}.',
		},
		{
			name: "MC_DISCONNECT",
			description: "Disconnect the Mineflayer bot from the Minecraft server",
			parameters: [],
			similes: ["MINECRAFT_DISCONNECT", "LEAVE_SERVER", "QUIT_MINECRAFT"],
			descriptionCompressed:
				"Disconnect the Mineflayer bot from the Minecraft server",
		},
		{
			name: "MC_GOTO",
			description:
				'Pathfind to a target (x y z). Provide coordinates like \'10 64 -20\' or JSON {"x":10,"y":64,"z":-20}.',
			parameters: [],
			similes: ["MINECRAFT_GOTO", "WALK_TO", "MOVE_TO_COORDS"],
			descriptionCompressed:
				'Pathfind to a target (x y z). Provide coordinates like \'10 64 -20\' or JSON {"x":10, "y":64, "z":-20}.',
		},
		{
			name: "MC_LOOK",
			description:
				"Look to yaw/pitch (radians). Provide 'yaw pitch' or JSON {yaw,pitch}.",
			parameters: [],
			similes: ["MINECRAFT_LOOK", "TURN_HEAD"],
			descriptionCompressed:
				"Look to yaw/pitch (radians). Provide 'yaw pitch' or JSON {yaw, pitch}.",
		},
		{
			name: "MC_PLACE",
			description:
				"Place the currently-held block onto a reference block face. Provide 'x y z face' (face=up/down/north/south/east/west) or JSON {x,y,z,face}.",
			parameters: [],
			similes: ["MINECRAFT_PLACE", "PLACE_BLOCK"],
			descriptionCompressed:
				"Place the -held block onto a reference block face. Provide 'x y z face' (face=up/down/north/south/east/west) or JSON {x, y, z, face}.",
		},
		{
			name: "MC_SCAN",
			description:
				'Scan nearby blocks. Optional JSON input: {"blocks":["oak_log"],"radius":16,"maxResults":32}. If omitted, scans for any non-air blocks.',
			parameters: [],
			similes: ["MINECRAFT_SCAN", "FIND_BLOCKS", "SCAN_BLOCKS"],
			descriptionCompressed:
				'Scan nearby blocks. Optional JSON input: {"blocks":["oak_log"], "radius":16, "maxResults":32}. If omitted, scans for any non-air blocks.',
		},
		{
			name: "MC_STOP",
			description: "Stop pathfinding / movement goals.",
			parameters: [],
			similes: ["MINECRAFT_STOP", "STOP_PATHFINDER", "STOP_MOVING"],
			descriptionCompressed: "Stop pathfinding/movement goals.",
		},
		{
			name: "MC_WAYPOINT_DELETE",
			description: "Delete a named waypoint (message text is the name).",
			parameters: [],
			similes: [
				"MINECRAFT_WAYPOINT_DELETE",
				"DELETE_WAYPOINT",
				"REMOVE_WAYPOINT",
			],
			descriptionCompressed: "Delete a named waypoint (msg text is the name).",
		},
		{
			name: "MC_WAYPOINT_GOTO",
			description: "Pathfind to a named waypoint (message text is the name).",
			parameters: [],
			similes: [
				"MINECRAFT_WAYPOINT_GOTO",
				"GOTO_WAYPOINT",
				"NAVIGATE_WAYPOINT",
			],
			descriptionCompressed:
				"Pathfind to a named waypoint (msg text is the name).",
		},
		{
			name: "MC_WAYPOINT_LIST",
			description: "List saved waypoints.",
			parameters: [],
			similes: ["MINECRAFT_WAYPOINT_LIST", "LIST_WAYPOINTS", "SHOW_WAYPOINTS"],
			descriptionCompressed: "List saved waypoints.",
		},
		{
			name: "MC_WAYPOINT_SET",
			description:
				"Save the bot's current position as a named waypoint (message text is the name).",
			parameters: [],
			similes: ["MINECRAFT_WAYPOINT_SET", "SET_WAYPOINT", "SAVE_WAYPOINT"],
			descriptionCompressed:
				"Save the bot's current position as a named waypoint (msg text is the name).",
		},
		{
			name: "MINE_ROCK",
			description:
				"Mine a nearby rock, optionally specifying the ore type (copper, tin, iron, etc.)",
			parameters: [],
			similes: ["MINE_ORE", "MINE"],
			descriptionCompressed:
				"Mine a nearby rock, optionally specifying the ore type (copper, tin, iron, etc.)",
		},
		{
			name: "MODELS_COMMAND",
			description:
				"List available AI models and providers. Only activates for /models slash command.",
			parameters: [],
			similes: ["/models"],
			descriptionCompressed:
				"List available AI models and providers. Only activates for /models slash command.",
		},
		{
			name: "MODIFY_EXISTING_N8N_WORKFLOW",
			description: "Load an existing deployed n8n workflow for modification. ",
			parameters: [],
			similes: [
				"EDIT_EXISTING_WORKFLOW",
				"UPDATE_EXISTING_WORKFLOW",
				"CHANGE_EXISTING_WORKFLOW",
				"LOAD_WORKFLOW_FOR_EDIT",
			],
			descriptionCompressed:
				"Load an existing deployed n8n workflow for modification.",
		},
		{
			name: "MULTIVERSE_ADD",
			description:
				"Performs addition in the multiverse where numbers behave differently based on dimensional constants (prime, quantum, or chaos).",
			parameters: [
				{
					name: "values",
					description: "The values to use.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["example"],
					descriptionCompressed: "The values to use.",
				},
			],
			similes: ["M_ADD", "MULTI_ADD", "DIMENSIONAL_ADD"],
			exampleCalls: [
				{
					user: "Use MULTIVERSE_ADD with the provided parameters.",
					actions: ["MULTIVERSE_ADD"],
					params: {
						MULTIVERSE_ADD: {
							values: "example",
						},
					},
				},
			],
			descriptionCompressed:
				"Performs addition in the multiverse where numbers behave differently based on dimensional constants (prime, quantum, or chaos).",
		},
		{
			name: "MULTIVERSE_DIVIDE",
			description:
				"Performs division in the multiverse where infinity and zero have special meanings (safe, infinite, or golden).",
			parameters: [
				{
					name: "values",
					description: "The values to use.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["example"],
					descriptionCompressed: "The values to use.",
				},
			],
			similes: ["M_DIVIDE", "MULTI_DIV", "DIMENSIONAL_DIVIDE"],
			exampleCalls: [
				{
					user: "Use MULTIVERSE_DIVIDE with the provided parameters.",
					actions: ["MULTIVERSE_DIVIDE"],
					params: {
						MULTIVERSE_DIVIDE: {
							values: "example",
						},
					},
				},
			],
			descriptionCompressed:
				"Performs division in the multiverse where infinity and zero have special meanings (safe, infinite, or golden).",
		},
		{
			name: "MULTIVERSE_MODULO",
			description:
				"Performs modulo operation in the multiverse with cyclical dimensional properties (cyclical, spiral, or fractal).",
			parameters: [
				{
					name: "values",
					description: "The values to use.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["example"],
					descriptionCompressed: "The values to use.",
				},
			],
			similes: ["M_MODULO", "MULTI_MOD", "DIMENSIONAL_MODULO"],
			exampleCalls: [
				{
					user: "Use MULTIVERSE_MODULO with the provided parameters.",
					actions: ["MULTIVERSE_MODULO"],
					params: {
						MULTIVERSE_MODULO: {
							values: "example",
						},
					},
				},
			],
			descriptionCompressed:
				"Performs modulo operation in the multiverse with cyclical dimensional properties (cyclical, spiral, or fractal).",
		},
		{
			name: "MULTIVERSE_MULTIPLY",
			description:
				"Performs multiplication across dimensional boundaries with exotic number behaviors (fibonacci, exponential, or harmonic).",
			parameters: [
				{
					name: "values",
					description: "The values to use.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["example"],
					descriptionCompressed: "The values to use.",
				},
			],
			similes: ["M_MULTIPLY", "MULTI_MUL", "DIMENSIONAL_MULTIPLY"],
			exampleCalls: [
				{
					user: "Use MULTIVERSE_MULTIPLY with the provided parameters.",
					actions: ["MULTIVERSE_MULTIPLY"],
					params: {
						MULTIVERSE_MULTIPLY: {
							values: "example",
						},
					},
				},
			],
			descriptionCompressed:
				"Performs multiplication across dimensional boundaries with exotic number behaviors (fibonacci, exponential, or harmonic).",
		},
		{
			name: "MULTIVERSE_POWER",
			description:
				"Raises numbers to powers in the multiverse with dimensional effects (standard, imaginary, or recursive).",
			parameters: [
				{
					name: "values",
					description: "The values to use.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["example"],
					descriptionCompressed: "The values to use.",
				},
			],
			similes: ["M_POWER", "MULTI_POW", "DIMENSIONAL_POWER"],
			exampleCalls: [
				{
					user: "Use MULTIVERSE_POWER with the provided parameters.",
					actions: ["MULTIVERSE_POWER"],
					params: {
						MULTIVERSE_POWER: {
							values: "example",
						},
					},
				},
			],
			descriptionCompressed:
				"Raises numbers to powers in the multiverse with dimensional effects (standard, imaginary, or recursive).",
		},
		{
			name: "MULTIVERSE_SQRT",
			description:
				"Takes square root in the multiverse with dimensional variations (positive, complex, or quantum).",
			parameters: [
				{
					name: "values",
					description: "The values to use.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["example"],
					descriptionCompressed: "The values to use.",
				},
			],
			similes: ["M_SQRT", "MULTI_ROOT", "DIMENSIONAL_SQRT"],
			exampleCalls: [
				{
					user: "Use MULTIVERSE_SQRT with the provided parameters.",
					actions: ["MULTIVERSE_SQRT"],
					params: {
						MULTIVERSE_SQRT: {
							values: "example",
						},
					},
				},
			],
			descriptionCompressed:
				"Takes square root in the multiverse with dimensional variations (positive, complex, or quantum).",
		},
		{
			name: "MULTIVERSE_SUBTRACT",
			description:
				"Performs subtraction in the multiverse where negative numbers might not exist in some dimensions (absolute, mirror, or void).",
			parameters: [
				{
					name: "values",
					description: "The values to use.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["example"],
					descriptionCompressed: "The values to use.",
				},
			],
			similes: ["M_SUBTRACT", "MULTI_SUB", "DIMENSIONAL_SUBTRACT"],
			exampleCalls: [
				{
					user: "Use MULTIVERSE_SUBTRACT with the provided parameters.",
					actions: ["MULTIVERSE_SUBTRACT"],
					params: {
						MULTIVERSE_SUBTRACT: {
							values: "example",
						},
					},
				},
			],
			descriptionCompressed:
				"Performs subtraction in the multiverse where negative numbers might not exist in some dimensions (absolute, mirror, or void).",
		},
		{
			name: "NAVIGATE_DIALOG",
			description:
				"Select a dialog option by number (1-based) during an NPC conversation",
			parameters: [],
			similes: ["SELECT_DIALOG", "CHOOSE_OPTION", "DIALOG_OPTION"],
			descriptionCompressed:
				"Select a dialog option by number (1-based) during an NPC convo",
		},
		{
			name: "NOSTR_PUBLISH_PROFILE",
			description:
				"Publish or update the bot's Nostr profile (kind:0 metadata)",
			parameters: [],
			similes: ["UPDATE_NOSTR_PROFILE", "SET_NOSTR_PROFILE", "NOSTR_PROFILE"],
			descriptionCompressed:
				"Publish or update the bot's Nostr profile (kind:0 metadata)",
		},
		{
			name: "NOSTR_SEND_DM",
			description: "Send an encrypted direct message via Nostr (NIP-04)",
			parameters: [],
			similes: ["SEND_NOSTR_DM", "NOSTR_MESSAGE", "NOSTR_TEXT", "DM_NOSTR"],
			descriptionCompressed: "Send an encrypted direct msg via Nostr (NIP-04)",
		},
		{
			name: "OPEN_BANK",
			description: "Open the nearest bank booth or banker NPC",
			parameters: [],
			similes: ["USE_BANK", "ACCESS_BANK"],
			descriptionCompressed: "Open the nearest bank booth or banker NPC",
		},
		{
			name: "OPEN_DOOR",
			description: "Open the nearest door or gate",
			parameters: [],
			similes: ["OPEN_GATE", "USE_DOOR"],
			descriptionCompressed: "Open the nearest door or gate",
		},
		{
			name: "OPEN_SHOP",
			description: "Open a shop by talking to a shopkeeper NPC",
			parameters: [],
			similes: ["TRADE_WITH_NPC", "BROWSE_SHOP"],
			descriptionCompressed: "Open a shop by talking to a shopkeeper NPC",
		},
		{
			name: "OWNER_SCHEDULE",
			description:
				"Owner-only. Inspect LifeOps passive schedule inference from local activity, screen-time, and optional health signals. ",
			parameters: [],
			similes: [
				"OWNER_SLEEP",
				"OWNER_SLEEP_SCHEDULE",
				"OWNER_MEAL_SCHEDULE",
				"OWNER_ROUTINE",
				"SLEEP_INFERENCE",
				"MEAL_INFERENCE",
			],
			descriptionCompressed:
				"Owner-only. Inspect LifeOps passive schedule inference from local activity, screen-time, and optional health signals.",
		},
		{
			name: "PAUSE_MUSIC",
			description:
				"Pause the currently playing track (hold playback). Use whenever the user asks to pause music or audio. ",
			parameters: [],
			similes: ["PAUSE", "PAUSE_AUDIO", "PAUSE_SONG", "PAUSE_PLAYBACK"],
			descriptionCompressed:
				"Pause the playing track (hold playback). Use whenever user asks to pause music or audio.",
		},
		{
			name: "PICKPOCKET_NPC",
			description: "Pickpocket a nearby NPC by name",
			parameters: [],
			similes: ["STEAL_FROM_NPC", "THIEVE_NPC"],
			descriptionCompressed: "Pickpocket a nearby NPC by name",
		},
		{
			name: "PICKUP_ITEM",
			description: "Pick up an item from the ground by name",
			parameters: [],
			similes: ["TAKE_ITEM", "GRAB_ITEM", "LOOT_ITEM"],
			descriptionCompressed: "Pick up an item from the ground by name",
		},
		{
			name: "PLACE_CALL",
			description:
				"Place a phone call to a given number using the Android Telecom service. ",
			parameters: [],
			similes: ["CALL", "DIAL", "RING", "PHONE_CALL", "MAKE_CALL"],
			descriptionCompressed:
				"Place a phone call to a given number using the Android Telecom service.",
		},
		{
			name: "PLAY_AUDIO",
			description:
				"Start playing a new song: provide a track name, artist, search words, or a media URL. ",
			parameters: [],
			similes: [
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
				"ADD_TO_QUEUE",
			],
			descriptionCompressed:
				"Start playing a new song: provide a track name, artist, search words, or a media URL.",
		},
		{
			name: "PLAY_EMOTE",
			description:
				"Play a one-shot emote animation on your 3D VRM avatar, then return to idle. ",
			parameters: [],
			similes: [
				"EMOTE",
				"ANIMATE",
				"GESTURE",
				"DANCE",
				"WAVE",
				"PLAY_ANIMATION",
				"DO_EMOTE",
				"PERFORM",
			],
			descriptionCompressed:
				"Play a one-shot emote animation on your 3D VRM avatar, then return to idle.",
		},
		{
			name: "PLAY_MUSIC_QUERY",
			description:
				"Handle any complex music query that requires understanding and research, then queue the selected track after confirmed:true. Supports: artist queries (first single, latest song, similar artists, popular songs, nth album), temporal (80s, 90s, specific years), genre/mood/vibe, activities (workout, study, party), charts/trending, albums, movie/game/TV soundtracks, lyrics/topics, versions (covers, remixes, acoustic, live), and more. Uses Wikipedia, music databases, and web search to find the right music.",
			parameters: [],
			similes: [
				"SMART_PLAY",
				"RESEARCH_AND_PLAY",
				"FIND_AND_PLAY",
				"INTELLIGENT_MUSIC_SEARCH",
			],
			descriptionCompressed:
				"Handle any complex music query that requires understanding and research, then queue the selected track after confirmed:true. Supports: artist queries (first...",
		},
		{
			name: "POLYMARKET_GET_MARKET",
			description: "Fetch a single Polymarket market by market id or slug.",
			parameters: [],
			similes: ["POLYMARKET_MARKET", "POLYMARKET_MARKET_DETAILS"],
			descriptionCompressed:
				"Fetch a single Polymarket market by market id or slug.",
		},
		{
			name: "POLYMARKET_GET_MARKETS",
			description:
				"List active Polymarket markets. Supports limit and offset parameters.",
			parameters: [],
			similes: ["POLYMARKET_MARKETS", "SEARCH_POLYMARKET_MARKETS"],
			descriptionCompressed:
				"List active Polymarket markets. Supports limit and offset params.",
		},
		{
			name: "POLYMARKET_GET_ORDERBOOK",
			description:
				"Fetch a token orderbook and derive true best bid/ask from all CLOB levels.",
			parameters: [],
			similes: [
				"POLYMARKET_QUOTE",
				"POLYMARKET_ORDERBOOK",
				"POLYMARKET_TOKEN_INFO",
			],
			descriptionCompressed:
				"Fetch a token orderbook and derive true best bid/ask from all CLOB levels.",
		},
		{
			name: "POLYMARKET_GET_POSITIONS",
			description: "Fetch Polymarket positions for a wallet address.",
			parameters: [],
			similes: ["POLYMARKET_POSITIONS", "POLYMARKET_WALLET_POSITIONS"],
			descriptionCompressed: "Fetch Polymarket positions for a wallet address.",
		},
		{
			name: "POLYMARKET_PLACE_ORDER",
			description:
				"Explain Polymarket order placement readiness. Signed trading is disabled in this app scaffold.",
			parameters: [],
			similes: ["POLYMARKET_TRADE", "POLYMARKET_BUY", "POLYMARKET_SELL"],
			descriptionCompressed:
				"Explain Polymarket order placement readiness. Signed trading is disabled in this app scaffold.",
		},
		{
			name: "POLYMARKET_STATUS",
			description:
				"Check Polymarket public-read and trading readiness for the local app.",
			parameters: [],
			similes: ["POLYMARKET_READINESS", "POLYMARKET_HEALTH"],
			descriptionCompressed:
				"Check Polymarket public-read and trading readiness for the local app.",
		},
		{
			name: "POST_INSTAGRAM_COMMENT",
			description: "Post a comment on an Instagram post or media",
			parameters: [
				{
					name: "response",
					description: "The response to use.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["example"],
					descriptionCompressed: "The reply to use.",
				},
			],
			similes: [
				"instagram_comment",
				"comment_instagram",
				"reply_instagram",
				"post_comment_instagram",
			],
			exampleCalls: [
				{
					user: "Use POST_INSTAGRAM_COMMENT with the provided parameters.",
					actions: ["POST_INSTAGRAM_COMMENT"],
					params: {
						POST_INSTAGRAM_COMMENT: {
							response: "example",
						},
					},
				},
			],
			descriptionCompressed: "Post a comment on an Instagram post or media",
		},
		{
			name: "POST_TWEET",
			description: "Post a tweet on Twitter",
			parameters: [],
			similes: [
				"TWEET",
				"SEND_TWEET",
				"TWITTER_POST",
				"POST_ON_TWITTER",
				"SHARE_ON_TWITTER",
			],
			descriptionCompressed: "Post a tweet on Twitter",
		},
		{
			name: "PREPARE_SWAP",
			description:
				"Prepare a non-binding swap proposal: returns route options, slippage ",
			parameters: [],
			similes: [
				"QUOTE_SWAP",
				"PREVIEW_SWAP",
				"ESTIMATE_SWAP",
				"SWAP_QUOTE",
				"GET_SWAP_QUOTE",
			],
			descriptionCompressed:
				"Prepare a non-binding swap proposal: returns route options, slippage",
		},
		{
			name: "PREPARE_TRANSFER",
			description:
				"Prepare a non-binding transfer proposal: validates the recipient ",
			parameters: [],
			similes: [
				"PREVIEW_TRANSFER",
				"ESTIMATE_TRANSFER",
				"QUOTE_TRANSFER",
				"TRANSFER_PREVIEW",
			],
			descriptionCompressed:
				"Prepare a non-binding transfer proposal: validates the recipient",
		},
		{
			name: "PROVISION_CLOUD_AGENT",
			description:
				"Deploy an ElizaOS agent to ElizaCloud. Provisions a container, waits for deployment, connects the bridge, and starts auto-backup.",
			parameters: [],
			similes: [
				"deploy agent to cloud",
				"launch cloud agent",
				"start remote agent",
				"provision container",
			],
			descriptionCompressed:
				"Deploy an ElizaOS agent to ElizaCloud. Provisions a container, waits for deployment, connects the bridge, and starts auto-backup.",
		},
		{
			name: "PROVISION_WORKSPACE",
			description: "Create a git workspace for coding tasks. ",
			parameters: [
				{
					name: "codingWorkspace",
					description: "The coding workspace to use.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["example"],
					descriptionCompressed: "The coding workspace to use.",
				},
			],
			similes: [
				"CREATE_WORKSPACE",
				"CLONE_REPO",
				"SETUP_WORKSPACE",
				"PREPARE_WORKSPACE",
			],
			exampleCalls: [
				{
					user: "Use PROVISION_WORKSPACE with the provided parameters.",
					actions: ["PROVISION_WORKSPACE"],
					params: {
						PROVISION_WORKSPACE: {
							codingWorkspace: "example",
						},
					},
				},
			],
			descriptionCompressed: "Create a git workspace for coding tasks.",
		},
		{
			name: "QUERY_ENTITIES",
			description: "Query entities by type or attribute values.",
			parameters: [
				{
					name: "values",
					description: "The values to use.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["example"],
					descriptionCompressed: "The values to use.",
				},
			],
			similes: ["FIND_ENTITIES", "SEARCH_ENTITIES", "LIST_ENTITIES"],
			exampleCalls: [
				{
					user: "Use QUERY_ENTITIES with the provided parameters.",
					actions: ["QUERY_ENTITIES"],
					params: {
						QUERY_ENTITIES: {
							values: "example",
						},
					},
				},
			],
			descriptionCompressed: "Query entities by type or attribute values.",
		},
		{
			name: "QUERY_RELATIONSHIPS",
			description:
				"Query relationships of a specific type or for a specific entity.",
			parameters: [
				{
					name: "values",
					description: "The values to use.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["example"],
					descriptionCompressed: "The values to use.",
				},
			],
			similes: ["FIND_RELATIONSHIPS", "GET_CONNECTIONS", "SHOW_LINKS"],
			exampleCalls: [
				{
					user: "Use QUERY_RELATIONSHIPS with the provided parameters.",
					actions: ["QUERY_RELATIONSHIPS"],
					params: {
						QUERY_RELATIONSHIPS: {
							values: "example",
						},
					},
				},
			],
			descriptionCompressed:
				"Query relationships of a specific type or for a specific entity.",
		},
		{
			name: "QUEUE_MUSIC",
			description: "Add a song to the queue for later after confirmed:true.",
			parameters: [
				{
					name: "data",
					description: "The data to use.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["example"],
					descriptionCompressed: "The data to use.",
				},
			],
			similes: ["ADD_TO_QUEUE", "QUEUE_SONG", "QUEUE_TRACK", "ADD_SONG"],
			exampleCalls: [
				{
					user: "Use QUEUE_MUSIC with the provided parameters.",
					actions: ["QUEUE_MUSIC"],
					params: {
						QUEUE_MUSIC: {
							data: "example",
						},
					},
				},
			],
			descriptionCompressed:
				"Add a song to the queue for later after confirmed:true.",
		},
		{
			name: "READ_CALL_LOG",
			description:
				"List the most recent phone calls from the Android call log. Returns up ",
			parameters: [],
			similes: ["RECENT_CALLS", "CALL_HISTORY", "LIST_CALLS"],
			descriptionCompressed:
				"List the most recent phone calls from the Android call log. Returns up",
		},
		{
			name: "READ_MCP_RESOURCE",
			description: "Reads a resource from an MCP server",
			parameters: [],
			similes: [
				"READ_RESOURCE",
				"READ_MCP_RESOURCE",
				"GET_RESOURCE",
				"GET_MCP_RESOURCE",
				"FETCH_RESOURCE",
				"FETCH_MCP_RESOURCE",
				"ACCESS_RESOURCE",
				"ACCESS_MCP_RESOURCE",
			],
			descriptionCompressed: "Reads a resource from an MCP server",
		},
		{
			name: "READ_UNREAD_X_DMS",
			description: "List unread Twitter/X direct messages.",
			parameters: [],
			similes: ["READ_X_DMS", "GET_X_UNREAD_DMS", "CHECK_X_DMS"],
			descriptionCompressed: "List unread Twitter/X direct msgs.",
		},
		{
			name: "READING_FOLLOWUP",
			description:
				"Continue an active reading by processing user feedback and revealing the next element.",
			parameters: [],
			similes: [
				"CONTINUE_READING",
				"NEXT_CARD",
				"READING_RESPONSE",
				"PROCEED_READING",
			],
			descriptionCompressed:
				"Continue an active reading by processing user feedback and revealing the next element.",
		},
		{
			name: "RELEASE_BLOCK",
			description:
				"Release an active website block rule. Requires confirmed:true. ",
			parameters: [],
			similes: ["RELEASE_WEBSITE_BLOCK", "END_BLOCK_RULE", "BYPASS_BLOCK_RULE"],
			descriptionCompressed:
				"Release an active website block rule. Requires confirmed:true.",
		},
		{
			name: "REMEMBER",
			description:
				"Write a note to the Scape Journal. Use for lessons, landmarks, and things you want to remember next step.",
			parameters: [],
			similes: ["NOTE", "LOG", "JOURNAL", "RECORD"],
			descriptionCompressed:
				"Write a note to the Scape Journal. Use for lessons, landmarks, and things you want to remember next step.",
		},
		{
			name: "REMOTE_ATTESTATION",
			description:
				"Generate a remote attestation to prove that the agent is running in a TEE (Trusted Execution Environment)",
			parameters: [],
			similes: [
				"REMOTE_ATTESTATION",
				"TEE_REMOTE_ATTESTATION",
				"TEE_ATTESTATION",
				"TEE_QUOTE",
				"ATTESTATION",
				"TEE_ATTESTATION_QUOTE",
				"PROVE_TEE",
				"VERIFY_TEE",
			],
			descriptionCompressed:
				"Generate a remote attestation to prove that agent is running in a TEE (Trusted Execution Environment)",
		},
		{
			name: "REPLY_X_DM",
			description:
				"Reply to a Twitter/X direct message. Two-stage: without `confirmed: true` this returns a preview and requires confirmation; with `confirmed: true` the DM is sent.",
			parameters: [],
			similes: ["SEND_X_DM", "REPLY_TWITTER_DM", "X_DM_REPLY"],
			descriptionCompressed:
				"Reply to a Twitter/X direct msg. Two-stage: without `confirmed: true` this returns a preview and requires confirmation. with `confirmed: true` the DM is sent.",
		},
		{
			name: "REQUEST_PAYMENT",
			description:
				"Request payment from the user for a reading service. Specify the amount to charge.",
			parameters: [],
			similes: ["CHARGE_USER", "ASK_FOR_PAYMENT", "SET_PRICE"],
			descriptionCompressed:
				"Request payment from user for a reading service. Specify the amount to charge.",
		},
		{
			name: "REQUEST_WEBSITE_BLOCKING_PERMISSION",
			description:
				"Owner-only. Prepare local website blocking by requesting administrator/root approval when the machine supports it, or explain the manual change needed when it does not.",
			parameters: [],
			similes: [
				"ENABLE_WEBSITE_BLOCKING",
				"ALLOW_WEBSITE_BLOCKING",
				"GRANT_WEBSITE_BLOCKING_PERMISSION",
				"REQUEST_SELFCONTROL_PERMISSION",
			],
			descriptionCompressed:
				"Owner-only. Prepare local website blocking by requesting administrator/root approval when the machine supports it, or explain the manual change needed when...",
		},
		{
			name: "RESUME_CLOUD_AGENT",
			description:
				"Resume a frozen cloud agent from snapshot. Re-provisions, restores state, reconnects bridge.",
			parameters: [],
			similes: [
				"resume agent",
				"unfreeze agent",
				"restart cloud agent",
				"restore agent",
			],
			descriptionCompressed:
				"Resume a frozen cloud agent from snapshot. Re-provisions, restores state, reconnects bridge.",
		},
		{
			name: "RESUME_MUSIC",
			description:
				"Resume music after a pause. Use when the user says resume, unpause, or continue. ",
			parameters: [],
			similes: [
				"RESUME",
				"RESUME_AUDIO",
				"RESUME_SONG",
				"UNPAUSE",
				"UNPAUSE_MUSIC",
				"CONTINUE_MUSIC",
			],
			descriptionCompressed:
				"Resume music after a pause. Use when user says resume, unpause, or continue.",
		},
		{
			name: "SAVE_PLAYLIST",
			description:
				"Save the current music queue as a playlist for the user after confirmed:true. Works best in DMs to avoid flooding group chats.",
			parameters: [
				{
					name: "data",
					description: "The data to use.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["example"],
					descriptionCompressed: "The data to use.",
				},
			],
			similes: [
				"SAVE_QUEUE",
				"CREATE_PLAYLIST",
				"STORE_PLAYLIST",
				"SAVE_MUSIC_LIST",
			],
			exampleCalls: [
				{
					user: "Use SAVE_PLAYLIST with the provided parameters.",
					actions: ["SAVE_PLAYLIST"],
					params: {
						SAVE_PLAYLIST: {
							data: "example",
						},
					},
				},
			],
			descriptionCompressed:
				"Save the current music queue as a playlist for user after confirmed:true. Works best in DMs to avoid flooding group chats.",
		},
		{
			name: "SCAN_WIFI",
			description:
				"List nearby Wi-Fi networks visible to the device. Returns SSID, BSSID, ",
			parameters: [],
			similes: ["LIST_WIFI", "WIFI_SCAN", "NEARBY_WIFI", "WIFI_NETWORKS"],
			descriptionCompressed:
				"List nearby Wi-Fi networks visible to the device. Returns SSID, BSSID,",
		},
		{
			name: "SCHEDULE_X_DM_REPLY",
			description:
				"Schedule a Twitter/X DM reply to send later by creating a real trigger task. ",
			parameters: [],
			similes: [
				"QUEUE_X_DM_REPLY",
				"SCHEDULE_TWITTER_DM_REPLY",
				"SCHEDULE_X_REPLY",
			],
			descriptionCompressed:
				"Schedule a Twitter/X DM reply to send later by creating a real trigger task.",
		},
		{
			name: "SCREEN_TIME",
			description:
				"Query screen time summaries (per app, per website, daily). Use this for quantitative usage questions like 'how much screen time have I used today?', 'break down my screen time by app this week', or 'which websites did I spend the most time on?'. Do not use this when the user is only reflecting or venting like 'I spend too much time on my phone' unless they actually ask for the numbers. Subactions: summary, today, weekly, weekly_average_by_app, by_app, by_website.",
			parameters: [],
			similes: ["SCREENTIME", "APP_USAGE", "WEBSITE_USAGE", "DWELL_TIME"],
			descriptionCompressed:
				"Query screen time summaries (per app, per website, daily). Use this for quantitative usage questions like 'how much screen time have I used today?', 'break...",
		},
		{
			name: "SEARCH_LINEAR_ISSUES",
			description: "Search for issues in Linear with various filters",
			parameters: [
				{
					name: "name",
					description: "The name to use.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["example"],
					descriptionCompressed: "The name to use.",
				},
			],
			similes: [
				"search-linear-issues",
				"find-linear-issues",
				"query-linear-issues",
				"list-linear-issues",
			],
			exampleCalls: [
				{
					user: "Use SEARCH_LINEAR_ISSUES with the provided parameters.",
					actions: ["SEARCH_LINEAR_ISSUES"],
					params: {
						SEARCH_LINEAR_ISSUES: {
							name: "example",
						},
					},
				},
			],
			descriptionCompressed: "Search for issues in Linear with various filters",
		},
		{
			name: "SEARCH_SHOPIFY_STORE",
			description:
				"Search across products, orders, and customers in a connected Shopify store.",
			parameters: [],
			similes: ["SHOPIFY_SEARCH", "STORE_SEARCH"],
			descriptionCompressed:
				"Search across products, orders, and customers in a connected Shopify store.",
		},
		{
			name: "SEARCH_SKILLS",
			description:
				"Search the skill registry for available skills by keyword or category. Returns each result with action chips (use/enable/disable/install/copy/details).",
			parameters: [],
			similes: ["BROWSE_SKILLS", "LIST_SKILLS", "FIND_SKILLS"],
			descriptionCompressed:
				"Search the skill registry for available skills by keyword or category. Returns each result with action chips (use/enable/disable/install/copy/details).",
		},
		{
			name: "SEARCH_X",
			description:
				"Search X recent tweets using the v2 recent search endpoint. Parameters: query (required), maxResults (optional, default 10).",
			parameters: [],
			similes: ["SEARCH_TWITTER", "SEARCH_TWEETS", "X_SEARCH"],
			descriptionCompressed:
				"Search X recent tweets using the v2 recent search endpoint. params: query (required), maxResults (optional, default 10).",
		},
		{
			name: "SEARCH_YOUTUBE",
			description:
				"Search YouTube for a song or video and return the link. Use this when a user asks to find or search for a YouTube video or song without providing a specific URL.",
			parameters: [],
			similes: [
				"FIND_YOUTUBE",
				"SEARCH_YOUTUBE_VIDEO",
				"FIND_SONG",
				"SEARCH_MUSIC",
				"GET_YOUTUBE_LINK",
				"LOOKUP_YOUTUBE",
			],
			descriptionCompressed:
				"Search YouTube for a song or video and return the link. Use when a user asks to find or search for a YouTube video or song without providing a specific URL.",
		},
		{
			name: "SELECT_DIMENSION",
			description:
				"Select the dimensional constant that affects how mathematical operations behave in the multiverse.",
			parameters: [
				{
					name: "values",
					description: "The values to use.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["example"],
					descriptionCompressed: "The values to use.",
				},
			],
			similes: ["DIMENSION", "SET_DIMENSION", "CHOOSE_DIMENSION"],
			exampleCalls: [
				{
					user: "Use SELECT_DIMENSION with the provided parameters.",
					actions: ["SELECT_DIMENSION"],
					params: {
						SELECT_DIMENSION: {
							values: "example",
						},
					},
				},
			],
			descriptionCompressed:
				"Select the dimensional constant that affects how mathematical operations behave in the multiverse.",
		},
		{
			name: "SELECT_ENTITY",
			description: "Select an entity as the current entity for operations.",
			parameters: [
				{
					name: "values",
					description: "The values to use.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["example"],
					descriptionCompressed: "The values to use.",
				},
			],
			similes: ["CHOOSE_ENTITY", "FOCUS_ENTITY", "SET_CURRENT_ENTITY"],
			exampleCalls: [
				{
					user: "Use SELECT_ENTITY with the provided parameters.",
					actions: ["SELECT_ENTITY"],
					params: {
						SELECT_ENTITY: {
							values: "example",
						},
					},
				},
			],
			descriptionCompressed:
				"Select an entity as the current entity for operations.",
		},
		{
			name: "SELL_TO_SHOP",
			description:
				"Sell an item to the currently open shop, optionally specifying a count (defaults to 1)",
			parameters: [],
			similes: ["SELL_ITEM"],
			descriptionCompressed:
				"Sell an item to the open shop, optionally specifying a count (defaults to 1)",
		},
		{
			name: "SEND_BLUEBUBBLES_MESSAGE",
			description: "Send a message via iMessage through BlueBubbles",
			parameters: [],
			similes: [
				"SEND_IMESSAGE",
				"TEXT_MESSAGE",
				"IMESSAGE_REPLY",
				"BLUEBUBBLES_SEND",
				"APPLE_MESSAGE",
			],
			descriptionCompressed: "Send a msg via iMessage through BlueBubbles",
		},
		{
			name: "SEND_INSTAGRAM_DM",
			description: "Send a direct message to an Instagram user",
			parameters: [
				{
					name: "response",
					description: "The response to use.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["example"],
					descriptionCompressed: "The reply to use.",
				},
			],
			similes: [
				"instagram_dm",
				"instagram_message",
				"send_instagram_message",
				"dm_instagram",
				"direct_message_instagram",
			],
			exampleCalls: [
				{
					user: "Use SEND_INSTAGRAM_DM with the provided parameters.",
					actions: ["SEND_INSTAGRAM_DM"],
					params: {
						SEND_INSTAGRAM_DM: {
							response: "example",
						},
					},
				},
			],
			descriptionCompressed: "Send direct msg to an Instagram user",
		},
		{
			name: "SEND_TO_AGENT",
			description:
				"Send text input or key presses to a running task-agent session. ",
			parameters: [
				{
					name: "codingSession",
					description: "The coding session to use.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["example"],
					descriptionCompressed: "The coding session to use.",
				},
			],
			similes: [
				"SEND_TO_CODING_AGENT",
				"MESSAGE_CODING_AGENT",
				"INPUT_TO_AGENT",
				"RESPOND_TO_AGENT",
				"TELL_CODING_AGENT",
				"MESSAGE_AGENT",
				"TELL_TASK_AGENT",
			],
			exampleCalls: [
				{
					user: "Use SEND_TO_AGENT with the provided parameters.",
					actions: ["SEND_TO_AGENT"],
					params: {
						SEND_TO_AGENT: {
							codingSession: "example",
						},
					},
				},
			],
			descriptionCompressed:
				"Send text input or key presses to a running task-agent session.",
		},
		{
			name: "SEND_X_POST",
			description:
				"Publish a tweet on Twitter/X with a confirmation gate. Two-stage: without `confirmed: true` this returns a preview; with `confirmed: true` the tweet is posted.",
			parameters: [],
			similes: ["POST_X", "TWEET_WITH_CONFIRMATION", "PUBLISH_TWEET"],
			descriptionCompressed:
				"Publish a tweet on Twitter/X with a confirmation gate. Two-stage: without `confirmed: true` this returns a preview. with `confirmed: true` the tweet is posted.",
		},
		{
			name: "SET_ATTRIBUTE",
			description:
				"Set an attribute on the current entity. Attributes store additional data on entities.",
			parameters: [
				{
					name: "values",
					description: "The values to use.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["example"],
					descriptionCompressed: "The values to use.",
				},
			],
			similes: ["ADD_ATTRIBUTE", "SET_PROPERTY", "UPDATE_ATTRIBUTE"],
			exampleCalls: [
				{
					user: "Use SET_ATTRIBUTE with the provided parameters.",
					actions: ["SET_ATTRIBUTE"],
					params: {
						SET_ATTRIBUTE: {
							values: "example",
						},
					},
				},
			],
			descriptionCompressed:
				"Set an attribute on the current entity. Attributes store additional data on entities.",
		},
		{
			name: "SET_COMBAT_STYLE",
			description:
				"Set the combat style (0=Attack, 1=Strength, 2=Defence, 3=Controlled)",
			parameters: [],
			similes: ["CHANGE_COMBAT_STYLE", "SWITCH_COMBAT"],
			descriptionCompressed:
				"Set the combat style (0=Attack, 1=Strength, 2=Defence, 3=Controlled)",
		},
		{
			name: "SET_FOLLOWUP_THRESHOLD",
			description:
				"Set a recurring follow-up cadence threshold (in days) for a specific contact. ",
			parameters: [],
			similes: [
				"FOLLOWUP_RULE",
				"CHANGE_FOLLOWUP_INTERVAL",
				"SET_CONTACT_FREQUENCY_DAYS",
			],
			descriptionCompressed:
				"Set a recurring follow-up cadence threshold (in days) for a specific contact.",
		},
		{
			name: "SET_GOAL",
			description:
				"Declare a new goal you want to pursue. Write a short title and optional notes; the goal goes into the Scape Journal and drives future steps until it's completed or abandoned.",
			parameters: [],
			similes: ["DECLARE_GOAL", "NEW_GOAL", "PLAN"],
			descriptionCompressed:
				"Declare a new goal you want to pursue. Write a short title and optional notes. the goal goes into the Scape Journal and drives future steps until it's...",
		},
		{
			name: "SETUP_CREDENTIALS",
			description:
				"Guide the user through setting up API credentials for supported third-party services, validate them when possible, and store them securely.",
			parameters: [
				{
					name: "data",
					description: "The data to use.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["example"],
					descriptionCompressed: "The data to use.",
				},
			],
			similes: [
				"ADD_CREDENTIALS",
				"CONFIGURE_SERVICE",
				"CONNECT_SERVICE",
				"ADD_API_KEY",
				"SETUP_SERVICE",
			],
			exampleCalls: [
				{
					user: "Use SETUP_CREDENTIALS with the provided parameters.",
					actions: ["SETUP_CREDENTIALS"],
					params: {
						SETUP_CREDENTIALS: {
							data: "example",
						},
					},
				},
			],
			descriptionCompressed:
				"Guide user through setting up API credentials for supported 3p services, validate them when possible, and store them securely.",
		},
		{
			name: "SHOW_QUEUE",
			description: "Show the current music queue",
			parameters: [],
			similes: ["QUEUE", "LIST_QUEUE", "SHOW_PLAYLIST", "QUEUE_LIST"],
			descriptionCompressed: "Show the current music queue",
		},
		{
			name: "SIGNAL_LIST_CONTACTS",
			description: "List Signal contacts",
			parameters: [],
			similes: [
				"LIST_SIGNAL_CONTACTS",
				"SHOW_CONTACTS",
				"GET_CONTACTS",
				"SIGNAL_CONTACTS",
			],
			descriptionCompressed: "List Signal contacts",
		},
		{
			name: "SIGNAL_LIST_GROUPS",
			description: "List Signal groups",
			parameters: [],
			similes: [
				"LIST_SIGNAL_GROUPS",
				"SHOW_GROUPS",
				"GET_GROUPS",
				"SIGNAL_GROUPS",
			],
			descriptionCompressed: "List Signal groups",
		},
		{
			name: "SIGNAL_READ_RECENT_MESSAGES",
			description:
				"Read the most recent Signal messages across active conversations",
			parameters: [],
			similes: [
				"READ_SIGNAL_MESSAGES",
				"CHECK_SIGNAL_MESSAGES",
				"SHOW_SIGNAL_MESSAGES",
				"SIGNAL_INBOX",
			],
			descriptionCompressed:
				"Read the most recent Signal msgs across active convos",
		},
		{
			name: "SIGNAL_SEND_MESSAGE",
			description: "Send a message to a Signal contact or group",
			parameters: [
				{
					name: "data",
					description: "The data to use.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["example"],
					descriptionCompressed: "The data to use.",
				},
			],
			similes: [
				"SEND_SIGNAL_MESSAGE",
				"TEXT_SIGNAL",
				"MESSAGE_SIGNAL",
				"SIGNAL_TEXT",
			],
			exampleCalls: [
				{
					user: "Use SIGNAL_SEND_MESSAGE with the provided parameters.",
					actions: ["SIGNAL_SEND_MESSAGE"],
					params: {
						SIGNAL_SEND_MESSAGE: {
							data: "example",
						},
					},
				},
			],
			descriptionCompressed: "Send a msg to a Signal contact or group",
		},
		{
			name: "SIGNAL_SEND_REACTION",
			description: "React to a Signal message with an emoji",
			parameters: [
				{
					name: "data",
					description: "The data to use.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["example"],
					descriptionCompressed: "The data to use.",
				},
			],
			similes: [
				"REACT_SIGNAL",
				"SIGNAL_REACT",
				"ADD_SIGNAL_REACTION",
				"SIGNAL_EMOJI",
			],
			exampleCalls: [
				{
					user: "Use SIGNAL_SEND_REACTION with the provided parameters.",
					actions: ["SIGNAL_SEND_REACTION"],
					params: {
						SIGNAL_SEND_REACTION: {
							data: "example",
						},
					},
				},
			],
			descriptionCompressed: "React to a Signal msg with an emoji",
		},
		{
			name: "SKIP_TRACK",
			description:
				"Skip the current track and play the next queued song. Use for skip, next track, or next song. ",
			parameters: [],
			similes: ["SKIP", "NEXT_TRACK", "SKIP_SONG", "NEXT_SONG"],
			descriptionCompressed:
				"Skip the current track and play the next queued song. Use for skip, next track, or next song.",
		},
		{
			name: "SLACK_DELETE_MESSAGE",
			description: "Delete a Slack message",
			parameters: [
				{
					name: "data",
					description: "The data to use.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["example"],
					descriptionCompressed: "The data to use.",
				},
			],
			similes: ["REMOVE_SLACK_MESSAGE", "DELETE_MESSAGE", "SLACK_REMOVE"],
			exampleCalls: [
				{
					user: "Use SLACK_DELETE_MESSAGE with the provided parameters.",
					actions: ["SLACK_DELETE_MESSAGE"],
					params: {
						SLACK_DELETE_MESSAGE: {
							data: "example",
						},
					},
				},
			],
			descriptionCompressed: "Delete a Slack msg",
		},
		{
			name: "SLACK_EDIT_MESSAGE",
			description: "Edit an existing Slack message",
			parameters: [
				{
					name: "data",
					description: "The data to use.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["example"],
					descriptionCompressed: "The data to use.",
				},
			],
			similes: [
				"UPDATE_SLACK_MESSAGE",
				"MODIFY_MESSAGE",
				"CHANGE_MESSAGE",
				"SLACK_UPDATE",
			],
			exampleCalls: [
				{
					user: "Use SLACK_EDIT_MESSAGE with the provided parameters.",
					actions: ["SLACK_EDIT_MESSAGE"],
					params: {
						SLACK_EDIT_MESSAGE: {
							data: "example",
						},
					},
				},
			],
			descriptionCompressed: "Edit an existing Slack msg",
		},
		{
			name: "SLACK_EMOJI_LIST",
			description: "List custom emoji available in the Slack workspace",
			parameters: [],
			similes: [
				"LIST_SLACK_EMOJI",
				"SHOW_EMOJI",
				"GET_CUSTOM_EMOJI",
				"CUSTOM_EMOJI",
				"WORKSPACE_EMOJI",
			],
			descriptionCompressed:
				"List custom emoji available in the Slack workspace",
		},
		{
			name: "SLACK_GET_USER_INFO",
			description: "Get information about a Slack user",
			parameters: [],
			similes: [
				"GET_SLACK_USER",
				"USER_INFO",
				"SLACK_USER",
				"MEMBER_INFO",
				"WHO_IS",
			],
			descriptionCompressed: "Get info about a Slack user",
		},
		{
			name: "SLACK_LIST_CHANNELS",
			description: "List available Slack channels in the workspace",
			parameters: [],
			similes: [
				"LIST_SLACK_CHANNELS",
				"SHOW_CHANNELS",
				"GET_CHANNELS",
				"CHANNELS_LIST",
			],
			descriptionCompressed: "List available Slack channels in the workspace",
		},
		{
			name: "SLACK_LIST_PINS",
			description: "List pinned messages in a Slack channel",
			parameters: [
				{
					name: "data",
					description: "The data to use.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["example"],
					descriptionCompressed: "The data to use.",
				},
			],
			similes: [
				"LIST_SLACK_PINS",
				"SHOW_PINS",
				"GET_PINNED_MESSAGES",
				"PINNED_MESSAGES",
			],
			exampleCalls: [
				{
					user: "Use SLACK_LIST_PINS with the provided parameters.",
					actions: ["SLACK_LIST_PINS"],
					params: {
						SLACK_LIST_PINS: {
							data: "example",
						},
					},
				},
			],
			descriptionCompressed: "List pinned msgs in a Slack channel",
		},
		{
			name: "SLACK_PIN_MESSAGE",
			description: "Pin a message in a Slack channel",
			parameters: [
				{
					name: "data",
					description: "The data to use.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["example"],
					descriptionCompressed: "The data to use.",
				},
			],
			similes: [
				"PIN_SLACK_MESSAGE",
				"PIN_MESSAGE",
				"SLACK_PIN",
				"SAVE_MESSAGE",
			],
			exampleCalls: [
				{
					user: "Use SLACK_PIN_MESSAGE with the provided parameters.",
					actions: ["SLACK_PIN_MESSAGE"],
					params: {
						SLACK_PIN_MESSAGE: {
							data: "example",
						},
					},
				},
			],
			descriptionCompressed: "Pin a msg in a Slack channel",
		},
		{
			name: "SLACK_REACT_TO_MESSAGE",
			description: "Add or remove an emoji reaction to a Slack message",
			parameters: [
				{
					name: "data",
					description: "The data to use.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["example"],
					descriptionCompressed: "The data to use.",
				},
			],
			similes: [
				"ADD_SLACK_REACTION",
				"REACT_SLACK",
				"SLACK_EMOJI",
				"ADD_EMOJI",
				"REMOVE_REACTION",
			],
			exampleCalls: [
				{
					user: "Use SLACK_REACT_TO_MESSAGE with the provided parameters.",
					actions: ["SLACK_REACT_TO_MESSAGE"],
					params: {
						SLACK_REACT_TO_MESSAGE: {
							data: "example",
						},
					},
				},
			],
			descriptionCompressed: "Add or remove an emoji reaction to a Slack msg",
		},
		{
			name: "SLACK_READ_CHANNEL",
			description: "Read message history from a Slack channel",
			parameters: [
				{
					name: "data",
					description: "The data to use.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["example"],
					descriptionCompressed: "The data to use.",
				},
			],
			similes: [
				"READ_SLACK_MESSAGES",
				"GET_CHANNEL_HISTORY",
				"SLACK_HISTORY",
				"FETCH_MESSAGES",
				"LIST_MESSAGES",
			],
			exampleCalls: [
				{
					user: "Use SLACK_READ_CHANNEL with the provided parameters.",
					actions: ["SLACK_READ_CHANNEL"],
					params: {
						SLACK_READ_CHANNEL: {
							data: "example",
						},
					},
				},
			],
			descriptionCompressed: "Read msg history from a Slack channel",
		},
		{
			name: "SLACK_SEND_MESSAGE",
			description: "Send a message to a Slack channel or thread",
			parameters: [
				{
					name: "data",
					description: "The data to use.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["example"],
					descriptionCompressed: "The data to use.",
				},
			],
			similes: [
				"SEND_SLACK_MESSAGE",
				"POST_TO_SLACK",
				"MESSAGE_SLACK",
				"SLACK_POST",
				"SEND_TO_CHANNEL",
			],
			exampleCalls: [
				{
					user: "Use SLACK_SEND_MESSAGE with the provided parameters.",
					actions: ["SLACK_SEND_MESSAGE"],
					params: {
						SLACK_SEND_MESSAGE: {
							data: "example",
						},
					},
				},
			],
			descriptionCompressed: "Send a msg to a Slack channel or thread",
		},
		{
			name: "SLACK_UNPIN_MESSAGE",
			description: "Unpin a message from a Slack channel",
			parameters: [
				{
					name: "data",
					description: "The data to use.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["example"],
					descriptionCompressed: "The data to use.",
				},
			],
			similes: [
				"UNPIN_SLACK_MESSAGE",
				"UNPIN_MESSAGE",
				"SLACK_UNPIN",
				"REMOVE_PIN",
			],
			exampleCalls: [
				{
					user: "Use SLACK_UNPIN_MESSAGE with the provided parameters.",
					actions: ["SLACK_UNPIN_MESSAGE"],
					params: {
						SLACK_UNPIN_MESSAGE: {
							data: "example",
						},
					},
				},
			],
			descriptionCompressed: "Unpin a msg from a Slack channel",
		},
		{
			name: "SMITH_AT_ANVIL",
			description:
				"Smith a metal bar at a nearby anvil, optionally specifying what to make",
			parameters: [],
			similes: ["SMITHING", "USE_ANVIL"],
			descriptionCompressed:
				"Smith a metal bar at a nearby anvil, optionally specifying what to make",
		},
		{
			name: "SPAWN_AGENT",
			description:
				"Spawn a specific task agent inside an existing workspace when you need direct control. ",
			parameters: [
				{
					name: "codingWorkspace",
					description: "The coding workspace to use.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["example"],
					descriptionCompressed: "The coding workspace to use.",
				},
			],
			similes: [
				"SPAWN_CODING_AGENT",
				"START_CODING_AGENT",
				"LAUNCH_CODING_AGENT",
				"CREATE_CODING_AGENT",
				"SPAWN_CODER",
				"RUN_CODING_AGENT",
				"SPAWN_SUB_AGENT",
				"START_TASK_AGENT",
				"CREATE_AGENT",
			],
			exampleCalls: [
				{
					user: "Use SPAWN_AGENT with the provided parameters.",
					actions: ["SPAWN_AGENT"],
					params: {
						SPAWN_AGENT: {
							codingWorkspace: "example",
						},
					},
				},
			],
			descriptionCompressed:
				"Spawn a specific task agent inside an existing workspace when you need direct control.",
		},
		{
			name: "START_TAILSCALE",
			description:
				"Start a Tailscale tunnel exposing a local port to your tailnet (or the public internet via Funnel)",
			parameters: [],
			similes: ["START_TUNNEL", "OPEN_TUNNEL", "CREATE_TUNNEL", "TAILSCALE_UP"],
			descriptionCompressed:
				"Start a Tailscale tunnel exposing a local port to your tailnet (or the public internet via Funnel)",
		},
		{
			name: "STATUS_COMMAND",
			description:
				"Show session directive settings via /status slash command. Only activates for /status or /s prefix.",
			parameters: [],
			similes: ["/status", "/s"],
			descriptionCompressed:
				"Show session directive settings via /status slash command. Only activates for /status or /s prefix.",
		},
		{
			name: "STOP_AGENT",
			description: "Stop a running task-agent session. ",
			parameters: [
				{
					name: "codingSession",
					description: "The coding session to use.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["example"],
					descriptionCompressed: "The coding session to use.",
				},
			],
			similes: [
				"STOP_CODING_AGENT",
				"KILL_CODING_AGENT",
				"TERMINATE_AGENT",
				"END_CODING_SESSION",
				"CANCEL_AGENT",
				"CANCEL_TASK_AGENT",
				"STOP_SUB_AGENT",
			],
			exampleCalls: [
				{
					user: "Use STOP_AGENT with the provided parameters.",
					actions: ["STOP_AGENT"],
					params: {
						STOP_AGENT: {
							codingSession: "example",
						},
					},
				},
			],
			descriptionCompressed: "Stop a running task-agent session.",
		},
		{
			name: "STOP_COMMAND",
			description:
				"Stop current operation or abort running tasks. Triggered by /stop, /abort, or /cancel slash commands only.",
			parameters: [],
			similes: ["/stop", "/abort", "/cancel"],
			descriptionCompressed:
				"Stop current operation or abort running tasks. Triggered by /stop, /abort, or /cancel slash commands only.",
		},
		{
			name: "STOP_MUSIC",
			description:
				"Stop playback and clear the queue. Use when the user wants music off or the queue cleared. ",
			parameters: [],
			similes: [
				"STOP_AUDIO",
				"STOP_PLAYING",
				"STOP_SONG",
				"TURN_OFF_MUSIC",
				"MUSIC_OFF",
				"SILENCE",
			],
			descriptionCompressed:
				"Stop playback and clear the queue. Use when user wants music off or the queue cleared.",
		},
		{
			name: "STOP_TAILSCALE",
			description: "Stop the running Tailscale tunnel",
			parameters: [],
			similes: ["STOP_TUNNEL", "CLOSE_TUNNEL", "TAILSCALE_DOWN"],
			descriptionCompressed: "Stop the running Tailscale tunnel",
		},
		{
			name: "SUMMARIZE_FEED",
			description:
				"Fetch the top-N X tweets and produce a concise natural-language summary using the runtime's small text model.",
			parameters: [],
			similes: ["X_FEED_SUMMARY", "SUMMARIZE_TWITTER", "SUMMARIZE_X_FEED"],
			descriptionCompressed:
				"Fetch the top-N X tweets and produce a concise natural-language summary using the runtime's small text model.",
		},
		{
			name: "SYNC_SKILL_CATALOG",
			description:
				"Sync the skill catalog from the registry to discover new skills.",
			parameters: [],
			similes: ["REFRESH_SKILLS", "UPDATE_CATALOG"],
			descriptionCompressed:
				"Sync the skill catalog from the registry to discover new skills.",
		},
		{
			name: "TALK_TO_NPC",
			description: "Talk to a nearby NPC by name",
			parameters: [],
			similes: ["SPEAK_TO_NPC", "CHAT_WITH_NPC"],
			descriptionCompressed: "Talk to a nearby NPC by name",
		},
		{
			name: "TAROT_READING",
			description:
				"Perform a tarot card reading, drawing cards into a spread and revealing each one iteratively.",
			parameters: [],
			similes: ["READ_TAROT", "DRAW_CARDS", "TAROT_SPREAD", "CARD_READING"],
			descriptionCompressed:
				"Perform a tarot card reading, drawing cards into a spread and revealing each one iteratively.",
		},
		{
			name: "TASK_CONTROL",
			description:
				"Pause, stop, resume, continue, archive, or reopen a coordinator task thread while preserving the durable thread history.",
			parameters: [],
			similes: [
				"CONTROL_TASK",
				"PAUSE_TASK",
				"RESUME_TASK",
				"STOP_TASK",
				"CONTINUE_TASK",
				"ARCHIVE_TASK",
				"REOPEN_TASK",
			],
			descriptionCompressed:
				"Pause, stop, resume, continue, archive, or reopen a coordinator task thread while preserving the durable thread history.",
		},
		{
			name: "TASK_HISTORY",
			description:
				"Query coordinator task history without stuffing raw transcripts into model context. Use this for active work, yesterday/last-week summaries, topic search, counts, and thread detail lookup.",
			parameters: [],
			similes: [
				"LIST_TASK_HISTORY",
				"GET_TASK_HISTORY",
				"SHOW_TASKS",
				"COUNT_TASKS",
				"TASK_STATUS_HISTORY",
			],
			descriptionCompressed:
				"Query coordinator task history without stuffing raw transcripts into model context. Use this for active work, yesterday/last-week summaries, topic search...",
		},
		{
			name: "TASK_SHARE",
			description:
				"Discover the best available way to view or share a task result, including artifacts, live preview URLs, workspace paths, and environment share capabilities.",
			parameters: [],
			similes: [
				"SHARE_TASK_RESULT",
				"SHOW_TASK_ARTIFACT",
				"VIEW_TASK_OUTPUT",
				"CAN_I_SEE_IT",
				"PULL_IT_UP",
			],
			descriptionCompressed:
				"Discover the best available way to view or share a task result, including artifacts, live preview URLs, workspace paths, and environment share capabilities.",
		},
		{
			name: "TERMINAL_ACTION",
			description:
				"Execute terminal commands and manage lightweight terminal sessions through the computer-use service. This includes connect, execute, read, type, clear, close, and the upstream execute_command alias.\n\n",
			parameters: [],
			similes: [
				"RUN_COMMAND",
				"EXECUTE_COMMAND",
				"SHELL_COMMAND",
				"TERMINAL",
				"RUN_SHELL",
			],
			descriptionCompressed:
				"Execute terminal commands and manage lightweight terminal sessions through the computer-use service. This includes connect, execute, read, type, clear...",
		},
		{
			name: "TOGGLE_SKILL",
			description:
				"Enable or disable an installed skill. Say 'enable <skill>' or 'disable <skill>'.",
			parameters: [],
			similes: [
				"ENABLE_SKILL",
				"DISABLE_SKILL",
				"TURN_ON_SKILL",
				"TURN_OFF_SKILL",
				"ACTIVATE_SKILL",
				"DEACTIVATE_SKILL",
			],
			descriptionCompressed:
				"Enable or disable an installed skill. Say 'enable <skill>' or 'disable <skill>'.",
		},
		{
			name: "TRANSFER_TO_INPUT",
			description:
				"Transfer accumulator value to input buffer for next operation.",
			parameters: [
				{
					name: "values",
					description: "The values to use.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["example"],
					descriptionCompressed: "The values to use.",
				},
			],
			similes: ["TRANSFER", "MOVE_TO_INPUT", "ACCUMULATOR_TO_INPUT"],
			exampleCalls: [
				{
					user: "Use TRANSFER_TO_INPUT with the provided parameters.",
					actions: ["TRANSFER_TO_INPUT"],
					params: {
						TRANSFER_TO_INPUT: {
							values: "example",
						},
					},
				},
			],
			descriptionCompressed:
				"Transfer accumulator value to input buffer for next operation.",
		},
		{
			name: "TRANSFER_TOKEN",
			description:
				"Transfer tokens or native BNB to another address. Use this when a user ",
			parameters: [],
			similes: [
				"SEND_TOKEN",
				"TRANSFER",
				"SEND",
				"SEND_BNB",
				"SEND_CRYPTO",
				"PAY",
			],
			descriptionCompressed:
				"Transfer tokens or native BNB to another address. Use when a user",
		},
		{
			name: "TWITCH_JOIN_CHANNEL",
			description: "Join a Twitch channel to listen and send messages",
			parameters: [],
			similes: ["JOIN_TWITCH_CHANNEL", "ENTER_CHANNEL", "CONNECT_CHANNEL"],
			descriptionCompressed: "Join a Twitch channel to listen and send msgs",
		},
		{
			name: "TWITCH_LEAVE_CHANNEL",
			description: "Leave a Twitch channel",
			parameters: [],
			similes: [
				"LEAVE_TWITCH_CHANNEL",
				"EXIT_CHANNEL",
				"PART_CHANNEL",
				"DISCONNECT_CHANNEL",
			],
			descriptionCompressed: "Leave a Twitch channel",
		},
		{
			name: "TWITCH_LIST_CHANNELS",
			description: "List all Twitch channels the bot is currently in",
			parameters: [],
			similes: [
				"LIST_TWITCH_CHANNELS",
				"SHOW_CHANNELS",
				"GET_CHANNELS",
				"CURRENT_CHANNELS",
			],
			descriptionCompressed: "List all Twitch channels the bot is in",
		},
		{
			name: "TWITCH_SEND_MESSAGE",
			description: "Send a message to a Twitch channel",
			parameters: [],
			similes: [
				"SEND_TWITCH_MESSAGE",
				"TWITCH_CHAT",
				"CHAT_TWITCH",
				"SAY_IN_TWITCH",
			],
			descriptionCompressed: "Send a msg to a Twitch channel",
		},
		{
			name: "UNBLOCK_APPS",
			description:
				"Owner-only. Remove the current app block, unshielding all blocked apps.",
			parameters: [],
			similes: [
				"UNBLOCK_APP",
				"REMOVE_APP_BLOCK",
				"STOP_BLOCKING_APPS",
				"UNSHIELD_APPS",
			],
			descriptionCompressed:
				"Owner-only. Remove the current app block, unshielding all blocked apps.",
		},
		{
			name: "UNBLOCK_WEBSITES",
			description:
				"Owner-only. Remove the current local website block by restoring the system hosts file entries Eliza added.",
			parameters: [],
			similes: [
				"SELFCONTROL_UNBLOCK_WEBSITES",
				"REMOVE_WEBSITE_BLOCK",
				"STOP_BLOCKING_SITES",
				"LIFT_WEBSITE_BLOCK",
			],
			descriptionCompressed:
				"Owner-only. Remove the current local website block by restoring the system hosts file entries Eliza added.",
		},
		{
			name: "UNEQUIP_ITEM",
			description: "Unequip a worn item by name",
			parameters: [],
			similes: ["REMOVE_ITEM", "TAKE_OFF_ITEM"],
			descriptionCompressed: "Unequip a worn item by name",
		},
		{
			name: "UNINSTALL_SKILL",
			description:
				"Uninstall a non-bundled skill. Bundled skills cannot be removed. ",
			parameters: [],
			similes: ["REMOVE_SKILL", "DELETE_SKILL"],
			descriptionCompressed:
				"Uninstall a non-bundled skill. Bundled skills cannot be removed.",
		},
		{
			name: "USE_COMPUTER",
			description:
				"Control the local desktop. This action can inspect the current screen, move the mouse, click, drag, type, press keys, scroll, and perform modified clicks. It is intended for real application interaction when the agent needs to operate the user's computer directly.\n\n",
			parameters: [],
			similes: [
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
				"CLICK_WITH_MODIFIERS",
				"TAKE_SCREENSHOT",
				"CAPTURE_SCREEN",
				"SEE_SCREEN",
			],
			descriptionCompressed:
				"Control the local desktop. inspect the current screen, move the mouse, click, drag, type, press keys, scroll, and perform modified clicks. It is intended for...",
		},
		{
			name: "USE_ITEM",
			description: "Use an item from inventory by name",
			parameters: [],
			similes: ["ACTIVATE_ITEM"],
			descriptionCompressed: "Use an item from inventory by name",
		},
		{
			name: "USE_ITEM_ON_ITEM",
			description: "Use one inventory item on another (e.g. tinderbox on logs)",
			parameters: [],
			similes: ["COMBINE_ITEMS"],
			descriptionCompressed:
				"Use one inventory item on another (e. g. tinderbox on logs)",
		},
		{
			name: "USE_ITEM_ON_OBJECT",
			description:
				"Use an inventory item on a world object (e.g. ore on furnace)",
			parameters: [],
			similes: ["ITEM_ON_OBJECT"],
			descriptionCompressed:
				"Use an inventory item on a world object (e. g. ore on furnace)",
		},
		{
			name: "USE_SKILL",
			description:
				"Invoke an enabled skill by slug. The skill's instructions or script run and the result returns to the conversation.",
			parameters: [],
			similes: ["INVOKE_SKILL", "EXECUTE_SKILL", "RUN_SKILL", "CALL_SKILL"],
			descriptionCompressed:
				"Invoke an enabled skill by slug. The skill's instructions or script run and the result returns to the convo.",
		},
		{
			name: "WALK_TO",
			description:
				"Walk the player to a coordinate or named destination (e.g. bank, lumbridge)",
			parameters: [],
			similes: ["MOVE_TO", "GO_TO", "TRAVEL_TO"],
			descriptionCompressed:
				"Walk the player to a coordinate or named destination (e. g. bank, lumbridge)",
		},
		{
			name: "WEB_SEARCH",
			description:
				"Perform a web search to find information related to the message.",
			parameters: [],
			similes: [
				"SEARCH_WEB",
				"INTERNET_SEARCH",
				"LOOKUP",
				"QUERY_WEB",
				"FIND_ONLINE",
				"SEARCH_ENGINE",
				"WEB_LOOKUP",
				"ONLINE_SEARCH",
				"FIND_INFORMATION",
			],
			descriptionCompressed:
				"Perform a web search to find info related to the msg.",
		},
		{
			name: "WITHDRAW_ITEM",
			description:
				"Withdraw an item from the bank by name, optionally specifying a count (defaults to 1)",
			parameters: [],
			similes: ["TAKE_FROM_BANK"],
			descriptionCompressed:
				"Withdraw an item from the bank by name, optionally specifying a count (defaults to 1)",
		},
	],
} as const satisfies { version: string; actions: readonly ActionDoc[] };
export const coreProvidersSpec = {
	version: "1.0.0",
	providers: [
		{
			name: "ACTIONS",
			description: "Possible response actions",
			position: -1,
			dynamic: false,
			descriptionCompressed: "Available response actions.",
		},
		{
			name: "CHARACTER",
			description:
				"Provides the agent's character definition and personality information including bio, topics, adjectives, style directions, and example conversations",
			dynamic: false,
			descriptionCompressed:
				"Agent character: bio, topics, adjectives, style, example conversations.",
		},
		{
			name: "RECENT_MESSAGES",
			description:
				"Provides recent message history from the current conversation including formatted messages, posts, action results, and recent interactions",
			position: 100,
			dynamic: true,
			descriptionCompressed:
				"Recent conversation messages, posts, action results.",
		},
		{
			name: "ACTION_STATE",
			description:
				"Provides information about the current action state and available actions",
			dynamic: true,
			descriptionCompressed: "Current action state and available actions.",
		},
		{
			name: "ATTACHMENTS",
			description: "Media attachments in the current message",
			dynamic: true,
			descriptionCompressed: "Media attachments in current message.",
		},
		{
			name: "CAPABILITIES",
			description:
				"Agent capabilities including models, services, and features",
			dynamic: false,
			descriptionCompressed: "Agent capabilities: models, services, features.",
		},
		{
			name: "CHOICE",
			description:
				"Available choice options for selection when there are pending tasks or decisions",
			dynamic: true,
			descriptionCompressed: "Pending choice options for multi-option tasks.",
		},
		{
			name: "CONTACTS",
			description:
				"Provides contact information from the relationships including categories and preferences",
			dynamic: true,
			descriptionCompressed: "Contact info from relationships with categories.",
		},
		{
			name: "CONTEXT_BENCH",
			description: "Benchmark/task context injected by a benchmark harness",
			position: 5,
			dynamic: true,
			descriptionCompressed: "Benchmark/task context from harness.",
		},
		{
			name: "ENTITIES",
			description:
				"Provides information about entities in the current context including users, agents, and participants",
			dynamic: true,
			descriptionCompressed:
				"Entities in context: users, agents, participants.",
		},
		{
			name: "EVALUATORS",
			description: "Available evaluators for assessing agent behavior",
			dynamic: false,
			descriptionCompressed: "Available evaluators for agent behavior.",
		},
		{
			name: "FACTS",
			description:
				"Provides known facts about entities learned through conversation",
			dynamic: true,
			descriptionCompressed: "Known facts about entities from conversation.",
		},
		{
			name: "FOLLOW_UPS",
			description:
				"Provides information about upcoming follow-ups and reminders scheduled for contacts",
			dynamic: true,
			descriptionCompressed: "Upcoming follow-ups/reminders for contacts.",
		},
		{
			name: "KNOWLEDGE",
			description:
				"Provides relevant knowledge from the agent's knowledge base based on semantic similarity",
			dynamic: true,
			descriptionCompressed: "Relevant knowledge from KB via semantic search.",
		},
		{
			name: "PROVIDERS",
			description: "Available context providers",
			dynamic: false,
			descriptionCompressed: "Available context providers.",
		},
		{
			name: "RELATIONSHIPS",
			description:
				"Relationships between entities observed by the agent including tags and metadata",
			dynamic: true,
			descriptionCompressed: "Entity relationships with tags/metadata.",
		},
		{
			name: "ROLES",
			description:
				"Roles assigned to entities in the current context (Admin, Owner, Member, None)",
			dynamic: true,
			descriptionCompressed:
				"Entity roles in context (Admin/Owner/Member/None).",
		},
		{
			name: "SETTINGS",
			description:
				"Current settings for the agent/server (filtered for security, excludes sensitive keys)",
			dynamic: true,
			descriptionCompressed: "Agent/server settings (security-filtered).",
		},
		{
			name: "TIME",
			description:
				"Provides the current date and time in UTC for time-based operations or responses",
			dynamic: true,
			descriptionCompressed: "Current UTC date/time.",
		},
		{
			name: "WORLD",
			description:
				"Provides information about the current world context including settings and members",
			dynamic: true,
			descriptionCompressed: "World context: settings and members.",
		},
		{
			name: "LONG_TERM_MEMORY",
			description:
				"Persistent facts and preferences about the user learned and remembered across conversations",
			position: 50,
			dynamic: false,
			descriptionCompressed:
				"Persistent user facts/preferences across conversations.",
		},
		{
			name: "SUMMARIZED_CONTEXT",
			description:
				"Provides summarized context from previous conversations for optimized context usage",
			position: 96,
			dynamic: false,
			descriptionCompressed: "Summarized context from prior conversations.",
		},
		{
			name: "AGENT_SETTINGS",
			description:
				"Provides the agent's current configuration settings (filtered for security)",
			dynamic: true,
			descriptionCompressed: "Agent config settings (security-filtered).",
		},
		{
			name: "CURRENT_TIME",
			description:
				"Provides current time and date information in various formats",
			dynamic: true,
			descriptionCompressed: "Current time/date in various formats.",
		},
	],
} as const satisfies { version: string; providers: readonly ProviderDoc[] };
export const allProvidersSpec = {
	version: "1.0.0",
	providers: [
		{
			name: "ACTIONS",
			description: "Possible response actions",
			position: -1,
			dynamic: false,
			descriptionCompressed: "Available response actions.",
		},
		{
			name: "CHARACTER",
			description:
				"Provides the agent's character definition and personality information including bio, topics, adjectives, style directions, and example conversations",
			dynamic: false,
			descriptionCompressed:
				"Agent character: bio, topics, adjectives, style, example conversations.",
		},
		{
			name: "RECENT_MESSAGES",
			description:
				"Provides recent message history from the current conversation including formatted messages, posts, action results, and recent interactions",
			position: 100,
			dynamic: true,
			descriptionCompressed:
				"Recent conversation messages, posts, action results.",
		},
		{
			name: "ACTION_STATE",
			description:
				"Provides information about the current action state and available actions",
			dynamic: true,
			descriptionCompressed: "Current action state and available actions.",
		},
		{
			name: "ATTACHMENTS",
			description: "Media attachments in the current message",
			dynamic: true,
			descriptionCompressed: "Media attachments in current message.",
		},
		{
			name: "CAPABILITIES",
			description:
				"Agent capabilities including models, services, and features",
			dynamic: false,
			descriptionCompressed: "Agent capabilities: models, services, features.",
		},
		{
			name: "CHOICE",
			description:
				"Available choice options for selection when there are pending tasks or decisions",
			dynamic: true,
			descriptionCompressed: "Pending choice options for multi-option tasks.",
		},
		{
			name: "CONTACTS",
			description:
				"Provides contact information from the relationships including categories and preferences",
			dynamic: true,
			descriptionCompressed: "Contact info from relationships with categories.",
		},
		{
			name: "CONTEXT_BENCH",
			description: "Benchmark/task context injected by a benchmark harness",
			position: 5,
			dynamic: true,
			descriptionCompressed: "Benchmark/task context from harness.",
		},
		{
			name: "ENTITIES",
			description:
				"Provides information about entities in the current context including users, agents, and participants",
			dynamic: true,
			descriptionCompressed:
				"Entities in context: users, agents, participants.",
		},
		{
			name: "EVALUATORS",
			description: "Available evaluators for assessing agent behavior",
			dynamic: false,
			descriptionCompressed: "Available evaluators for agent behavior.",
		},
		{
			name: "FACTS",
			description:
				"Provides known facts about entities learned through conversation",
			dynamic: true,
			descriptionCompressed: "Known facts about entities from conversation.",
		},
		{
			name: "FOLLOW_UPS",
			description:
				"Provides information about upcoming follow-ups and reminders scheduled for contacts",
			dynamic: true,
			descriptionCompressed: "Upcoming follow-ups/reminders for contacts.",
		},
		{
			name: "KNOWLEDGE",
			description:
				"Provides relevant knowledge from the agent's knowledge base based on semantic similarity",
			dynamic: true,
			descriptionCompressed: "Relevant knowledge from KB via semantic search.",
		},
		{
			name: "PROVIDERS",
			description: "Available context providers",
			dynamic: false,
			descriptionCompressed: "Available context providers.",
		},
		{
			name: "RELATIONSHIPS",
			description:
				"Relationships between entities observed by the agent including tags and metadata",
			dynamic: true,
			descriptionCompressed: "Entity relationships with tags/metadata.",
		},
		{
			name: "ROLES",
			description:
				"Roles assigned to entities in the current context (Admin, Owner, Member, None)",
			dynamic: true,
			descriptionCompressed:
				"Entity roles in context (Admin/Owner/Member/None).",
		},
		{
			name: "SETTINGS",
			description:
				"Current settings for the agent/server (filtered for security, excludes sensitive keys)",
			dynamic: true,
			descriptionCompressed: "Agent/server settings (security-filtered).",
		},
		{
			name: "TIME",
			description:
				"Provides the current date and time in UTC for time-based operations or responses",
			dynamic: true,
			descriptionCompressed: "Current UTC date/time.",
		},
		{
			name: "WORLD",
			description:
				"Provides information about the current world context including settings and members",
			dynamic: true,
			descriptionCompressed: "World context: settings and members.",
		},
		{
			name: "LONG_TERM_MEMORY",
			description:
				"Persistent facts and preferences about the user learned and remembered across conversations",
			position: 50,
			dynamic: false,
			descriptionCompressed:
				"Persistent user facts/preferences across conversations.",
		},
		{
			name: "SUMMARIZED_CONTEXT",
			description:
				"Provides summarized context from previous conversations for optimized context usage",
			position: 96,
			dynamic: false,
			descriptionCompressed: "Summarized context from prior conversations.",
		},
		{
			name: "AGENT_SETTINGS",
			description:
				"Provides the agent's current configuration settings (filtered for security)",
			dynamic: true,
			descriptionCompressed: "Agent config settings (security-filtered).",
		},
		{
			name: "CURRENT_TIME",
			description:
				"Provides current time and date information in various formats",
			dynamic: true,
			descriptionCompressed: "Current time/date in various formats.",
		},
	],
} as const satisfies { version: string; providers: readonly ProviderDoc[] };
export const coreEvaluatorsSpec = {
	version: "1.0.0",
	evaluators: [
		{
			name: "REFLECTION",
			description:
				"Generate a self-reflective thought on the conversation, then extract facts and relationships between entities in the conversation. Reflects on agent behavior and provides feedback for improvement.",
			similes: [
				"REFLECT",
				"SELF_REFLECT",
				"EVALUATE_INTERACTION",
				"ASSESS_SITUATION",
			],
			alwaysRun: false,
			examples: [
				{
					prompt:
						"Agent Name: Sarah\nAgent Role: Community Manager\nRoom Type: group\nCurrent Room: general-chat\nMessage Sender: John (user-123)",
					messages: [
						{
							name: "John",
							content: {
								text: "Hey everyone, I'm new here!",
							},
						},
						{
							name: "Sarah",
							content: {
								text: "Welcome John! How did you find our community?",
							},
						},
						{
							name: "John",
							content: {
								text: "Through a friend who's really into AI",
							},
						},
					],
					outcome:
						'thought: "I\'m engaging appropriately with a new community member, maintaining a welcoming and professional tone. My questions are helping to learn more about John and make him feel welcome."\nfacts[0]:\n  claim: John is new to the community\n  type: fact\n  in_bio: false\n  already_known: false\nfacts[1]:\n  claim: John found the community through a friend interested in AI\n  type: fact\n  in_bio: false\n  already_known: false\nrelationships[0]:\n  sourceEntityId: sarah-agent\n  targetEntityId: user-123\n  tags[0]: group_interaction',
				},
				{
					prompt:
						"Agent Name: Alex\nAgent Role: Tech Support\nRoom Type: group\nCurrent Room: tech-help\nMessage Sender: Emma (user-456)",
					messages: [
						{
							name: "Emma",
							content: {
								text: "My app keeps crashing when I try to upload files",
							},
						},
						{
							name: "Alex",
							content: {
								text: "Have you tried clearing your cache?",
							},
						},
						{
							name: "Emma",
							content: {
								text: "No response...",
							},
						},
						{
							name: "Alex",
							content: {
								text: "Emma, are you still there? We can try some other troubleshooting steps.",
							},
						},
					],
					outcome:
						"thought: \"I'm not sure if I'm being helpful or if Emma is frustrated with my suggestions. The lack of response is concerning - maybe I should have asked for more details about the issue first before jumping to solutions.\"\nfacts[0]:\n  claim: Emma is having technical issues with file uploads\n  type: fact\n  in_bio: false\n  already_known: false\nfacts[1]:\n  claim: Emma stopped responding after the first troubleshooting suggestion\n  type: fact\n  in_bio: false\n  already_known: false\nrelationships[0]:\n  sourceEntityId: alex-agent\n  targetEntityId: user-456\n  tags[0]: group_interaction\n  tags[1]: support_interaction\n  tags[2]: incomplete_interaction",
				},
				{
					prompt:
						"Agent Name: Max\nAgent Role: Discussion Facilitator\nRoom Type: group\nCurrent Room: book-club\nMessage Sender: Lisa (user-789)",
					messages: [
						{
							name: "Lisa",
							content: {
								text: "What did everyone think about chapter 5?",
							},
						},
						{
							name: "Max",
							content: {
								text: "The symbolism was fascinating! The red door clearly represents danger.",
							},
						},
						{
							name: "Max",
							content: {
								text: "And did anyone notice how the author used weather to reflect the protagonist's mood?",
							},
						},
						{
							name: "Max",
							content: {
								text: "Plus the foreshadowing in the first paragraph was brilliant!",
							},
						},
						{
							name: "Max",
							content: {
								text: "I also have thoughts about the character development...",
							},
						},
					],
					outcome:
						"thought: \"I'm dominating the conversation and not giving others a chance to share their perspectives. I've sent multiple messages in a row without waiting for responses. I need to step back and create space for other members to participate.\"\nfacts[0]:\n  claim: The discussion is about chapter 5 of a book\n  type: fact\n  in_bio: false\n  already_known: false\nfacts[1]:\n  claim: Max has sent 4 consecutive messages without user responses\n  type: fact\n  in_bio: false\n  already_known: false\nrelationships[0]:\n  sourceEntityId: max-agent\n  targetEntityId: user-789\n  tags[0]: group_interaction\n  tags[1]: excessive_interaction",
				},
			],
			descriptionCompressed:
				"Generate a self-reflective thought on the convo, then extract facts and relationships between entities in the convo. Reflects on agent behavior and provides...",
		},
		{
			name: "RELATIONSHIP_EXTRACTION",
			description:
				"Passively extracts and updates relationship information from conversations. Identifies platform identities, relationship indicators, and mentioned third parties.",
			similes: [
				"RELATIONSHIP_ANALYZER",
				"SOCIAL_GRAPH_BUILDER",
				"CONTACT_EXTRACTOR",
			],
			alwaysRun: false,
			examples: [
				{
					prompt: "User introduces themselves with social media",
					messages: [
						{
							name: "{{name1}}",
							content: {
								type: "text",
								text: "Hi, I'm Sarah Chen. You can find me on X @sarahchen_dev",
							},
						},
					],
					outcome:
						"Extracts X handle and creates/updates the entity with a platform identity.",
				},
			],
			descriptionCompressed:
				"Passively extracts and updates relationship info from convos. Identifies platform identities, relationship indicators, and mentioned third parties.",
		},
		{
			name: "MEMORY_SUMMARIZATION",
			description:
				"Automatically summarizes conversations to optimize context usage. Compresses conversation history while preserving important information.",
			similes: [
				"CONVERSATION_SUMMARY",
				"CONTEXT_COMPRESSION",
				"MEMORY_OPTIMIZATION",
			],
			alwaysRun: true,
			examples: [],
			descriptionCompressed:
				"Auto summarizes convos to optimize context usage. Compresses convo history while preserving important info.",
		},
		{
			name: "LONG_TERM_MEMORY_EXTRACTION",
			description:
				"Extracts long-term facts about users from conversations. Identifies and stores persistent information like preferences, interests, and personal details.",
			similes: ["MEMORY_EXTRACTION", "FACT_LEARNING", "USER_PROFILING"],
			alwaysRun: true,
			examples: [],
			descriptionCompressed:
				"Extract long-term facts about users from convos. Identifies and stores persistent info like preferences, interests, and personal details.",
		},
	],
} as const satisfies {
	version: string;
	evaluators: readonly EvaluatorDoc[];
};
export const allEvaluatorsSpec = {
	version: "1.0.0",
	evaluators: [
		{
			name: "REFLECTION",
			description:
				"Generate a self-reflective thought on the conversation, then extract facts and relationships between entities in the conversation. Reflects on agent behavior and provides feedback for improvement.",
			similes: [
				"REFLECT",
				"SELF_REFLECT",
				"EVALUATE_INTERACTION",
				"ASSESS_SITUATION",
			],
			alwaysRun: false,
			examples: [
				{
					prompt:
						"Agent Name: Sarah\nAgent Role: Community Manager\nRoom Type: group\nCurrent Room: general-chat\nMessage Sender: John (user-123)",
					messages: [
						{
							name: "John",
							content: {
								text: "Hey everyone, I'm new here!",
							},
						},
						{
							name: "Sarah",
							content: {
								text: "Welcome John! How did you find our community?",
							},
						},
						{
							name: "John",
							content: {
								text: "Through a friend who's really into AI",
							},
						},
					],
					outcome:
						'thought: "I\'m engaging appropriately with a new community member, maintaining a welcoming and professional tone. My questions are helping to learn more about John and make him feel welcome."\nfacts[0]:\n  claim: John is new to the community\n  type: fact\n  in_bio: false\n  already_known: false\nfacts[1]:\n  claim: John found the community through a friend interested in AI\n  type: fact\n  in_bio: false\n  already_known: false\nrelationships[0]:\n  sourceEntityId: sarah-agent\n  targetEntityId: user-123\n  tags[0]: group_interaction',
				},
				{
					prompt:
						"Agent Name: Alex\nAgent Role: Tech Support\nRoom Type: group\nCurrent Room: tech-help\nMessage Sender: Emma (user-456)",
					messages: [
						{
							name: "Emma",
							content: {
								text: "My app keeps crashing when I try to upload files",
							},
						},
						{
							name: "Alex",
							content: {
								text: "Have you tried clearing your cache?",
							},
						},
						{
							name: "Emma",
							content: {
								text: "No response...",
							},
						},
						{
							name: "Alex",
							content: {
								text: "Emma, are you still there? We can try some other troubleshooting steps.",
							},
						},
					],
					outcome:
						"thought: \"I'm not sure if I'm being helpful or if Emma is frustrated with my suggestions. The lack of response is concerning - maybe I should have asked for more details about the issue first before jumping to solutions.\"\nfacts[0]:\n  claim: Emma is having technical issues with file uploads\n  type: fact\n  in_bio: false\n  already_known: false\nfacts[1]:\n  claim: Emma stopped responding after the first troubleshooting suggestion\n  type: fact\n  in_bio: false\n  already_known: false\nrelationships[0]:\n  sourceEntityId: alex-agent\n  targetEntityId: user-456\n  tags[0]: group_interaction\n  tags[1]: support_interaction\n  tags[2]: incomplete_interaction",
				},
				{
					prompt:
						"Agent Name: Max\nAgent Role: Discussion Facilitator\nRoom Type: group\nCurrent Room: book-club\nMessage Sender: Lisa (user-789)",
					messages: [
						{
							name: "Lisa",
							content: {
								text: "What did everyone think about chapter 5?",
							},
						},
						{
							name: "Max",
							content: {
								text: "The symbolism was fascinating! The red door clearly represents danger.",
							},
						},
						{
							name: "Max",
							content: {
								text: "And did anyone notice how the author used weather to reflect the protagonist's mood?",
							},
						},
						{
							name: "Max",
							content: {
								text: "Plus the foreshadowing in the first paragraph was brilliant!",
							},
						},
						{
							name: "Max",
							content: {
								text: "I also have thoughts about the character development...",
							},
						},
					],
					outcome:
						"thought: \"I'm dominating the conversation and not giving others a chance to share their perspectives. I've sent multiple messages in a row without waiting for responses. I need to step back and create space for other members to participate.\"\nfacts[0]:\n  claim: The discussion is about chapter 5 of a book\n  type: fact\n  in_bio: false\n  already_known: false\nfacts[1]:\n  claim: Max has sent 4 consecutive messages without user responses\n  type: fact\n  in_bio: false\n  already_known: false\nrelationships[0]:\n  sourceEntityId: max-agent\n  targetEntityId: user-789\n  tags[0]: group_interaction\n  tags[1]: excessive_interaction",
				},
			],
			descriptionCompressed:
				"Generate a self-reflective thought on the convo, then extract facts and relationships between entities in the convo. Reflects on agent behavior and provides...",
		},
		{
			name: "RELATIONSHIP_EXTRACTION",
			description:
				"Passively extracts and updates relationship information from conversations. Identifies platform identities, relationship indicators, and mentioned third parties.",
			similes: [
				"RELATIONSHIP_ANALYZER",
				"SOCIAL_GRAPH_BUILDER",
				"CONTACT_EXTRACTOR",
			],
			alwaysRun: false,
			examples: [
				{
					prompt: "User introduces themselves with social media",
					messages: [
						{
							name: "{{name1}}",
							content: {
								type: "text",
								text: "Hi, I'm Sarah Chen. You can find me on X @sarahchen_dev",
							},
						},
					],
					outcome:
						"Extracts X handle and creates/updates the entity with a platform identity.",
				},
			],
			descriptionCompressed:
				"Passively extracts and updates relationship info from convos. Identifies platform identities, relationship indicators, and mentioned third parties.",
		},
		{
			name: "MEMORY_SUMMARIZATION",
			description:
				"Automatically summarizes conversations to optimize context usage. Compresses conversation history while preserving important information.",
			similes: [
				"CONVERSATION_SUMMARY",
				"CONTEXT_COMPRESSION",
				"MEMORY_OPTIMIZATION",
			],
			alwaysRun: true,
			examples: [],
			descriptionCompressed:
				"Auto summarizes convos to optimize context usage. Compresses convo history while preserving important info.",
		},
		{
			name: "LONG_TERM_MEMORY_EXTRACTION",
			description:
				"Extracts long-term facts about users from conversations. Identifies and stores persistent information like preferences, interests, and personal details.",
			similes: ["MEMORY_EXTRACTION", "FACT_LEARNING", "USER_PROFILING"],
			alwaysRun: true,
			examples: [],
			descriptionCompressed:
				"Extract long-term facts about users from convos. Identifies and stores persistent info like preferences, interests, and personal details.",
		},
	],
} as const satisfies {
	version: string;
	evaluators: readonly EvaluatorDoc[];
};

export const coreActionDocs: readonly ActionDoc[] = coreActionsSpec.actions;
export const allActionDocs: readonly ActionDoc[] = allActionsSpec.actions;
export const coreProviderDocs: readonly ProviderDoc[] =
	coreProvidersSpec.providers;
export const allProviderDocs: readonly ProviderDoc[] =
	allProvidersSpec.providers;
export const coreEvaluatorDocs: readonly EvaluatorDoc[] =
	coreEvaluatorsSpec.evaluators;
export const allEvaluatorDocs: readonly EvaluatorDoc[] =
	allEvaluatorsSpec.evaluators;
