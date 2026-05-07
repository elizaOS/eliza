/**
 * Auto-generated canonical action/provider/evaluator docs.
 * DO NOT EDIT - Generated from packages/prompts/specs/**.
 */

export type ActionDocParameterExampleValue = string | number | boolean | null;

export type ActionDocParameterSchema = {
	type: "string" | "number" | "integer" | "boolean" | "object" | "array";
	description?: string;
	default?: ActionDocParameterExampleValue;
	enum?: string[];
	properties?: Record<string, ActionDocParameterSchema>;
	items?: ActionDocParameterSchema;
	oneOf?: ActionDocParameterSchema[];
	anyOf?: ActionDocParameterSchema[];
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
				"Reply in current chat only; use connector actions for external connector sends.",
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
					descriptionCompressed: "source platform (telegram, discord, x).",
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
					description:
						"Structured fields to update, such as notes, tags, categories, preferences, or custom fields.",
					required: true,
					schema: {
						type: "string",
					},
					examples: ["notes: prefers email; tags: friend"],
					descriptionCompressed:
						"Structured fields to update: notes, tags, category/categories, preferences.",
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
					description: "Key/value setting updates to apply.",
					required: true,
					schema: {
						type: "string",
					},
					examples: ["model: gpt-5"],
					descriptionCompressed: "Key/value setting updates.",
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
					description: "Named field updates to apply.",
					required: true,
					schema: {
						type: "string",
					},
					examples: ["bio: Loves Rust"],
					descriptionCompressed: "Named field updates.",
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
				"Reply in current chat only; use connector actions for external connector sends.",
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
					descriptionCompressed: "source platform (telegram, discord, x).",
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
					description:
						"Structured fields to update, such as notes, tags, categories, preferences, or custom fields.",
					required: true,
					schema: {
						type: "string",
					},
					examples: ["notes: prefers email; tags: friend"],
					descriptionCompressed:
						"Structured fields to update: notes, tags, category/categories, preferences.",
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
					description: "Key/value setting updates to apply.",
					required: true,
					schema: {
						type: "string",
					},
					examples: ["model: gpt-5"],
					descriptionCompressed: "Key/value setting updates.",
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
					description: "Named field updates to apply.",
					required: true,
					schema: {
						type: "string",
					},
					examples: ["bio: Loves Rust"],
					descriptionCompressed: "Named field updates.",
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
			parameters: [
				{
					name: "workflowId",
					description: "Optional exact n8n workflow id to activate.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Optional exact n8n workflow id to activate.",
				},
				{
					name: "workflowName",
					description: "Optional workflow name to activate.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Optional workflow name to activate.",
				},
				{
					name: "query",
					description:
						"Optional natural-language description of the workflow to activate.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Optional natural-language description of the workflow to activate.",
				},
			],
			descriptionCompressed:
				"activate n8n workflow start process trigger run automatically identify workflow ID, name, semantic description language",
			similes: [
				"ACTIVATE_WORKFLOW",
				"ENABLE_WORKFLOW",
				"START_WORKFLOW",
				"TURN_ON_WORKFLOW",
			],
			exampleCalls: [
				{
					user: "Use ACTIVATE_N8N_WORKFLOW with the provided parameters.",
					actions: ["ACTIVATE_N8N_WORKFLOW"],
					params: {
						ACTIVATE_N8N_WORKFLOW: {
							workflowId: "example",
							workflowName: "example",
							query: "example",
						},
					},
				},
			],
		},
		{
			name: "ASK_USER_QUESTION",
			description:
				"Broadcast 1-4 structured questions back to the user. Each question has a short header, a full question string, and optional multi-choice options with descriptions and previews. This is a structured-question broadcast surface — the action returns the question payload as data so a UI layer can render it; the action does NOT block waiting for an answer. UI integration is pending; for now treat the response as a published question, not as an interactive prompt.",
			parameters: [
				{
					name: "questions",
					description:
						"Array of 1-4 question objects. Each: { question: string, header: string, options?: Array<{label, description?, preview?}>, multiSelect?: boolean }. If options is empty/undefined, the question is treated as freeform.",
					required: true,
					schema: {
						type: "array",
						items: {
							type: "object",
							properties: {
								question: {
									type: "string",
								},
								header: {
									type: "string",
								},
								multiSelect: {
									type: "boolean",
								},
								options: {
									type: "array",
									items: {
										type: "object",
										properties: {
											label: {
												type: "string",
											},
											description: {
												type: "string",
											},
											preview: {
												type: "string",
											},
										},
									},
								},
							},
						},
					},
					descriptionCompressed:
						"Array of 1-4 question objects. Each: { question: string, header: string, options?: Array<{label, description?, preview?}>, multiSelect?: boolean }. If...",
				},
			],
			descriptionCompressed:
				"Broadcast 1-4 structured questions to the user (UI integration pending; non-blocking).",
			similes: ["ASK", "CLARIFY"],
			exampleCalls: [
				{
					user: "Use ASK_USER_QUESTION with the provided parameters.",
					actions: ["ASK_USER_QUESTION"],
					params: {
						ASK_USER_QUESTION: {
							questions: "example",
						},
					},
				},
			],
		},
		{
			name: "ATTACK_NPC",
			description:
				"Engage a nearby NPC in combat by its instance id. The server pathfinds the agent into attack range automatically.",
			parameters: [
				{
					name: "npcId",
					description: "Nearby NPC instance id from the SCAPE_NEARBY provider.",
					required: true,
					schema: {
						type: "number",
					},
					descriptionCompressed: "NPC id.",
				},
			],
			descriptionCompressed: "Attack NPC by id.",
			similes: ["FIGHT_NPC", "KILL_NPC", "ENGAGE"],
			exampleCalls: [
				{
					user: "Use ATTACK_NPC with the provided parameters.",
					actions: ["ATTACK_NPC"],
					params: {
						ATTACK_NPC: {
							npcId: 1,
						},
					},
				},
			],
		},
		{
			name: "BASH",
			description:
				"Execute a shell command via /bin/bash -c <command>. Runs in the session cwd unless an explicit cwd inside the sandbox roots is supplied. Foreground commands return stdout, stderr, and exit code. Long-running commands auto-promote to background and return a task_id; pass run_in_background=true to background immediately. Respects the sandbox command denylist.",
			parameters: [
				{
					name: "command",
					description:
						"Shell command to run; executed via /bin/bash -c <command>.",
					required: true,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Shell command to run. executed via /bin/bash -c <command>.",
				},
				{
					name: "description",
					description:
						"Five to ten word humanly-readable summary of the command.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Five to ten word humanly-readable summary of the command.",
				},
				{
					name: "timeout",
					description:
						"Hard timeout in ms; clamped to [100, 600000]. Default 120000.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed:
						"Hard timeout in ms. clamped to [100, 600000]. Default 120000.",
				},
				{
					name: "cwd",
					description:
						"Absolute working directory; must resolve inside the configured workspace roots. Defaults to the session cwd.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Absolute working directory. must resolve inside the configured workspace roots. Defaults to the session cwd.",
				},
				{
					name: "run_in_background",
					description:
						"If true, return a task_id immediately. Use TASK_OUTPUT to poll and TASK_STOP to terminate.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed:
						"If true, return a task_id immediately. Use TASK_OUTPUT to poll and TASK_STOP to terminate.",
				},
			],
			descriptionCompressed:
				"Run a shell command (foreground or background) within sandbox roots.",
			similes: ["SHELL", "EXEC", "RUN_COMMAND"],
			exampleCalls: [
				{
					user: "Use BASH with the provided parameters.",
					actions: ["BASH"],
					params: {
						BASH: {
							command: "example",
							description: "example",
							timeout: 1,
							cwd: "example",
							run_in_background: false,
						},
					},
				},
			],
		},
		{
			name: "BLOCK_UNTIL_TASK_COMPLETE",
			description:
				"Block websites until a specific todo is marked complete. Use this only when the unblock condition is finishing a task, workout, assignment, or todo, like 'block x.com until I finish my workout'. ",
			parameters: [
				{
					name: "websites",
					description: "List of website hostnames to block.",
					required: true,
					schema: {
						type: "array",
						items: {
							type: "string",
						},
					},
					descriptionCompressed: "List of website hostnames to block.",
				},
				{
					name: "todoId",
					description:
						"ID of an existing todo. Preferred over todoName when known.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"ID of an existing todo. Preferred over todoName when known.",
				},
				{
					name: "todoName",
					description:
						"Name of the todo. Resolved against active todos; created if no match.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Name of the todo. Resolved against active todos. created if no match.",
				},
				{
					name: "unlockDurationMinutes",
					description:
						"Optional: once the gate is satisfied, re-lock the same websites after this many minutes.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed:
						"Optional: once the gate is satisfied, re-lock the same websites after this many minutes.",
				},
				{
					name: "profile",
					description: "Optional profile label for the block rule.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Optional profile label for the block rule.",
				},
			],
			descriptionCompressed: "Block websites until a named todo is completed.",
			similes: [
				"BLOCK_SITES_UNTIL_TODO_DONE",
				"BLOCK_WEBSITE_UNTIL_TASK",
				"CONDITIONAL_WEBSITE_BLOCK",
				"BLOCK_UNTIL_DONE",
				"FOCUS_UNTIL_TASK_DONE",
			],
			exampleCalls: [
				{
					user: "Use BLOCK_UNTIL_TASK_COMPLETE with the provided parameters.",
					actions: ["BLOCK_UNTIL_TASK_COMPLETE"],
					params: {
						BLOCK_UNTIL_TASK_COMPLETE: {
							websites: "example",
							todoId: "example",
							todoName: "example",
							unlockDurationMinutes: 1,
							profile: "example",
						},
					},
				},
			],
		},
		{
			name: "BLUEBUBBLES_MESSAGE_OP",
			description:
				"BlueBubbles iMessage operation router. Send a reply or react to a message by setting op (send | react).",
			parameters: [
				{
					name: "op",
					description: "Operation to run: send or react.",
					required: false,
					schema: {
						type: "string",
						enum: ["send", "react"],
					},
					descriptionCompressed: "Operation to run: send or react.",
				},
				{
					name: "text",
					description: "Message text for send.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "msg text for send.",
				},
				{
					name: "to",
					description:
						"BlueBubbles chat guid, handle, or current conversation.",
					required: false,
					schema: {
						type: "string",
						default: "current",
					},
					descriptionCompressed:
						"BlueBubbles chat guid, handle, or current convo.",
				},
				{
					name: "messageGuid",
					description: "Target message guid for reactions.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Target msg guid for reactions.",
				},
				{
					name: "emoji",
					description: "Reaction emoji.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Reaction emoji.",
				},
			],
			descriptionCompressed: "Bluebubbles message ops: send, react.",
			similes: [
				"SEND_IMESSAGE",
				"TEXT_MESSAGE",
				"IMESSAGE_REPLY",
				"BLUEBUBBLES_SEND",
				"APPLE_MESSAGE",
				"BLUEBUBBLES_REACT",
				"BB_REACTION",
				"IMESSAGE_REACT",
			],
			exampleCalls: [
				{
					user: "Use BLUEBUBBLES_MESSAGE_OP with the provided parameters.",
					actions: ["BLUEBUBBLES_MESSAGE_OP"],
					params: {
						BLUEBUBBLES_MESSAGE_OP: {
							op: "send",
							text: "example",
							to: "current",
							messageGuid: "example",
							emoji: "example",
						},
					},
				},
			],
		},
		{
			name: "BROWSER_ACTION",
			description:
				"browser_action:\n  purpose: Control a Chromium-based browser through the local runtime: launch, navigate, interact, inspect, execute JavaScript, wait, and manage tabs.\n  provider_state: Read-only browser availability and recent action state are available from the computerState provider. Use state/info/list_tabs only for explicit live refreshes.\n  flow: Open or connect first, then navigate and interact. Use clickables to discover interactive elements.\n  actions: open/connect/close/navigate/click/type/scroll/screenshot/dom/get_dom/clickables/get_clickables/execute/state/info/context/get_context/wait/list_tabs/open_tab/close_tab/switch_tab.",
			parameters: [
				{
					name: "action",
					description: "Browser action to perform.",
					required: true,
					schema: {
						type: "string",
						enum: [
							"open",
							"connect",
							"close",
							"navigate",
							"click",
							"type",
							"scroll",
							"screenshot",
							"dom",
							"get_dom",
							"clickables",
							"get_clickables",
							"execute",
							"state",
							"info",
							"context",
							"get_context",
							"wait",
							"list_tabs",
							"open_tab",
							"close_tab",
							"switch_tab",
						],
					},
					descriptionCompressed: "Browser action to perform.",
				},
				{
					name: "url",
					description: "URL for open, navigate, or open_tab.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "URL for open, navigate, or open_tab.",
				},
				{
					name: "selector",
					description: "CSS selector for click, type, or wait.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "CSS selector for click, type, or wait.",
				},
				{
					name: "coordinate",
					description: "Viewport [x, y] coordinate for click.",
					required: false,
					schema: {
						type: "array",
						items: {
							type: "number",
						},
					},
					descriptionCompressed: "Viewport [x, y] coordinate for click.",
				},
				{
					name: "text",
					description: "Text to type, text to click, or text to wait for.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Text to type, text to click, or text to wait for.",
				},
				{
					name: "code",
					description: "JavaScript source to execute in the page.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "JavaScript source to execute in the page.",
				},
				{
					name: "direction",
					description: "Scroll direction.",
					required: false,
					schema: {
						type: "string",
						enum: ["up", "down"],
					},
					descriptionCompressed: "Scroll direction.",
				},
				{
					name: "amount",
					description: "Scroll amount in pixels.",
					required: false,
					schema: {
						type: "number",
						default: 300,
					},
					descriptionCompressed: "Scroll amount in pixels.",
				},
				{
					name: "tabId",
					description: "Tab identifier for tab actions.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Tab id for tab actions.",
				},
				{
					name: "timeout",
					description: "Timeout in milliseconds for wait actions.",
					required: false,
					schema: {
						type: "number",
						default: 5000,
					},
					descriptionCompressed: "Timeout in milliseconds for wait actions.",
				},
			],
			descriptionCompressed:
				"Chromium browser control router: open/connect/navigate/click/type/read dom/clickables/execute/wait/tabs; read-only state.",
			similes: [
				"CONTROL_BROWSER",
				"WEB_BROWSER",
				"OPEN_BROWSER",
				"BROWSE_WEB",
				"NAVIGATE_BROWSER",
				"BROWSER_CLICK",
				"BROWSER_TYPE",
			],
			exampleCalls: [
				{
					user: "Use BROWSER_ACTION with the provided parameters.",
					actions: ["BROWSER_ACTION"],
					params: {
						BROWSER_ACTION: {
							action: "open",
							url: "example",
							selector: "example",
							coordinate: "example",
							text: "example",
							code: "example",
							direction: "up",
							amount: 300,
							tabId: "example",
							timeout: 5000,
						},
					},
				},
			],
		},
		{
			name: "CALL_MCP_TOOL",
			description: "Calls a tool from an MCP server to perform a specific task",
			parameters: [
				{
					name: "serverName",
					description: "Optional MCP server name that owns the tool.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Optional MCP server name that owns the tool.",
				},
				{
					name: "toolName",
					description: "Optional exact MCP tool name to call.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Optional exact MCP tool name to call.",
				},
				{
					name: "arguments",
					description:
						"Optional JSON arguments to pass to the selected MCP tool.",
					required: false,
					schema: {
						type: "object",
					},
					descriptionCompressed:
						"Optional JSON arguments to pass to the selected MCP tool.",
				},
				{
					name: "query",
					description:
						"Natural-language description of the tool call to select.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Natural-language description of the tool call to select.",
				},
			],
			descriptionCompressed: "call tool MCP server perform specific task",
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
			exampleCalls: [
				{
					user: "Use CALL_MCP_TOOL with the provided parameters.",
					actions: ["CALL_MCP_TOOL"],
					params: {
						CALL_MCP_TOOL: {
							serverName: "example",
							toolName: "example",
							arguments: "example",
							query: "example",
						},
					},
				},
			],
		},
		{
			name: "CANCEL_TASK",
			description:
				"Cancel a durable task and stop any associated task-agent sessions, preserving history and marking sessions or threads as canceled or interrupted.",
			parameters: [
				{
					name: "threadId",
					description: "Task thread ID",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Task thread ID",
				},
				{
					name: "sessionId",
					description: "Session ID",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Session ID",
				},
				{
					name: "search",
					description: "Search text for a matching task",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Search text for a matching task",
				},
				{
					name: "all",
					description: "Cancel all active tasks",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed: "Cancel all active tasks",
				},
				{
					name: "reason",
					description: "Cancellation reason",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Cancellation reason",
				},
			],
			similes: [
				"STOP_TASK",
				"CANCEL_AGENT_TASK",
				"CANCEL_TASK_AGENT",
				"ABORT_TASK",
				"KILL_TASK",
				"STOP_SUBTASK",
			],
			exampleCalls: [
				{
					user: "Use CANCEL_TASK with the provided parameters.",
					actions: ["CANCEL_TASK"],
					params: {
						CANCEL_TASK: {
							threadId: "example",
							sessionId: "example",
							search: "example",
							all: false,
							reason: "example",
						},
					},
				},
			],
			descriptionCompressed:
				"Cancel a durable task and stop any associated task-agent sessions, preserving history and marking sessions or threads as canceled or interrupted.",
		},
		{
			name: "CHAT_PUBLIC",
			description:
				"Say something in public chat so nearby players and agents can see it. Use to narrate, socialize, or respond to operator prompts.",
			parameters: [
				{
					name: "message",
					description: "Public chat text to send, capped to 80 characters.",
					required: true,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Chat text.",
				},
			],
			descriptionCompressed: "Say something in public chat.",
			similes: ["SAY", "SPEAK", "TALK", "BROADCAST"],
			exampleCalls: [
				{
					user: "Use CHAT_PUBLIC with the provided parameters.",
					actions: ["CHAT_PUBLIC"],
					params: {
						CHAT_PUBLIC: {
							message: "example",
						},
					},
				},
			],
		},
		{
			name: "CHECK_AVAILABILITY",
			description:
				"Check whether the owner is free or busy across a specific ISO-8601 ",
			parameters: [
				{
					name: "startAt",
					description: "ISO-8601 start of the window to check.",
					required: true,
					schema: {
						type: "string",
					},
					descriptionCompressed: "ISO-8601 start of the window to check.",
				},
				{
					name: "endAt",
					description: "ISO-8601 end of the window to check.",
					required: true,
					schema: {
						type: "string",
					},
					descriptionCompressed: "ISO-8601 end of the window to check.",
				},
			],
			descriptionCompressed:
				"Check owner free/busy for one ISO-8601 time window and list overlapping events.",
			similes: ["AM_I_FREE", "AVAILABILITY_CHECK", "FREE_BUSY"],
			exampleCalls: [
				{
					user: "Use CHECK_AVAILABILITY with the provided parameters.",
					actions: ["CHECK_AVAILABILITY"],
					params: {
						CHECK_AVAILABILITY: {
							startAt: "example",
							endAt: "example",
						},
					},
				},
			],
		},
		{
			name: "CLAUDE_CODE_WORKBENCH_LIST",
			description: "List available Claude Code workbench workflows.",
			parameters: [
				{
					name: "includeDisabled",
					description:
						"Whether to include disabled workbench workflows. Defaults to true.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed:
						"Whether to include disabled workbench workflows. Defaults to true.",
				},
			],
			descriptionCompressed: "list available Claude Code workbench workflow",
			similes: ["LIST_WORKBENCH_WORKFLOWS", "WORKBENCH_LIST", "CCW_LIST"],
			exampleCalls: [
				{
					user: "Use CLAUDE_CODE_WORKBENCH_LIST with the provided parameters.",
					actions: ["CLAUDE_CODE_WORKBENCH_LIST"],
					params: {
						CLAUDE_CODE_WORKBENCH_LIST: {
							includeDisabled: false,
						},
					},
				},
			],
		},
		{
			name: "CLAUDE_CODE_WORKBENCH_RUN",
			description:
				"Run an allowlisted repo workflow through the Claude Code workbench service.",
			parameters: [
				{
					name: "workflow",
					description: "Allowlisted workflow name to run.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Allowlisted workflow name to run.",
				},
				{
					name: "cwd",
					description: "Optional working directory for the workflow.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Optional working directory for the workflow.",
				},
				{
					name: "stdin",
					description: "Optional stdin passed to the workflow.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Optional stdin passed to the workflow.",
				},
			],
			descriptionCompressed:
				"run allowlist repo workflow through Claude Code workbench service",
			similes: ["RUN_WORKBENCH_WORKFLOW", "WORKBENCH_RUN", "CCW_RUN"],
			exampleCalls: [
				{
					user: "Use CLAUDE_CODE_WORKBENCH_RUN with the provided parameters.",
					actions: ["CLAUDE_CODE_WORKBENCH_RUN"],
					params: {
						CLAUDE_CODE_WORKBENCH_RUN: {
							workflow: "example",
							cwd: "example",
							stdin: "example",
						},
					},
				},
			],
		},
		{
			name: "CLEAR_LINEAR_ACTIVITY",
			description: "Clear the Linear activity log",
			parameters: [],
			descriptionCompressed: "clear Linear activity log",
			similes: [
				"clear-linear-activity",
				"reset-linear-activity",
				"delete-linear-activity",
			],
		},
		{
			name: "CLOUD_AGENT",
			description:
				"ElizaCloud agent ops router: provision a container, freeze (snapshot+stop) a running agent, resume a frozen agent from snapshot, or check credit balance and runtime estimate.",
			parameters: [
				{
					name: "op",
					description:
						"Which cloud-agent operation to run: 'provision', 'freeze', 'resume', or 'check_credits'.",
					required: true,
					schema: {
						type: "string",
						enum: ["provision", "freeze", "resume", "check_credits"],
					},
					descriptionCompressed:
						"Which cloud-agent operation to run: 'provision', 'freeze', 'resume', or 'check_credits'.",
				},
				{
					name: "name",
					description:
						"Human-readable agent name. Required for op='provision' and op='resume'.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Human-readable agent name. Required for op='provision' and op='resume'.",
				},
				{
					name: "project_name",
					description:
						"Project identifier (lowercase, no spaces). Required for op='provision' and op='resume'.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Project id (lowercase, no spaces). Required for op='provision' and op='resume'.",
				},
				{
					name: "containerId",
					description: "Container ID. Required for op='freeze'.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Container ID. Required for op='freeze'.",
				},
				{
					name: "snapshotId",
					description:
						"Specific snapshot ID for op='resume' (defaults to latest).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Specific snapshot ID for op='resume' (defaults to latest).",
				},
				{
					name: "description",
					description: "Optional description for op='provision'.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Optional description for op='provision'.",
				},
				{
					name: "environment_vars",
					description:
						"Additional environment variables for op='provision' or op='resume'.",
					required: false,
					schema: {
						type: "object",
					},
					descriptionCompressed:
						"Additional environment variables for op='provision' or op='resume'.",
				},
				{
					name: "auto_backup",
					description:
						"Enable periodic auto-backup for op='provision' (default: true).",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed:
						"Enable periodic auto-backup for op='provision' (default: true).",
				},
				{
					name: "detailed",
					description: "Include transaction history for op='check_credits'.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed:
						"Include transaction history for op='check_credits'.",
				},
				{
					name: "confirmed",
					description:
						"Must be true to execute mutating ops ('provision', 'freeze', 'resume') after the preview.",
					required: false,
					schema: {
						type: "boolean",
						default: false,
					},
					descriptionCompressed:
						"Must be true to execute mutating ops ('provision', 'freeze', 'resume') after the preview.",
				},
			],
			descriptionCompressed:
				"Cloud agent ops: provision, freeze, resume, check credits.",
			similes: [
				"deploy agent to cloud",
				"launch cloud agent",
				"provision container",
				"freeze agent",
				"hibernate agent",
				"stop cloud agent",
				"resume agent",
				"unfreeze agent",
				"restore agent",
				"check credits",
				"check balance",
				"cloud billing",
				"PROVISION_CLOUD_AGENT",
				"FREEZE_CLOUD_AGENT",
				"RESUME_CLOUD_AGENT",
				"CHECK_CLOUD_CREDITS",
			],
			exampleCalls: [
				{
					user: "Use CLOUD_AGENT with the provided parameters.",
					actions: ["CLOUD_AGENT"],
					params: {
						CLOUD_AGENT: {
							op: "provision",
							name: "example",
							project_name: "example",
							containerId: "example",
							snapshotId: "example",
							description: "example",
							environment_vars: "example",
							auto_backup: false,
							detailed: false,
							confirmed: false,
						},
					},
				},
			],
		},
		{
			name: "COMMAND",
			description:
				"Slash-command router. Operations: help, status, stop, models, list. Selects the operation from parameters.op or the detected /<command> in the message text.",
			parameters: [
				{
					name: "op",
					description:
						"Command operation. One of: help, status, stop, models, list.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Command operation. One of: help, status, stop, models, list.",
				},
			],
			descriptionCompressed:
				"Slash commands: help, status, stop, models, list.",
			similes: [
				"COMMAND_OP",
				"SLASH_COMMAND",
				"HELP_COMMAND",
				"STATUS_COMMAND",
				"STOP_COMMAND",
				"MODELS_COMMAND",
				"COMMANDS_LIST",
			],
			exampleCalls: [
				{
					user: "Use COMMAND with the provided parameters.",
					actions: ["COMMAND"],
					params: {
						COMMAND: {
							op: "example",
						},
					},
				},
			],
		},
		{
			name: "COMPUTER_USE",
			description:
				"computer_use:\n  purpose: Canonical cross-platform computer-use action for real desktop interaction on macOS, Linux, and Windows when direct computer operation is required.\n  guidance: Take a screenshot before acting. After each desktop action, the result includes a screenshot when available. Use this standard plugin action, not a LifeOps wrapper, for Finder/Desktop/native-app/browser/file/terminal workflows on the owner's machine.\n  actions: screenshot/click/click_with_modifiers/double_click/right_click/mouse_move/type/key/key_combo/scroll/drag/detect_elements/ocr.",
			parameters: [
				{
					name: "action",
					description: "Desktop action to perform.",
					required: true,
					schema: {
						type: "string",
						enum: [
							"screenshot",
							"click",
							"click_with_modifiers",
							"double_click",
							"right_click",
							"mouse_move",
							"type",
							"key",
							"key_combo",
							"scroll",
							"drag",
							"detect_elements",
							"ocr",
						],
					},
					descriptionCompressed: "Desktop action to perform.",
				},
				{
					name: "coordinate",
					description: "Target [x, y] pixel coordinate.",
					required: false,
					schema: {
						type: "array",
						items: {
							type: "number",
						},
					},
					descriptionCompressed: "Target [x, y] pixel coordinate.",
				},
				{
					name: "startCoordinate",
					description: "Start [x, y] pixel coordinate for drag.",
					required: false,
					schema: {
						type: "array",
						items: {
							type: "number",
						},
					},
					descriptionCompressed: "Start [x, y] pixel coordinate for drag.",
				},
				{
					name: "text",
					description: "Text to type.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Text to type.",
				},
				{
					name: "modifiers",
					description:
						"Modifier keys to hold during click_with_modifiers, e.g. ['cmd', 'shift'] or ['ctrl'].",
					required: false,
					schema: {
						type: "array",
						items: {
							type: "string",
						},
					},
					descriptionCompressed:
						"Modifier keys to hold during click_with_modifiers, e. g. ['cmd', 'shift'] or ['ctrl'].",
				},
				{
					name: "key",
					description: "Single key or combo string depending on action.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Single key or combo string depending on action.",
				},
				{
					name: "button",
					description: "Mouse button for click_with_modifiers.",
					required: false,
					schema: {
						type: "string",
						enum: ["left", "middle", "right"],
					},
					descriptionCompressed: "Mouse button for click_with_modifiers.",
				},
				{
					name: "clicks",
					description: "Number of clicks for click_with_modifiers.",
					required: false,
					schema: {
						type: "number",
						minimum: 1,
						maximum: 5,
					},
					descriptionCompressed: "Number of clicks for click_with_modifiers.",
				},
				{
					name: "scrollDirection",
					description: "Scroll direction.",
					required: false,
					schema: {
						type: "string",
						enum: ["up", "down", "left", "right"],
					},
					descriptionCompressed: "Scroll direction.",
				},
				{
					name: "scrollAmount",
					description: "Scroll tick count.",
					required: false,
					schema: {
						type: "number",
						default: 3,
						minimum: 1,
						maximum: 20,
					},
					descriptionCompressed: "Scroll tick count.",
				},
			],
			descriptionCompressed:
				"Canonical cross-platform desktop control: screenshot/click/modified click/double/right/move/type/key/key_combo/scroll/drag/detect_elements/ocr.",
			similes: [
				"USE_COMPUTER",
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
			exampleCalls: [
				{
					user: "Use COMPUTER_USE with the provided parameters.",
					actions: ["COMPUTER_USE"],
					params: {
						COMPUTER_USE: {
							action: "screenshot",
							coordinate: "example",
							startCoordinate: "example",
							text: "example",
							modifiers: "example",
							key: "example",
							button: "left",
							clicks: 1,
							scrollDirection: "up",
							scrollAmount: 3,
						},
					},
				},
			],
		},
		{
			name: "CREATE_LINEAR_COMMENT",
			description: "Add a comment to a Linear issue",
			parameters: [
				{
					name: "issueId",
					description: "Linear issue id or identifier to comment on.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Linear issue id or id to comment on.",
				},
				{
					name: "body",
					description: "Comment body to add to the issue.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Comment body to add to the issue.",
				},
			],
			descriptionCompressed: "add comment Linear issue",
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
							issueId: "example",
							body: "example",
						},
					},
				},
			],
		},
		{
			name: "CREATE_LINEAR_ISSUE",
			description: "Create a new issue in Linear",
			parameters: [
				{
					name: "issueData",
					description: "Structured Linear issue fields.",
					required: false,
					schema: {
						type: "object",
						properties: {
							title: {
								type: "string",
							},
							description: {
								type: "string",
							},
							priority: {
								type: "number",
							},
							teamId: {
								type: "string",
							},
							assigneeId: {
								type: "string",
							},
							labelIds: {
								type: "array",
								items: {
									type: "string",
								},
							},
						},
					},
					descriptionCompressed: "Structured Linear issue fields.",
				},
			],
			descriptionCompressed: "create new issue Linear",
			similes: ["create-linear-issue", "new-linear-issue", "add-linear-issue"],
			exampleCalls: [
				{
					user: "Use CREATE_LINEAR_ISSUE with the provided parameters.",
					actions: ["CREATE_LINEAR_ISSUE"],
					params: {
						CREATE_LINEAR_ISSUE: {
							issueData: "example",
						},
					},
				},
			],
		},
		{
			name: "CREATE_N8N_WORKFLOW",
			description:
				"Generate, preview, and deploy n8n workflows from natural language. ",
			parameters: [
				{
					name: "request",
					description:
						"Natural-language workflow request, draft modification, deployment confirmation, or cancellation request.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Natural-language workflow request, draft modification, deployment confirmation, or cancellation request.",
				},
				{
					name: "draftAction",
					description:
						"Optional explicit operation for a pending workflow draft.",
					required: false,
					schema: {
						type: "string",
						enum: ["generate", "modify", "deploy", "cancel"],
					},
					descriptionCompressed:
						"Optional explicit operation for a pending workflow draft.",
				},
			],
			descriptionCompressed:
				"generate, preview, deploy n8n workflow natural language handle full lifecycle: generate draft, show preview, deploy user confirmation handle modify/cancel pend draft IMPORTANT: workflow draft pend, action use user response draft includ yes, ok, deploy, cancel, modification request never reply w/ text draft pend",
			similes: [
				"CREATE_WORKFLOW",
				"BUILD_WORKFLOW",
				"GENERATE_WORKFLOW",
				"MAKE_AUTOMATION",
				"CREATE_AUTOMATION",
				"BUILD_N8N_WORKFLOW",
				"SETUP_WORKFLOW",
				"CONFIRM_WORKFLOW",
				"DEPLOY_WORKFLOW",
				"CANCEL_WORKFLOW",
			],
			exampleCalls: [
				{
					user: "Use CREATE_N8N_WORKFLOW with the provided parameters.",
					actions: ["CREATE_N8N_WORKFLOW"],
					params: {
						CREATE_N8N_WORKFLOW: {
							request: "example",
							draftAction: "generate",
						},
					},
				},
			],
		},
		{
			name: "DEACTIVATE_N8N_WORKFLOW",
			description:
				"Deactivate an n8n workflow to stop it from processing triggers and running automatically. Identifies workflows by ID, name, or semantic description in any language.",
			parameters: [
				{
					name: "workflowId",
					description: "Optional exact n8n workflow id to deactivate.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Optional exact n8n workflow id to deactivate.",
				},
				{
					name: "workflowName",
					description: "Optional workflow name to deactivate.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Optional workflow name to deactivate.",
				},
				{
					name: "query",
					description:
						"Optional natural-language description of the workflow to deactivate.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Optional natural-language description of the workflow to deactivate.",
				},
			],
			descriptionCompressed:
				"deactivate n8n workflow stop process trigger run automatically identify workflow ID, name, semantic description language",
			similes: [
				"DEACTIVATE_WORKFLOW",
				"DISABLE_WORKFLOW",
				"STOP_WORKFLOW",
				"PAUSE_WORKFLOW",
				"TURN_OFF_WORKFLOW",
			],
			exampleCalls: [
				{
					user: "Use DEACTIVATE_N8N_WORKFLOW with the provided parameters.",
					actions: ["DEACTIVATE_N8N_WORKFLOW"],
					params: {
						DEACTIVATE_N8N_WORKFLOW: {
							workflowId: "example",
							workflowName: "example",
							query: "example",
						},
					},
				},
			],
		},
		{
			name: "DELETE_LINEAR_ISSUE",
			description: "Delete (archive) an issue in Linear",
			parameters: [
				{
					name: "issueId",
					description: "Linear issue id or identifier to archive.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Linear issue id or id to archive.",
				},
			],
			descriptionCompressed: "delete (archive) issue Linear",
			similes: [
				"delete-linear-issue",
				"archive-linear-issue",
				"remove-linear-issue",
				"close-linear-issue",
			],
			exampleCalls: [
				{
					user: "Use DELETE_LINEAR_ISSUE with the provided parameters.",
					actions: ["DELETE_LINEAR_ISSUE"],
					params: {
						DELETE_LINEAR_ISSUE: {
							issueId: "example",
						},
					},
				},
			],
		},
		{
			name: "DELETE_N8N_WORKFLOW",
			description:
				"Delete an n8n workflow permanently. This action cannot be undone. Identifies workflows by ID, name, or semantic description in any language.",
			parameters: [
				{
					name: "workflowId",
					description: "Optional exact n8n workflow id to delete.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Optional exact n8n workflow id to delete.",
				},
				{
					name: "workflowName",
					description: "Optional workflow name to delete.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Optional workflow name to delete.",
				},
				{
					name: "query",
					description:
						"Optional natural-language description of the workflow to delete.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Optional natural-language description of the workflow to delete.",
				},
				{
					name: "confirmed",
					description: "Whether the user has confirmed permanent deletion.",
					required: false,
					schema: {
						type: "boolean",
						default: false,
					},
					descriptionCompressed:
						"Whether user has confirmed permanent deletion.",
				},
			],
			descriptionCompressed:
				"delete n8n workflow permanently action cannot undone identify workflow ID, name, semantic description language",
			similes: ["DELETE_WORKFLOW", "REMOVE_WORKFLOW", "DESTROY_WORKFLOW"],
			exampleCalls: [
				{
					user: "Use DELETE_N8N_WORKFLOW with the provided parameters.",
					actions: ["DELETE_N8N_WORKFLOW"],
					params: {
						DELETE_N8N_WORKFLOW: {
							workflowId: "example",
							workflowName: "example",
							query: "example",
							confirmed: false,
						},
					},
				},
			],
		},
		{
			name: "DEXSCREENER_BOOSTED_TOKENS",
			description:
				"Get boosted (promoted/sponsored) tokens from DexScreener, showing tokens with paid promotional boosts",
			parameters: [
				{
					name: "top",
					description:
						"When true, return top boosted tokens instead of latest boosted tokens.",
					required: false,
					schema: {
						type: "boolean",
						default: false,
					},
					descriptionCompressed:
						"When true, return top boosted tokens instead of latest boosted tokens.",
				},
			],
			similes: ["promoted tokens", "sponsored tokens", "boosted coins"],
			exampleCalls: [
				{
					user: "Use DEXSCREENER_BOOSTED_TOKENS with the provided parameters.",
					actions: ["DEXSCREENER_BOOSTED_TOKENS"],
					params: {
						DEXSCREENER_BOOSTED_TOKENS: {
							top: false,
						},
					},
				},
			],
			descriptionCompressed:
				"Get boosted (promoted/sponsored) tokens from DexScreener, showing tokens with paid promotional boosts",
		},
		{
			name: "DEXSCREENER_CHAIN_PAIRS",
			description:
				"Get top trading pairs from a specific blockchain sorted by volume, liquidity, price change, or transaction count",
			parameters: [
				{
					name: "chain",
					description: "Chain id/name to inspect.",
					required: true,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Chain id/name to inspect.",
				},
				{
					name: "sortBy",
					description: "Metric used to rank pairs.",
					required: false,
					schema: {
						type: "string",
						enum: ["volume", "liquidity", "priceChange", "txns"],
						default: "volume",
					},
					descriptionCompressed: "Metric used to rank pairs.",
				},
				{
					name: "limit",
					description: "Maximum number of chain pairs to return.",
					required: false,
					schema: {
						type: "number",
						default: 10,
						minimum: 1,
						maximum: 25,
					},
					descriptionCompressed: "max number of chain pairs to return.",
				},
			],
			similes: ["tokens on", "pairs on", "top on"],
			exampleCalls: [
				{
					user: "Use DEXSCREENER_CHAIN_PAIRS with the provided parameters.",
					actions: ["DEXSCREENER_CHAIN_PAIRS"],
					params: {
						DEXSCREENER_CHAIN_PAIRS: {
							chain: "example",
							sortBy: "volume",
							limit: 10,
						},
					},
				},
			],
			descriptionCompressed:
				"Get top trading pairs from a specific blockchain sorted by volume, liquidity, price change, or transaction count",
		},
		{
			name: "DEXSCREENER_NEW_PAIRS",
			description:
				"Get newly created trading pairs from DexScreener, showing recently launched tokens and their initial liquidity",
			parameters: [
				{
					name: "chain",
					description: "Optional chain id/name to filter new pairs.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Optional chain id/name to filter new pairs.",
				},
				{
					name: "limit",
					description: "Maximum number of new pairs to return.",
					required: false,
					schema: {
						type: "number",
						default: 10,
						minimum: 1,
						maximum: 25,
					},
					descriptionCompressed: "max number of new pairs to return.",
				},
			],
			similes: ["new listings", "latest pairs", "new tokens", "fresh pairs"],
			exampleCalls: [
				{
					user: "Use DEXSCREENER_NEW_PAIRS with the provided parameters.",
					actions: ["DEXSCREENER_NEW_PAIRS"],
					params: {
						DEXSCREENER_NEW_PAIRS: {
							chain: "example",
							limit: 10,
						},
					},
				},
			],
			descriptionCompressed:
				"Get newly created trading pairs from DexScreener, showing recently launched tokens and their initial liquidity",
		},
		{
			name: "DEXSCREENER_SEARCH",
			description:
				"Search for tokens or trading pairs on DexScreener by name, symbol, or contract address",
			parameters: [
				{
					name: "query",
					description:
						"Token name, symbol, pair, or contract address to search for.",
					required: true,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Token name, symbol, pair, or contract address to search for.",
				},
			],
			similes: ["find token", "look for", "search dexscreener"],
			exampleCalls: [
				{
					user: "Use DEXSCREENER_SEARCH with the provided parameters.",
					actions: ["DEXSCREENER_SEARCH"],
					params: {
						DEXSCREENER_SEARCH: {
							query: "example",
						},
					},
				},
			],
			descriptionCompressed:
				"Search for tokens or trading pairs on DexScreener by name, symbol, or contract address",
		},
		{
			name: "DEXSCREENER_TOKEN_INFO",
			description:
				"Get detailed information about a specific token including price, volume, liquidity, and trading pairs from DexScreener",
			parameters: [
				{
					name: "tokenAddress",
					description: "Token contract address to look up on DexScreener.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Token contract address to look up on DexScreener.",
				},
			],
			similes: ["token details", "token price", "get token", "check token"],
			exampleCalls: [
				{
					user: "Use DEXSCREENER_TOKEN_INFO with the provided parameters.",
					actions: ["DEXSCREENER_TOKEN_INFO"],
					params: {
						DEXSCREENER_TOKEN_INFO: {
							tokenAddress: "example",
						},
					},
				},
			],
			descriptionCompressed:
				"Get detailed info about a specific token including price, volume, liquidity, and trading pairs from DexScreener",
		},
		{
			name: "DEXSCREENER_TOKEN_PROFILES",
			description:
				"Get latest token profiles from DexScreener including social links, descriptions, and project information",
			parameters: [
				{
					name: "limit",
					description: "Maximum number of token profiles to include.",
					required: false,
					schema: {
						type: "number",
						default: 10,
					},
					descriptionCompressed: "max number of token profiles to include.",
				},
			],
			similes: ["token profiles", "token details page"],
			exampleCalls: [
				{
					user: "Use DEXSCREENER_TOKEN_PROFILES with the provided parameters.",
					actions: ["DEXSCREENER_TOKEN_PROFILES"],
					params: {
						DEXSCREENER_TOKEN_PROFILES: {
							limit: 10,
						},
					},
				},
			],
			descriptionCompressed:
				"Get latest token profiles from DexScreener including social links, descriptions, and project info",
		},
		{
			name: "DEXSCREENER_TRENDING",
			description:
				"Get trending tokens from DexScreener based on volume, price changes, and trading activity",
			parameters: [
				{
					name: "timeframe",
					description: "Trending window.",
					required: false,
					schema: {
						type: "string",
						enum: ["1h", "6h", "24h"],
						default: "24h",
					},
					descriptionCompressed: "Trending window.",
				},
				{
					name: "limit",
					description: "Maximum number of trending pairs to return.",
					required: false,
					schema: {
						type: "number",
						default: 10,
						minimum: 1,
						maximum: 25,
					},
					descriptionCompressed: "max number of trending pairs to return.",
				},
			],
			similes: [
				"hot tokens",
				"popular coins",
				"top gainers",
				"what's trending",
			],
			exampleCalls: [
				{
					user: "Use DEXSCREENER_TRENDING with the provided parameters.",
					actions: ["DEXSCREENER_TRENDING"],
					params: {
						DEXSCREENER_TRENDING: {
							timeframe: "24h",
							limit: 10,
						},
					},
				},
			],
			descriptionCompressed:
				"Get trending tokens from DexScreener based on volume, price changes, and trading activity",
		},
		{
			name: "DISCORD_SETUP_CREDENTIALS",
			description:
				"Start Discord credential setup or account pairing. Guides the user through setting up API credentials for supported third-party services, validates them when possible, and stores them securely.",
			parameters: [
				{
					name: "service",
					description: "Third-party service to configure from Discord.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "3p service to configure from Discord.",
				},
				{
					name: "credentials",
					description: "Credential values supplied by the user, when present.",
					required: false,
					schema: {
						type: "object",
					},
					descriptionCompressed:
						"Credential values supplied by user, when present.",
				},
			],
			descriptionCompressed: "Set up Discord credentials.",
			similes: [
				"DISCORD_SETUP",
				"DISCORD_PAIR",
				"DISCORD_CONNECT",
				"DISCORD_ADD_CREDENTIALS",
				"DISCORD_CONFIGURE_SERVICE",
				"DISCORD_CONNECT_SERVICE",
				"DISCORD_ADD_API_KEY",
				"DISCORD_SETUP_SERVICE",
			],
			exampleCalls: [
				{
					user: "Use DISCORD_SETUP_CREDENTIALS with the provided parameters.",
					actions: ["DISCORD_SETUP_CREDENTIALS"],
					params: {
						DISCORD_SETUP_CREDENTIALS: {
							service: "example",
							credentials: "example",
						},
					},
				},
			],
		},
		{
			name: "DOWNLOAD_MUSIC",
			description:
				"Download music to the local library without playing it. Requires confirmed:true before fetching and saving.",
			parameters: [
				{
					name: "confirmed",
					description: "Must be true to download music after preview.",
					required: false,
					schema: {
						type: "boolean",
						default: false,
					},
					descriptionCompressed:
						"Must be true to download music after preview.",
				},
			],
			descriptionCompressed: "Download track to library without playing.",
			similes: [
				"FETCH_MUSIC",
				"GET_MUSIC",
				"DOWNLOAD_SONG",
				"SAVE_MUSIC",
				"GRAB_MUSIC",
			],
			exampleCalls: [
				{
					user: "Use DOWNLOAD_MUSIC with the provided parameters.",
					actions: ["DOWNLOAD_MUSIC"],
					params: {
						DOWNLOAD_MUSIC: {
							confirmed: false,
						},
					},
				},
			],
		},
		{
			name: "EDIT",
			description:
				"Replace text in an existing file. Default behavior requires `old_string` to match exactly once; pass `replace_all=true` to substitute every occurrence. The file must have been READ in this session, must still match its recorded mtime, and the new content cannot introduce a detected secret pattern.",
			parameters: [
				{
					name: "file_path",
					description: "Absolute path to the file to edit.",
					required: true,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Absolute path to the file to edit.",
				},
				{
					name: "old_string",
					description: "Exact substring to replace.",
					required: true,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Exact substring to replace.",
				},
				{
					name: "new_string",
					description: "Replacement text. Must differ from old_string.",
					required: true,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Replacement text. Must differ from old_string.",
				},
				{
					name: "replace_all",
					description:
						"If true, replace every occurrence; otherwise require exactly one match.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed:
						"If true, replace every occurrence. otherwise require exactly one match.",
				},
			],
			descriptionCompressed:
				"Replace exact-match text in a file (single match by default; pass replace_all for multiple).",
			similes: ["EDIT_FILE", "MODIFY_FILE"],
			exampleCalls: [
				{
					user: "Use EDIT with the provided parameters.",
					actions: ["EDIT"],
					params: {
						EDIT: {
							file_path: "example",
							old_string: "example",
							new_string: "example",
							replace_all: false,
						},
					},
				},
			],
		},
		{
			name: "ENTER_WORKTREE",
			description:
				"Create a git worktree for the current repo and switch the session into it. The new worktree path becomes the session cwd and a sandbox root, so subsequent file operations land there until EXIT_WORKTREE pops it. Use to isolate a parallel branch of work without disturbing the main checkout.",
			parameters: [
				{
					name: "name",
					description:
						"Optional worktree branch/dir name. Defaults to a random auto-* identifier.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Optional worktree branch/dir name. Defaults to a random auto-* id.",
				},
				{
					name: "path",
					description:
						"Optional absolute worktree directory. Must lie within sandbox roots. Defaults to a per-call directory under the OS temp dir.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Optional absolute worktree directory. Must lie within sandbox roots. Defaults to a per-call directory under the OS temp dir.",
				},
				{
					name: "base",
					description: "Optional base ref for the new worktree (default HEAD).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Optional base ref for the new worktree (default HEAD).",
				},
			],
			descriptionCompressed:
				"Create and switch into a git worktree for parallel work.",
			similes: ["GIT_WORKTREE_ADD", "ADD_WORKTREE", "OPEN_WORKTREE"],
			exampleCalls: [
				{
					user: "Use ENTER_WORKTREE with the provided parameters.",
					actions: ["ENTER_WORKTREE"],
					params: {
						ENTER_WORKTREE: {
							name: "example",
							path: "example",
							base: "example",
						},
					},
				},
			],
		},
		{
			name: "EXECUTE_TRADE",
			description:
				"Execute a BSC token trade (buy or sell). Use this when a user asks to ",
			parameters: [
				{
					name: "side",
					description: 'Trade direction: "buy" or "sell"',
					required: true,
					schema: {
						type: "string",
					},
					descriptionCompressed: 'Trade direction: "buy" or "sell"',
				},
				{
					name: "tokenAddress",
					description:
						"BSC token contract address (0x-prefixed, 40 hex characters)",
					required: true,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"BSC token contract address (0x-prefixed, 40 hex characters)",
				},
				{
					name: "amount",
					description:
						'Human-readable trade amount (e.g. "0.5" BNB for buys, or token amount for sells)',
					required: true,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						'Human-readable trade amount (e. g. "0. 5" BNB for buys, or token amount for sells)',
				},
				{
					name: "slippageBps",
					description: "Slippage tolerance in basis points (default 300 = 3%)",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed:
						"Slippage tolerance in basis points (default 300 = 3%)",
				},
				{
					name: "routeProvider",
					description:
						'Route provider preference for the swap: "pancakeswap-v2" or "0x". Defaults to "pancakeswap-v2".',
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						'Route provider preference for the swap: "pancakeswap-v2" or "0x". Defaults to "pancakeswap-v2".',
				},
			],
			descriptionCompressed:
				"Execute BSC token trade (buy/sell) via PancakeSwap (admin/owner only).",
			similes: ["BUY_TOKEN", "SELL_TOKEN", "SWAP", "TRADE", "BUY", "SELL"],
			exampleCalls: [
				{
					user: "Use EXECUTE_TRADE with the provided parameters.",
					actions: ["EXECUTE_TRADE"],
					params: {
						EXECUTE_TRADE: {
							side: "example",
							tokenAddress: "example",
							amount: "example",
							slippageBps: 1,
							routeProvider: "example",
						},
					},
				},
			],
		},
		{
			name: "EXIT_WORKTREE",
			description:
				"Pop the most recent ENTER_WORKTREE: restore the previous session cwd, drop the added sandbox root, and (with cleanup=true) run `git worktree remove --force` to delete the worktree directory.",
			parameters: [
				{
					name: "cleanup",
					description:
						"If true, also `git worktree remove --force` the popped worktree directory.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed:
						"If true, also `git worktree remove --force` the popped worktree directory.",
				},
			],
			descriptionCompressed:
				"Exit current worktree, restore previous cwd, optionally git worktree remove --force.",
			similes: ["LEAVE_WORKTREE", "POP_WORKTREE", "GIT_WORKTREE_REMOVE"],
			exampleCalls: [
				{
					user: "Use EXIT_WORKTREE with the provided parameters.",
					actions: ["EXIT_WORKTREE"],
					params: {
						EXIT_WORKTREE: {
							cleanup: false,
						},
					},
				},
			],
		},
		{
			name: "FARCASTER_CAST",
			description:
				"Post a public Farcaster cast, or reply to an existing cast when replyToHash is provided.",
			parameters: [
				{
					name: "text",
					description: "Cast text.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Cast text.",
				},
				{
					name: "replyToHash",
					description:
						"Hash of the parent cast. When set, posts as a reply; otherwise posts a new cast.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Hash of the parent cast. When set, posts as a reply. otherwise posts a new cast.",
				},
			],
			descriptionCompressed:
				"Farcaster cast: post or reply (with replyToHash).",
			similes: [
				"SEND_CAST",
				"REPLY_TO_CAST",
				"POST_CAST",
				"FARCASTER_POST",
				"SHARE_ON_FARCASTER",
			],
			exampleCalls: [
				{
					user: "Use FARCASTER_CAST with the provided parameters.",
					actions: ["FARCASTER_CAST"],
					params: {
						FARCASTER_CAST: {
							text: "example",
							replyToHash: "example",
						},
					},
				},
			],
		},
		{
			name: "FILE_ACTION",
			description:
				"Perform local filesystem operations through the computer-use service. This includes read, write, edit, append, delete, exists, list, delete_directory, upload, download, and list_downloads actions.\n\n",
			parameters: [
				{
					name: "action",
					description: "File action to perform.",
					required: true,
					schema: {
						type: "string",
						enum: [
							"read",
							"write",
							"edit",
							"append",
							"delete",
							"exists",
							"list",
							"delete_directory",
							"upload",
							"download",
							"list_downloads",
						],
					},
					descriptionCompressed: "File action to perform.",
				},
				{
					name: "path",
					description: "Primary file or directory path.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Primary file or directory path.",
				},
				{
					name: "filepath",
					description: "Upstream alias for path.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Upstream alias for path.",
				},
				{
					name: "dirpath",
					description: "Upstream alias for directory path.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Upstream alias for directory path.",
				},
				{
					name: "content",
					description: "Content for write, append, or upload.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Content for write, append, or upload.",
				},
				{
					name: "encoding",
					description: "Encoding for read/download.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Encoding for read/download.",
				},
				{
					name: "oldText",
					description: "Replacement source text alias for edit.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Replacement source text alias for edit.",
				},
				{
					name: "newText",
					description: "Replacement destination text alias for edit.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Replacement destination text alias for edit.",
				},
				{
					name: "old_text",
					description: "Upstream edit source text.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Upstream edit source text.",
				},
				{
					name: "new_text",
					description: "Upstream edit destination text.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Upstream edit destination text.",
				},
				{
					name: "find",
					description: "Upstream alias for old_text.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Upstream alias for old_text.",
				},
				{
					name: "replace",
					description: "Upstream alias for new_text.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Upstream alias for new_text.",
				},
			],
			descriptionCompressed:
				"File ops: read, write, edit, append, delete, list, copy, move, rename, exists, stat.",
			similes: [
				"READ_FILE",
				"WRITE_FILE",
				"EDIT_FILE",
				"DELETE_FILE",
				"LIST_DIRECTORY",
				"FILE_OPERATION",
			],
			exampleCalls: [
				{
					user: "Use FILE_ACTION with the provided parameters.",
					actions: ["FILE_ACTION"],
					params: {
						FILE_ACTION: {
							action: "read",
							path: "example",
							filepath: "example",
							dirpath: "example",
							content: "example",
							encoding: "example",
							oldText: "example",
							newText: "example",
							old_text: "example",
							new_text: "example",
							find: "example",
							replace: "example",
						},
					},
				},
			],
		},
		{
			name: "FINALIZE_WORKSPACE",
			description:
				"Finalize workspace changes by committing, pushing, and optionally creating a pull request. ",
			parameters: [
				{
					name: "workspaceId",
					description:
						"ID of the workspace to finalize. Uses current workspace if not specified.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Commit, push, opt. create PR for workspace changes.",
				},
				{
					name: "commitMessage",
					description: "Commit message for the changes.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Commit msg for the changes.",
				},
				{
					name: "prTitle",
					description: "Title for the pull request.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Title for the pull request.",
				},
				{
					name: "prBody",
					description: "Body/description for the pull request.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Body/description for the pull request.",
				},
				{
					name: "baseBranch",
					description: "Base branch for the PR (e.g., main, develop).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Base branch for the PR (e. g. , main, develop).",
				},
				{
					name: "draft",
					description: "Create as draft PR.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed: "Create as draft PR.",
				},
				{
					name: "skipPR",
					description: "Skip PR creation, only commit and push.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed: "Skip PR creation, only commit and push.",
				},
			],
			descriptionCompressed:
				"finalize workspace change commit, push, optionally create pull request use after task agent complete task",
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
							workspaceId: "example",
							commitMessage: "example",
							prTitle: "example",
							prBody: "example",
							baseBranch: "example",
							draft: false,
							skipPR: false,
						},
					},
				},
			],
		},
		{
			name: "FORM_RESTORE",
			description: "Restore a previously stashed form session",
			parameters: [
				{
					name: "sessionId",
					description: "Optional stashed form session id to restore.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Optional stashed form session id to restore.",
				},
			],
			descriptionCompressed: "Restore stashed form session.",
			similes: ["RESUME_FORM", "CONTINUE_FORM"],
			exampleCalls: [
				{
					user: "Use FORM_RESTORE with the provided parameters.",
					actions: ["FORM_RESTORE"],
					params: {
						FORM_RESTORE: {
							sessionId: "example",
						},
					},
				},
			],
		},
		{
			name: "GET_LINEAR_ACTIVITY",
			description: "Get recent Linear activity log with optional filters",
			parameters: [
				{
					name: "filters",
					description:
						"Optional activity filters, e.g. fromDate ISO timestamp, action, resource_type, resource_id, or success.",
					required: false,
					schema: {
						type: "object",
					},
					descriptionCompressed:
						"Optional activity filters, e. g. fromDate ISO timestamp, action, resource_type, resource_id, or success.",
				},
				{
					name: "limit",
					description: "Maximum number of activity log entries to return.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed:
						"max number of activity log entries to return.",
				},
			],
			descriptionCompressed:
				"get recent Linear activity log w/ optional filter",
			similes: [
				"get-linear-activity",
				"show-linear-activity",
				"view-linear-activity",
				"check-linear-activity",
			],
			exampleCalls: [
				{
					user: "Use GET_LINEAR_ACTIVITY with the provided parameters.",
					actions: ["GET_LINEAR_ACTIVITY"],
					params: {
						GET_LINEAR_ACTIVITY: {
							filters: "example",
							limit: 1,
						},
					},
				},
			],
		},
		{
			name: "GET_LINEAR_ISSUE",
			description: "Get details of a specific Linear issue",
			parameters: [
				{
					name: "issueId",
					description: "Linear issue identifier or id, e.g. ENG-123.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Linear issue id or id, e. g. ENG-123.",
				},
				{
					name: "query",
					description:
						"Search text when the exact Linear issue identifier is unknown.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Search text when the exact Linear issue id is unknown.",
				},
			],
			descriptionCompressed: "get detail specific Linear issue",
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
							issueId: "example",
							query: "example",
						},
					},
				},
			],
		},
		{
			name: "GET_N8N_EXECUTIONS",
			description:
				"Get execution history for an n8n workflow. Shows status, start time, and error messages if any. Identifies workflows by ID, name, or semantic description in any language.",
			parameters: [
				{
					name: "workflowId",
					description: "Exact n8n workflow id to inspect.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Exact n8n workflow id to inspect.",
				},
				{
					name: "workflowName",
					description: "Workflow name or partial name when id is unknown.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Workflow name or partial name when id is unknown.",
				},
				{
					name: "limit",
					description: "Maximum number of executions to return.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed: "max number of executions to return.",
				},
			],
			descriptionCompressed:
				"get execution history n8n workflow show status, start time, error message identify workflow ID, name, semantic description language",
			similes: [
				"GET_EXECUTIONS",
				"SHOW_EXECUTIONS",
				"EXECUTION_HISTORY",
				"WORKFLOW_RUNS",
				"WORKFLOW_EXECUTIONS",
			],
			exampleCalls: [
				{
					user: "Use GET_N8N_EXECUTIONS with the provided parameters.",
					actions: ["GET_N8N_EXECUTIONS"],
					params: {
						GET_N8N_EXECUTIONS: {
							workflowId: "example",
							workflowName: "example",
							limit: 1,
						},
					},
				},
			],
		},
		{
			name: "GET_SKILL_DETAILS",
			description:
				"Get detailed information about a specific skill including version, owner, and stats.",
			parameters: [
				{
					name: "slug",
					description: "Skill slug to inspect, e.g. pdf-processing.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Skill slug to inspect, e. g. pdf-processing.",
				},
			],
			descriptionCompressed: "Get skill version, owner, stats.",
			similes: ["SKILL_INFO", "SKILL_DETAILS"],
			exampleCalls: [
				{
					user: "Use GET_SKILL_DETAILS with the provided parameters.",
					actions: ["GET_SKILL_DETAILS"],
					params: {
						GET_SKILL_DETAILS: {
							slug: "example",
						},
					},
				},
			],
		},
		{
			name: "GLOB",
			description:
				"Find files matching a glob pattern (e.g. '**/*.ts'). Returns up to 100 absolute paths sorted by mtime descending. Excludes VCS, build, and dependency directories. Use this instead of BASH for file discovery.",
			parameters: [
				{
					name: "pattern",
					description:
						"Glob pattern relative to the search root (e.g. '**/*.ts').",
					required: true,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Glob pattern relative to the search root (e. g. '**/*. ts').",
				},
				{
					name: "path",
					description:
						"Absolute path of the directory to search. Defaults to the session cwd.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Absolute path of the directory to search. Defaults to the session cwd.",
				},
			],
			descriptionCompressed:
				"Find files by glob (e.g. '**/*.ts'); returns absolute paths sorted by mtime.",
			similes: ["FIND_FILES"],
			exampleCalls: [
				{
					user: "Use GLOB with the provided parameters.",
					actions: ["GLOB"],
					params: {
						GLOB: {
							pattern: "example",
							path: "example",
						},
					},
				},
			],
		},
		{
			name: "GREP",
			description:
				"Search file contents using ripgrep (a fast regex search). Returns matching files, counts, or line content. Always excludes VCS directories. Use this instead of BASH for content search.",
			parameters: [
				{
					name: "pattern",
					description: "Regex pattern to search for.",
					required: true,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Regex pattern to search for.",
				},
				{
					name: "path",
					description:
						"Absolute path to a file or directory to search. Defaults to the session cwd.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Absolute path to a file or directory to search. Defaults to the session cwd.",
				},
				{
					name: "glob",
					description:
						"Optional glob filter passed to ripgrep -g (e.g. '*.ts').",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Optional glob filter passed to ripgrep -g (e. g. '*. ts').",
				},
				{
					name: "type",
					description:
						"Optional ripgrep file type passed via -t (e.g. 'js', 'py').",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Optional ripgrep file type passed via -t (e. g. 'js', 'py').",
				},
				{
					name: "output_mode",
					description:
						"How to render matches: 'content' returns matching lines, 'files_with_matches' returns file paths, 'count' returns per-file counts. Defaults to 'files_with_matches'.",
					required: false,
					schema: {
						type: "string",
						enum: ["content", "files_with_matches", "count"],
					},
					descriptionCompressed:
						"How to render matches: 'content' returns matching lines, 'files_with_matches' returns file paths, 'count' returns per-file counts. Defaults to...",
				},
				{
					name: "-A",
					description:
						"Lines of context to show after each match (content mode).",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed:
						"Lines of context to show after each match (content mode).",
				},
				{
					name: "-B",
					description:
						"Lines of context to show before each match (content mode).",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed:
						"Lines of context to show before each match (content mode).",
				},
				{
					name: "-C",
					description: "Lines of context around each match (content mode).",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed:
						"Lines of context around each match (content mode).",
				},
				{
					name: "case_insensitive",
					description: "Match case-insensitively (alias of -i).",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed: "Match case-insensitively (alias of -i).",
				},
				{
					name: "multiline",
					description:
						"Enable multiline matching (the pattern can span newlines).",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed:
						"Enable multiline matching (the pattern can span newlines).",
				},
				{
					name: "head_limit",
					description:
						"Truncate output to the first N lines. 0 means unlimited. Defaults to CODING_TOOLS_GREP_HEAD_LIMIT or 250.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed:
						"Truncate output to the first N lines. 0 means unlimited. Defaults to CODING_TOOLS_GREP_HEAD_LIMIT or 250.",
				},
				{
					name: "show_line_numbers",
					description: "Show 1-based line numbers in content mode.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed: "Show 1-based line numbers in content mode.",
				},
			],
			descriptionCompressed:
				"Ripgrep wrapper: regex search across files, returns matches/counts/files.",
			similes: ["SEARCH_CONTENT", "RIPGREP", "RG"],
			exampleCalls: [
				{
					user: "Use GREP with the provided parameters.",
					actions: ["GREP"],
					params: {
						GREP: {
							pattern: "example",
							path: "example",
							glob: "example",
							type: "example",
							output_mode: "content",
							"-A": 1,
							"-B": 1,
							"-C": 1,
							case_insensitive: false,
							multiline: false,
							head_limit: 1,
							show_line_numbers: false,
						},
					},
				},
			],
		},
		{
			name: "HEALTH",
			description:
				"Query health and fitness telemetry from HealthKit, Google Fit, Strava, Fitbit, Withings, or Oura — sleep ",
			parameters: [
				{
					name: "subaction",
					description:
						"Which health query to run: today, trend, by_metric, status.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Which health query to run: today, trend, by_metric, status.",
				},
				{
					name: "intent",
					description:
						"Free-form user intent used to infer subaction when not explicitly set.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "free-form intent infer subaction",
				},
				{
					name: "metric",
					description:
						"Metric for by_metric queries: steps, active_minutes, sleep_hours, heart_rate, calories, distance_meters.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Metric for by_metric queries: steps, active_minutes, sleep_hours, heart_rate, calories, distance_meters.",
				},
				{
					name: "date",
					description: "YYYY-MM-DD for single-day queries.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "YYYY-MM-DD for single-day queries.",
				},
				{
					name: "days",
					description: "Window size for trend and by_metric queries.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed: "Window size for trend and by_metric queries.",
				},
			],
			descriptionCompressed:
				"health/fitness telemetry HealthKit/GoogleFit/Strava/Fitbit/Withings/Oura: today | trend(days) | by_metric(steps heart-rate sleep calories distance workouts) | status",
			similes: [
				"FITNESS",
				"WELLNESS",
				"SLEEP",
				"STEPS",
				"HEART_RATE",
				"WORKOUT",
				"EXERCISE",
				"CALORIES",
				"ACTIVITY_METRICS",
			],
			exampleCalls: [
				{
					user: "Use HEALTH with the provided parameters.",
					actions: ["HEALTH"],
					params: {
						HEALTH: {
							subaction: "example",
							intent: "example",
							metric: "example",
							date: "example",
							days: 1,
						},
					},
				},
			],
		},
		{
			name: "IMESSAGE_SEND_MESSAGE",
			description: "Send a text message via iMessage (macOS only)",
			parameters: [
				{
					name: "text",
					description: "Message text to send.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "msg text to send.",
				},
				{
					name: "to",
					description: "Phone number, email address, or current conversation.",
					required: false,
					schema: {
						type: "string",
						default: "current",
					},
					descriptionCompressed:
						"Phone number, email address, or current convo.",
				},
			],
			descriptionCompressed: "Send iMessage (macOS).",
			similes: ["SEND_IMESSAGE", "IMESSAGE_TEXT", "TEXT_IMESSAGE", "SEND_IMSG"],
			exampleCalls: [
				{
					user: "Use IMESSAGE_SEND_MESSAGE with the provided parameters.",
					actions: ["IMESSAGE_SEND_MESSAGE"],
					params: {
						IMESSAGE_SEND_MESSAGE: {
							text: "example",
							to: "current",
						},
					},
				},
			],
		},
		{
			name: "INSTAGRAM_REPLY",
			description:
				"Reply on Instagram. mode=comment posts a comment on a media post (target=mediaId, text=comment). mode=dm sends a direct message to a thread (target=threadId, text=message).",
			parameters: [
				{
					name: "mode",
					description:
						"Reply mode: comment (post comment) or dm (direct message).",
					required: true,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Reply mode: comment (post comment) or dm (direct msg).",
				},
				{
					name: "target",
					description:
						"Target identifier: mediaId for comment, threadId for dm. Falls back to message.content.mediaId/threadId.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Target id: mediaId for comment, threadId for dm. Falls back to msg. content. mediaId/threadId.",
				},
				{
					name: "text",
					description:
						"Reply text. Falls back to state.response.text or message.content.text.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Reply text. Falls back to state. reply. text or msg. content. text.",
				},
			],
			descriptionCompressed: "Reply on Instagram: comment on post or DM user.",
			similes: [
				"POST_INSTAGRAM_COMMENT",
				"INSTAGRAM_COMMENT",
				"COMMENT_INSTAGRAM",
				"REPLY_INSTAGRAM",
				"SEND_INSTAGRAM_DM",
				"INSTAGRAM_DM",
				"INSTAGRAM_MESSAGE",
				"DM_INSTAGRAM",
				"DIRECT_MESSAGE_INSTAGRAM",
			],
			exampleCalls: [
				{
					user: "Use INSTAGRAM_REPLY with the provided parameters.",
					actions: ["INSTAGRAM_REPLY"],
					params: {
						INSTAGRAM_REPLY: {
							mode: "example",
							target: "example",
							text: "example",
						},
					},
				},
			],
		},
		{
			name: "INSTALL_SKILL",
			description:
				"Install a skill from the ClawHub registry. The skill will be security-scanned before activation. ",
			parameters: [
				{
					name: "slug",
					description: "Skill slug or search term to install.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Skill slug or search term to install.",
				},
			],
			descriptionCompressed:
				"Install skill from ClawHub registry. Security-scanned before activation.",
			similes: ["DOWNLOAD_SKILL", "ADD_SKILL", "GET_SKILL"],
			exampleCalls: [
				{
					user: "Use INSTALL_SKILL with the provided parameters.",
					actions: ["INSTALL_SKILL"],
					params: {
						INSTALL_SKILL: {
							slug: "example",
						},
					},
				},
			],
		},
		{
			name: "LIST_ACTIVE_BLOCKS",
			description:
				"List the live website blocker status and any active managed website block rules, including their gate type and gate target. Only use this for website/app blocking status. Do not use it for inbox blockers, message priority, morning briefs, night briefs, operating pictures, end-of-day reviews, or general executive-assistant triage.",
			parameters: [
				{
					name: "includeLiveStatus",
					description:
						"Whether to include the current hosts-file/SelfControl live block state.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed:
						"Whether to include the current hosts-file/SelfControl live block state.",
				},
				{
					name: "includeManagedRules",
					description:
						"Whether to include managed LifeOps block rules and gate metadata.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed:
						"Whether to include managed LifeOps block rules and gate metadata.",
				},
			],
			descriptionCompressed:
				"List live website blocker status and active block rules.",
			similes: [
				"LIST_BLOCK_RULES",
				"SHOW_ACTIVE_BLOCKS",
				"WEBSITE_BLOCKS_STATUS",
			],
			exampleCalls: [
				{
					user: "Use LIST_ACTIVE_BLOCKS with the provided parameters.",
					actions: ["LIST_ACTIVE_BLOCKS"],
					params: {
						LIST_ACTIVE_BLOCKS: {
							includeLiveStatus: false,
							includeManagedRules: false,
						},
					},
				},
			],
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
			name: "LIST_OVERDUE_FOLLOWUPS",
			description:
				"List contacts whose last-contacted-at timestamp exceeds their follow-up threshold. ",
			parameters: [
				{
					name: "thresholdDays",
					description:
						"Override the default overdue threshold in days for this query.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed:
						"Override the default overdue threshold in days for this query.",
				},
				{
					name: "limit",
					description: "Maximum number of overdue contacts to return.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed: "max number of overdue contacts to return.",
				},
			],
			similes: [
				"OVERDUE_FOLLOWUPS",
				"WHO_TO_FOLLOW_UP",
				"WHO_HAVEN_T_I_TALKED_TO",
				"LIST_FOLLOWUPS",
				"FOLLOWUP_LIST",
			],
			exampleCalls: [
				{
					user: "Use LIST_OVERDUE_FOLLOWUPS with the provided parameters.",
					actions: ["LIST_OVERDUE_FOLLOWUPS"],
					params: {
						LIST_OVERDUE_FOLLOWUPS: {
							thresholdDays: 1,
							limit: 1,
						},
					},
				},
			],
			descriptionCompressed:
				"List contacts whose last-contacted-at timestamp exceeds their follow-up threshold.",
		},
		{
			name: "lp_management",
			description:
				"Single LP management action. Params: subaction=onboard|list_pools|open|close|reposition|list_positions|get_position|set_preferences, chain=solana|evm, dex, pool, position, amount, range, tokenA, tokenB, chainId, slippageBps.",
			parameters: [
				{
					name: "subaction",
					description:
						"LP operation: onboard, list_pools, open, close, reposition, list_positions, get_position, set_preferences.",
					required: true,
					schema: {
						type: "string",
						enum: [
							"onboard",
							"list_pools",
							"open",
							"close",
							"reposition",
							"list_positions",
							"get_position",
							"set_preferences",
						],
					},
					descriptionCompressed:
						"LP operation: onboard, list_pools, open, close, reposition, list_positions, get_position, set_preferences.",
				},
				{
					name: "chain",
					description: "Chain for the LP operation.",
					required: false,
					schema: {
						type: "string",
						enum: ["solana", "evm"],
					},
					descriptionCompressed: "Chain for the LP operation.",
				},
				{
					name: "dex",
					description: "DEX/protocol name.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "DEX/protocol name.",
				},
				{
					name: "pool",
					description:
						"Pool id/address for open, close, reposition, or position lookup.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Pool id/address for open, close, reposition, or position lookup.",
				},
				{
					name: "position",
					description: "LP position id/mint/address.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "LP position id/mint/address.",
				},
				{
					name: "amount",
					description:
						"Liquidity amount for open, close, or reposition operations.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Liquidity amount for open, close, or reposition operations.",
				},
				{
					name: "range",
					description: "Desired concentrated liquidity price range.",
					required: false,
					schema: {
						type: "object",
					},
					descriptionCompressed: "Desired concentrated liquidity price range.",
				},
				{
					name: "tokenA",
					description: "First token filter or deposit token.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "First token filter or deposit token.",
				},
				{
					name: "tokenB",
					description: "Second token filter or deposit token.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Second token filter or deposit token.",
				},
				{
					name: "chainId",
					description: "Optional numeric EVM chain id.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed: "Optional numeric EVM chain id.",
				},
				{
					name: "slippageBps",
					description: "Maximum allowed slippage in basis points.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed: "max allowed slippage in basis points.",
				},
			],
			descriptionCompressed:
				"Manage LP positions by subaction, chain, dex, pool, position, amount, range, token filters.",
			similes: [
				"LP_MANAGEMENT",
				"LIQUIDITY_POOL_MANAGEMENT",
				"LP_MANAGER",
				"MANAGE_LP",
				"MANAGE_LIQUIDITY",
			],
			exampleCalls: [
				{
					user: "Use lp_management with the provided parameters.",
					actions: ["lp_management"],
					params: {
						lp_management: {
							subaction: "onboard",
							chain: "solana",
							dex: "example",
							pool: "example",
							position: "example",
							amount: "example",
							range: "example",
							tokenA: "example",
							tokenB: "example",
							chainId: 1,
							slippageBps: 1,
						},
					},
				},
			],
		},
		{
			name: "LS",
			description:
				"List entries in a directory, sorted with directories first then files. Each directory name has a trailing '/'. Pass an `ignore` array of glob patterns to skip entries. Use this instead of BASH for directory listing.",
			parameters: [
				{
					name: "path",
					description:
						"Absolute path of the directory to list. Defaults to the session cwd.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Absolute path of the directory to list. Defaults to the session cwd.",
				},
				{
					name: "ignore",
					description:
						"Array of glob patterns to exclude (e.g. ['*.log', 'tmp/*']).",
					required: false,
					schema: {
						type: "array",
						items: {
							type: "string",
						},
					},
					descriptionCompressed:
						"Array of glob patterns to exclude (e. g. ['*. log', 'tmp/*']).",
				},
			],
			descriptionCompressed:
				"List a directory; dirs first, files second; supports ignore globs.",
			similes: ["LIST_DIR", "DIR"],
			exampleCalls: [
				{
					user: "Use LS with the provided parameters.",
					actions: ["LS"],
					params: {
						LS: {
							path: "example",
							ignore: "example",
						},
					},
				},
			],
		},
		{
			name: "MANAGE_ISSUES",
			description: "Manage GitHub issues for a repository. ",
			parameters: [
				{
					name: "operation",
					description:
						"The operation to perform: create, list, get, update, comment, close, reopen, add_labels",
					required: true,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Manage GitHub issues: create, list, comment, close, reopen.",
				},
				{
					name: "repo",
					description: "Repository in owner/repo format or full GitHub URL.",
					required: true,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Repository in owner/repo format or full GitHub URL.",
				},
				{
					name: "title",
					description: "Issue title (for create operation).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Issue title (for create operation).",
				},
				{
					name: "body",
					description:
						"Issue body/description (for create or comment operations).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Issue body/description (for create or comment operations).",
				},
				{
					name: "issueNumber",
					description:
						"Issue number (for get, update, comment, close, reopen operations).",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed:
						"Issue number (for get, update, comment, close, reopen operations).",
				},
				{
					name: "labels",
					description: "Labels to add (comma-separated string or array).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Labels to add (comma-separated string or array).",
				},
				{
					name: "state",
					description:
						"Filter by state: open, closed, or all (for list operation).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Filter by state: open, closed, or all (for list operation).",
				},
			],
			descriptionCompressed:
				"manage GitHub issue repository support create issue, list issue, get issue detail, add comment, updat, close, reopen issue",
			similes: [
				"CREATE_ISSUE",
				"LIST_ISSUES",
				"CLOSE_ISSUE",
				"COMMENT_ISSUE",
				"UPDATE_ISSUE",
				"GET_ISSUE",
			],
			exampleCalls: [
				{
					user: "Use MANAGE_ISSUES with the provided parameters.",
					actions: ["MANAGE_ISSUES"],
					params: {
						MANAGE_ISSUES: {
							operation: "example",
							repo: "example",
							title: "example",
							body: "example",
							issueNumber: 1,
							labels: "example",
							state: "example",
						},
					},
				},
			],
		},
		{
			name: "manage_raydium_positions",
			description:
				"Automatically manage Raydium positions by rebalancing them when they drift too far from the pool price",
			parameters: [
				{
					name: "repositionThresholdBps",
					description:
						"Required drift threshold in basis points before rebalancing.",
					required: true,
					schema: {
						type: "integer",
						minimum: 1,
						maximum: 10000,
					},
					descriptionCompressed:
						"Required drift threshold in basis points before rebalancing.",
				},
				{
					name: "intervalSeconds",
					description:
						"Requested monitoring interval in seconds for the automation policy.",
					required: true,
					schema: {
						type: "integer",
						minimum: 1,
						maximum: 86400,
					},
					descriptionCompressed:
						"Requested monitoring interval in seconds for the automation policy.",
				},
				{
					name: "slippageToleranceBps",
					description:
						"Required slippage tolerance in basis points for reopen transactions.",
					required: true,
					schema: {
						type: "integer",
						minimum: 1,
						maximum: 5000,
					},
					descriptionCompressed:
						"Required slippage tolerance in basis points for reopen transactions.",
				},
			],
			descriptionCompressed:
				"automatically manage Raydium position rebalance drift too far pool price",
			similes: [
				"AUTOMATE_RAYDIUM_REBALANCING",
				"AUTOMATE_RAYDIUM_POSITIONS",
				"START_MANAGING_RAYDIUM_POSITIONS",
			],
			exampleCalls: [
				{
					user: "Use manage_raydium_positions with the provided parameters.",
					actions: ["manage_raydium_positions"],
					params: {
						manage_raydium_positions: {
							repositionThresholdBps: "example",
							intervalSeconds: "example",
							slippageToleranceBps: "example",
						},
					},
				},
			],
		},
		{
			name: "MANAGE_SHOPIFY_CUSTOMERS",
			description: "List and search customers in a connected Shopify store.",
			parameters: [
				{
					name: "action",
					description: "Customer action. One of: list, search.",
					required: false,
					schema: {
						type: "string",
						enum: ["list", "search"],
					},
					descriptionCompressed: "Customer action. One of: list, search.",
				},
				{
					name: "query",
					description:
						"Customer name, email, or other Shopify customer search term.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Customer name, email, or other Shopify customer search term.",
				},
			],
			descriptionCompressed: "List/search Shopify customers.",
			similes: ["LIST_CUSTOMERS", "FIND_CUSTOMER", "SEARCH_CUSTOMERS"],
			exampleCalls: [
				{
					user: "Use MANAGE_SHOPIFY_CUSTOMERS with the provided parameters.",
					actions: ["MANAGE_SHOPIFY_CUSTOMERS"],
					params: {
						MANAGE_SHOPIFY_CUSTOMERS: {
							action: "list",
							query: "example",
						},
					},
				},
			],
		},
		{
			name: "MANAGE_SHOPIFY_INVENTORY",
			description:
				"Check inventory levels and list store locations. Stock adjustments require confirmed:true.",
			parameters: [
				{
					name: "confirmed",
					description:
						"Must be true to adjust Shopify inventory after preview.",
					required: false,
					schema: {
						type: "boolean",
						default: false,
					},
					descriptionCompressed:
						"Must be true to adjust Shopify inventory after preview.",
				},
			],
			descriptionCompressed:
				"Check inventory, adjust stock, list Shopify locations.",
			similes: [
				"CHECK_INVENTORY",
				"ADJUST_INVENTORY",
				"CHECK_STOCK",
				"UPDATE_STOCK",
			],
			exampleCalls: [
				{
					user: "Use MANAGE_SHOPIFY_INVENTORY with the provided parameters.",
					actions: ["MANAGE_SHOPIFY_INVENTORY"],
					params: {
						MANAGE_SHOPIFY_INVENTORY: {
							confirmed: false,
						},
					},
				},
			],
		},
		{
			name: "MANAGE_SHOPIFY_ORDERS",
			description:
				"List recent orders and check order status. Fulfillment requires confirmed:true.",
			parameters: [
				{
					name: "confirmed",
					description: "Must be true to fulfill a Shopify order after preview.",
					required: false,
					schema: {
						type: "boolean",
						default: false,
					},
					descriptionCompressed:
						"Must be true to fulfill a Shopify order after preview.",
				},
			],
			descriptionCompressed:
				"List orders, check status, mark fulfilled in Shopify.",
			similes: ["LIST_ORDERS", "CHECK_ORDERS", "FULFILL_ORDER", "ORDER_STATUS"],
			exampleCalls: [
				{
					user: "Use MANAGE_SHOPIFY_ORDERS with the provided parameters.",
					actions: ["MANAGE_SHOPIFY_ORDERS"],
					params: {
						MANAGE_SHOPIFY_ORDERS: {
							confirmed: false,
						},
					},
				},
			],
		},
		{
			name: "MANAGE_SHOPIFY_PRODUCTS",
			description:
				"List and search Shopify products. Product creation and updates require confirmed:true.",
			parameters: [
				{
					name: "confirmed",
					description:
						"Must be true to create or update a Shopify product after preview.",
					required: false,
					schema: {
						type: "boolean",
						default: false,
					},
					descriptionCompressed:
						"Must be true to create or update a Shopify product after preview.",
				},
			],
			descriptionCompressed: "List/search/create/update Shopify products.",
			similes: [
				"LIST_PRODUCTS",
				"CREATE_PRODUCT",
				"UPDATE_PRODUCT",
				"SEARCH_PRODUCTS",
			],
			exampleCalls: [
				{
					user: "Use MANAGE_SHOPIFY_PRODUCTS with the provided parameters.",
					actions: ["MANAGE_SHOPIFY_PRODUCTS"],
					params: {
						MANAGE_SHOPIFY_PRODUCTS: {
							confirmed: false,
						},
					},
				},
			],
		},
		{
			name: "MANAGE_WINDOW",
			description:
				"manage_window_action:\n  purpose: Manage desktop windows: list visible windows, focus or switch, arrange or move, minimize, maximize, restore, and close.\n  guidance: Use list first to discover window IDs, then use focused window actions.\n  actions: list/focus/switch/arrange/move/minimize/maximize/restore/close.",
			parameters: [
				{
					name: "action",
					description: "Window action to perform.",
					required: true,
					schema: {
						type: "string",
						enum: [
							"list",
							"focus",
							"switch",
							"arrange",
							"move",
							"minimize",
							"maximize",
							"restore",
							"close",
						],
					},
					descriptionCompressed: "Window action to perform.",
				},
				{
					name: "windowId",
					description: "Window identifier.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Window id.",
				},
				{
					name: "windowTitle",
					description:
						"Window title or app-name query for switch/restore/focus operations.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Window title or app-name query for switch/restore/focus operations.",
				},
				{
					name: "arrangement",
					description:
						"Layout for arrange: tile, cascade, vertical, or horizontal.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Layout for arrange: tile, cascade, vertical, or horizontal.",
				},
				{
					name: "x",
					description: "Target X coordinate for move.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed: "Target X coordinate for move.",
				},
				{
					name: "y",
					description: "Target Y coordinate for move.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed: "Target Y coordinate for move.",
				},
			],
			descriptionCompressed:
				"Window management router: list/focus/switch/arrange/move/minimize/maximize/restore/close; list first to discover window ids.",
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
			exampleCalls: [
				{
					user: "Use MANAGE_WINDOW with the provided parameters.",
					actions: ["MANAGE_WINDOW"],
					params: {
						MANAGE_WINDOW: {
							action: "list",
							windowId: "example",
							windowTitle: "example",
							arrangement: "example",
							x: 1,
							y: 1,
						},
					},
				},
			],
		},
		{
			name: "MARK_FOLLOWUP_DONE",
			description:
				"Mark a contact as already followed-up-with (updates lastContactedAt to now). ",
			parameters: [
				{
					name: "contactId",
					description:
						"UUID of the contact. Preferred when known — eliminates name ambiguity.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"UUID of the contact. Preferred when known - eliminates name ambiguity.",
				},
				{
					name: "contactName",
					description:
						"Human-readable contact name. Must be unambiguous across stored contacts.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Human-readable contact name. Must be unambiguous across stored contacts.",
				},
				{
					name: "note",
					description: "Optional note about the interaction.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Optional note about the interaction.",
				},
			],
			similes: [
				"FOLLOWED_UP",
				"FOLLOWUP_DONE",
				"CONTACTED",
				"MARK_CONTACTED",
				"RECORD_INTERACTION",
			],
			exampleCalls: [
				{
					user: "Use MARK_FOLLOWUP_DONE with the provided parameters.",
					actions: ["MARK_FOLLOWUP_DONE"],
					params: {
						MARK_FOLLOWUP_DONE: {
							contactId: "example",
							contactName: "example",
							note: "example",
						},
					},
				},
			],
			descriptionCompressed:
				"Mark a contact as already followed-up-with (updates lastContactedAt to now).",
		},
		{
			name: "MATRIX_JOIN_ROOM",
			description: "Join a Matrix room by ID or alias",
			parameters: [
				{
					name: "room",
					description:
						"Matrix room id (!room:server) or alias (#alias:server).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Matrix room id (!room:server) or alias (#alias:server).",
				},
			],
			descriptionCompressed: "Join Matrix room by id or alias.",
			similes: ["JOIN_MATRIX_ROOM", "ENTER_ROOM"],
			exampleCalls: [
				{
					user: "Use MATRIX_JOIN_ROOM with the provided parameters.",
					actions: ["MATRIX_JOIN_ROOM"],
					params: {
						MATRIX_JOIN_ROOM: {
							room: "example",
						},
					},
				},
			],
		},
		{
			name: "MODIFY_EXISTING_N8N_WORKFLOW",
			description: "Load an existing deployed n8n workflow for modification. ",
			parameters: [
				{
					name: "workflowId",
					description:
						"Optional exact n8n workflow id to load into the draft editor.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Optional exact n8n workflow id to load into the draft editor.",
				},
				{
					name: "workflowName",
					description: "Optional workflow name to load into the draft editor.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Optional workflow name to load into the draft editor.",
				},
				{
					name: "query",
					description:
						"Optional natural-language description of the workflow to modify.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Optional natural-language description of the workflow to modify.",
				},
			],
			descriptionCompressed:
				"Load deployed n8n workflow into draft editor; then use CREATE_N8N_WORKFLOW to change, preview, redeploy.",
			similes: [
				"EDIT_EXISTING_WORKFLOW",
				"UPDATE_EXISTING_WORKFLOW",
				"CHANGE_EXISTING_WORKFLOW",
				"LOAD_WORKFLOW_FOR_EDIT",
			],
			exampleCalls: [
				{
					user: "Use MODIFY_EXISTING_N8N_WORKFLOW with the provided parameters.",
					actions: ["MODIFY_EXISTING_N8N_WORKFLOW"],
					params: {
						MODIFY_EXISTING_N8N_WORKFLOW: {
							workflowId: "example",
							workflowName: "example",
							query: "example",
						},
					},
				},
			],
		},
		{
			name: "MUSIC_GENERATION",
			description:
				"Generate music through Suno. Use subaction generate for a simple prompt, custom for style/BPM/key/reference parameters, or extend for an existing audio_id and duration.",
			parameters: [
				{
					name: "subaction",
					description: "Suno operation: generate, custom, or extend.",
					required: false,
					schema: {
						type: "string",
						enum: ["generate", "custom", "extend"],
					},
					descriptionCompressed: "Suno operation: generate, custom, or extend.",
				},
				{
					name: "prompt",
					description: "Music prompt for generate/custom.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Music prompt for generate/custom.",
				},
				{
					name: "audio_id",
					description: "Existing Suno audio id for extend.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Existing Suno audio id for extend.",
				},
				{
					name: "duration",
					description: "Generation duration or extension seconds.",
					required: false,
					schema: {
						type: "number",
						default: 30,
					},
					descriptionCompressed: "Generation duration or extension seconds.",
				},
			],
			descriptionCompressed:
				"Suno music generation router subaction: generate, custom, extend.",
			similes: [
				"GENERATE_MUSIC",
				"CREATE_MUSIC",
				"MAKE_MUSIC",
				"COMPOSE_MUSIC",
				"CUSTOM_GENERATE_MUSIC",
				"EXTEND_AUDIO",
			],
			exampleCalls: [
				{
					user: "Use MUSIC_GENERATION with the provided parameters.",
					actions: ["MUSIC_GENERATION"],
					params: {
						MUSIC_GENERATION: {
							subaction: "generate",
							prompt: "example",
							audio_id: "example",
							duration: 30,
						},
					},
				},
			],
		},
		{
			name: "NOSTR_PUBLISH_NOTE",
			description:
				"Publish a Nostr text note (kind:1) to the configured relays. Use for short broadcast posts; use NOSTR_SEND_DM for private messages.",
			parameters: [
				{
					name: "text",
					description: "Note content to publish.",
					required: true,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Note content to publish.",
				},
			],
			descriptionCompressed: "Publish Nostr note (kind:1) to relays.",
			similes: [
				"NOSTR_NOTE",
				"POST_NOSTR_NOTE",
				"NOSTR_KIND_1",
				"PUBLISH_NOSTR",
			],
			exampleCalls: [
				{
					user: "Use NOSTR_PUBLISH_NOTE with the provided parameters.",
					actions: ["NOSTR_PUBLISH_NOTE"],
					params: {
						NOSTR_PUBLISH_NOTE: {
							text: "example",
						},
					},
				},
			],
		},
		{
			name: "NOSTR_PUBLISH_PROFILE",
			description:
				"Publish or update the bot's Nostr profile (kind:0 metadata)",
			parameters: [
				{
					name: "name",
					description: "Display name for the Nostr profile.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Display name for the Nostr profile.",
				},
				{
					name: "about",
					description: "Profile bio/about text.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Profile bio/about text.",
				},
				{
					name: "picture",
					description: "Profile picture URL.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Profile picture URL.",
				},
			],
			descriptionCompressed:
				"publish update bot Nostr profile (kind: 0 metadata)",
			similes: ["UPDATE_NOSTR_PROFILE", "SET_NOSTR_PROFILE", "NOSTR_PROFILE"],
			exampleCalls: [
				{
					user: "Use NOSTR_PUBLISH_PROFILE with the provided parameters.",
					actions: ["NOSTR_PUBLISH_PROFILE"],
					params: {
						NOSTR_PUBLISH_PROFILE: {
							name: "example",
							about: "example",
							picture: "example",
						},
					},
				},
			],
		},
		{
			name: "NOSTR_SEND_DM",
			description: "Send an encrypted direct message via Nostr (NIP-04)",
			parameters: [
				{
					name: "text",
					description: "Direct message text to send.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Direct msg text to send.",
				},
				{
					name: "toPubkey",
					description: "Recipient npub, hex pubkey, or current.",
					required: false,
					schema: {
						type: "string",
						default: "current",
					},
					descriptionCompressed: "Recipient npub, hex pubkey, or current.",
				},
			],
			descriptionCompressed: "send encrypt direct message via Nostr (NIP-04)",
			similes: ["SEND_NOSTR_DM", "NOSTR_MESSAGE", "NOSTR_TEXT", "DM_NOSTR"],
			exampleCalls: [
				{
					user: "Use NOSTR_SEND_DM with the provided parameters.",
					actions: ["NOSTR_SEND_DM"],
					params: {
						NOSTR_SEND_DM: {
							text: "example",
							toPubkey: "current",
						},
					},
				},
			],
		},
		{
			name: "NOTEBOOK_EDIT",
			description:
				"Replace, insert, or delete a cell in a Jupyter `.ipynb` notebook. Default `edit_mode` is `replace`. Insert places a new cell after `cell_id` (or at the start if omitted). Delete removes the matching cell. The notebook must have been READ in this session and must still match its recorded mtime.",
			parameters: [
				{
					name: "notebook_path",
					description: "Absolute path to a .ipynb notebook.",
					required: true,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Absolute path to a. ipynb notebook.",
				},
				{
					name: "cell_id",
					description:
						"Target cell id. Required for replace and delete; optional for insert.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Target cell id. Required for replace and delete. optional for insert.",
				},
				{
					name: "new_source",
					description: "New cell source text. Required for replace and insert.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"New cell source text. Required for replace and insert.",
				},
				{
					name: "cell_type",
					description: "Cell type: code | markdown | raw.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Cell type: code | markdown | raw.",
				},
				{
					name: "edit_mode",
					description: "replace | insert | delete (default replace).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "replace | insert | delete (default replace).",
				},
			],
			descriptionCompressed:
				"Replace/insert/delete a cell in a Jupyter notebook by cell_id.",
			similes: ["EDIT_NOTEBOOK"],
			exampleCalls: [
				{
					user: "Use NOTEBOOK_EDIT with the provided parameters.",
					actions: ["NOTEBOOK_EDIT"],
					params: {
						NOTEBOOK_EDIT: {
							notebook_path: "example",
							cell_id: "example",
							new_source: "example",
							cell_type: "example",
							edit_mode: "example",
						},
					},
				},
			],
		},
		{
			name: "PAYMENT_OP",
			description:
				"Payment router for the active mysticism reading session. Set op to 'check' to read payment status, or 'request' to ask the user to pay (set amount or include $X.XX in the message).",
			parameters: [
				{
					name: "op",
					description: "Operation: check or request.",
					required: true,
					schema: {
						type: "string",
						enum: ["check", "request"],
					},
					descriptionCompressed: "Operation: check or request.",
				},
				{
					name: "amount",
					description:
						"For request — payment amount as a string (e.g. '3.00').",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"For request - payment amount as a string (e. g. '3. 00').",
				},
				{
					name: "entityId",
					description:
						"For check — optional entity id whose active reading payment should be checked. Defaults to the current sender.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"For check - optional entity id whose active reading payment should be checked. Defaults to the current sender.",
				},
				{
					name: "roomId",
					description:
						"For check — optional room id whose active reading payment should be checked. Defaults to the current room.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"For check - optional room id whose active reading payment should be checked. Defaults to the current room.",
				},
			],
			descriptionCompressed: "Mysticism payment ops: check, request.",
			similes: [
				"REQUEST_PAYMENT",
				"CHARGE_USER",
				"ASK_FOR_PAYMENT",
				"SET_PRICE",
				"CHECK_PAYMENT",
				"VERIFY_PAYMENT",
				"PAYMENT_STATUS",
			],
			exampleCalls: [
				{
					user: "Use PAYMENT_OP with the provided parameters.",
					actions: ["PAYMENT_OP"],
					params: {
						PAYMENT_OP: {
							op: "check",
							amount: "example",
							entityId: "example",
							roomId: "example",
						},
					},
				},
			],
		},
		{
			name: "PLACE_CALL",
			description:
				"Place a phone call to a given number using the Android Telecom service. ",
			parameters: [
				{
					name: "phoneNumber",
					description:
						"Phone number to call. Accepts E.164 (`+15551234567`) or local ",
					required: true,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Phone number to call. Accepts E. 164 (`+15551234567`) or local",
				},
			],
			descriptionCompressed:
				"Place a phone call via Android Telecom. Requires CALL_PHONE permission.",
			similes: ["CALL", "DIAL", "RING", "PHONE_CALL", "MAKE_CALL"],
			exampleCalls: [
				{
					user: "Use PLACE_CALL with the provided parameters.",
					actions: ["PLACE_CALL"],
					params: {
						PLACE_CALL: {
							phoneNumber: "example",
						},
					},
				},
			],
		},
		{
			name: "PLAY_AUDIO",
			description:
				"Start playing a new song: provide a track name, artist, search words, or a media URL. ",
			parameters: [
				{
					name: "query",
					description:
						"Track name, artist, search phrase, or direct media URL to play.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Track name, artist, search phrase, or direct media URL to play.",
				},
				{
					name: "url",
					description:
						"Direct media URL to play. Prefer query for standard song requests.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Direct media URL to play. Prefer query for standard song requests.",
				},
				{
					name: "confirmed",
					description: "Must be true to play or queue the requested audio.",
					required: false,
					schema: {
						type: "boolean",
						default: false,
					},
					descriptionCompressed:
						"Must be true to play or queue the requested audio.",
				},
			],
			descriptionCompressed:
				"Play new song by name/artist/URL. Not for pause/resume/stop/skip.",
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
			exampleCalls: [
				{
					user: "Use PLAY_AUDIO with the provided parameters.",
					actions: ["PLAY_AUDIO"],
					params: {
						PLAY_AUDIO: {
							query: "example",
							url: "example",
							confirmed: false,
						},
					},
				},
			],
		},
		{
			name: "PLAY_EMOTE",
			description:
				"Play a one-shot emote animation on your 3D VRM avatar, then return to idle. ",
			parameters: [
				{
					name: "emote",
					description:
						"Required emote ID to play once silently before returning to idle. ",
					required: true,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Required emote ID to play once silently before returning to idle.",
				},
			],
			descriptionCompressed:
				"Play one-shot VRM avatar emote animation. Silent visual side-action.",
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
			exampleCalls: [
				{
					user: "Use PLAY_EMOTE with the provided parameters.",
					actions: ["PLAY_EMOTE"],
					params: {
						PLAY_EMOTE: {
							emote: "example",
						},
					},
				},
			],
		},
		{
			name: "PLAY_MUSIC_QUERY",
			description:
				"Handle any complex music query that requires understanding and research, then queue the selected track after confirmed:true. Supports: artist queries (first single, latest song, similar artists, popular songs, nth album), temporal (80s, 90s, specific years), genre/mood/vibe, activities (workout, study, party), charts/trending, albums, movie/game/TV soundtracks, lyrics/topics, versions (covers, remixes, acoustic, live), and more. Uses Wikipedia, music databases, and web search to find the right music.",
			parameters: [
				{
					name: "confirmed",
					description:
						"Must be true to resolve the music query and add the result to the queue.",
					required: false,
					schema: {
						type: "boolean",
						default: false,
					},
					descriptionCompressed:
						"Must be true to resolve the music query and add the result to the queue.",
				},
			],
			descriptionCompressed:
				"Complex music search: artist, genre, mood, era, activity, charts, soundtracks, versions. Uses web search + databases.",
			similes: [
				"SMART_PLAY",
				"RESEARCH_AND_PLAY",
				"FIND_AND_PLAY",
				"INTELLIGENT_MUSIC_SEARCH",
			],
			exampleCalls: [
				{
					user: "Use PLAY_MUSIC_QUERY with the provided parameters.",
					actions: ["PLAY_MUSIC_QUERY"],
					params: {
						PLAY_MUSIC_QUERY: {
							confirmed: false,
						},
					},
				},
			],
		},
		{
			name: "PLAYBACK_OP",
			description:
				"Music playback control. Use op=pause, resume, skip, stop, or queue. ",
			parameters: [
				{
					name: "op",
					description:
						"Playback operation: pause, resume, skip, stop, or queue.",
					required: true,
					schema: {
						type: "string",
						enum: ["pause", "resume", "skip", "stop", "queue"],
					},
					descriptionCompressed:
						"Playback operation: pause, resume, skip, stop, or queue.",
				},
				{
					name: "query",
					description: "Track query for op=queue.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Track query for op=queue.",
				},
				{
					name: "confirmed",
					description: "Must be true for skip, stop, or queue.",
					required: false,
					schema: {
						type: "boolean",
						default: false,
					},
					descriptionCompressed: "Must be true for skip, stop, or queue.",
				},
			],
			descriptionCompressed:
				"Music playback ops: pause, resume, skip, stop, queue.",
			similes: [
				"PAUSE_MUSIC",
				"RESUME_MUSIC",
				"STOP_MUSIC",
				"SKIP_TRACK",
				"QUEUE_MUSIC",
				"PAUSE",
				"RESUME",
				"UNPAUSE",
				"SKIP",
				"NEXT_TRACK",
				"ADD_TO_QUEUE",
			],
			exampleCalls: [
				{
					user: "Use PLAYBACK_OP with the provided parameters.",
					actions: ["PLAYBACK_OP"],
					params: {
						PLAYBACK_OP: {
							op: "pause",
							query: "example",
							confirmed: false,
						},
					},
				},
			],
		},
		{
			name: "PLAYLIST_OP",
			description:
				"Playlist operations. Use op=save, load, delete, or add. State-changing ops require confirmed:true.",
			parameters: [
				{
					name: "op",
					description: "Playlist operation: save, load, delete, or add.",
					required: true,
					schema: {
						type: "string",
						enum: ["save", "load", "delete", "add"],
					},
					descriptionCompressed:
						"Playlist operation: save, load, delete, or add.",
				},
				{
					name: "playlistName",
					description: "Playlist name for save/load/delete/add.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Playlist name for save/load/delete/add.",
				},
				{
					name: "song",
					description: "Song query for op=add.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Song query for op=add.",
				},
				{
					name: "confirmed",
					description: "Must be true to perform a state-changing playlist op.",
					required: false,
					schema: {
						type: "boolean",
						default: false,
					},
					descriptionCompressed:
						"Must be true to perform a state-changing playlist op.",
				},
			],
			descriptionCompressed: "Playlist ops: save, load, delete, add.",
			similes: [
				"MUSIC_PLAYLIST",
				"SAVE_PLAYLIST",
				"LOAD_PLAYLIST",
				"DELETE_PLAYLIST",
				"ADD_TO_PLAYLIST",
				"REMOVE_PLAYLIST",
				"PLAY_PLAYLIST",
			],
			exampleCalls: [
				{
					user: "Use PLAYLIST_OP with the provided parameters.",
					actions: ["PLAYLIST_OP"],
					params: {
						PLAYLIST_OP: {
							op: "save",
							playlistName: "example",
							song: "example",
							confirmed: false,
						},
					},
				},
			],
		},
		{
			name: "POLYMARKET_PLACE_ORDER",
			description:
				"Explain Polymarket order placement readiness. Signed trading is disabled in this app scaffold.",
			parameters: [
				{
					name: "side",
					description:
						"Intended side, buy or sell. Trading is currently disabled.",
					required: false,
					schema: {
						type: "string",
						enum: ["buy", "sell"],
					},
					descriptionCompressed:
						"Intended side, buy or sell. Trading is disabled.",
				},
				{
					name: "marketId",
					description: "Polymarket market id or condition id.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Polymarket market id or condition id.",
				},
				{
					name: "amount",
					description: "Intended order amount. Trading is currently disabled.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed: "Intended order amount. Trading is disabled.",
				},
			],
			descriptionCompressed: "Report disabled Polymarket trading readiness.",
			similes: ["POLYMARKET_TRADE", "POLYMARKET_BUY", "POLYMARKET_SELL"],
			exampleCalls: [
				{
					user: "Use POLYMARKET_PLACE_ORDER with the provided parameters.",
					actions: ["POLYMARKET_PLACE_ORDER"],
					params: {
						POLYMARKET_PLACE_ORDER: {
							side: "buy",
							marketId: "example",
							amount: 1,
						},
					},
				},
			],
		},
		{
			name: "POLYMARKET_READ",
			description:
				"Read Polymarket public state. kind selects: status (readiness), markets (list active markets), market (single market by id/slug), orderbook (CLOB quote by tokenId), positions (wallet positions).",
			parameters: [
				{
					name: "kind",
					description:
						"Read kind: status | markets | market | orderbook | positions.",
					required: true,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Read kind: status | markets | market | orderbook | positions.",
				},
				{
					name: "limit",
					description: "markets only: max markets (1-100).",
					required: false,
					schema: {
						type: "number",
						default: 20,
					},
					descriptionCompressed: "markets only: max markets (1-100).",
				},
				{
					name: "offset",
					description: "markets only: result offset.",
					required: false,
					schema: {
						type: "number",
						default: 0,
					},
					descriptionCompressed: "markets only: result offset.",
				},
				{
					name: "id",
					description: "market only: Polymarket Gamma market id.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "market only: Polymarket Gamma market id.",
				},
				{
					name: "slug",
					description: "market only: Polymarket market slug.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "market only: Polymarket market slug.",
				},
				{
					name: "tokenId",
					description: "orderbook only: Polymarket CLOB token id.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "orderbook only: Polymarket CLOB token id.",
				},
				{
					name: "user",
					description: "positions only: wallet address.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "positions only: wallet address.",
				},
			],
			descriptionCompressed:
				"Polymarket reads: status, markets, market, orderbook, positions.",
			similes: [
				"POLYMARKET_STATUS",
				"POLYMARKET_READINESS",
				"POLYMARKET_HEALTH",
				"POLYMARKET_GET_MARKETS",
				"POLYMARKET_MARKETS",
				"SEARCH_POLYMARKET_MARKETS",
				"POLYMARKET_GET_MARKET",
				"POLYMARKET_MARKET",
				"POLYMARKET_MARKET_DETAILS",
				"POLYMARKET_GET_ORDERBOOK",
				"POLYMARKET_ORDERBOOK",
				"POLYMARKET_QUOTE",
				"POLYMARKET_TOKEN_INFO",
				"POLYMARKET_GET_POSITIONS",
				"POLYMARKET_POSITIONS",
				"POLYMARKET_WALLET_POSITIONS",
			],
			exampleCalls: [
				{
					user: "Use POLYMARKET_READ with the provided parameters.",
					actions: ["POLYMARKET_READ"],
					params: {
						POLYMARKET_READ: {
							kind: "example",
							limit: 20,
							offset: 0,
							id: "example",
							slug: "example",
							tokenId: "example",
							user: "example",
						},
					},
				},
			],
		},
		{
			name: "POST_BLUESKY",
			description:
				"Post a top-level Bluesky post or a reply. kind=post supports replyTo={uri,cid}. text optional; if empty the runtime model generates content.",
			parameters: [
				{
					name: "kind",
					description: "Always 'post' for now.",
					required: true,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Always 'post' for now.",
				},
				{
					name: "text",
					description:
						"Post text. If empty, the agent's model generates content.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Post text. If empty, agent's model generates content.",
				},
				{
					name: "replyTo",
					description:
						"Reply target as { uri, cid }. Omit for a top-level post.",
					required: false,
					schema: {
						type: "object",
					},
					descriptionCompressed:
						"Reply target as { uri, cid }. Omit for a top-level post.",
				},
			],
			descriptionCompressed: "Post or reply on Bluesky.",
			similes: [
				"BLUESKY_POST",
				"BLUESKY_REPLY",
				"REPLY_BLUESKY",
				"POST_TO_BLUESKY",
			],
			exampleCalls: [
				{
					user: "Use POST_BLUESKY with the provided parameters.",
					actions: ["POST_BLUESKY"],
					params: {
						POST_BLUESKY: {
							kind: "example",
							text: "example",
							replyTo: "example",
						},
					},
				},
			],
		},
		{
			name: "PROVISION_WORKSPACE",
			description: "Create a git workspace for coding tasks. ",
			parameters: [
				{
					name: "repo",
					description: "Git repository URL to clone.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Create git workspace for coding tasks.",
				},
				{
					name: "baseBranch",
					description:
						"Base branch to create feature branch from (default: main).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Base branch to create feature branch from (default: main).",
				},
				{
					name: "useWorktree",
					description: "Create a git worktree instead of a full clone.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed:
						"Create a git worktree instead of a full clone.",
				},
				{
					name: "parentWorkspaceId",
					description: "Parent workspace ID for worktree creation.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Parent workspace ID for worktree creation.",
				},
			],
			descriptionCompressed:
				"create git workspace cod task clone repository create git worktree isolat development",
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
							repo: "example",
							baseBranch: "example",
							useWorktree: false,
							parentWorkspaceId: "example",
						},
					},
				},
			],
		},
		{
			name: "READ",
			description:
				"Read the contents of a file at an absolute path. Returns numbered lines, capped by a per-call line limit and a per-file byte limit. Use offset/limit to paginate through large files. Required before WRITE/EDIT can mutate an existing file.",
			parameters: [
				{
					name: "file_path",
					description: "Absolute path to the file to read.",
					required: true,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Absolute path to the file to read.",
				},
				{
					name: "offset",
					description: "Zero-based line offset to start reading from.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed:
						"Zero-based line offset to start reading from.",
				},
				{
					name: "limit",
					description: "Max number of lines to return.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed: "Max number of lines to return.",
				},
			],
			descriptionCompressed:
				"Read a file by absolute path; returns numbered lines (offset/limit supported).",
			similes: ["READ_FILE", "CAT", "OPEN_FILE"],
			exampleCalls: [
				{
					user: "Use READ with the provided parameters.",
					actions: ["READ"],
					params: {
						READ: {
							file_path: "example",
							offset: 1,
							limit: 1,
						},
					},
				},
			],
		},
		{
			name: "READ_MCP_RESOURCE",
			description: "Reads a resource from an MCP server",
			parameters: [
				{
					name: "serverName",
					description: "MCP server name that exposes the resource.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "MCP server name that exposes the resource.",
				},
				{
					name: "uri",
					description: "Exact MCP resource URI to read.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Exact MCP resource URI to read.",
				},
			],
			descriptionCompressed: "read resource MCP server",
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
			exampleCalls: [
				{
					user: "Use READ_MCP_RESOURCE with the provided parameters.",
					actions: ["READ_MCP_RESOURCE"],
					params: {
						READ_MCP_RESOURCE: {
							serverName: "example",
							uri: "example",
						},
					},
				},
			],
		},
		{
			name: "READING_OP",
			description:
				"Mystical reading router. Set type to tarot, astrology, or iching, and subaction to start (begin a new reading), followup (reveal the next element), or deepen (more interpretation for the most-recent element).",
			parameters: [
				{
					name: "type",
					description: "Reading type: tarot, astrology, or iching.",
					required: true,
					schema: {
						type: "string",
						enum: ["tarot", "astrology", "iching"],
					},
					descriptionCompressed: "Reading type: tarot, astrology, or iching.",
				},
				{
					name: "subaction",
					description: "Subaction: start, followup, or deepen.",
					required: true,
					schema: {
						type: "string",
						enum: ["start", "followup", "deepen"],
					},
					descriptionCompressed: "Subaction: start, followup, or deepen.",
				},
				{
					name: "question",
					description: "Optional question or focus for the reading.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Optional question or focus for the reading.",
				},
				{
					name: "context",
					description:
						"Optional additional context (e.g., birth data hint for astrology).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Optional additional context (e. g. , birth data hint for astrology).",
				},
			],
			descriptionCompressed:
				"Mystical readings: tarot, astrology, iching; subactions: start, followup, deepen.",
			similes: [
				"TAROT_READING",
				"READ_TAROT",
				"DRAW_CARDS",
				"TAROT_SPREAD",
				"CARD_READING",
				"ICHING_READING",
				"CAST_HEXAGRAM",
				"CONSULT_ICHING",
				"THROW_COINS",
				"ORACLE_READING",
				"ASTROLOGY_READING",
				"BIRTH_CHART",
				"NATAL_CHART",
				"HOROSCOPE_READING",
				"ZODIAC_READING",
				"READING_FOLLOWUP",
				"CONTINUE_READING",
				"NEXT_CARD",
				"PROCEED_READING",
				"DEEPEN_READING",
				"EXPLORE_DEEPER",
				"ELABORATE_READING",
			],
			exampleCalls: [
				{
					user: "Use READING_OP with the provided parameters.",
					actions: ["READING_OP"],
					params: {
						READING_OP: {
							type: "tarot",
							subaction: "start",
							question: "example",
							context: "example",
						},
					},
				},
			],
		},
		{
			name: "RELEASE_BLOCK",
			description:
				"Release an active website block rule. Requires confirmed:true. ",
			parameters: [
				{
					name: "ruleId",
					description: "ID of the block rule to release.",
					required: true,
					schema: {
						type: "string",
					},
					descriptionCompressed: "ID of the block rule to release.",
				},
				{
					name: "confirmed",
					description:
						"Must be true to release. Prevents accidental unblocking.",
					required: true,
					schema: {
						type: "boolean",
					},
					descriptionCompressed:
						"Must be true to release. Prevents accidental unblocking.",
				},
				{
					name: "reason",
					description: "Optional reason for release, stored on the rule.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Optional reason for release, stored on the rule.",
				},
			],
			descriptionCompressed:
				"Release a website block rule; requires confirmation.",
			similes: ["RELEASE_WEBSITE_BLOCK", "END_BLOCK_RULE", "BYPASS_BLOCK_RULE"],
			exampleCalls: [
				{
					user: "Use RELEASE_BLOCK with the provided parameters.",
					actions: ["RELEASE_BLOCK"],
					params: {
						RELEASE_BLOCK: {
							ruleId: "example",
							confirmed: false,
							reason: "example",
						},
					},
				},
			],
		},
		{
			name: "REMOTE_ATTESTATION",
			description:
				"Generate a remote attestation to prove that the agent is running in a TEE (Trusted Execution Environment)",
			parameters: [],
			descriptionCompressed:
				"generate remote attestation prove agent run TEE (Trusted Execution Environment)",
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
		},
		{
			name: "REPLY_X_DM",
			description:
				"Reply to a Twitter/X direct message. Two-stage: without `confirmed: true` this returns a preview and requires confirmation; with `confirmed: true` the DM is sent.",
			parameters: [
				{
					name: "recipient",
					description: "Recipient user id or username (without leading @).",
					required: true,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Recipient user id or username (without leading @).",
				},
				{
					name: "text",
					description: "The DM body.",
					required: true,
					schema: {
						type: "string",
					},
					descriptionCompressed: "The DM body.",
				},
				{
					name: "confirmed",
					description: "Must be true for the DM to actually send.",
					required: false,
					schema: {
						type: "boolean",
						default: false,
					},
					descriptionCompressed: "Must be true for the DM to send.",
				},
			],
			descriptionCompressed:
				"reply Twitter/X direct message two-stage: wo/ confirm: true return preview require confirmation; w/ confirm: true DM send",
			similes: ["SEND_X_DM", "REPLY_TWITTER_DM", "X_DM_REPLY"],
			exampleCalls: [
				{
					user: "Use REPLY_X_DM with the provided parameters.",
					actions: ["REPLY_X_DM"],
					params: {
						REPLY_X_DM: {
							recipient: "example",
							text: "example",
							confirmed: false,
						},
					},
				},
			],
		},
		{
			name: "SCHEDULE",
			description:
				"Owner-only. Inspect LifeOps passive schedule inference from local activity, screen-time, and optional health signals. ",
			parameters: [
				{
					name: "subaction",
					description: "Optional. summary or inspect.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Optional. summary or inspect.",
				},
				{
					name: "timezone",
					description: "Optional IANA timezone override.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Optional IANA timezone override.",
				},
			],
			descriptionCompressed:
				"passive schedule inference activity+screen-time+health: summary | inspect(sleep meals evidence-windows)",
			similes: ["SLEEP_INFERENCE", "MEAL_INFERENCE"],
			exampleCalls: [
				{
					user: "Use SCHEDULE with the provided parameters.",
					actions: ["SCHEDULE"],
					params: {
						SCHEDULE: {
							subaction: "example",
							timezone: "example",
						},
					},
				},
			],
		},
		{
			name: "SEARCH_LINEAR_ISSUES",
			description: "Search for issues in Linear with various filters",
			parameters: [
				{
					name: "filters",
					description:
						"Structured Linear issue filters: query, state, assignee, priority, team, label, and limit.",
					required: false,
					schema: {
						type: "object",
					},
					descriptionCompressed:
						"Structured Linear issue filters: query, state, assignee, priority, team, label, and limit.",
				},
				{
					name: "limit",
					description: "Maximum number of issues to return.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed: "max number of issues to return.",
				},
			],
			descriptionCompressed: "search issue Linear w/ various filter",
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
							filters: "example",
							limit: 1,
						},
					},
				},
			],
		},
		{
			name: "SEARCH_SHOPIFY_STORE",
			description:
				"Search across products, orders, and customers in a connected Shopify store.",
			parameters: [
				{
					name: "query",
					description:
						"Search term for Shopify products, orders, or customers.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Search term for Shopify products, orders, or customers.",
				},
				{
					name: "scope",
					description:
						"Restrict search to all, products, orders, or customers.",
					required: false,
					schema: {
						type: "string",
						enum: ["all", "products", "orders", "customers"],
					},
					descriptionCompressed:
						"Restrict search to all, products, orders, or customers.",
				},
				{
					name: "limit",
					description: "Maximum results per searched Shopify category.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed: "max results per searched Shopify category.",
				},
			],
			descriptionCompressed: "Search Shopify products, orders, customers.",
			similes: ["SHOPIFY_SEARCH", "STORE_SEARCH"],
			exampleCalls: [
				{
					user: "Use SEARCH_SHOPIFY_STORE with the provided parameters.",
					actions: ["SEARCH_SHOPIFY_STORE"],
					params: {
						SEARCH_SHOPIFY_STORE: {
							query: "example",
							scope: "all",
							limit: 1,
						},
					},
				},
			],
		},
		{
			name: "SEARCH_SKILLS",
			description:
				"Search the skill registry for available skills by keyword or category. Returns each result with action chips (use/enable/disable/install/copy/details).",
			parameters: [
				{
					name: "query",
					description: "Search query or skill category.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Search query or skill category.",
				},
				{
					name: "limit",
					description: "Maximum number of skill results.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed: "max number of skill results.",
				},
			],
			descriptionCompressed:
				"Search skill registry by keyword/category; returns action chips.",
			similes: ["BROWSE_SKILLS", "LIST_SKILLS", "FIND_SKILLS"],
			exampleCalls: [
				{
					user: "Use SEARCH_SKILLS with the provided parameters.",
					actions: ["SEARCH_SKILLS"],
					params: {
						SEARCH_SKILLS: {
							query: "example",
							limit: 1,
						},
					},
				},
			],
		},
		{
			name: "SEARCH_X",
			description:
				"Search X recent tweets using the v2 recent search endpoint. Parameters: query (required), maxResults (optional, default 10).",
			parameters: [
				{
					name: "query",
					description: "Search query to run against X recent tweets.",
					required: true,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Search query to run against X recent tweets.",
				},
				{
					name: "maxResults",
					description: "Maximum tweets to return (1-100).",
					required: false,
					schema: {
						type: "number",
						default: 10,
						minimum: 1,
						maximum: 100,
					},
					descriptionCompressed: "max tweets to return (1-100).",
				},
			],
			descriptionCompressed:
				"search x recent tweet use v2 recent search endpoint parameter: query (require), maxresult (optional, default 10)",
			similes: ["SEARCH_TWITTER", "SEARCH_TWEETS", "X_SEARCH"],
			exampleCalls: [
				{
					user: "Use SEARCH_X with the provided parameters.",
					actions: ["SEARCH_X"],
					params: {
						SEARCH_X: {
							query: "example",
							maxResults: 10,
						},
					},
				},
			],
		},
		{
			name: "SEARCH_YOUTUBE",
			description:
				"Search YouTube for a song or video and return the link. Use this when a user asks to find or search for a YouTube video or song without providing a specific URL.",
			parameters: [
				{
					name: "query",
					description: "Song, artist, or video query to search on YouTube.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Song, artist, or video query to search on YouTube.",
				},
				{
					name: "limit",
					description: "Maximum YouTube results to inspect.",
					required: false,
					schema: {
						type: "number",
						default: 5,
						minimum: 1,
						maximum: 10,
					},
					descriptionCompressed: "max YouTube results to inspect.",
				},
			],
			descriptionCompressed: "Search YouTube for song/video, return link.",
			similes: [
				"FIND_YOUTUBE",
				"SEARCH_YOUTUBE_VIDEO",
				"FIND_SONG",
				"SEARCH_MUSIC",
				"GET_YOUTUBE_LINK",
				"LOOKUP_YOUTUBE",
			],
			exampleCalls: [
				{
					user: "Use SEARCH_YOUTUBE with the provided parameters.",
					actions: ["SEARCH_YOUTUBE"],
					params: {
						SEARCH_YOUTUBE: {
							query: "example",
							limit: 5,
						},
					},
				},
			],
		},
		{
			name: "SEND_TO_AGENT",
			description:
				"Send text input or key presses to a running task-agent session. Use it to respond to prompts, provide feedback, continue a task, or assign a fresh tracked task to an existing agent.",
			parameters: [
				{
					name: "sessionId",
					description: "Target task-agent session ID",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Target task-agent session ID",
				},
				{
					name: "input",
					description: "Text to send to the agent",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Text to send to agent",
				},
				{
					name: "task",
					description: "New task to assign to the agent",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "New task to assign to agent",
				},
				{
					name: "label",
					description: "Optional task label",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Optional task label",
				},
				{
					name: "keys",
					description: "Key sequence to send",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Key sequence to send",
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
							sessionId: "example",
							input: "example",
							task: "example",
							label: "example",
							keys: "example",
						},
					},
				},
			],
			descriptionCompressed:
				"Send text input or key presses to a running task-agent session. Use it to respond to prompts, provide feedback, continue a task, or assign a fresh tracked...",
		},
		{
			name: "SEND_X_POST",
			description:
				"Publish a tweet on Twitter/X with a confirmation gate. Supports replies via replyToTweetId. Two-stage: without `confirmed: true` this returns a preview; with `confirmed: true` the tweet is posted.",
			parameters: [
				{
					name: "text",
					description: "The tweet body.",
					required: true,
					schema: {
						type: "string",
					},
					descriptionCompressed: "The tweet body.",
				},
				{
					name: "replyToTweetId",
					description: "Tweet id to reply to. When set, posts as a reply.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Tweet id to reply to. When set, posts as a reply.",
				},
				{
					name: "confirmed",
					description: "Must be true for the tweet to actually post.",
					required: false,
					schema: {
						type: "boolean",
						default: false,
					},
					descriptionCompressed: "Must be true for the tweet to post.",
				},
			],
			descriptionCompressed:
				"Post tweet on X (Twitter); supports replies via replyToTweetId.",
			similes: [
				"POST_X",
				"POST_TWEET",
				"TWEET",
				"SEND_TWEET",
				"TWITTER_POST",
				"POST_ON_TWITTER",
				"SHARE_ON_TWITTER",
				"TWEET_WITH_CONFIRMATION",
				"PUBLISH_TWEET",
			],
			exampleCalls: [
				{
					user: "Use SEND_X_POST with the provided parameters.",
					actions: ["SEND_X_POST"],
					params: {
						SEND_X_POST: {
							text: "example",
							replyToTweetId: "example",
							confirmed: false,
						},
					},
				},
			],
		},
		{
			name: "SET_FOLLOWUP_THRESHOLD",
			description:
				"Set a recurring follow-up cadence threshold (in days) for a specific contact. ",
			parameters: [
				{
					name: "contactId",
					description: "UUID of the contact. Preferred when known.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "UUID of the contact. Preferred when known.",
				},
				{
					name: "contactName",
					description:
						"Human-readable contact name. Must be unambiguous across stored contacts.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Human-readable contact name. Must be unambiguous across stored contacts.",
				},
				{
					name: "thresholdDays",
					description:
						"Number of days after last contact before this contact is considered overdue.",
					required: true,
					schema: {
						type: "number",
					},
					descriptionCompressed:
						"Number of days after last contact before this contact is considered overdue.",
				},
			],
			similes: [
				"FOLLOWUP_RULE",
				"CHANGE_FOLLOWUP_INTERVAL",
				"SET_CONTACT_FREQUENCY_DAYS",
			],
			exampleCalls: [
				{
					user: "Use SET_FOLLOWUP_THRESHOLD with the provided parameters.",
					actions: ["SET_FOLLOWUP_THRESHOLD"],
					params: {
						SET_FOLLOWUP_THRESHOLD: {
							contactId: "example",
							contactName: "example",
							thresholdDays: 1,
						},
					},
				},
			],
			descriptionCompressed:
				"Set a recurring follow-up cadence threshold (in days) for a specific contact.",
		},
		{
			name: "SIGNAL_READ_RECENT_MESSAGES",
			description:
				"Read the most recent Signal messages across active conversations",
			parameters: [
				{
					name: "limit",
					description: "Maximum recent messages to return.",
					required: false,
					schema: {
						type: "number",
						default: 10,
						minimum: 1,
						maximum: 25,
					},
					descriptionCompressed: "max recent msgs to return.",
				},
			],
			descriptionCompressed: "Read recent Signal msgs.",
			similes: [
				"READ_SIGNAL_MESSAGES",
				"CHECK_SIGNAL_MESSAGES",
				"SHOW_SIGNAL_MESSAGES",
				"SIGNAL_INBOX",
			],
			exampleCalls: [
				{
					user: "Use SIGNAL_READ_RECENT_MESSAGES with the provided parameters.",
					actions: ["SIGNAL_READ_RECENT_MESSAGES"],
					params: {
						SIGNAL_READ_RECENT_MESSAGES: {
							limit: 10,
						},
					},
				},
			],
		},
		{
			name: "SLACK_GET_USER_INFO",
			description: "Get information about a Slack user",
			parameters: [
				{
					name: "userId",
					description: "Slack user ID to look up, such as U0123456789.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Slack user ID to look up, such as U0123456789.",
				},
			],
			descriptionCompressed: "Get Slack user info.",
			similes: [
				"GET_SLACK_USER",
				"USER_INFO",
				"SLACK_USER",
				"MEMBER_INFO",
				"WHO_IS",
			],
			exampleCalls: [
				{
					user: "Use SLACK_GET_USER_INFO with the provided parameters.",
					actions: ["SLACK_GET_USER_INFO"],
					params: {
						SLACK_GET_USER_INFO: {
							userId: "example",
						},
					},
				},
			],
		},
		{
			name: "SLACK_MESSAGE_OP",
			description:
				"Slack message operation router. Send, edit, delete, react, pin, or unpin Slack messages by setting op.",
			parameters: [
				{
					name: "op",
					description: "Operation: send, edit, delete, react, pin, or unpin.",
					required: false,
					schema: {
						type: "string",
						enum: ["send", "edit", "delete", "react", "pin", "unpin"],
					},
					descriptionCompressed:
						"Operation: send, edit, delete, react, pin, or unpin.",
				},
				{
					name: "text",
					description: "Message text for send or edit.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "msg text for send or edit.",
				},
				{
					name: "channelRef",
					description: "Slack channel name/id or current.",
					required: false,
					schema: {
						type: "string",
						default: "current",
					},
					descriptionCompressed: "Slack channel name/id or current.",
				},
				{
					name: "messageTs",
					description:
						"Slack message timestamp for edit/delete/react/pin/unpin.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Slack msg timestamp for edit/delete/react/pin/unpin.",
				},
				{
					name: "emoji",
					description: "Reaction emoji name without colons.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Reaction emoji name without colons.",
				},
			],
			descriptionCompressed:
				"Slack message ops: send, edit, delete, react, pin, unpin.",
			similes: [
				"SLACK_SEND_MESSAGE",
				"SEND_SLACK_MESSAGE",
				"POST_TO_SLACK",
				"MESSAGE_SLACK",
				"SLACK_POST",
				"SEND_TO_CHANNEL",
				"SLACK_EDIT_MESSAGE",
				"UPDATE_SLACK_MESSAGE",
				"MODIFY_MESSAGE",
				"CHANGE_MESSAGE",
				"SLACK_UPDATE",
				"SLACK_DELETE_MESSAGE",
				"REMOVE_SLACK_MESSAGE",
				"DELETE_MESSAGE",
				"SLACK_REMOVE",
				"SLACK_REACT_TO_MESSAGE",
				"ADD_SLACK_REACTION",
				"REACT_SLACK",
				"SLACK_EMOJI",
				"ADD_EMOJI",
				"REMOVE_REACTION",
				"SLACK_PIN_MESSAGE",
				"PIN_SLACK_MESSAGE",
				"PIN_MESSAGE",
				"SLACK_PIN",
				"SAVE_MESSAGE",
				"SLACK_UNPIN_MESSAGE",
				"UNPIN_SLACK_MESSAGE",
				"UNPIN_MESSAGE",
				"SLACK_UNPIN",
				"REMOVE_PIN",
			],
			exampleCalls: [
				{
					user: "Use SLACK_MESSAGE_OP with the provided parameters.",
					actions: ["SLACK_MESSAGE_OP"],
					params: {
						SLACK_MESSAGE_OP: {
							op: "send",
							text: "example",
							channelRef: "current",
							messageTs: "example",
							emoji: "example",
						},
					},
				},
			],
		},
		{
			name: "SLACK_READ_CHANNEL",
			description: "Read message history from a Slack channel",
			parameters: [
				{
					name: "channelRef",
					description: "Slack channel name/id or current.",
					required: false,
					schema: {
						type: "string",
						default: "current",
					},
					descriptionCompressed: "Slack channel name/id or current.",
				},
				{
					name: "limit",
					description: "Maximum messages to read.",
					required: false,
					schema: {
						type: "number",
						default: 10,
						minimum: 1,
						maximum: 100,
					},
					descriptionCompressed: "max msgs to read.",
				},
				{
					name: "after",
					description: "Optional lower bound timestamp or date.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Optional lower bound timestamp or date.",
				},
			],
			descriptionCompressed: "Read Slack channel message history.",
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
							channelRef: "current",
							limit: 10,
							after: "example",
						},
					},
				},
			],
		},
		{
			name: "SPAWN_AGENT",
			description:
				"Spawn a specific task agent inside an existing workspace when you need direct control. ",
			parameters: [
				{
					name: "agentType",
					description:
						"Specific task-agent framework to spawn. Options: claude (Claude Code), codex (OpenAI Codex), gemini (Google Gemini), aider, pi, shell (generic shell). ",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Specific task-agent framework to spawn. Options: claude (Claude Code), codex (OpenAI Codex), gemini (Google Gemini), aider, pi, shell (generic shell).",
				},
				{
					name: "workdir",
					description:
						"Working directory for the agent. Defaults to current directory.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Spawn task agent in existing workspace for direct control.",
				},
				{
					name: "task",
					description:
						"Open-ended task or prompt to send to the task agent once spawned.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Open-ended task or prompt to send to the task agent once spawned.",
				},
				{
					name: "memoryContent",
					description:
						"Instructions or shared context to write to the task agent's memory file before spawning.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Instructions or shared context to write to the task agent's memory file before spawning.",
				},
				{
					name: "approvalPreset",
					description:
						"OPTIONAL permission preset. Leave UNSET for normal coding/research tasks — the runtime defaults to 'autonomous' which gives the agent full tools including shell, the helpers it needs to work effectively, and standard --dangerously-skip-permissions (the orchestrator runs in a sandbox so this is safe). Only set this when the user EXPLICITLY asks for a constrained agent: 'readonly' for a true audit-only review (no shell, no writes, no web), 'standard' or 'permissive' for unusual approval flows. Picking 'readonly' for normal tasks breaks bash helper scripts and is almost never what the user wants.",
					required: false,
					schema: {
						type: "string",
						enum: ["readonly", "standard", "permissive", "autonomous"],
					},
					descriptionCompressed:
						"OPTIONAL permission preset. Leave UNSET for normal coding/research tasks - the runtime defaults to 'autonomous' which gives agent full tools including shell...",
				},
				{
					name: "keepAliveAfterComplete",
					description:
						"Keep the spawned task-agent session alive after a completed turn so it can receive another tracked task.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed:
						"Keep the spawned task-agent session alive after a completed turn so it can receive another tracked task.",
				},
			],
			descriptionCompressed:
				"Spawn task agent in existing workspace for async coding/research; returns session id for follow-up.",
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
							agentType: "example",
							workdir: "example",
							task: "example",
							memoryContent: "example",
							approvalPreset: "readonly",
							keepAliveAfterComplete: false,
						},
					},
				},
			],
		},
		{
			name: "STOP_AGENT",
			description:
				"Stop a running task-agent session, terminating the session and cleaning up resources.",
			parameters: [
				{
					name: "sessionId",
					description: "Session ID to stop",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Session ID to stop",
				},
				{
					name: "all",
					description: "Stop all active sessions",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed: "Stop all active sessions",
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
							sessionId: "example",
							all: false,
						},
					},
				},
			],
			descriptionCompressed:
				"Stop a running task-agent session, terminating the session and cleaning up resources.",
		},
		{
			name: "SUMMARIZE_FEED",
			description:
				"Fetch the top-N X tweets and produce a concise natural-language summary using the runtime's small text model.",
			parameters: [
				{
					name: "limit",
					description: "Number of top feed tweets to summarize.",
					required: false,
					schema: {
						type: "number",
						default: 5,
						minimum: 1,
						maximum: 25,
					},
					descriptionCompressed: "Number of top feed tweets to summarize.",
				},
				{
					name: "fetchCount",
					description: "Number of feed tweets to fetch before ranking.",
					required: false,
					schema: {
						type: "number",
						default: 50,
						minimum: 1,
						maximum: 100,
					},
					descriptionCompressed:
						"Number of feed tweets to fetch before ranking.",
				},
			],
			descriptionCompressed:
				"fetch top-n x tweet produce concise natural-language summary use runtime small text model",
			similes: ["X_FEED_SUMMARY", "SUMMARIZE_TWITTER", "SUMMARIZE_X_FEED"],
			exampleCalls: [
				{
					user: "Use SUMMARIZE_FEED with the provided parameters.",
					actions: ["SUMMARIZE_FEED"],
					params: {
						SUMMARIZE_FEED: {
							limit: 5,
							fetchCount: 50,
						},
					},
				},
			],
		},
		{
			name: "SYNC_SKILL_CATALOG",
			description:
				"Sync the skill catalog from the registry to discover new skills.",
			parameters: [],
			descriptionCompressed: "Sync skill catalog from registry.",
			similes: ["REFRESH_SKILLS", "UPDATE_CATALOG"],
		},
		{
			name: "TAILSCALE",
			description:
				"Tailscale tunnel router. Operations: start (open tunnel for a local port), stop (close active tunnel). Status reads come from the tailscaleStatus provider.",
			parameters: [
				{
					name: "op",
					description: "Tunnel operation. One of: start, stop.",
					required: true,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Tunnel operation. One of: start, stop.",
				},
				{
					name: "port",
					description: "Local port to expose when op is start.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed: "Local port to expose when op is start.",
				},
			],
			descriptionCompressed: "Tailscale: start tunnel, stop tunnel.",
			similes: [
				"TAILSCALE_OP",
				"START_TAILSCALE",
				"STOP_TAILSCALE",
				"START_TUNNEL",
				"STOP_TUNNEL",
				"OPEN_TUNNEL",
				"CLOSE_TUNNEL",
				"CREATE_TUNNEL",
				"TAILSCALE_UP",
				"TAILSCALE_DOWN",
			],
			exampleCalls: [
				{
					user: "Use TAILSCALE with the provided parameters.",
					actions: ["TAILSCALE"],
					params: {
						TAILSCALE: {
							op: "example",
							port: 1,
						},
					},
				},
			],
		},
		{
			name: "TASK_CONTROL",
			description:
				"Pause, stop, resume, continue, archive, or reopen a coordinator task thread while preserving the durable thread history.",
			parameters: [
				{
					name: "operation",
					description: "Control operation to apply to the task thread.",
					required: true,
					schema: {
						type: "string",
						enum: ["pause", "stop", "resume", "continue", "archive", "reopen"],
					},
					descriptionCompressed:
						"Control operation to apply to the task thread.",
				},
				{
					name: "threadId",
					description: "Specific task thread id to control.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Specific task thread id to control.",
				},
				{
					name: "sessionId",
					description: "Task session id to resolve into a thread when needed.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Task session id to resolve into a thread when needed.",
				},
				{
					name: "search",
					description: "Search text used to find the relevant thread.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Search text for finding relevant thread.",
				},
				{
					name: "note",
					description: "Optional reason for pausing or stopping the thread.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Optional reason for pausing or stopping the thread.",
				},
				{
					name: "instruction",
					description:
						"Follow-up instruction for resume or continue operations.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Follow-up instruction for resume or continue operations.",
				},
				{
					name: "agentType",
					description: "Optional framework override for a resumed task.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Optional framework override for a resumed task.",
				},
			],
			descriptionCompressed:
				"Pause/stop/resume/archive/reopen coordinator task thread.",
			similes: [
				"CONTROL_TASK",
				"PAUSE_TASK",
				"RESUME_TASK",
				"STOP_TASK",
				"CONTINUE_TASK",
				"ARCHIVE_TASK",
				"REOPEN_TASK",
			],
			exampleCalls: [
				{
					user: "Use TASK_CONTROL with the provided parameters.",
					actions: ["TASK_CONTROL"],
					params: {
						TASK_CONTROL: {
							operation: "pause",
							threadId: "example",
							sessionId: "example",
							search: "example",
							note: "example",
							instruction: "example",
							agentType: "example",
						},
					},
				},
			],
		},
		{
			name: "TASK_HISTORY",
			description:
				"Query coordinator task history without stuffing raw transcripts into model context. Use this for active work, yesterday/last-week summaries, topic search, counts, and thread detail lookup.",
			parameters: [
				{
					name: "metric",
					description: "Query mode: list, count, or detail.",
					required: false,
					schema: {
						type: "string",
						enum: ["list", "count", "detail"],
					},
					descriptionCompressed: "Query mode: list, count, or detail.",
				},
				{
					name: "window",
					description: "Relative time window for the query.",
					required: false,
					schema: {
						type: "string",
						enum: [
							"active",
							"today",
							"yesterday",
							"last_7_days",
							"last_30_days",
						],
					},
					descriptionCompressed: "Relative time window for the query.",
				},
				{
					name: "search",
					description:
						"Topic or free-text search string to match task threads.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Topic or free-text search string to match task threads.",
				},
				{
					name: "statuses",
					description: "Optional status filter list.",
					required: false,
					schema: {
						type: "array",
						items: {
							type: "string",
						},
					},
					descriptionCompressed: "Optional status filter list.",
				},
				{
					name: "limit",
					description: "Maximum number of thread summaries to return.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed: "max number of thread summaries to return.",
				},
				{
					name: "includeArchived",
					description: "Whether archived threads should be included.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed: "Whether archived threads should be included.",
				},
			],
			descriptionCompressed:
				"Query task history: active work, summaries, search, thread details.",
			similes: [
				"LIST_TASK_HISTORY",
				"GET_TASK_HISTORY",
				"SHOW_TASKS",
				"COUNT_TASKS",
				"TASK_STATUS_HISTORY",
			],
			exampleCalls: [
				{
					user: "Use TASK_HISTORY with the provided parameters.",
					actions: ["TASK_HISTORY"],
					params: {
						TASK_HISTORY: {
							metric: "list",
							window: "active",
							search: "example",
							statuses: "example",
							limit: 1,
							includeArchived: false,
						},
					},
				},
			],
		},
		{
			name: "TASK_OUTPUT",
			description:
				"Read captured output and current status of a background BASH task. Pass block=true to wait for completion (or until timeout) before returning.",
			parameters: [
				{
					name: "task_id",
					description:
						"Task id returned by BASH (background or auto-promoted).",
					required: true,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Task id returned by BASH (background or auto-promoted).",
				},
				{
					name: "block",
					description:
						"If true, wait for the task to finish (or until timeout) before returning.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed:
						"If true, wait for the task to finish (or until timeout) before returning.",
				},
				{
					name: "timeout",
					description:
						"When blocking, max ms to wait. Clamped to [0, 600000]. Default 30000 when block=true, 0 otherwise.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed:
						"When blocking, max ms to wait. Clamped to [0, 600000]. Default 30000 when block=true, 0 otherwise.",
				},
			],
			descriptionCompressed:
				"Read background shell task output (optionally blocking).",
			similes: ["GET_TASK_OUTPUT"],
			exampleCalls: [
				{
					user: "Use TASK_OUTPUT with the provided parameters.",
					actions: ["TASK_OUTPUT"],
					params: {
						TASK_OUTPUT: {
							task_id: "example",
							block: false,
							timeout: 1,
						},
					},
				},
			],
		},
		{
			name: "TASK_SHARE",
			description:
				"Discover the best available way to view or share a task result, including artifacts, live preview URLs, workspace paths, and environment share capabilities.",
			parameters: [
				{
					name: "threadId",
					description: "Specific task thread id to inspect.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Specific task thread id to inspect.",
				},
				{
					name: "sessionId",
					description: "Task session id to resolve to its thread.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Task session id to resolve to its thread.",
				},
				{
					name: "search",
					description: "Search text used to find the task thread to share.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Search text for finding task thread to share.",
				},
			],
			descriptionCompressed:
				"Find best way to view/share task result: artifacts, live URLs, paths.",
			similes: [
				"SHARE_TASK_RESULT",
				"SHOW_TASK_ARTIFACT",
				"VIEW_TASK_OUTPUT",
				"CAN_I_SEE_IT",
				"PULL_IT_UP",
			],
			exampleCalls: [
				{
					user: "Use TASK_SHARE with the provided parameters.",
					actions: ["TASK_SHARE"],
					params: {
						TASK_SHARE: {
							threadId: "example",
							sessionId: "example",
							search: "example",
						},
					},
				},
			],
		},
		{
			name: "TASK_STOP",
			description:
				"Terminate a running background BASH task by id. Sends SIGTERM (and SIGKILL after a grace period). Returns the task's terminal status.",
			parameters: [
				{
					name: "task_id",
					description:
						"Task id returned by BASH (background or auto-promoted).",
					required: true,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Task id returned by BASH (background or auto-promoted).",
				},
			],
			descriptionCompressed: "Stop a background shell task.",
			similes: ["KILL_TASK", "STOP_TASK"],
			exampleCalls: [
				{
					user: "Use TASK_STOP with the provided parameters.",
					actions: ["TASK_STOP"],
					params: {
						TASK_STOP: {
							task_id: "example",
						},
					},
				},
			],
		},
		{
			name: "TERMINAL_ACTION",
			description:
				"Execute terminal commands and manage lightweight terminal sessions through the computer-use service. This includes connect, execute, read, type, clear, close, and the upstream execute_command alias.\n\n",
			parameters: [
				{
					name: "action",
					description: "Terminal action to perform.",
					required: true,
					schema: {
						type: "string",
						enum: [
							"connect",
							"execute",
							"read",
							"type",
							"clear",
							"close",
							"execute_command",
						],
					},
					descriptionCompressed: "Terminal action to perform.",
				},
				{
					name: "command",
					description: "Shell command for execute or execute_command.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Shell command for execute or execute_command.",
				},
				{
					name: "cwd",
					description: "Working directory for connect or execute.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Working directory for connect or execute.",
				},
				{
					name: "sessionId",
					description: "Session ID alias.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Session ID alias.",
				},
				{
					name: "session_id",
					description: "Upstream session ID alias.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Upstream session ID alias.",
				},
				{
					name: "text",
					description: "Text for terminal type.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Text for terminal type.",
				},
				{
					name: "timeout",
					description: "Timeout in seconds.",
					required: false,
					schema: {
						type: "number",
						default: 30,
					},
					descriptionCompressed: "Timeout in seconds.",
				},
				{
					name: "timeoutSeconds",
					description: "Alias for timeout.",
					required: false,
					schema: {
						type: "number",
						default: 30,
					},
					descriptionCompressed: "Alias for timeout.",
				},
			],
			descriptionCompressed:
				"Terminal ops: open, exec, read, type, kill, list, switch, send-input, get-output.",
			similes: [
				"RUN_COMMAND",
				"EXECUTE_COMMAND",
				"SHELL_COMMAND",
				"TERMINAL",
				"RUN_SHELL",
			],
			exampleCalls: [
				{
					user: "Use TERMINAL_ACTION with the provided parameters.",
					actions: ["TERMINAL_ACTION"],
					params: {
						TERMINAL_ACTION: {
							action: "connect",
							command: "example",
							cwd: "example",
							sessionId: "example",
							session_id: "example",
							text: "example",
							timeout: 30,
							timeoutSeconds: 30,
						},
					},
				},
			],
		},
		{
			name: "TODO_WRITE",
			description:
				"Replace the conversation's todo list with the provided array. Each todo has content, status (pending|in_progress|completed), and an optional activeForm describing the in-progress phrasing. The full list is replaced on every call. Use to plan multi-step work and track progress within a session.",
			parameters: [
				{
					name: "todos",
					description:
						"Array of todo objects. Each item: { id?: string, content: string, status: 'pending'|'in_progress'|'completed', activeForm?: string }. Replaces the entire list.",
					required: true,
					schema: {
						type: "array",
						items: {
							type: "object",
							properties: {
								id: {
									type: "string",
								},
								content: {
									type: "string",
								},
								status: {
									type: "string",
									enum: ["pending", "in_progress", "completed"],
								},
								activeForm: {
									type: "string",
								},
							},
						},
					},
					descriptionCompressed:
						"Array of todo objects. Each item: { id?: string, content: string, status: 'pending'|'in_progress'|'completed', activeForm?: string }. Replaces the entire list.",
				},
			],
			descriptionCompressed:
				"Replace conversation todo list with {content,status,activeForm}[].",
			similes: ["UPDATE_TODOS", "SET_TODOS"],
			exampleCalls: [
				{
					user: "Use TODO_WRITE with the provided parameters.",
					actions: ["TODO_WRITE"],
					params: {
						TODO_WRITE: {
							todos: "example",
						},
					},
				},
			],
		},
		{
			name: "TOGGLE_SKILL",
			description:
				"Enable or disable an installed skill. Say 'enable <skill>' or 'disable <skill>'.",
			parameters: [
				{
					name: "slug",
					description: "Installed skill slug or name to enable or disable.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Installed skill slug or name to enable or disable.",
				},
				{
					name: "enabled",
					description: "Whether to enable true or disable false the skill.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed:
						"Whether to enable true or disable false the skill.",
				},
			],
			descriptionCompressed: "Enable/disable installed skill.",
			similes: [
				"ENABLE_SKILL",
				"DISABLE_SKILL",
				"TURN_ON_SKILL",
				"TURN_OFF_SKILL",
				"ACTIVATE_SKILL",
				"DEACTIVATE_SKILL",
			],
			exampleCalls: [
				{
					user: "Use TOGGLE_SKILL with the provided parameters.",
					actions: ["TOGGLE_SKILL"],
					params: {
						TOGGLE_SKILL: {
							slug: "example",
							enabled: false,
						},
					},
				},
			],
		},
		{
			name: "TWITCH_CHANNEL_OP",
			description: "Join or leave a Twitch channel.",
			parameters: [
				{
					name: "op",
					description: "Either join or leave.",
					required: true,
					schema: {
						type: "string",
						enum: ["join", "leave"],
					},
					descriptionCompressed: "Either join or leave.",
				},
				{
					name: "channel",
					description: "Twitch channel name without #.",
					required: true,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Twitch channel name without #.",
				},
			],
			descriptionCompressed: "Twitch channel ops: join, leave.",
			similes: [
				"TWITCH_CHANNEL",
				"TWITCH_JOIN_CHANNEL",
				"TWITCH_LEAVE_CHANNEL",
				"MANAGE_TWITCH_CHANNEL",
			],
			exampleCalls: [
				{
					user: "Use TWITCH_CHANNEL_OP with the provided parameters.",
					actions: ["TWITCH_CHANNEL_OP"],
					params: {
						TWITCH_CHANNEL_OP: {
							op: "join",
							channel: "example",
						},
					},
				},
			],
		},
		{
			name: "TWITCH_SEND_MESSAGE",
			description: "Send a message to a Twitch channel",
			parameters: [
				{
					name: "text",
					description: "Chat message text to send.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Chat msg text to send.",
				},
				{
					name: "channel",
					description: "Twitch channel name, without #, or current.",
					required: false,
					schema: {
						type: "string",
						default: "current",
					},
					descriptionCompressed: "Twitch channel name, without #, or current.",
				},
			],
			descriptionCompressed: "send message Twitch channel",
			similes: [
				"SEND_TWITCH_MESSAGE",
				"TWITCH_CHAT",
				"CHAT_TWITCH",
				"SAY_IN_TWITCH",
			],
			exampleCalls: [
				{
					user: "Use TWITCH_SEND_MESSAGE with the provided parameters.",
					actions: ["TWITCH_SEND_MESSAGE"],
					params: {
						TWITCH_SEND_MESSAGE: {
							text: "example",
							channel: "current",
						},
					},
				},
			],
		},
		{
			name: "UNINSTALL_SKILL",
			description:
				"Uninstall a non-bundled skill. Bundled skills cannot be removed. ",
			parameters: [
				{
					name: "slug",
					description: "Installed skill slug or name to uninstall.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Installed skill slug or name to uninstall.",
				},
			],
			descriptionCompressed: "Remove non-bundled skill.",
			similes: ["REMOVE_SKILL", "DELETE_SKILL"],
			exampleCalls: [
				{
					user: "Use UNINSTALL_SKILL with the provided parameters.",
					actions: ["UNINSTALL_SKILL"],
					params: {
						UNINSTALL_SKILL: {
							slug: "example",
						},
					},
				},
			],
		},
		{
			name: "USE_SKILL",
			description:
				"Invoke an enabled skill by slug. The skill's instructions or script run and the result returns to the conversation.",
			parameters: [],
			descriptionCompressed: "Invoke an enabled skill by slug.",
			similes: ["INVOKE_SKILL", "EXECUTE_SKILL", "RUN_SKILL", "CALL_SKILL"],
		},
		{
			name: "WALK_TO",
			description:
				"Walk to a coordinate or named destination. Provide either destination: name OR x: N, z: N.",
			parameters: [
				{
					name: "destination",
					description: "Optional named destination (overrides x/z).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Named destination.",
				},
				{
					name: "x",
					description: "Target world X coordinate.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed: "Target x.",
				},
				{
					name: "z",
					description: "Target world Z coordinate.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed: "Target z.",
				},
				{
					name: "reason",
					description: "Optional reason logged with the walk.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Walk reason.",
				},
			],
			similes: ["MOVE_TO", "GOTO"],
			exampleCalls: [
				{
					user: "Use WALK_TO with the provided parameters.",
					actions: ["WALK_TO"],
					params: {
						WALK_TO: {
							destination: "example",
							x: 1,
							z: 1,
							reason: "example",
						},
					},
				},
			],
			descriptionCompressed:
				"Walk to a coordinate or named destination. Provide either destination: name OR x: N, z: N.",
		},
		{
			name: "WALLET_PREPARE",
			description:
				'Prepare a non-binding wallet proposal. Set kind="swap" to fetch a BSC ',
			parameters: [
				{
					name: "kind",
					description:
						'Proposal kind: "swap" for a BSC swap quote, "transfer" for a token transfer preview.',
					required: true,
					schema: {
						type: "string",
						enum: ["swap", "transfer"],
					},
					descriptionCompressed:
						'Proposal kind: "swap" for a BSC swap quote, "transfer" for a token transfer preview.',
				},
				{
					name: "fromSymbol",
					description:
						'Source asset symbol (swap only, e.g. "BNB", "USDT"). One of fromSymbol/toSymbol must be BNB on BSC.',
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						'Source asset symbol (swap only, e. g. "BNB", "USDT"). One of fromSymbol/toSymbol must be BNB on BSC.',
				},
				{
					name: "toSymbol",
					description:
						'Destination asset symbol (swap only, e.g. "BNB", "USDT"). One of fromSymbol/toSymbol must be BNB on BSC.',
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						'Destination asset symbol (swap only, e. g. "BNB", "USDT"). One of fromSymbol/toSymbol must be BNB on BSC.',
				},
				{
					name: "fromAddress",
					description:
						"Source token contract address (swap only — required when the source asset is not BNB).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Source token contract address (swap only - required when the source asset is not BNB).",
				},
				{
					name: "slippageBps",
					description:
						"Slippage tolerance in basis points (swap only, default 300 = 3%).",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed:
						"Slippage tolerance in basis points (swap only, default 300 = 3%).",
				},
				{
					name: "toAddress",
					description:
						"Recipient EVM address (transfer) or destination token contract address (swap, required when destination is not BNB). 0x-prefixed, 40 hex characters.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Recipient EVM address (transfer) or destination token contract address (swap, required when destination is not BNB). 0x-prefixed, 40 hex characters.",
				},
				{
					name: "assetSymbol",
					description:
						'Token symbol to transfer (transfer only, e.g. "BNB", "USDT", "USDC").',
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						'Token symbol to transfer (transfer only, e. g. "BNB", "USDT", "USDC").',
				},
				{
					name: "amount",
					description:
						'Human-readable amount. For swaps the source-asset units (e.g. "0.5"); for transfers the asset units (e.g. "1.5", "100").',
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						'Human-readable amount. For swaps the source-asset units (e. g. "0. 5"). for transfers the asset units (e. g. "1. 5", "100").',
				},
			],
			descriptionCompressed: "Wallet preview ops: swap, transfer.",
			similes: [
				"PREPARE_SWAP",
				"QUOTE_SWAP",
				"PREVIEW_SWAP",
				"ESTIMATE_SWAP",
				"SWAP_QUOTE",
				"GET_SWAP_QUOTE",
				"PREVIEW_TRANSFER",
				"ESTIMATE_TRANSFER",
				"QUOTE_TRANSFER",
				"TRANSFER_PREVIEW",
			],
			exampleCalls: [
				{
					user: "Use WALLET_PREPARE with the provided parameters.",
					actions: ["WALLET_PREPARE"],
					params: {
						WALLET_PREPARE: {
							kind: "swap",
							fromSymbol: "example",
							toSymbol: "example",
							fromAddress: "example",
							slippageBps: 1,
							toAddress: "example",
							assetSymbol: "example",
							amount: "example",
						},
					},
				},
			],
		},
		{
			name: "WEB_FETCH",
			description:
				"Fetch a single http(s) URL and return its body as text. HTML responses are stripped of tags and collapsed to plain text. Body is capped at 5MB; text is capped at 50000 chars. Loopback addresses (localhost, 127.0.0.1, 0.0.0.0, ::1, 169.254.*) are blocked by default; set CODING_TOOLS_WEB_FETCH_ALLOW_LOOPBACK=1 to permit them. Use for reading documentation, blog posts, or pasting in a URL the user referenced.",
			parameters: [
				{
					name: "url",
					description: "Absolute http:// or https:// URL to fetch.",
					required: true,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Absolute http:// or https:// URL to fetch.",
				},
				{
					name: "prompt",
					description:
						"Optional summary/extraction instruction. Echoed verbatim in the result text; no LLM is run on the body in v1.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Optional summary/extraction instruction. Echoed verbatim in the result text. no LLM is run on the body in v1.",
				},
			],
			descriptionCompressed:
				"Fetch http(s) URL and return body as plain text (HTML stripped, capped).",
			similes: ["FETCH_URL", "GET_URL", "DOWNLOAD_PAGE"],
			exampleCalls: [
				{
					user: "Use WEB_FETCH with the provided parameters.",
					actions: ["WEB_FETCH"],
					params: {
						WEB_FETCH: {
							url: "example",
							prompt: "example",
						},
					},
				},
			],
		},
		{
			name: "WEB_SEARCH",
			description:
				"Run a web search and return ranked results. Stub in v1: no provider is wired in this plugin, so the action returns a placeholder success that echoes the query and any domain filters. Wire a Brave/Bing/Tavily backend before relying on this for real results.",
			parameters: [
				{
					name: "query",
					description: "Search query string.",
					required: true,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Search query string.",
				},
				{
					name: "allowed_domains",
					description: "Optional list of domains to restrict results to.",
					required: false,
					schema: {
						type: "array",
						items: {
							type: "string",
						},
					},
					descriptionCompressed:
						"Optional list of domains to restrict results to.",
				},
				{
					name: "blocked_domains",
					description: "Optional list of domains to exclude from results.",
					required: false,
					schema: {
						type: "array",
						items: {
							type: "string",
						},
					},
					descriptionCompressed:
						"Optional list of domains to exclude from results.",
				},
			],
			descriptionCompressed:
				"Web search (stub — no backend configured; echoes query + filters).",
			similes: ["SEARCH_WEB", "GOOGLE", "BING"],
			exampleCalls: [
				{
					user: "Use WEB_SEARCH with the provided parameters.",
					actions: ["WEB_SEARCH"],
					params: {
						WEB_SEARCH: {
							query: "example",
							allowed_domains: "example",
							blocked_domains: "example",
						},
					},
				},
			],
		},
		{
			name: "WORKFLOW_LIFECYCLE_OP",
			description:
				'n8n workflow lifecycle operation. Pass `op` ("activate", "deactivate", or "delete") and optionally `workflowId`. Identifies workflows by ID, name, or semantic description.',
			parameters: [
				{
					name: "op",
					description:
						"Lifecycle operation to perform. One of: activate, deactivate, delete.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Lifecycle operation to perform. One of: activate, deactivate, delete.",
				},
				{
					name: "workflowId",
					description:
						"Exact n8n workflow id. When omitted, the workflow is matched semantically.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Exact n8n workflow id. When omitted, the workflow is matched semantically.",
				},
			],
			descriptionCompressed:
				"n8n workflow lifecycle: activate, deactivate, delete.",
			similes: [
				"ACTIVATE_WORKFLOW",
				"DEACTIVATE_WORKFLOW",
				"DELETE_WORKFLOW",
				"ENABLE_WORKFLOW",
				"DISABLE_WORKFLOW",
				"STOP_WORKFLOW",
				"PAUSE_WORKFLOW",
				"TURN_ON_WORKFLOW",
				"TURN_OFF_WORKFLOW",
				"START_WORKFLOW",
				"REMOVE_WORKFLOW",
				"DESTROY_WORKFLOW",
				"ACTIVATE_N8N_WORKFLOW",
				"DEACTIVATE_N8N_WORKFLOW",
				"DELETE_N8N_WORKFLOW",
			],
			exampleCalls: [
				{
					user: "Use WORKFLOW_LIFECYCLE_OP with the provided parameters.",
					actions: ["WORKFLOW_LIFECYCLE_OP"],
					params: {
						WORKFLOW_LIFECYCLE_OP: {
							op: "example",
							workflowId: "example",
						},
					},
				},
			],
		},
		{
			name: "WRITE",
			description:
				"Write a file at an absolute path, replacing any existing contents. The file's parent directory is created if missing. Existing files must have been READ in this session first; otherwise the write is rejected to avoid clobbering external edits.",
			parameters: [
				{
					name: "file_path",
					description: "Absolute path to the file to write.",
					required: true,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Absolute path to the file to write.",
				},
				{
					name: "content",
					description: "Full new file contents.",
					required: true,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Full new file contents.",
				},
			],
			descriptionCompressed:
				"Write a file at an absolute path (creates parents; rejects if existing file was not READ first).",
			similes: ["WRITE_FILE", "CREATE_FILE"],
			exampleCalls: [
				{
					user: "Use WRITE with the provided parameters.",
					actions: ["WRITE"],
					params: {
						WRITE: {
							file_path: "example",
							content: "example",
						},
					},
				},
			],
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
