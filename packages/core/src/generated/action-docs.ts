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
			name: "MESSAGE",
			description:
				"Primary action for addressed messaging surfaces: DMs, group chats, channels, rooms, threads, servers, and users. Choose operation=send, read, search, list_channels, list_servers, react, edit, delete, pin, join, leave, or get_user. Public feed publishing belongs to POST.",
			similes: ["DM", "DIRECT_MESSAGE", "CHAT", "CHANNEL", "ROOM"],
			parameters: [
				{
					name: "operation",
					description:
						"Message subaction: send, read, search, list_channels, list_servers, react, edit, delete, pin, join, leave, or get_user.",
					required: false,
					schema: {
						type: "string",
						enum: [
							"send",
							"read",
							"search",
							"list_channels",
							"list_servers",
							"react",
							"edit",
							"delete",
							"pin",
							"join",
							"leave",
							"get_user",
						],
					},
					descriptionCompressed: "message operation",
				},
				{
					name: "source",
					description:
						"Connector source such as discord, slack, signal, whatsapp, telegram, x, imessage, matrix, line, google-chat, feishu, instagram, or wechat.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "connector source",
				},
				{
					name: "target",
					description:
						"Loose target reference: user, handle, channel, room, group, server, contact, phone, email, or platform-specific ID.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "loose message target",
				},
				{
					name: "roomId",
					description:
						"Platform room or stored room ID for channel/group/DM operations.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "room id",
				},
				{
					name: "channel",
					description: "Loose channel, room, or group name/reference.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "channel reference",
				},
				{
					name: "channelId",
					description: "Platform channel ID for channel operations.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "channel id",
				},
				{
					name: "server",
					description:
						"Loose server, guild, workspace, or team name/reference.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "server reference",
				},
				{
					name: "serverId",
					description: "Platform server, guild, workspace, or team ID.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "server id",
				},
				{
					name: "userId",
					description:
						"Platform user ID or stored entity ID for user/DM operations.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "user id",
				},
				{
					name: "username",
					description: "Loose username for user/DM lookup.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "username",
				},
				{
					name: "handle",
					description: "Loose platform handle for user/DM lookup.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "handle",
				},
				{
					name: "threadId",
					description: "Thread identifier for threaded message operations.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "thread id",
				},
				{
					name: "alias",
					description:
						"Channel or room alias for operation=join or operation=leave.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "room alias",
				},
				{
					name: "invite",
					description: "Invite URL or token for operation=join.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "invite",
				},
				{
					name: "message",
					description:
						"Message text for operation=send or replacement text for operation=edit.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "message text",
				},
				{
					name: "query",
					description: "Search term for operation=search.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "search query",
				},
				{
					name: "messageId",
					description:
						"Platform message ID, full message ID, or stored memory ID for react/edit/delete/pin.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "message id",
				},
				{
					name: "emoji",
					description: "Reaction value for operation=react.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "reaction emoji",
				},
				{
					name: "pin",
					description:
						"Pin state for operation=pin. Use false to unpin when supported.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed: "pin state",
				},
				{
					name: "limit",
					description: "Maximum number of messages/channels/servers to return.",
					required: false,
					schema: {
						type: "integer",
					},
					descriptionCompressed: "result limit",
				},
				{
					name: "cursor",
					description:
						"Opaque pagination cursor for read/search/list operations.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "pagination cursor",
				},
				{
					name: "before",
					description:
						"Optional message id or timestamp boundary for older read/search results.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "before boundary",
				},
				{
					name: "after",
					description:
						"Optional message id or timestamp boundary for newer read/search results.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "after boundary",
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
							actions: ["MESSAGE"],
						},
					},
				],
			],
			exampleCalls: [
				{
					user: 'Send a message to @dev_guru on telegram saying "Hello!"',
					actions: ["REPLY", "MESSAGE"],
					params: {
						MESSAGE: {
							operation: "send",
							source: "telegram",
							target: "dev_guru",
							message: "Hello!",
						},
					},
				},
			],
			descriptionCompressed:
				"primary message action operations send read search list_channels list_servers react edit delete pin join leave get_user dm group channel room thread user server",
		},
		{
			name: "POST",
			description:
				"Primary action for public feed surfaces and timelines. Choose operation=send to publish a post, operation=read to fetch recent feed posts, or operation=search to search public posts. Addressed DMs, groups, channels, and rooms belong to MESSAGE.",
			similes: ["TWEET", "CAST", "PUBLISH", "FEED_POST", "TIMELINE"],
			parameters: [
				{
					name: "operation",
					description: "Post subaction: send, read, or search.",
					required: false,
					schema: {
						type: "string",
						enum: ["send", "read", "search"],
					},
					descriptionCompressed: "post operation",
				},
				{
					name: "source",
					description:
						"Post connector source such as x, bluesky, farcaster, nostr, or instagram.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "post connector source",
				},
				{
					name: "text",
					description: "Public post text for operation=send.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "post text",
				},
				{
					name: "target",
					description:
						"Loose feed target for operation=send/read, such as a user, handle, channel, media id, or connector-specific reference.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "post target",
				},
				{
					name: "feed",
					description:
						"Feed convention for operation=read, such as home, user, hashtag, channel, or connector-specific feed.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "feed selector",
				},
				{
					name: "replyTo",
					description:
						"Optional post, cast, media, or thread identifier when publishing a reply/comment.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "reply/comment target",
				},
				{
					name: "mediaId",
					description:
						"Optional media identifier for connectors that publish comments or replies to media.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "media id",
				},
				{
					name: "query",
					description: "Search term for operation=search.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "search query",
				},
				{
					name: "limit",
					description: "Maximum number of posts to return.",
					required: false,
					schema: {
						type: "integer",
					},
					descriptionCompressed: "result limit",
				},
				{
					name: "cursor",
					description:
						"Opaque pagination cursor for operation=read or operation=search.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "pagination cursor",
				},
				{
					name: "before",
					description:
						"Optional post id or timestamp boundary for older feed/search results.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "before boundary",
				},
				{
					name: "after",
					description:
						"Optional post id or timestamp boundary for newer feed/search results.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "after boundary",
				},
				{
					name: "attachments",
					description:
						"Optional media attachments for connectors that support media posts.",
					required: false,
					schema: {
						type: "array",
					},
					descriptionCompressed: "media attachments",
				},
			],
			examples: [
				[
					{
						name: "{{name1}}",
						content: {
							text: "Post 'shipping today' to X",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "Posted to X.",
							actions: ["POST"],
						},
					},
				],
			],
			exampleCalls: [
				{
					user: 'Post "shipping today" to X',
					actions: ["REPLY", "POST"],
					params: {
						POST: {
							operation: "send",
							source: "x",
							text: "shipping today",
						},
					},
				},
				{
					user: "Comment 'looks good' on Instagram media 180123",
					actions: ["REPLY", "POST"],
					params: {
						POST: {
							operation: "send",
							source: "instagram",
							mediaId: "180123",
							text: "looks good",
						},
					},
				},
			],
			descriptionCompressed:
				"primary post action operations send read search public feed timeline posts",
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
			name: "GENERATE_MEDIA",
			description:
				"Generates media based on a prompt and media type. Use GENERATE_MEDIA when the agent needs to create an image, video, music, sound effect, or speech audio for the user.",
			similes: [
				"GENERATE_IMAGE",
				"GENERATE_VIDEO",
				"GENERATE_AUDIO",
				"GENERATE_MEDIA_IMAGE",
				"DRAW",
				"CREATE_IMAGE",
				"RENDER_IMAGE",
				"VISUALIZE",
				"MAKE_IMAGE",
				"PAINT",
				"IMAGE",
				"CREATE_VIDEO",
				"MAKE_VIDEO",
				"ANIMATE",
				"COMPOSE",
				"MAKE_MUSIC",
				"TEXT_TO_SPEECH",
				"SOUND_EFFECT",
			],
			parameters: [
				{
					name: "mediaType",
					description: "The kind of media to generate.",
					required: true,
					schema: {
						type: "string",
						enum: ["image", "video", "audio"],
					},
					examples: ["image", "video", "audio"],
					descriptionCompressed: "Media kind: image, video, audio.",
				},
				{
					name: "prompt",
					description:
						"Detailed generation prompt describing the desired media.",
					required: true,
					schema: {
						type: "string",
					},
					examples: ["A futuristic cityscape at sunset, cinematic lighting"],
					descriptionCompressed: "Generation prompt.",
				},
				{
					name: "audioKind",
					description: "For audio generation, choose music, sfx, or tts.",
					required: false,
					schema: {
						type: "string",
						enum: ["music", "sfx", "tts"],
					},
					examples: ["music", "sfx", "tts"],
					descriptionCompressed: "Audio subtype.",
				},
				{
					name: "duration",
					description:
						"Optional target duration in seconds for video or audio.",
					required: false,
					schema: {
						type: "number",
					},
					examples: [5, 30],
					descriptionCompressed: "Duration seconds.",
				},
				{
					name: "aspectRatio",
					description:
						"Optional video aspect ratio such as 16:9, 9:16, or 1:1.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["16:9", "9:16"],
					descriptionCompressed: "Video aspect ratio.",
				},
				{
					name: "size",
					description: "Optional image size or image provider size preset.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["1024x1024", "landscape_4_3"],
					descriptionCompressed: "Image size.",
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
							actions: ["GENERATE_MEDIA"],
						},
					},
				],
				[
					{
						name: "{{name1}}",
						content: {
							text: "Make a five second clip of waves rolling in.",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "I'll create that video clip.",
							actions: ["GENERATE_MEDIA"],
						},
					},
				],
				[
					{
						name: "{{name1}}",
						content: {
							text: "Compose a mellow synth track for studying.",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "I'll generate that audio track.",
							actions: ["GENERATE_MEDIA"],
						},
					},
				],
			],
			descriptionCompressed: "Generate image, video, or audio from prompt.",
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
			name: "MESSAGE",
			description:
				"Primary action for addressed messaging surfaces: DMs, group chats, channels, rooms, threads, servers, and users. Choose operation=send, read, search, list_channels, list_servers, react, edit, delete, pin, join, leave, or get_user. Public feed publishing belongs to POST.",
			similes: ["DM", "DIRECT_MESSAGE", "CHAT", "CHANNEL", "ROOM"],
			parameters: [
				{
					name: "operation",
					description:
						"Message subaction: send, read, search, list_channels, list_servers, react, edit, delete, pin, join, leave, or get_user.",
					required: false,
					schema: {
						type: "string",
						enum: [
							"send",
							"read",
							"search",
							"list_channels",
							"list_servers",
							"react",
							"edit",
							"delete",
							"pin",
							"join",
							"leave",
							"get_user",
						],
					},
					descriptionCompressed: "message operation",
				},
				{
					name: "source",
					description:
						"Connector source such as discord, slack, signal, whatsapp, telegram, x, imessage, matrix, line, google-chat, feishu, instagram, or wechat.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "connector source",
				},
				{
					name: "target",
					description:
						"Loose target reference: user, handle, channel, room, group, server, contact, phone, email, or platform-specific ID.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "loose message target",
				},
				{
					name: "roomId",
					description:
						"Platform room or stored room ID for channel/group/DM operations.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "room id",
				},
				{
					name: "channel",
					description: "Loose channel, room, or group name/reference.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "channel reference",
				},
				{
					name: "channelId",
					description: "Platform channel ID for channel operations.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "channel id",
				},
				{
					name: "server",
					description:
						"Loose server, guild, workspace, or team name/reference.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "server reference",
				},
				{
					name: "serverId",
					description: "Platform server, guild, workspace, or team ID.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "server id",
				},
				{
					name: "userId",
					description:
						"Platform user ID or stored entity ID for user/DM operations.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "user id",
				},
				{
					name: "username",
					description: "Loose username for user/DM lookup.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "username",
				},
				{
					name: "handle",
					description: "Loose platform handle for user/DM lookup.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "handle",
				},
				{
					name: "threadId",
					description: "Thread identifier for threaded message operations.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "thread id",
				},
				{
					name: "alias",
					description:
						"Channel or room alias for operation=join or operation=leave.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "room alias",
				},
				{
					name: "invite",
					description: "Invite URL or token for operation=join.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "invite",
				},
				{
					name: "message",
					description:
						"Message text for operation=send or replacement text for operation=edit.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "message text",
				},
				{
					name: "query",
					description: "Search term for operation=search.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "search query",
				},
				{
					name: "messageId",
					description:
						"Platform message ID, full message ID, or stored memory ID for react/edit/delete/pin.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "message id",
				},
				{
					name: "emoji",
					description: "Reaction value for operation=react.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "reaction emoji",
				},
				{
					name: "pin",
					description:
						"Pin state for operation=pin. Use false to unpin when supported.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed: "pin state",
				},
				{
					name: "limit",
					description: "Maximum number of messages/channels/servers to return.",
					required: false,
					schema: {
						type: "integer",
					},
					descriptionCompressed: "result limit",
				},
				{
					name: "cursor",
					description:
						"Opaque pagination cursor for read/search/list operations.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "pagination cursor",
				},
				{
					name: "before",
					description:
						"Optional message id or timestamp boundary for older read/search results.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "before boundary",
				},
				{
					name: "after",
					description:
						"Optional message id or timestamp boundary for newer read/search results.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "after boundary",
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
							actions: ["MESSAGE"],
						},
					},
				],
			],
			exampleCalls: [
				{
					user: 'Send a message to @dev_guru on telegram saying "Hello!"',
					actions: ["REPLY", "MESSAGE"],
					params: {
						MESSAGE: {
							operation: "send",
							source: "telegram",
							target: "dev_guru",
							message: "Hello!",
						},
					},
				},
			],
			descriptionCompressed:
				"primary message action operations send read search list_channels list_servers react edit delete pin join leave get_user dm group channel room thread user server",
		},
		{
			name: "POST",
			description:
				"Primary action for public feed surfaces and timelines. Choose operation=send to publish a post, operation=read to fetch recent feed posts, or operation=search to search public posts. Addressed DMs, groups, channels, and rooms belong to MESSAGE.",
			similes: ["TWEET", "CAST", "PUBLISH", "FEED_POST", "TIMELINE"],
			parameters: [
				{
					name: "operation",
					description: "Post subaction: send, read, or search.",
					required: false,
					schema: {
						type: "string",
						enum: ["send", "read", "search"],
					},
					descriptionCompressed: "post operation",
				},
				{
					name: "source",
					description:
						"Post connector source such as x, bluesky, farcaster, nostr, or instagram.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "post connector source",
				},
				{
					name: "text",
					description: "Public post text for operation=send.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "post text",
				},
				{
					name: "target",
					description:
						"Loose feed target for operation=send/read, such as a user, handle, channel, media id, or connector-specific reference.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "post target",
				},
				{
					name: "feed",
					description:
						"Feed convention for operation=read, such as home, user, hashtag, channel, or connector-specific feed.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "feed selector",
				},
				{
					name: "replyTo",
					description:
						"Optional post, cast, media, or thread identifier when publishing a reply/comment.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "reply/comment target",
				},
				{
					name: "mediaId",
					description:
						"Optional media identifier for connectors that publish comments or replies to media.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "media id",
				},
				{
					name: "query",
					description: "Search term for operation=search.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "search query",
				},
				{
					name: "limit",
					description: "Maximum number of posts to return.",
					required: false,
					schema: {
						type: "integer",
					},
					descriptionCompressed: "result limit",
				},
				{
					name: "cursor",
					description:
						"Opaque pagination cursor for operation=read or operation=search.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "pagination cursor",
				},
				{
					name: "before",
					description:
						"Optional post id or timestamp boundary for older feed/search results.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "before boundary",
				},
				{
					name: "after",
					description:
						"Optional post id or timestamp boundary for newer feed/search results.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "after boundary",
				},
				{
					name: "attachments",
					description:
						"Optional media attachments for connectors that support media posts.",
					required: false,
					schema: {
						type: "array",
					},
					descriptionCompressed: "media attachments",
				},
			],
			examples: [
				[
					{
						name: "{{name1}}",
						content: {
							text: "Post 'shipping today' to X",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "Posted to X.",
							actions: ["POST"],
						},
					},
				],
			],
			exampleCalls: [
				{
					user: 'Post "shipping today" to X',
					actions: ["REPLY", "POST"],
					params: {
						POST: {
							operation: "send",
							source: "x",
							text: "shipping today",
						},
					},
				},
				{
					user: "Comment 'looks good' on Instagram media 180123",
					actions: ["REPLY", "POST"],
					params: {
						POST: {
							operation: "send",
							source: "instagram",
							mediaId: "180123",
							text: "looks good",
						},
					},
				},
			],
			descriptionCompressed:
				"primary post action operations send read search public feed timeline posts",
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
			name: "GENERATE_MEDIA",
			description:
				"Generates media based on a prompt and media type. Use GENERATE_MEDIA when the agent needs to create an image, video, music, sound effect, or speech audio for the user.",
			similes: [
				"GENERATE_IMAGE",
				"GENERATE_VIDEO",
				"GENERATE_AUDIO",
				"GENERATE_MEDIA_IMAGE",
				"DRAW",
				"CREATE_IMAGE",
				"RENDER_IMAGE",
				"VISUALIZE",
				"MAKE_IMAGE",
				"PAINT",
				"IMAGE",
				"CREATE_VIDEO",
				"MAKE_VIDEO",
				"ANIMATE",
				"COMPOSE",
				"MAKE_MUSIC",
				"TEXT_TO_SPEECH",
				"SOUND_EFFECT",
			],
			parameters: [
				{
					name: "mediaType",
					description: "The kind of media to generate.",
					required: true,
					schema: {
						type: "string",
						enum: ["image", "video", "audio"],
					},
					examples: ["image", "video", "audio"],
					descriptionCompressed: "Media kind: image, video, audio.",
				},
				{
					name: "prompt",
					description:
						"Detailed generation prompt describing the desired media.",
					required: true,
					schema: {
						type: "string",
					},
					examples: ["A futuristic cityscape at sunset, cinematic lighting"],
					descriptionCompressed: "Generation prompt.",
				},
				{
					name: "audioKind",
					description: "For audio generation, choose music, sfx, or tts.",
					required: false,
					schema: {
						type: "string",
						enum: ["music", "sfx", "tts"],
					},
					examples: ["music", "sfx", "tts"],
					descriptionCompressed: "Audio subtype.",
				},
				{
					name: "duration",
					description:
						"Optional target duration in seconds for video or audio.",
					required: false,
					schema: {
						type: "number",
					},
					examples: [5, 30],
					descriptionCompressed: "Duration seconds.",
				},
				{
					name: "aspectRatio",
					description:
						"Optional video aspect ratio such as 16:9, 9:16, or 1:1.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["16:9", "9:16"],
					descriptionCompressed: "Video aspect ratio.",
				},
				{
					name: "size",
					description: "Optional image size or image provider size preset.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["1024x1024", "landscape_4_3"],
					descriptionCompressed: "Image size.",
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
							actions: ["GENERATE_MEDIA"],
						},
					},
				],
				[
					{
						name: "{{name1}}",
						content: {
							text: "Make a five second clip of waves rolling in.",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "I'll create that video clip.",
							actions: ["GENERATE_MEDIA"],
						},
					},
				],
				[
					{
						name: "{{name1}}",
						content: {
							text: "Compose a mellow synth track for studying.",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "I'll generate that audio track.",
							actions: ["GENERATE_MEDIA"],
						},
					},
				],
			],
			descriptionCompressed: "Generate image, video, or audio from prompt.",
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
				"Engage a nearby NPC in the SCAPE world in combat by its instance id (taken from the SCAPE_NEARBY provider's npcs list). The game server pathfinds the agent into attack range and starts combat via PlayerManager.attackNpcAsAgent. Use only when an enemy id is known and combat is desired; this is a write action that mutates world state.",
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
			descriptionCompressed: "scape:attack-npc by-id (paths-into-range)",
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
				"Execute a shell command via /bin/bash -c <command>. Runs synchronously in the session cwd by default. Returns stdout, stderr, and exit code. Hard timeout kills the command. Paths under the configured blocklist are off-limits as cwd.",
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
						"Absolute working directory; must not resolve under a blocked path. Defaults to the session cwd.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Absolute working directory. must not resolve under a blocked path. Defaults to the session cwd.",
				},
			],
			descriptionCompressed: "Run a shell command synchronously.",
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
						},
					},
				},
			],
		},
		{
			name: "BLOCK_UNTIL_TASK_COMPLETE",
			description:
				"Create a LifeOps-managed website block rule gated on completion of a specific todo, so the named hosts stay blocked until that todo is marked done. Use when the unblock condition is finishing a task, workout, assignment, or todo (for example, 'block x.com until I finish my workout'). When todoName is supplied with no matching active todo, create that todo first; optional unlockDurationMinutes re-locks the same hosts after the todo gate releases. Do not use for fixed-duration blocks ('for 2 hours') or generic focus blocks ('turn on social media blocking'); those belong to OWNER_WEBSITE_BLOCK.",
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
			descriptionCompressed:
				"block-websites-until-todo-complete: websites + todoId|todoName + optional unlockDurationMinutes",
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
			name: "BROWSER",
			description:
				"Single BROWSER action — control whichever browser target is registered. Targets are pluggable: `workspace` (electrobun-embedded BrowserView, the default; falls back to a JSDOM web mode when the desktop bridge isn't configured), `bridge` (the user's real Chrome/Safari via the Agent Browser Bridge companion extension), and `computeruse` (a local puppeteer-driven Chromium via plugin-computeruse). The agent uses what is available — the BrowserService picks the active target when none is specified.",
			parameters: [
				{
					name: "action",
					description:
						"Compatibility alias for subaction from older BROWSER_ACTION calls. Prefer subaction in new plans.",
					required: false,
					schema: {
						type: "string",
						enum: [
							"back",
							"click",
							"close",
							"context",
							"forward",
							"get",
							"get_context",
							"hide",
							"info",
							"list_tabs",
							"navigate",
							"open",
							"open_tab",
							"press",
							"reload",
							"screenshot",
							"show",
							"snapshot",
							"state",
							"tab",
							"type",
							"wait",
							"close_tab",
							"switch_tab",
							"realistic-click",
							"realistic-fill",
							"realistic-type",
							"realistic-press",
							"cursor-move",
							"cursor-hide",
						],
					},
					descriptionCompressed:
						"Compatibility alias for subaction from older BROWSER_ACTION calls. Prefer subaction in new plans.",
				},
				{
					name: "subaction",
					description: "Browser action to perform",
					required: false,
					schema: {
						type: "string",
						enum: [
							"back",
							"click",
							"close",
							"forward",
							"get",
							"hide",
							"navigate",
							"open",
							"press",
							"reload",
							"screenshot",
							"show",
							"snapshot",
							"state",
							"tab",
							"type",
							"wait",
							"realistic-click",
							"realistic-fill",
							"realistic-type",
							"realistic-press",
							"cursor-move",
							"cursor-hide",
						],
					},
					descriptionCompressed: "Browser action to perform",
				},
				{
					name: "tabAction",
					description: "Tab operation when subaction is tab",
					required: false,
					schema: {
						type: "string",
						enum: ["close", "list", "new", "switch"],
					},
					descriptionCompressed: "Tab operation when subaction is tab",
				},
				{
					name: "id",
					description: "Session or tab id to target",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Session or tab id to target",
				},
				{
					name: "url",
					description: "URL for open or navigate",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "URL for open or navigate",
				},
				{
					name: "selector",
					description: "Selector for click, type, or wait",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Selector for click, type, or wait",
				},
				{
					name: "text",
					description: "Text for type",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Text for type",
				},
				{
					name: "key",
					description: "Keyboard key for press",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Keyboard key for press",
				},
				{
					name: "pixels",
					description: "Scroll distance in pixels",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed: "Scroll distance in pixels",
				},
				{
					name: "timeoutMs",
					description: "Command timeout in milliseconds",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed: "Command timeout in milliseconds",
				},
				{
					name: "script",
					description: "Script for eval",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Script for eval",
				},
				{
					name: "watchMode",
					description:
						"Hint that the user is watching; prefers realistic-* subactions for click/fill so the cursor moves visibly and pointer events fire faithfully.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed:
						"Hint that user is watching. prefers realistic-* subactions for click/fill so the cursor moves visibly and pointer events fire faithfully.",
				},
				{
					name: "cursorDurationMs",
					description:
						"Cursor animation duration (ms) for realistic-* subactions",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed:
						"Cursor animation duration (ms) for realistic-* subactions",
				},
				{
					name: "perCharDelayMs",
					description:
						"Per-character delay for realistic-type/realistic-fill (ms)",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed:
						"Per-character delay for realistic-type/realistic-fill (ms)",
				},
				{
					name: "replace",
					description:
						"Replace existing input value when filling (vs append) — applies to realistic-fill",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed:
						"Replace existing input value when filling (vs append) - applies to realistic-fill",
				},
				{
					name: "x",
					description: "Cursor target X (CSS pixels) for cursor-move",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed: "Cursor target X (CSS pixels) for cursor-move",
				},
				{
					name: "y",
					description: "Cursor target Y (CSS pixels) for cursor-move",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed: "Cursor target Y (CSS pixels) for cursor-move",
				},
			],
			descriptionCompressed:
				"Browser tab/page control only: open/navigate/click/type/screenshot/state. For LifeOps Browser Bridge settings/status use MANAGE_BROWSER_BRIDGE.",
			similes: [
				"BROWSE_SITE",
				"BROWSER_SESSION",
				"CONTROL_BROWSER",
				"CONTROL_BROWSER_SESSION",
				"MANAGE_ELIZA_BROWSER_WORKSPACE",
				"MANAGE_LIFEOPS_BROWSER",
				"NAVIGATE_SITE",
				"OPEN_SITE",
				"USE_BROWSER",
				"BROWSER_ACTION",
			],
			exampleCalls: [
				{
					user: "Use BROWSER with the provided parameters.",
					actions: ["BROWSER"],
					params: {
						BROWSER: {
							action: "back",
							subaction: "back",
							tabAction: "close",
							id: "example",
							url: "example",
							selector: "example",
							text: "example",
							key: "example",
							pixels: 1,
							timeoutMs: 1,
							script: "example",
							watchMode: false,
							cursorDurationMs: 1,
							perCharDelayMs: 1,
							replace: false,
							x: 1,
							y: 1,
						},
					},
				},
			],
		},
		{
			name: "BROWSER_AUTOFILL_LOGIN",
			description:
				"Autofill saved credentials into an open Eliza browser tab for the requested domain. Requires the user to have pre-authorized agent autofill for the domain via Settings -> Vault -> Logins (`creds.<domain>.:autoallow = 1`).",
			parameters: [
				{
					name: "domain",
					description:
						"Registrable hostname to autofill (e.g. `github.com`, no protocol or path).",
					required: true,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Registrable hostname to autofill (e. g. `github.com`, no protocol or path).",
				},
				{
					name: "username",
					description:
						"Specific saved login to use. When omitted, the most recently modified saved login for the domain is selected.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Specific saved login to use. When omitted, the most recently modified saved login for the domain is selected.",
				},
				{
					name: "submit",
					description:
						"When true, submit the form after filling. Defaults to false (fill-only).",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed:
						"When true, submit the form after filling. Defaults to false (fill-only).",
				},
			],
			descriptionCompressed:
				"autofill save credential open Eliza browser tab request domain require user pre-authorize agent autofill domain via Settings - Vault - Logins (cred domain: autoallow 1)",
			similes: [
				"AGENT_AUTOFILL",
				"AUTOFILL_BROWSER_LOGIN",
				"AUTOFILL_LOGIN",
				"FILL_BROWSER_CREDENTIALS",
				"LOG_INTO_SITE",
				"SIGN_IN_TO_SITE",
			],
			exampleCalls: [
				{
					user: "Use BROWSER_AUTOFILL_LOGIN with the provided parameters.",
					actions: ["BROWSER_AUTOFILL_LOGIN"],
					params: {
						BROWSER_AUTOFILL_LOGIN: {
							domain: "example",
							username: "example",
							submit: false,
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
				"COMMAND",
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
			name: "CREATE_WORKSPACE",
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
				"PROVISION_WORKSPACE",
				"CLONE_REPO",
				"SETUP_WORKSPACE",
				"PREPARE_WORKSPACE",
			],
			exampleCalls: [
				{
					user: "Use CREATE_WORKSPACE with the provided parameters.",
					actions: ["CREATE_WORKSPACE"],
					params: {
						CREATE_WORKSPACE: {
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
			name: "DELETE_LINEAR_COMMENT",
			description: "Delete a Linear comment by id",
			parameters: [
				{
					name: "commentId",
					description: "Linear comment id to delete.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Linear comment id to delete.",
				},
			],
			descriptionCompressed: "delete Linear comment id",
			similes: ["remove-linear-comment", "erase-linear-comment"],
			exampleCalls: [
				{
					user: "Use DELETE_LINEAR_COMMENT with the provided parameters.",
					actions: ["DELETE_LINEAR_COMMENT"],
					params: {
						DELETE_LINEAR_COMMENT: {
							commentId: "example",
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
			name: "LINEAR",
			description:
				"Manage Linear issues, comments, and activity. Operations: create_issue, get_issue, update_issue, delete_issue, create_comment, update_comment, delete_comment, list_comments, get_activity, clear_activity, search_issues. The op is inferred from the message text when not explicitly provided.",
			parameters: [
				{
					name: "op",
					description:
						"Operation to perform. One of: create_issue, get_issue, update_issue, delete_issue, create_comment, update_comment, delete_comment, list_comments, get_activity, clear_activity, search_issues. Inferred from message text when omitted.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Operation to perform. One of: create_issue, get_issue, update_issue, delete_issue, create_comment, update_comment, delete_comment, list_comments...",
				},
			],
			descriptionCompressed:
				"Linear: create/get/update/delete issue, create/update/delete/list comment, search issues, get/clear activity.",
			similes: [
				"LINEAR_ISSUE",
				"LINEAR_ISSUES",
				"LINEAR_COMMENT",
				"LINEAR_COMMENTS",
				"LINEAR_WORKFLOW",
				"LINEAR_ACTIVITY",
				"LINEAR_SEARCH",
				"CREATE_LINEAR_ISSUE",
				"GET_LINEAR_ISSUE",
				"UPDATE_LINEAR_ISSUE",
				"DELETE_LINEAR_ISSUE",
				"MANAGE_LINEAR_ISSUE",
				"MANAGE_LINEAR_ISSUES",
				"CREATE_LINEAR_COMMENT",
				"COMMENT_LINEAR_ISSUE",
				"UPDATE_LINEAR_COMMENT",
				"DELETE_LINEAR_COMMENT",
				"LIST_LINEAR_COMMENTS",
				"GET_LINEAR_ACTIVITY",
				"CLEAR_LINEAR_ACTIVITY",
				"SEARCH_LINEAR_ISSUES",
				"LINEAR_WORKFLOW_SEARCH",
			],
			exampleCalls: [
				{
					user: "Use LINEAR with the provided parameters.",
					actions: ["LINEAR"],
					params: {
						LINEAR: {
							op: "example",
						},
					},
				},
			],
		},
		{
			name: "LIST_ACTIVE_BLOCKS",
			description:
				"Report the current website blocker state by combining the live OS-level hosts/SelfControl status (active hosts, end time, permission notes) with LifeOps-managed block rules (id, gateType, websites, and gate target: todo id, ISO deadline, or fixed duration). Toggle either source via includeLiveStatus and includeManagedRules. Use only for website/app blocking status; do not use for inbox blockers, message priority, morning/night briefs, operating pictures, end-of-day reviews, or general executive-assistant triage.",
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
				"list-website-blocks: live hosts/SelfControl status + managed rules (gateType, target, websites)",
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
			name: "LIST_LINEAR_COMMENTS",
			description: "List comments on a Linear issue",
			parameters: [
				{
					name: "issueId",
					description: "Linear issue id or identifier to list comments for.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Linear issue id or id to list comments for.",
				},
				{
					name: "limit",
					description:
						"Maximum number of comments to return (default 25, max 100).",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed:
						"max number of comments to return (default 25, max 100).",
				},
			],
			descriptionCompressed: "list comment Linear issue",
			similes: [
				"get-linear-comments",
				"show-linear-comments",
				"fetch-linear-comments",
			],
			exampleCalls: [
				{
					user: "Use LIST_LINEAR_COMMENTS with the provided parameters.",
					actions: ["LIST_LINEAR_COMMENTS"],
					params: {
						LIST_LINEAR_COMMENTS: {
							issueId: "example",
							limit: 1,
						},
					},
				},
			],
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
			name: "MUSIC_LIBRARY",
			description:
				"Consolidated music library action. Use op=playlist with subaction=save, load, delete, or add for playlist management; op=play-query to research and queue complex music requests; op=search-youtube to return YouTube links; op=download to fetch music into the local library. Queue changes, downloads, and playlist mutations require confirmed:true.",
			parameters: [
				{
					name: "op",
					description:
						"Music library operation: playlist, play-query, search-youtube, or download.",
					required: true,
					schema: {
						type: "string",
						enum: ["playlist", "play-query", "search-youtube", "download"],
					},
					descriptionCompressed:
						"Music library operation: playlist, play-query, search-youtube, or download.",
				},
				{
					name: "subaction",
					description:
						"Playlist subaction when op=playlist: save, load, delete, or add.",
					required: false,
					schema: {
						type: "string",
						enum: ["save", "load", "delete", "add"],
					},
					descriptionCompressed:
						"Playlist subaction when op=playlist: save, load, delete, or add.",
				},
				{
					name: "query",
					description:
						"Song, artist, album, or video query for play-query, search-youtube, download, or playlist add.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Song, artist, album, or video query for play-query, search-youtube, download, or playlist add.",
				},
				{
					name: "playlistName",
					description: "Playlist name for playlist save, load, delete, or add.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Playlist name for playlist save, load, delete, or add.",
				},
				{
					name: "song",
					description: "Song query for playlist subaction=add.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Song query for playlist subaction=add.",
				},
				{
					name: "limit",
					description: "Maximum YouTube search results to inspect.",
					required: false,
					schema: {
						type: "number",
						default: 5,
						minimum: 1,
						maximum: 10,
					},
					descriptionCompressed: "max YouTube search results to inspect.",
				},
				{
					name: "confirmed",
					description:
						"Must be true before queue changes, downloads, or playlist mutations.",
					required: false,
					schema: {
						type: "boolean",
						default: false,
					},
					descriptionCompressed:
						"Must be true before queue changes, downloads, or playlist mutations.",
				},
			],
			descriptionCompressed:
				"Music library ops: playlist(subaction save/load/delete/add), play-query, search-youtube, download. Mutations require confirmed:true.",
			exampleCalls: [
				{
					user: "Use MUSIC_LIBRARY with the provided parameters.",
					actions: ["MUSIC_LIBRARY"],
					params: {
						MUSIC_LIBRARY: {
							op: "playlist",
							subaction: "save",
							query: "example",
							playlistName: "example",
							song: "example",
							limit: 5,
							confirmed: false,
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
			name: "PAYMENT",
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
					user: "Use PAYMENT with the provided parameters.",
					actions: ["PAYMENT"],
					params: {
						PAYMENT: {
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
			name: "PLAYBACK",
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
					user: "Use PLAYBACK with the provided parameters.",
					actions: ["PLAYBACK"],
					params: {
						PLAYBACK: {
							op: "pause",
							query: "example",
							confirmed: false,
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
			name: "READING",
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
					user: "Use READING with the provided parameters.",
					actions: ["READING"],
					params: {
						READING: {
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
			name: "RS_2004_WALK_TO",
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
					user: "Use RS_2004_WALK_TO with the provided parameters.",
					actions: ["RS_2004_WALK_TO"],
					params: {
						RS_2004_WALK_TO: {
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
			name: "SCAPE_WALK_TO",
			description:
				"Walk the agent toward a specific world tile (x, z). Use this to move to banks, NPCs, resource nodes, or just to explore.",
			parameters: [
				{
					name: "x",
					description: "Target world X coordinate.",
					required: true,
					schema: {
						type: "number",
					},
					descriptionCompressed: "Target x.",
				},
				{
					name: "z",
					description: "Target world Z coordinate.",
					required: true,
					schema: {
						type: "number",
					},
					descriptionCompressed: "Target z.",
				},
				{
					name: "run",
					description: "Whether to run toward the target when possible.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed: "Run toggle.",
				},
			],
			descriptionCompressed: "Walk to coordinate.",
			similes: ["MOVE_TO", "GO_TO", "TRAVEL_TO", "HEAD_TO"],
			exampleCalls: [
				{
					user: "Use SCAPE_WALK_TO with the provided parameters.",
					actions: ["SCAPE_WALK_TO"],
					params: {
						SCAPE_WALK_TO: {
							x: 1,
							z: 1,
							run: false,
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
					description: "Search term.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Search term.",
				},
				{
					name: "scope",
					description: "Search scope: all, products, orders, or customers.",
					required: false,
					schema: {
						type: "string",
						enum: ["all", "products", "orders", "customers"],
					},
					descriptionCompressed:
						"Search scope: all, products, orders, or customers.",
				},
				{
					name: "limit",
					description: "Maximum results per scope.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed: "max results per scope.",
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
			name: "SHOPIFY",
			description:
				"Manage a Shopify store. Operations: products (CRUD on products), inventory (stock adjustments), orders (list/update orders), customers (CRUD on customers). Op is inferred from the message text when not explicitly provided. For read-only catalog browsing use SEARCH_SHOPIFY_STORE.",
			parameters: [
				{
					name: "op",
					description:
						"Operation to perform. One of: products, inventory, orders, customers. Inferred from message text when omitted.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Operation to perform. One of: products, inventory, orders, customers. Inferred from msg text when omitted.",
				},
			],
			descriptionCompressed: "Shopify: products, inventory, orders, customers.",
			exampleCalls: [
				{
					user: "Use SHOPIFY with the provided parameters.",
					actions: ["SHOPIFY"],
					params: {
						SHOPIFY: {
							op: "example",
						},
					},
				},
			],
		},
		{
			name: "SKILL",
			description:
				"Manage skill catalog. Operations: search (browse available skills), details (info about a specific skill), sync (refresh catalog from registry), toggle (enable/disable installed skill), install (install from registry), uninstall (remove non-bundled skill). For invoking an enabled skill, use USE_SKILL instead.",
			parameters: [
				{
					name: "op",
					description:
						"Operation to perform. One of: search, details, sync, toggle, install, uninstall. Inferred from message text when omitted.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Operation to perform. One of: search, details, sync, toggle, install, uninstall. Inferred from msg text when omitted.",
				},
			],
			descriptionCompressed:
				"Skill catalog: search, details, sync, toggle, install, uninstall.",
			exampleCalls: [
				{
					user: "Use SKILL with the provided parameters.",
					actions: ["SKILL"],
					params: {
						SKILL: {
							op: "example",
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
			name: "SUBMIT_WORKSPACE",
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
				"FINALIZE_WORKSPACE",
				"COMMIT_AND_PR",
				"CREATE_PR",
				"SUBMIT_CHANGES",
				"FINISH_WORKSPACE",
			],
			exampleCalls: [
				{
					user: "Use SUBMIT_WORKSPACE with the provided parameters.",
					actions: ["SUBMIT_WORKSPACE"],
					params: {
						SUBMIT_WORKSPACE: {
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
				{
					name: "accountId",
					description:
						"Optional Tailscale account id from TAILSCALE_ACCOUNTS. Defaults to TAILSCALE_DEFAULT_ACCOUNT_ID or legacy settings.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Optional Tailscale account id from TAILSCALE_ACCOUNTS. Defaults to TAILSCALE_DEFAULT_ACCOUNT_ID or legacy settings.",
				},
			],
			descriptionCompressed: "Tailscale: start tunnel, stop tunnel.",
			exampleCalls: [
				{
					user: "Use TAILSCALE with the provided parameters.",
					actions: ["TAILSCALE"],
					params: {
						TAILSCALE: {
							op: "example",
							port: 1,
							accountId: "example",
						},
					},
				},
			],
		},
		{
			name: "TASK_CONTROL",
			description:
				"Apply a current control operation to an agent-orchestrator coordinator task thread while preserving durable thread history. Operations: pause (suspend with optional note), stop (halt and keep history), resume (re-attach a task session with optional follow-up instruction and agentType override), continue (send a follow-up instruction to the existing or a new task session), archive (hide from active lists), reopen (restore from archive). Resolve the target from threadId, sessionId, or free-text search.",
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
				"task-control:op=pause|stop|resume|continue|archive|reopen coordinator-task-thread (threadId|sessionId|search; +note|instruction|agentType)",
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
				"Query the agent-orchestrator coordinator's current task-thread registry as structured summaries (status, latestActivityAt, optional summary) without loading raw transcripts. Pick metric=list (default), count, or detail; narrow with window=active|today|yesterday|last_7_days|last_30_days, statuses, free-text search, includeArchived, and limit. Use for current work, date-range summaries, topic search, task counts, or one thread's detail.",
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
				"task-history:metric=list|count|detail + window + statuses + search + limit (no raw transcripts)",
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
			name: "TODO",
			description:
				"Manage the user's todo list. Op-based dispatch — provide an `op` parameter:\n",
			parameters: [
				{
					name: "op",
					description:
						"Operation: write, create, update, complete, cancel, delete, list, clear.",
					required: true,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Operation: write, create, update, complete, cancel, delete, list, clear.",
				},
				{
					name: "id",
					description: "Todo id (update/complete/cancel/delete).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Todo id (update/complete/cancel/delete).",
				},
				{
					name: "content",
					description: "Imperative form, e.g. 'Add tests' (create/update).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Imperative form, e. g. 'Add tests' (create/update).",
				},
				{
					name: "activeForm",
					description:
						"Present-continuous form, e.g. 'Adding tests' (create/update).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Present-continuous form, e. g. 'Adding tests' (create/update).",
				},
				{
					name: "status",
					description: "pending | in_progress | completed | cancelled.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"pending | in_progress | completed | cancelled.",
				},
				{
					name: "parentTodoId",
					description: "Parent todo id for sub-tasks (create/update).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Parent todo id for sub-tasks (create/update).",
				},
				{
					name: "todos",
					description:
						"Array of {id?, content, status, activeForm?} for op=write. Replaces the user's list for this conversation.",
					required: false,
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
								},
								activeForm: {
									type: "string",
								},
							},
						},
					},
					descriptionCompressed:
						"Array of {id?, content, status, activeForm?} for op=write. Replaces user's list for this convo.",
				},
				{
					name: "includeCompleted",
					description: "Include completed/cancelled todos in op=list output.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed:
						"Include completed/cancelled todos in op=list output.",
				},
				{
					name: "limit",
					description: "Max rows to return for op=list.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed: "Max rows to return for op=list.",
				},
			],
			descriptionCompressed:
				"todo manage list; op: write|create|update|complete|cancel|delete|list|clear; user-scoped (entityId).",
			similes: [
				"TODO_WRITE",
				"WRITE_TODOS",
				"SET_TODOS",
				"UPDATE_TODOS",
				"TODO_CREATE",
				"CREATE_TODO",
				"TODO_UPDATE",
				"UPDATE_TODO",
				"TODO_COMPLETE",
				"COMPLETE_TODO",
				"FINISH_TODO",
				"TODO_CANCEL",
				"CANCEL_TODO",
				"TODO_DELETE",
				"DELETE_TODO",
				"REMOVE_TODO",
				"TODO_LIST",
				"LIST_TODOS",
				"GET_TODOS",
				"SHOW_TODOS",
				"TODO_CLEAR",
				"CLEAR_TODOS",
			],
			exampleCalls: [
				{
					user: "Use TODO with the provided parameters.",
					actions: ["TODO"],
					params: {
						TODO: {
							op: "example",
							id: "example",
							content: "example",
							activeForm: "example",
							status: "example",
							parentTodoId: "example",
							todos: "example",
							includeCompleted: false,
							limit: 1,
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
			name: "UPDATE_LINEAR_COMMENT",
			description: "Update (edit) the body of an existing Linear comment",
			parameters: [
				{
					name: "commentId",
					description: "Linear comment id to update.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Linear comment id to update.",
				},
				{
					name: "body",
					description: "New comment body text.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "New comment body text.",
				},
			],
			descriptionCompressed: "update (edit) body exist Linear comment",
			similes: [
				"edit-linear-comment",
				"modify-linear-comment",
				"change-linear-comment",
			],
			exampleCalls: [
				{
					user: "Use UPDATE_LINEAR_COMMENT with the provided parameters.",
					actions: ["UPDATE_LINEAR_COMMENT"],
					params: {
						UPDATE_LINEAR_COMMENT: {
							commentId: "example",
							body: "example",
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
			name: "DOCUMENTS",
			description:
				"Provides relevant snippets and recent entries from the agent document store",
			dynamic: true,
			descriptionCompressed: "Relevant snippets and recent stored documents.",
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
			name: "DOCUMENTS",
			description:
				"Provides relevant snippets and recent entries from the agent document store",
			dynamic: true,
			descriptionCompressed: "Relevant snippets and recent stored documents.",
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
