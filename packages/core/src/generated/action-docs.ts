/**
 * Auto-generated action/provider docs.
 * DO NOT EDIT - Generated from packages/prompts/specs/**.
 */

export type ActionDocParameterExampleValue =
	| string
	| number
	| boolean
	| null
	| readonly ActionDocParameterExampleValue[]
	| { readonly [key: string]: ActionDocParameterExampleValue };

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

export const coreActionsSpecVersion = "1.0.0" as const;
export const allActionsSpecVersion = "1.0.0" as const;
export const coreProvidersSpecVersion = "1.0.0" as const;
export const allProvidersSpecVersion = "1.0.0" as const;

export const coreActionsSpec = {
	version: "1.0.0",
	actions: [
		{
			name: "REPLY",
			description:
				"Send a direct chat reply in the current conversation/thread. Default if the agent is responding with a message and no other action. Use REPLY at the beginning of a chain of actions as an acknowledgement, and at the end of a chain of actions as a final response. Do NOT use REPLY to send to a different channel/person or to run an email/inbox workflow — use MESSAGE (action=send) for a directed send to another channel or DM, MESSAGE inbox operations for triage/drafts, and POST to publish to a public feed.",
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
				"Send a direct chat reply in the current conversation/thread. Default if the agent is responding with a message and no other action. Use REPLY at the beginning of a chain of actions as an acknowledgement, and at the end of a chain of actions as a final response. Do NOT use REPLY to send to a different channel/person or to run an email/inbox workflow — use MESSAGE (action=send) for a directed send to another channel or DM, MESSAGE inbox operations for triage/drafts, and POST to publish to a public feed.",
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
							text: "Leave me alone",
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
							text: "Stop talking, bot",
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
							text: "send me something inappropriate",
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
				"Call this action if ignoring the user. If the user is aggressive, creepy or is finished with the conversation, use this action. In group conversations, use IGNORE when the latest message is addressed to someone else and not to the agent. Or, if both you and the user have already said goodbye, use this action instead of saying bye again. Use IGNORE any time the conversation has naturally ended. Do not use IGNORE if the user has engaged directly, or if something went wrong and you need to tell them. Only ignore if the user should be ignored.",
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
							text: "Yes, probably.",
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
							text: "Why don't scientists trust atoms? Because they make up everything.",
							actions: ["NONE"],
						},
					},
				],
			],
			descriptionCompressed:
				"Respond but perform no additional action. This is the default if the agent is speaking and not doing anything additional.",
		},
		{
			name: "MESSAGE",
			description:
				"Primary action for addressed messaging surfaces: DMs, group chats, channels, rooms, threads, servers, users, inboxes, drafts, and owner message workflows. Choose action=send, read_channel, read_with_contact, search, list_channels, list_servers, react, edit, delete, pin, join, leave, get_user, triage, list_inbox, search_inbox, draft_reply, draft_followup, respond, send_draft, schedule_draft_send, or manage. Public feed publishing belongs to POST.",
			similes: ["DM", "DIRECT_MESSAGE", "CHAT", "CHANNEL", "ROOM"],
			parameters: [
				{
					name: "action",
					description:
						"Message action: send, read_channel, read_with_contact, search, list_channels, list_servers, react, edit, delete, pin, join, leave, get_user, triage, list_inbox, search_inbox, draft_reply, draft_followup, respond, send_draft, schedule_draft_send, or manage.",
					required: false,
					schema: {
						type: "string",
						enum: [
							"send",
							"read_channel",
							"read_with_contact",
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
							"triage",
							"list_inbox",
							"search_inbox",
							"draft_reply",
							"draft_followup",
							"respond",
							"send_draft",
							"schedule_draft_send",
							"manage",
						],
					},
					descriptionCompressed:
						"Message action: send, read_channel, read_with_contact, search, list_channels, list_servers, react, edit, delete, pin, join, leave, get_user, triage, list_inbox, search_inbox, draft_reply, draft_followup, respond, send_draft, schedule_draft_send, or manage.",
				},
				{
					name: "source",
					description:
						"Connector or inbox source such as discord, slack, whatsapp, telegram, x, imessage, matrix, line, google-chat, feishu, instagram, wechat, gmail, calendly, or browser_bridge.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Connector or inbox source such as discord, slack, whatsapp, telegram, x, imessage, matrix, line, google-chat, feishu, instagram, wechat, gmail, calendly, or browser_bridge.",
				},
				{
					name: "accountId",
					description:
						"Optional connector account id for multi-account message connectors.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Optional connector account id for multi-account message connectors.",
				},
				{
					name: "sources",
					description:
						"Optional inbox sources for action=triage, list_inbox, or search_inbox.",
					required: false,
					schema: {
						type: "array",
						items: {
							type: "string",
						},
					},
					descriptionCompressed:
						"Optional inbox sources for action=triage, list_inbox, or search_inbox.",
				},
				{
					name: "target",
					description:
						"Loose target reference: user, handle, channel, room, group, server, contact, phone, email, or platform-specific ID.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Loose target reference: user, handle, channel, room, group, server, contact, phone, email, or platform-specific ID.",
				},
				{
					name: "channel",
					description: "Loose channel, room, or group name/reference.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Loose channel, room, or group name/reference.",
				},
				{
					name: "server",
					description:
						"Loose server, guild, workspace, or team name/reference.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Loose server, guild, workspace, or team name/reference.",
				},
				{
					name: "message",
					description:
						"Message text for action=send or replacement text for action=edit.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Message text for action=send or replacement text for action=edit.",
				},
				{
					name: "query",
					description: "Search term for action=search or action=search_inbox.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Search term for action=search or action=search_inbox.",
				},
				{
					name: "content",
					description:
						"Inbox search text or message lookup hint for draft/respond/manage operations.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Inbox search text or message lookup hint for draft/respond/manage operations.",
				},
				{
					name: "sender",
					description:
						"Sender identifier, handle, or display name for inbox search or reply lookup.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Sender identifier, handle, or display name for inbox search or reply lookup.",
				},
				{
					name: "body",
					description:
						"Draft or response body for action=draft_reply, draft_followup, or respond.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Draft or response body for action=draft_reply, draft_followup, or respond.",
				},
				{
					name: "to",
					description: "Recipient identifiers for action=draft_followup.",
					required: false,
					schema: {
						type: "array",
						items: {
							type: "string",
						},
					},
					descriptionCompressed:
						"Recipient identifiers for action=draft_followup.",
				},
				{
					name: "subject",
					description: "Optional subject for email-like draft operations.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Optional subject for email-like draft operations.",
				},
				{
					name: "messageId",
					description:
						"Platform message ID, full message ID, or stored memory ID for react/edit/delete/pin/respond/manage.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Platform message ID, full message ID, or stored memory ID for react/edit/delete/pin/respond/manage.",
				},
				{
					name: "draftId",
					description:
						"Draft identifier for action=send_draft or action=schedule_draft_send.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Draft identifier for action=send_draft or action=schedule_draft_send.",
				},
				{
					name: "confirmed",
					description:
						"Whether the user explicitly confirmed sending for action=send_draft.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed:
						"Whether the user explicitly confirmed sending for action=send_draft.",
				},
				{
					name: "sendAt",
					description: "Scheduled send time for action=schedule_draft_send.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Scheduled send time for action=schedule_draft_send.",
				},
				{
					name: "emoji",
					description: "Reaction value for action=react.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Reaction value for action=react.",
				},
				{
					name: "pin",
					description:
						"Pin state for action=pin. Use false to unpin when supported.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed:
						"Pin state for action=pin. Use false to unpin when supported.",
				},
				{
					name: "manageOperation",
					description:
						"Management action for action=manage, such as archive, trash, spam, mark_read, label_add, label_remove, tag_add, tag_remove, mute_thread, or unsubscribe.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Management action for action=manage, such as archive, trash, spam, mark_read, label_add, label_remove, tag_add, tag_remove, mute_thread, or unsubscribe.",
				},
				{
					name: "label",
					description:
						"Label for action=manage when adding or removing labels.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Label for action=manage when adding or removing labels.",
				},
				{
					name: "tag",
					description: "Tag for action=manage when adding or removing tags.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Tag for action=manage when adding or removing tags.",
				},
				{
					name: "limit",
					description:
						"Maximum number of messages/channels/servers/inbox items to return.",
					required: false,
					schema: {
						type: "integer",
					},
					descriptionCompressed:
						"Maximum number of messages/channels/servers/inbox items to return.",
				},
				{
					name: "cursor",
					description:
						"Opaque pagination cursor for read/search/list operations.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Opaque pagination cursor for read/search/list operations.",
				},
				{
					name: "sinceMs",
					description:
						"Start timestamp in milliseconds for inbox list/search/triage operations.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed:
						"Start timestamp in milliseconds for inbox list/search/triage operations.",
				},
				{
					name: "since",
					description:
						"Start timestamp or parseable date for action=search_inbox.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Start timestamp or parseable date for action=search_inbox.",
				},
				{
					name: "until",
					description:
						"End timestamp or parseable date for action=read_channel range=dates or action=search_inbox.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"End timestamp or parseable date for action=read_channel range=dates or action=search_inbox.",
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
							action: "send",
							source: "telegram",
							target: "dev_guru",
							message: "Hello!",
						},
					},
				},
				{
					user: "Triage my Gmail inbox",
					actions: ["MESSAGE"],
					params: {
						MESSAGE: {
							action: "triage",
							sources: ["gmail"],
						},
					},
				},
			],
			descriptionCompressed:
				"Primary action for addressed messaging surfaces: DMs, group chats, channels, rooms, threads, servers, users, inboxes, drafts, and owner message workflows. Choose action=send, read_channel, read_with_contact, search, list_channels, list_servers, react, edit, delete, pin, join, leave, get_user, triage, list_inbox, search_inbox, draft_reply, draft_followup, respond, send_draft, schedule_draft_send, or manage. Public feed publishing belongs to POST.",
		},
		{
			name: "POST",
			description:
				"Primary action for public feed surfaces and timelines. Choose action=send to publish a post, action=read to fetch recent feed posts, or action=search to search public posts. Addressed DMs, groups, channels, rooms, and inbox/draft workflows belong to MESSAGE.",
			similes: ["TWEET", "CAST", "PUBLISH", "FEED_POST", "TIMELINE"],
			parameters: [
				{
					name: "action",
					description: "Post action: send, read, or search.",
					required: false,
					schema: {
						type: "string",
						enum: ["send", "read", "search"],
					},
					descriptionCompressed: "Post action: send, read, or search.",
				},
				{
					name: "source",
					description:
						"Post connector source such as x, bluesky, farcaster, nostr, or instagram.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Post connector source such as x, bluesky, farcaster, nostr, or instagram.",
				},
				{
					name: "accountId",
					description:
						"Optional connector account id for multi-account post connectors.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Optional connector account id for multi-account post connectors.",
				},
				{
					name: "text",
					description: "Public post text for action=send.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Public post text for action=send.",
				},
				{
					name: "target",
					description:
						"Loose feed target for action=send/read, such as a user, channel, media id, or connector-specific reference.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Loose feed target for action=send/read, such as a user, channel, media id, or connector-specific reference.",
				},
				{
					name: "feed",
					description:
						"Feed convention for action=read, such as home, user, hashtag, channel, or connector-specific feed.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Feed convention for action=read, such as home, user, hashtag, channel, or connector-specific feed.",
				},
				{
					name: "query",
					description: "Search term for action=search.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Search term for action=search.",
				},
				{
					name: "replyTo",
					description: "Post/comment/reply target for action=send.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Post/comment/reply target for action=send.",
				},
				{
					name: "mediaId",
					description:
						"Media id for connector-specific comment surfaces such as Instagram.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Media id for connector-specific comment surfaces such as Instagram.",
				},
				{
					name: "limit",
					description: "Maximum number of posts to return.",
					required: false,
					schema: {
						type: "integer",
					},
					descriptionCompressed: "Maximum number of posts to return.",
				},
				{
					name: "cursor",
					description:
						"Opaque pagination cursor for action=read or action=search.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Opaque pagination cursor for action=read or action=search.",
				},
				{
					name: "attachments",
					description: "Optional post attachments.",
					required: false,
					schema: {
						type: "array",
					},
					descriptionCompressed: "Optional post attachments.",
				},
			],
			examples: [
				[
					{
						name: "{{name1}}",
						content: {
							text: "Post this on X: shipping today",
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
					user: "Post this on X: shipping today",
					actions: ["POST"],
					params: {
						POST: {
							source: "x",
							text: "shipping today",
							action: "send",
						},
					},
				},
			],
			descriptionCompressed:
				"Primary action for public feed surfaces and timelines. Choose action=send to publish a post, action=read to fetch recent feed posts, or action=search to search public posts. Addressed DMs, groups, channels, rooms, and inbox/draft workflows belong to MESSAGE.",
		},
		{
			name: "ROOM",
			description:
				"Manage current room participation state. Use action=follow to opt into a room, action=unfollow to stop following, action=mute to ignore messages unless mentioned, or action=unmute to resume normal room activity.",
			similes: [
				"FOLLOW_ROOM",
				"UNFOLLOW_ROOM",
				"MUTE_ROOM",
				"UNMUTE_ROOM",
				"ROOM_FOLLOW",
				"ROOM_MUTE",
			],
			parameters: [
				{
					name: "action",
					description: "Room operation: follow, unfollow, mute, or unmute.",
					required: true,
					schema: {
						type: "string",
						enum: ["follow", "unfollow", "mute", "unmute"],
					},
					descriptionCompressed:
						"Room operation: follow, unfollow, mute, or unmute.",
				},
				{
					name: "roomId",
					description:
						"Optional target room id. Defaults to the current room when omitted.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Optional target room id. Defaults to the current room when omitted.",
				},
			],
			descriptionCompressed:
				"Manage current room participation state. Use action=follow to opt into a room, action=unfollow to stop following, action=mute to ignore messages unless mentioned, or action=unmute to resume normal room activity.",
		},
		{
			name: "ROLE",
			description:
				"Assign or update trust roles for users. Use action=update with entityId and role when the owner explicitly asks to change permissions.",
			similes: [
				"UPDATE_ROLE",
				"SET_ROLE",
				"CHANGE_ROLE",
				"ASSIGN_ROLE",
				"MAKE_ADMIN",
				"GRANT_ROLE",
			],
			parameters: [
				{
					name: "action",
					description: "Role operation. Currently update.",
					required: false,
					schema: {
						type: "string",
						enum: ["update"],
					},
					descriptionCompressed: "Role operation. Currently update.",
				},
				{
					name: "entityId",
					description: "Entity id whose role should be updated.",
					required: true,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Entity id whose role should be updated.",
				},
				{
					name: "role",
					description: "Role to assign.",
					required: true,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Role to assign.",
				},
			],
			descriptionCompressed:
				"Assign or update trust roles for users. Use action=update with entityId and role when the owner explicitly asks to change permissions.",
		},
		{
			name: "SEARCH_EXPERIENCES",
			description:
				"Search the agent experience store for prior events, decisions, summaries, or memories relevant to the current request.",
			similes: [
				"SEARCH_MEMORY",
				"SEARCH_EXPERIENCE",
				"SEARCH_PRIOR_CONTEXT",
				"FIND_EXPERIENCES",
			],
			parameters: [
				{
					name: "query",
					description: "Search query.",
					required: true,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Search query.",
				},
				{
					name: "limit",
					description: "Maximum number of results to return.",
					required: false,
					schema: {
						type: "integer",
					},
					descriptionCompressed: "Maximum number of results to return.",
				},
			],
			descriptionCompressed:
				"Search the agent experience store for prior events, decisions, summaries, or memories relevant to the current request.",
		},
		{
			name: "CHARACTER",
			description:
				"Manage the agent character profile and identity. Use action=modify for temporary changes, action=persist to save approved changes, or action=update_identity for identity-level updates.",
			similes: [
				"CHARACTER_MODIFY",
				"CHARACTER_PERSIST",
				"CHARACTER_UPDATE_IDENTITY",
				"UPDATE_CHARACTER",
				"EDIT_CHARACTER",
			],
			parameters: [
				{
					name: "action",
					description:
						"Character operation: modify, persist, or update_identity.",
					required: true,
					schema: {
						type: "string",
						enum: ["modify", "persist", "update_identity"],
					},
					descriptionCompressed:
						"Character operation: modify, persist, or update_identity.",
				},
				{
					name: "updates",
					description: "Structured or textual character updates.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Structured or textual character updates.",
				},
			],
			descriptionCompressed:
				"Manage the agent character profile and identity. Use action=modify for temporary changes, action=persist to save approved changes, or action=update_identity for identity-level updates.",
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
					examples: ["aabbccdd-1111-2222-3333-444455556666"],
					descriptionCompressed: "The pending task id.",
				},
				{
					name: "option",
					description: "The selected option name exactly as listed.",
					required: true,
					schema: {
						type: "string",
					},
					examples: ["APPROVE", "ABORT"],
					descriptionCompressed: "The selected option name exactly as listed.",
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
			descriptionCompressed:
				"Select an option for a pending task that has multiple options.",
		},
		{
			name: "ATTACHMENT",
			description:
				"Read current or recent attachments and link previews, or save readable attachment content as a document. Use action=read for extracted text, transcripts, page content, or media descriptions. Use action=save_as_document to store readable attachment content in the document store.",
			similes: [
				"READ_ATTACHMENT",
				"SAVE_ATTACHMENT_AS_DOCUMENT",
				"OPEN_ATTACHMENT",
				"INSPECT_ATTACHMENT",
				"READ_URL",
				"OPEN_URL",
				"READ_WEBPAGE",
			],
			parameters: [
				{
					name: "action",
					description: "Attachment operation: read or save_as_document.",
					required: false,
					schema: {
						type: "string",
						enum: ["read", "save_as_document"],
					},
					examples: ["read", "save_as_document"],
					descriptionCompressed:
						"Attachment operation: read or save_as_document.",
				},
				{
					name: "attachmentId",
					description:
						"Optional attachment ID to read or save. Omit to use the current or most recent attachment.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["attachment-123"],
					descriptionCompressed:
						"Optional attachment ID to read or save. Omit to use the current or most recent attachment.",
				},
				{
					name: "addToClipboard",
					description:
						"When true with action=read, store the attachment content in bounded task clipboard state.",
					required: false,
					schema: {
						type: "boolean",
						default: false,
					},
					examples: [true, false],
					descriptionCompressed:
						"When true with action=read, store the attachment content in bounded task clipboard state.",
				},
				{
					name: "title",
					description:
						"Optional title when saving attachment content as a document.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["Meeting notes"],
					descriptionCompressed:
						"Optional title when saving attachment content as a document.",
				},
			],
			descriptionCompressed:
				"Read current or recent attachments and link previews, or save readable attachment content as a document. Use action=read for extracted text, transcripts, page content, or media descriptions. Use action=save_as_document to store readable attachment content in the document store.",
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
					descriptionCompressed: "The kind of media to generate.",
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
					descriptionCompressed:
						"Detailed generation prompt describing the desired media.",
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
					descriptionCompressed:
						"For audio generation, choose music, sfx, or tts.",
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
					descriptionCompressed:
						"Optional target duration in seconds for video or audio.",
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
					descriptionCompressed:
						"Optional video aspect ratio such as 16:9, 9:16, or 1:1.",
				},
				{
					name: "size",
					description: "Optional image size or image provider size preset.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["1024x1024", "landscape_4_3"],
					descriptionCompressed:
						"Optional image size or image provider size preset.",
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
			descriptionCompressed:
				"Generates media based on a prompt and media type. Use GENERATE_MEDIA when the agent needs to create an image, video, music, sound effect, or speech audio for the user.",
		},
		{
			name: "PAYMENT",
			description:
				"Payment operations. Use action=create_request to create a payment request, deliver_link to send a payment link, verify_payload to verify a provider proof, settle to finalize a payment, await_callback to wait for settlement, and cancel_request to void a pending request.",
			similes: [
				"NEW_PAYMENT_REQUEST",
				"OPEN_PAYMENT_REQUEST",
				"SEND_PAYMENT_LINK",
				"DISPATCH_PAYMENT_LINK",
				"VERIFY_PAYMENT_PROOF",
				"CHECK_PAYMENT_PROOF",
				"FINALIZE_PAYMENT",
				"CONFIRM_PAYMENT",
				"WAIT_FOR_PAYMENT",
				"AWAIT_PAYMENT_SETTLEMENT",
				"VOID_PAYMENT_REQUEST",
				"ABORT_PAYMENT_REQUEST",
			],
			parameters: [
				{
					name: "action",
					description:
						"Payment operation: create_request, deliver_link, verify_payload, settle, await_callback, or cancel_request.",
					required: true,
					schema: {
						type: "string",
						enum: [
							"create_request",
							"deliver_link",
							"verify_payload",
							"settle",
							"await_callback",
							"cancel_request",
						],
					},
					examples: ["create_request", "deliver_link", "settle"],
					descriptionCompressed:
						"Payment operation: create_request, deliver_link, verify_payload, settle, await_callback, or cancel_request.",
				},
				{
					name: "provider",
					description:
						"For action=create_request, provider key: stripe, oxapay, x402, or wallet_native.",
					required: false,
					schema: {
						type: "string",
						enum: ["stripe", "oxapay", "x402", "wallet_native"],
					},
					examples: ["stripe", "wallet_native"],
					descriptionCompressed:
						"For action=create_request, provider key: stripe, oxapay, x402, or wallet_native.",
				},
				{
					name: "amountCents",
					description:
						"For action=create_request, amount in minor currency units.",
					required: false,
					schema: {
						type: "number",
					},
					examples: [500, 1000],
					descriptionCompressed:
						"For action=create_request, amount in minor currency units.",
				},
				{
					name: "currency",
					description: "For action=create_request, ISO 4217 currency.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["USD"],
					descriptionCompressed:
						"For action=create_request, ISO 4217 currency.",
				},
				{
					name: "paymentContext",
					description:
						"For action=create_request, payer constraint. kind can be any_payer, verified_payer, or specific_payer; scope can be one_time, session, or recurring.",
					required: false,
					schema: {
						type: "object",
						properties: {
							kind: {
								type: "string",
								enum: ["any_payer", "verified_payer", "specific_payer"],
							},
							scope: {
								type: "string",
								enum: ["one_time", "session", "recurring"],
							},
							payerIdentityId: {
								type: "string",
							},
						},
					},
					examples: ["any_payer", "specific_payer:identity_123"],
					descriptionCompressed:
						"For action=create_request, payer constraint. kind can be any_payer, verified_payer, or specific_payer; scope can be one_time, session, or recurring.",
				},
				{
					name: "reason",
					description:
						"For action=create_request or cancel_request, payment or cancellation reason.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["Invoice #123"],
					descriptionCompressed:
						"For action=create_request or cancel_request, payment or cancellation reason.",
				},
				{
					name: "expiresInMs",
					description:
						"For action=create_request, optional time-to-live override in milliseconds.",
					required: false,
					schema: {
						type: "number",
					},
					examples: [600000],
					descriptionCompressed:
						"For action=create_request, optional time-to-live override in milliseconds.",
				},
				{
					name: "paymentRequestId",
					description:
						"For deliver_link, verify_payload, settle, await_callback, and cancel_request: payment request ID.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["pay_123"],
					descriptionCompressed:
						"For deliver_link, verify_payload, settle, await_callback, and cancel_request: payment request ID.",
				},
				{
					name: "target",
					description: "For action=deliver_link, delivery channel.",
					required: false,
					schema: {
						type: "string",
						enum: [
							"dm",
							"owner_app_inline",
							"cloud_authenticated_link",
							"tunnel_authenticated_link",
							"public_link",
							"instruct_dm_only",
						],
					},
					examples: ["dm", "public_link"],
					descriptionCompressed: "For action=deliver_link, delivery channel.",
				},
				{
					name: "targetChannelId",
					description:
						"For action=deliver_link, optional delivery channel override.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["room_123"],
					descriptionCompressed:
						"For action=deliver_link, optional delivery channel override.",
				},
				{
					name: "proof",
					description:
						"For action=verify_payload or settle, provider proof payload.",
					required: false,
					schema: {
						type: "object",
					},
					examples: ["stripe:evt_123"],
					descriptionCompressed:
						"For action=verify_payload or settle, provider proof payload.",
				},
				{
					name: "strategy",
					description: "For action=settle, optional settler strategy hint.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["webhook"],
					descriptionCompressed:
						"For action=settle, optional settler strategy hint.",
				},
				{
					name: "timeoutMs",
					description:
						"For action=await_callback, wait timeout in milliseconds. Default is 600000.",
					required: false,
					schema: {
						type: "number",
					},
					examples: [600000],
					descriptionCompressed:
						"For action=await_callback, wait timeout in milliseconds. Default is 600000.",
				},
			],
			examples: [
				[
					{
						name: "{{name1}}",
						content: {
							text: "Create a $10 payment request for the workshop.",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "I'll create that payment request.",
							actions: ["PAYMENT"],
						},
					},
				],
				[
					{
						name: "{{name1}}",
						content: {
							text: "Send the payment link to the payer.",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "I'll deliver the payment link.",
							actions: ["PAYMENT"],
						},
					},
				],
			],
			descriptionCompressed:
				"Payment operations. Use action=create_request to create a payment request, deliver_link to send a payment link, verify_payload to verify a provider proof, settle to finalize a payment, await_callback to wait for settlement, and cancel_request to void a pending request.",
		},
		{
			name: "TRUST",
			description:
				"Trust system control. action=evaluate reads a trust profile for an entity; record_interaction logs a trust-affecting event; request_elevation requests temporary permissions; update_role assigns OWNER / ADMIN / NONE roles within a world.",
			similes: [
				"TRUST_MANAGEMENT",
				"TRUST_OPERATION",
				"TRUST_PROFILE",
				"TRUST_INTERACTION",
				"ELEVATE_PERMISSIONS",
				"ASSIGN_ROLE",
				"CHANGE_ROLE",
				"MAKE_ADMIN",
				"SET_PERMISSIONS",
			],
			parameters: [
				{
					name: "action",
					description:
						"Action: evaluate | record_interaction | request_elevation | update_role.",
					required: true,
					schema: {
						type: "string",
						enum: [
							"evaluate",
							"record_interaction",
							"request_elevation",
							"update_role",
						],
					},
					descriptionCompressed:
						"Action: evaluate | record_interaction | request_elevation | update_role.",
				},
				{
					name: "entityId",
					description:
						"Target entity ID. evaluate: defaults to sender. record_interaction: target of the interaction (defaults to agent).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Target entity ID. evaluate: defaults to sender. record_interaction: target of the interaction (defaults to agent).",
				},
				{
					name: "entityName",
					description:
						"Optional target entity name (evaluate). Name-only lookups return a bounded failure; provide entityId where possible.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Optional target entity name (evaluate). Name-only lookups return a bounded failure; provide entityId where possible.",
				},
				{
					name: "detailed",
					description:
						"Whether evaluate should return detailed dimensions (default false).",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed:
						"Whether evaluate should return detailed dimensions (default false).",
				},
				{
					name: "type",
					description: "Trust evidence type (record_interaction).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Trust evidence type (record_interaction).",
				},
				{
					name: "impact",
					description:
						"Numerical trust impact (record_interaction). Default 10.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed:
						"Numerical trust impact (record_interaction). Default 10.",
				},
				{
					name: "description",
					description: "Optional interaction description (record_interaction).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Optional interaction description (record_interaction).",
				},
				{
					name: "permissionAction",
					description: "Permission action being requested (request_elevation).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Permission action being requested (request_elevation).",
				},
				{
					name: "resource",
					description: "Resource scope for elevation (request_elevation).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Resource scope for elevation (request_elevation).",
				},
				{
					name: "justification",
					description: "Reason elevation is needed (request_elevation).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Reason elevation is needed (request_elevation).",
				},
				{
					name: "duration",
					description:
						"Requested duration in hours (request_elevation). Defaults to 60.",
					required: false,
					schema: {
						type: "number",
						minimum: 1,
						maximum: 168,
					},
					descriptionCompressed:
						"Requested duration in hours (request_elevation). Defaults to 60.",
				},
				{
					name: "roleAssignments",
					description: "Role assignments (update_role).",
					required: false,
					schema: {
						type: "array",
						items: {
							type: "object",
							properties: {
								entityId: {
									type: "string",
								},
								newRole: {
									type: "string",
									enum: ["OWNER", "ADMIN", "NONE"],
								},
							},
						},
					},
					descriptionCompressed: "Role assignments (update_role).",
				},
			],
			examples: [
				[
					{
						name: "{{name1}}",
						content: {
							text: "What is my trust score?",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "Trust Level: Good (65/100) based on 42 interactions",
							actions: ["TRUST"],
						},
					},
				],
				[
					{
						name: "{{name1}}",
						content: {
							text: "Record that Alice kept their promise to help with the project",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "Trust interaction recorded: PROMISE_KEPT with impact +15",
							actions: ["TRUST"],
						},
					},
				],
				[
					{
						name: "{{name1}}",
						content: {
							text: "I need permission to manage roles to help moderate spam",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "Elevation approved! You have been granted temporary manage_roles permissions.",
							actions: ["TRUST"],
						},
					},
				],
				[
					{
						name: "{{name1}}",
						content: {
							text: "Make {{name2}} an ADMIN",
						},
					},
					{
						name: "{{name3}}",
						content: {
							text: "Updated {{name2}}'s role to ADMIN.",
							actions: ["TRUST"],
						},
					},
				],
			],
			descriptionCompressed:
				"Trust system control. action=evaluate reads a trust profile for an entity; record_interaction logs a trust-affecting event; request_elevation requests temporary permissions; update_role assigns OWNER / ADMIN / NONE roles within a world.",
		},
	],
} as const satisfies { version: string; actions: readonly ActionDoc[] };
export const allActionsSpec = {
	version: "1.0.0",
	actions: [
		{
			name: "REPLY",
			description:
				"Send a direct chat reply in the current conversation/thread. Default if the agent is responding with a message and no other action. Use REPLY at the beginning of a chain of actions as an acknowledgement, and at the end of a chain of actions as a final response. Do NOT use REPLY to send to a different channel/person or to run an email/inbox workflow — use MESSAGE (action=send) for a directed send to another channel or DM, MESSAGE inbox operations for triage/drafts, and POST to publish to a public feed.",
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
				"Send a direct chat reply in the current conversation/thread. Default if the agent is responding with a message and no other action. Use REPLY at the beginning of a chain of actions as an acknowledgement, and at the end of a chain of actions as a final response. Do NOT use REPLY to send to a different channel/person or to run an email/inbox workflow — use MESSAGE (action=send) for a directed send to another channel or DM, MESSAGE inbox operations for triage/drafts, and POST to publish to a public feed.",
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
							text: "Leave me alone",
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
							text: "Stop talking, bot",
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
							text: "send me something inappropriate",
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
				"Call this action if ignoring the user. If the user is aggressive, creepy or is finished with the conversation, use this action. In group conversations, use IGNORE when the latest message is addressed to someone else and not to the agent. Or, if both you and the user have already said goodbye, use this action instead of saying bye again. Use IGNORE any time the conversation has naturally ended. Do not use IGNORE if the user has engaged directly, or if something went wrong and you need to tell them. Only ignore if the user should be ignored.",
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
							text: "Yes, probably.",
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
							text: "Why don't scientists trust atoms? Because they make up everything.",
							actions: ["NONE"],
						},
					},
				],
			],
			descriptionCompressed:
				"Respond but perform no additional action. This is the default if the agent is speaking and not doing anything additional.",
		},
		{
			name: "MESSAGE",
			description:
				"Primary action for addressed messaging surfaces: DMs, group chats, channels, rooms, threads, servers, users, inboxes, drafts, and owner message workflows. Choose action=send, read_channel, read_with_contact, search, list_channels, list_servers, react, edit, delete, pin, join, leave, get_user, triage, list_inbox, search_inbox, draft_reply, draft_followup, respond, send_draft, schedule_draft_send, or manage. Public feed publishing belongs to POST.",
			similes: ["DM", "DIRECT_MESSAGE", "CHAT", "CHANNEL", "ROOM"],
			parameters: [
				{
					name: "action",
					description:
						"Message action: send, read_channel, read_with_contact, search, list_channels, list_servers, react, edit, delete, pin, join, leave, get_user, triage, list_inbox, search_inbox, draft_reply, draft_followup, respond, send_draft, schedule_draft_send, or manage.",
					required: false,
					schema: {
						type: "string",
						enum: [
							"send",
							"read_channel",
							"read_with_contact",
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
							"triage",
							"list_inbox",
							"search_inbox",
							"draft_reply",
							"draft_followup",
							"respond",
							"send_draft",
							"schedule_draft_send",
							"manage",
						],
					},
					descriptionCompressed:
						"Message action: send, read_channel, read_with_contact, search, list_channels, list_servers, react, edit, delete, pin, join, leave, get_user, triage, list_inbox, search_inbox, draft_reply, draft_followup, respond, send_draft, schedule_draft_send, or manage.",
				},
				{
					name: "source",
					description:
						"Connector or inbox source such as discord, slack, whatsapp, telegram, x, imessage, matrix, line, google-chat, feishu, instagram, wechat, gmail, calendly, or browser_bridge.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Connector or inbox source such as discord, slack, whatsapp, telegram, x, imessage, matrix, line, google-chat, feishu, instagram, wechat, gmail, calendly, or browser_bridge.",
				},
				{
					name: "accountId",
					description:
						"Optional connector account id for multi-account message connectors.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Optional connector account id for multi-account message connectors.",
				},
				{
					name: "sources",
					description:
						"Optional inbox sources for action=triage, list_inbox, or search_inbox.",
					required: false,
					schema: {
						type: "array",
						items: {
							type: "string",
						},
					},
					descriptionCompressed:
						"Optional inbox sources for action=triage, list_inbox, or search_inbox.",
				},
				{
					name: "target",
					description:
						"Loose target reference: user, handle, channel, room, group, server, contact, phone, email, or platform-specific ID.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Loose target reference: user, handle, channel, room, group, server, contact, phone, email, or platform-specific ID.",
				},
				{
					name: "channel",
					description: "Loose channel, room, or group name/reference.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Loose channel, room, or group name/reference.",
				},
				{
					name: "server",
					description:
						"Loose server, guild, workspace, or team name/reference.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Loose server, guild, workspace, or team name/reference.",
				},
				{
					name: "message",
					description:
						"Message text for action=send or replacement text for action=edit.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Message text for action=send or replacement text for action=edit.",
				},
				{
					name: "query",
					description: "Search term for action=search or action=search_inbox.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Search term for action=search or action=search_inbox.",
				},
				{
					name: "content",
					description:
						"Inbox search text or message lookup hint for draft/respond/manage operations.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Inbox search text or message lookup hint for draft/respond/manage operations.",
				},
				{
					name: "sender",
					description:
						"Sender identifier, handle, or display name for inbox search or reply lookup.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Sender identifier, handle, or display name for inbox search or reply lookup.",
				},
				{
					name: "body",
					description:
						"Draft or response body for action=draft_reply, draft_followup, or respond.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Draft or response body for action=draft_reply, draft_followup, or respond.",
				},
				{
					name: "to",
					description: "Recipient identifiers for action=draft_followup.",
					required: false,
					schema: {
						type: "array",
						items: {
							type: "string",
						},
					},
					descriptionCompressed:
						"Recipient identifiers for action=draft_followup.",
				},
				{
					name: "subject",
					description: "Optional subject for email-like draft operations.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Optional subject for email-like draft operations.",
				},
				{
					name: "messageId",
					description:
						"Platform message ID, full message ID, or stored memory ID for react/edit/delete/pin/respond/manage.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Platform message ID, full message ID, or stored memory ID for react/edit/delete/pin/respond/manage.",
				},
				{
					name: "draftId",
					description:
						"Draft identifier for action=send_draft or action=schedule_draft_send.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Draft identifier for action=send_draft or action=schedule_draft_send.",
				},
				{
					name: "confirmed",
					description:
						"Whether the user explicitly confirmed sending for action=send_draft.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed:
						"Whether the user explicitly confirmed sending for action=send_draft.",
				},
				{
					name: "sendAt",
					description: "Scheduled send time for action=schedule_draft_send.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Scheduled send time for action=schedule_draft_send.",
				},
				{
					name: "emoji",
					description: "Reaction value for action=react.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Reaction value for action=react.",
				},
				{
					name: "pin",
					description:
						"Pin state for action=pin. Use false to unpin when supported.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed:
						"Pin state for action=pin. Use false to unpin when supported.",
				},
				{
					name: "manageOperation",
					description:
						"Management action for action=manage, such as archive, trash, spam, mark_read, label_add, label_remove, tag_add, tag_remove, mute_thread, or unsubscribe.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Management action for action=manage, such as archive, trash, spam, mark_read, label_add, label_remove, tag_add, tag_remove, mute_thread, or unsubscribe.",
				},
				{
					name: "label",
					description:
						"Label for action=manage when adding or removing labels.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Label for action=manage when adding or removing labels.",
				},
				{
					name: "tag",
					description: "Tag for action=manage when adding or removing tags.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Tag for action=manage when adding or removing tags.",
				},
				{
					name: "limit",
					description:
						"Maximum number of messages/channels/servers/inbox items to return.",
					required: false,
					schema: {
						type: "integer",
					},
					descriptionCompressed:
						"Maximum number of messages/channels/servers/inbox items to return.",
				},
				{
					name: "cursor",
					description:
						"Opaque pagination cursor for read/search/list operations.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Opaque pagination cursor for read/search/list operations.",
				},
				{
					name: "sinceMs",
					description:
						"Start timestamp in milliseconds for inbox list/search/triage operations.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed:
						"Start timestamp in milliseconds for inbox list/search/triage operations.",
				},
				{
					name: "since",
					description:
						"Start timestamp or parseable date for action=search_inbox.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Start timestamp or parseable date for action=search_inbox.",
				},
				{
					name: "until",
					description:
						"End timestamp or parseable date for action=read_channel range=dates or action=search_inbox.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"End timestamp or parseable date for action=read_channel range=dates or action=search_inbox.",
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
							action: "send",
							source: "telegram",
							target: "dev_guru",
							message: "Hello!",
						},
					},
				},
				{
					user: "Triage my Gmail inbox",
					actions: ["MESSAGE"],
					params: {
						MESSAGE: {
							action: "triage",
							sources: ["gmail"],
						},
					},
				},
			],
			descriptionCompressed:
				"Primary action for addressed messaging surfaces: DMs, group chats, channels, rooms, threads, servers, users, inboxes, drafts, and owner message workflows. Choose action=send, read_channel, read_with_contact, search, list_channels, list_servers, react, edit, delete, pin, join, leave, get_user, triage, list_inbox, search_inbox, draft_reply, draft_followup, respond, send_draft, schedule_draft_send, or manage. Public feed publishing belongs to POST.",
		},
		{
			name: "POST",
			description:
				"Primary action for public feed surfaces and timelines. Choose action=send to publish a post, action=read to fetch recent feed posts, or action=search to search public posts. Addressed DMs, groups, channels, rooms, and inbox/draft workflows belong to MESSAGE.",
			similes: ["TWEET", "CAST", "PUBLISH", "FEED_POST", "TIMELINE"],
			parameters: [
				{
					name: "action",
					description: "Post action: send, read, or search.",
					required: false,
					schema: {
						type: "string",
						enum: ["send", "read", "search"],
					},
					descriptionCompressed: "Post action: send, read, or search.",
				},
				{
					name: "source",
					description:
						"Post connector source such as x, bluesky, farcaster, nostr, or instagram.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Post connector source such as x, bluesky, farcaster, nostr, or instagram.",
				},
				{
					name: "accountId",
					description:
						"Optional connector account id for multi-account post connectors.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Optional connector account id for multi-account post connectors.",
				},
				{
					name: "text",
					description: "Public post text for action=send.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Public post text for action=send.",
				},
				{
					name: "target",
					description:
						"Loose feed target for action=send/read, such as a user, channel, media id, or connector-specific reference.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Loose feed target for action=send/read, such as a user, channel, media id, or connector-specific reference.",
				},
				{
					name: "feed",
					description:
						"Feed convention for action=read, such as home, user, hashtag, channel, or connector-specific feed.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Feed convention for action=read, such as home, user, hashtag, channel, or connector-specific feed.",
				},
				{
					name: "query",
					description: "Search term for action=search.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Search term for action=search.",
				},
				{
					name: "replyTo",
					description: "Post/comment/reply target for action=send.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Post/comment/reply target for action=send.",
				},
				{
					name: "mediaId",
					description:
						"Media id for connector-specific comment surfaces such as Instagram.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Media id for connector-specific comment surfaces such as Instagram.",
				},
				{
					name: "limit",
					description: "Maximum number of posts to return.",
					required: false,
					schema: {
						type: "integer",
					},
					descriptionCompressed: "Maximum number of posts to return.",
				},
				{
					name: "cursor",
					description:
						"Opaque pagination cursor for action=read or action=search.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Opaque pagination cursor for action=read or action=search.",
				},
				{
					name: "attachments",
					description: "Optional post attachments.",
					required: false,
					schema: {
						type: "array",
					},
					descriptionCompressed: "Optional post attachments.",
				},
			],
			examples: [
				[
					{
						name: "{{name1}}",
						content: {
							text: "Post this on X: shipping today",
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
					user: "Post this on X: shipping today",
					actions: ["POST"],
					params: {
						POST: {
							source: "x",
							text: "shipping today",
							action: "send",
						},
					},
				},
			],
			descriptionCompressed:
				"Primary action for public feed surfaces and timelines. Choose action=send to publish a post, action=read to fetch recent feed posts, or action=search to search public posts. Addressed DMs, groups, channels, rooms, and inbox/draft workflows belong to MESSAGE.",
		},
		{
			name: "ROOM",
			description:
				"Manage current room participation state. Use action=follow to opt into a room, action=unfollow to stop following, action=mute to ignore messages unless mentioned, or action=unmute to resume normal room activity.",
			similes: [
				"FOLLOW_ROOM",
				"UNFOLLOW_ROOM",
				"MUTE_ROOM",
				"UNMUTE_ROOM",
				"ROOM_FOLLOW",
				"ROOM_MUTE",
			],
			parameters: [
				{
					name: "action",
					description: "Room operation: follow, unfollow, mute, or unmute.",
					required: true,
					schema: {
						type: "string",
						enum: ["follow", "unfollow", "mute", "unmute"],
					},
					descriptionCompressed:
						"Room operation: follow, unfollow, mute, or unmute.",
				},
				{
					name: "roomId",
					description:
						"Optional target room id. Defaults to the current room when omitted.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Optional target room id. Defaults to the current room when omitted.",
				},
			],
			descriptionCompressed:
				"Manage current room participation state. Use action=follow to opt into a room, action=unfollow to stop following, action=mute to ignore messages unless mentioned, or action=unmute to resume normal room activity.",
		},
		{
			name: "ROLE",
			description:
				"Assign or update trust roles for users. Use action=update with entityId and role when the owner explicitly asks to change permissions.",
			similes: [
				"UPDATE_ROLE",
				"SET_ROLE",
				"CHANGE_ROLE",
				"ASSIGN_ROLE",
				"MAKE_ADMIN",
				"GRANT_ROLE",
			],
			parameters: [
				{
					name: "action",
					description: "Role operation. Currently update.",
					required: false,
					schema: {
						type: "string",
						enum: ["update"],
					},
					descriptionCompressed: "Role operation. Currently update.",
				},
				{
					name: "entityId",
					description: "Entity id whose role should be updated.",
					required: true,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Entity id whose role should be updated.",
				},
				{
					name: "role",
					description: "Role to assign.",
					required: true,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Role to assign.",
				},
			],
			descriptionCompressed:
				"Assign or update trust roles for users. Use action=update with entityId and role when the owner explicitly asks to change permissions.",
		},
		{
			name: "SEARCH_EXPERIENCES",
			description:
				"Search the agent experience store for prior events, decisions, summaries, or memories relevant to the current request.",
			similes: [
				"SEARCH_MEMORY",
				"SEARCH_EXPERIENCE",
				"SEARCH_PRIOR_CONTEXT",
				"FIND_EXPERIENCES",
			],
			parameters: [
				{
					name: "query",
					description: "Search query.",
					required: true,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Search query.",
				},
				{
					name: "limit",
					description: "Maximum number of results to return.",
					required: false,
					schema: {
						type: "integer",
					},
					descriptionCompressed: "Maximum number of results to return.",
				},
			],
			descriptionCompressed:
				"Search the agent experience store for prior events, decisions, summaries, or memories relevant to the current request.",
		},
		{
			name: "CHARACTER",
			description:
				"Manage the agent character profile and identity. Use action=modify for temporary changes, action=persist to save approved changes, or action=update_identity for identity-level updates.",
			similes: [
				"CHARACTER_MODIFY",
				"CHARACTER_PERSIST",
				"CHARACTER_UPDATE_IDENTITY",
				"UPDATE_CHARACTER",
				"EDIT_CHARACTER",
			],
			parameters: [
				{
					name: "action",
					description:
						"Character operation: modify, persist, or update_identity.",
					required: true,
					schema: {
						type: "string",
						enum: ["modify", "persist", "update_identity"],
					},
					descriptionCompressed:
						"Character operation: modify, persist, or update_identity.",
				},
				{
					name: "updates",
					description: "Structured or textual character updates.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Structured or textual character updates.",
				},
			],
			descriptionCompressed:
				"Manage the agent character profile and identity. Use action=modify for temporary changes, action=persist to save approved changes, or action=update_identity for identity-level updates.",
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
					examples: ["aabbccdd-1111-2222-3333-444455556666"],
					descriptionCompressed: "The pending task id.",
				},
				{
					name: "option",
					description: "The selected option name exactly as listed.",
					required: true,
					schema: {
						type: "string",
					},
					examples: ["APPROVE", "ABORT"],
					descriptionCompressed: "The selected option name exactly as listed.",
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
			descriptionCompressed:
				"Select an option for a pending task that has multiple options.",
		},
		{
			name: "ATTACHMENT",
			description:
				"Read current or recent attachments and link previews, or save readable attachment content as a document. Use action=read for extracted text, transcripts, page content, or media descriptions. Use action=save_as_document to store readable attachment content in the document store.",
			similes: [
				"READ_ATTACHMENT",
				"SAVE_ATTACHMENT_AS_DOCUMENT",
				"OPEN_ATTACHMENT",
				"INSPECT_ATTACHMENT",
				"READ_URL",
				"OPEN_URL",
				"READ_WEBPAGE",
			],
			parameters: [
				{
					name: "action",
					description: "Attachment operation: read or save_as_document.",
					required: false,
					schema: {
						type: "string",
						enum: ["read", "save_as_document"],
					},
					examples: ["read", "save_as_document"],
					descriptionCompressed:
						"Attachment operation: read or save_as_document.",
				},
				{
					name: "attachmentId",
					description:
						"Optional attachment ID to read or save. Omit to use the current or most recent attachment.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["attachment-123"],
					descriptionCompressed:
						"Optional attachment ID to read or save. Omit to use the current or most recent attachment.",
				},
				{
					name: "addToClipboard",
					description:
						"When true with action=read, store the attachment content in bounded task clipboard state.",
					required: false,
					schema: {
						type: "boolean",
						default: false,
					},
					examples: [true, false],
					descriptionCompressed:
						"When true with action=read, store the attachment content in bounded task clipboard state.",
				},
				{
					name: "title",
					description:
						"Optional title when saving attachment content as a document.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["Meeting notes"],
					descriptionCompressed:
						"Optional title when saving attachment content as a document.",
				},
			],
			descriptionCompressed:
				"Read current or recent attachments and link previews, or save readable attachment content as a document. Use action=read for extracted text, transcripts, page content, or media descriptions. Use action=save_as_document to store readable attachment content in the document store.",
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
					descriptionCompressed: "The kind of media to generate.",
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
					descriptionCompressed:
						"Detailed generation prompt describing the desired media.",
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
					descriptionCompressed:
						"For audio generation, choose music, sfx, or tts.",
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
					descriptionCompressed:
						"Optional target duration in seconds for video or audio.",
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
					descriptionCompressed:
						"Optional video aspect ratio such as 16:9, 9:16, or 1:1.",
				},
				{
					name: "size",
					description: "Optional image size or image provider size preset.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["1024x1024", "landscape_4_3"],
					descriptionCompressed:
						"Optional image size or image provider size preset.",
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
			descriptionCompressed:
				"Generates media based on a prompt and media type. Use GENERATE_MEDIA when the agent needs to create an image, video, music, sound effect, or speech audio for the user.",
		},
		{
			name: "PAYMENT",
			description:
				"Payment operations. Use action=create_request to create a payment request, deliver_link to send a payment link, verify_payload to verify a provider proof, settle to finalize a payment, await_callback to wait for settlement, and cancel_request to void a pending request.",
			similes: [
				"NEW_PAYMENT_REQUEST",
				"OPEN_PAYMENT_REQUEST",
				"SEND_PAYMENT_LINK",
				"DISPATCH_PAYMENT_LINK",
				"VERIFY_PAYMENT_PROOF",
				"CHECK_PAYMENT_PROOF",
				"FINALIZE_PAYMENT",
				"CONFIRM_PAYMENT",
				"WAIT_FOR_PAYMENT",
				"AWAIT_PAYMENT_SETTLEMENT",
				"VOID_PAYMENT_REQUEST",
				"ABORT_PAYMENT_REQUEST",
			],
			parameters: [
				{
					name: "action",
					description:
						"Payment operation: create_request, deliver_link, verify_payload, settle, await_callback, or cancel_request.",
					required: true,
					schema: {
						type: "string",
						enum: [
							"create_request",
							"deliver_link",
							"verify_payload",
							"settle",
							"await_callback",
							"cancel_request",
						],
					},
					examples: ["create_request", "deliver_link", "settle"],
					descriptionCompressed:
						"Payment operation: create_request, deliver_link, verify_payload, settle, await_callback, or cancel_request.",
				},
				{
					name: "provider",
					description:
						"For action=create_request, provider key: stripe, oxapay, x402, or wallet_native.",
					required: false,
					schema: {
						type: "string",
						enum: ["stripe", "oxapay", "x402", "wallet_native"],
					},
					examples: ["stripe", "wallet_native"],
					descriptionCompressed:
						"For action=create_request, provider key: stripe, oxapay, x402, or wallet_native.",
				},
				{
					name: "amountCents",
					description:
						"For action=create_request, amount in minor currency units.",
					required: false,
					schema: {
						type: "number",
					},
					examples: [500, 1000],
					descriptionCompressed:
						"For action=create_request, amount in minor currency units.",
				},
				{
					name: "currency",
					description: "For action=create_request, ISO 4217 currency.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["USD"],
					descriptionCompressed:
						"For action=create_request, ISO 4217 currency.",
				},
				{
					name: "paymentContext",
					description:
						"For action=create_request, payer constraint. kind can be any_payer, verified_payer, or specific_payer; scope can be one_time, session, or recurring.",
					required: false,
					schema: {
						type: "object",
						properties: {
							kind: {
								type: "string",
								enum: ["any_payer", "verified_payer", "specific_payer"],
							},
							scope: {
								type: "string",
								enum: ["one_time", "session", "recurring"],
							},
							payerIdentityId: {
								type: "string",
							},
						},
					},
					examples: ["any_payer", "specific_payer:identity_123"],
					descriptionCompressed:
						"For action=create_request, payer constraint. kind can be any_payer, verified_payer, or specific_payer; scope can be one_time, session, or recurring.",
				},
				{
					name: "reason",
					description:
						"For action=create_request or cancel_request, payment or cancellation reason.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["Invoice #123"],
					descriptionCompressed:
						"For action=create_request or cancel_request, payment or cancellation reason.",
				},
				{
					name: "expiresInMs",
					description:
						"For action=create_request, optional time-to-live override in milliseconds.",
					required: false,
					schema: {
						type: "number",
					},
					examples: [600000],
					descriptionCompressed:
						"For action=create_request, optional time-to-live override in milliseconds.",
				},
				{
					name: "paymentRequestId",
					description:
						"For deliver_link, verify_payload, settle, await_callback, and cancel_request: payment request ID.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["pay_123"],
					descriptionCompressed:
						"For deliver_link, verify_payload, settle, await_callback, and cancel_request: payment request ID.",
				},
				{
					name: "target",
					description: "For action=deliver_link, delivery channel.",
					required: false,
					schema: {
						type: "string",
						enum: [
							"dm",
							"owner_app_inline",
							"cloud_authenticated_link",
							"tunnel_authenticated_link",
							"public_link",
							"instruct_dm_only",
						],
					},
					examples: ["dm", "public_link"],
					descriptionCompressed: "For action=deliver_link, delivery channel.",
				},
				{
					name: "targetChannelId",
					description:
						"For action=deliver_link, optional delivery channel override.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["room_123"],
					descriptionCompressed:
						"For action=deliver_link, optional delivery channel override.",
				},
				{
					name: "proof",
					description:
						"For action=verify_payload or settle, provider proof payload.",
					required: false,
					schema: {
						type: "object",
					},
					examples: ["stripe:evt_123"],
					descriptionCompressed:
						"For action=verify_payload or settle, provider proof payload.",
				},
				{
					name: "strategy",
					description: "For action=settle, optional settler strategy hint.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["webhook"],
					descriptionCompressed:
						"For action=settle, optional settler strategy hint.",
				},
				{
					name: "timeoutMs",
					description:
						"For action=await_callback, wait timeout in milliseconds. Default is 600000.",
					required: false,
					schema: {
						type: "number",
					},
					examples: [600000],
					descriptionCompressed:
						"For action=await_callback, wait timeout in milliseconds. Default is 600000.",
				},
			],
			examples: [
				[
					{
						name: "{{name1}}",
						content: {
							text: "Create a $10 payment request for the workshop.",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "I'll create that payment request.",
							actions: ["PAYMENT"],
						},
					},
				],
				[
					{
						name: "{{name1}}",
						content: {
							text: "Send the payment link to the payer.",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "I'll deliver the payment link.",
							actions: ["PAYMENT"],
						},
					},
				],
			],
			descriptionCompressed:
				"Payment operations. Use action=create_request to create a payment request, deliver_link to send a payment link, verify_payload to verify a provider proof, settle to finalize a payment, await_callback to wait for settlement, and cancel_request to void a pending request.",
		},
		{
			name: "TRUST",
			description:
				"Trust system control. action=evaluate reads a trust profile for an entity; record_interaction logs a trust-affecting event; request_elevation requests temporary permissions; update_role assigns OWNER / ADMIN / NONE roles within a world.",
			similes: [
				"TRUST_MANAGEMENT",
				"TRUST_OPERATION",
				"TRUST_PROFILE",
				"TRUST_INTERACTION",
				"ELEVATE_PERMISSIONS",
				"ASSIGN_ROLE",
				"CHANGE_ROLE",
				"MAKE_ADMIN",
				"SET_PERMISSIONS",
			],
			parameters: [
				{
					name: "action",
					description:
						"Action: evaluate | record_interaction | request_elevation | update_role.",
					required: true,
					schema: {
						type: "string",
						enum: [
							"evaluate",
							"record_interaction",
							"request_elevation",
							"update_role",
						],
					},
					descriptionCompressed:
						"Action: evaluate | record_interaction | request_elevation | update_role.",
				},
				{
					name: "entityId",
					description:
						"Target entity ID. evaluate: defaults to sender. record_interaction: target of the interaction (defaults to agent).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Target entity ID. evaluate: defaults to sender. record_interaction: target of the interaction (defaults to agent).",
				},
				{
					name: "entityName",
					description:
						"Optional target entity name (evaluate). Name-only lookups return a bounded failure; provide entityId where possible.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Optional target entity name (evaluate). Name-only lookups return a bounded failure; provide entityId where possible.",
				},
				{
					name: "detailed",
					description:
						"Whether evaluate should return detailed dimensions (default false).",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed:
						"Whether evaluate should return detailed dimensions (default false).",
				},
				{
					name: "type",
					description: "Trust evidence type (record_interaction).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Trust evidence type (record_interaction).",
				},
				{
					name: "impact",
					description:
						"Numerical trust impact (record_interaction). Default 10.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed:
						"Numerical trust impact (record_interaction). Default 10.",
				},
				{
					name: "description",
					description: "Optional interaction description (record_interaction).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Optional interaction description (record_interaction).",
				},
				{
					name: "permissionAction",
					description: "Permission action being requested (request_elevation).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Permission action being requested (request_elevation).",
				},
				{
					name: "resource",
					description: "Resource scope for elevation (request_elevation).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Resource scope for elevation (request_elevation).",
				},
				{
					name: "justification",
					description: "Reason elevation is needed (request_elevation).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Reason elevation is needed (request_elevation).",
				},
				{
					name: "duration",
					description:
						"Requested duration in hours (request_elevation). Defaults to 60.",
					required: false,
					schema: {
						type: "number",
						minimum: 1,
						maximum: 168,
					},
					descriptionCompressed:
						"Requested duration in hours (request_elevation). Defaults to 60.",
				},
				{
					name: "roleAssignments",
					description: "Role assignments (update_role).",
					required: false,
					schema: {
						type: "array",
						items: {
							type: "object",
							properties: {
								entityId: {
									type: "string",
								},
								newRole: {
									type: "string",
									enum: ["OWNER", "ADMIN", "NONE"],
								},
							},
						},
					},
					descriptionCompressed: "Role assignments (update_role).",
				},
			],
			examples: [
				[
					{
						name: "{{name1}}",
						content: {
							text: "What is my trust score?",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "Trust Level: Good (65/100) based on 42 interactions",
							actions: ["TRUST"],
						},
					},
				],
				[
					{
						name: "{{name1}}",
						content: {
							text: "Record that Alice kept their promise to help with the project",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "Trust interaction recorded: PROMISE_KEPT with impact +15",
							actions: ["TRUST"],
						},
					},
				],
				[
					{
						name: "{{name1}}",
						content: {
							text: "I need permission to manage roles to help moderate spam",
						},
					},
					{
						name: "{{name2}}",
						content: {
							text: "Elevation approved! You have been granted temporary manage_roles permissions.",
							actions: ["TRUST"],
						},
					},
				],
				[
					{
						name: "{{name1}}",
						content: {
							text: "Make {{name2}} an ADMIN",
						},
					},
					{
						name: "{{name3}}",
						content: {
							text: "Updated {{name2}}'s role to ADMIN.",
							actions: ["TRUST"],
						},
					},
				],
			],
			descriptionCompressed:
				"Trust system control. action=evaluate reads a trust profile for an entity; record_interaction logs a trust-affecting event; request_elevation requests temporary permissions; update_role assigns OWNER / ADMIN / NONE roles within a world.",
		},
		{
			name: "ACCOUNTS_COMMAND",
			description: "View provider accounts and usage, or manage them",
			parameters: [
				{
					name: "action",
					description:
						"use, enable, disable, strategy, refresh — omit for the report",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"use, enable, disable, strategy, refresh — omit for the report",
				},
				{
					name: "provider",
					description: "claude, codex, cerebras, or a full provider id",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"claude, codex, cerebras, or a full provider id",
				},
				{
					name: "value",
					description:
						"account by id, label, or email — or the strategy name for `strategy`",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"account by id, label, or email — or the strategy name for `strategy`",
				},
			],
			similes: ["/accounts"],
			descriptionCompressed: "View provider accounts and usage, or manage them",
		},
		{
			name: "BACKEND_COMMAND",
			description: "Show or set the default coding backend",
			parameters: [
				{
					name: "backend",
					description: "default coding backend for new tasks",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "default coding backend for new tasks",
				},
			],
			similes: ["/backend"],
			descriptionCompressed: "Show or set the default coding backend",
		},
		{
			name: "CONTEXT_COMMAND",
			description: "Show current context information",
			parameters: [
				{
					name: "mode",
					description: "Output mode (list, detail, json)",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Output mode (list, detail, json)",
				},
			],
			similes: ["/context", "/ctx"],
			descriptionCompressed: "Show current context information",
		},
		{
			name: "ELEVATED_COMMAND",
			description: "Set elevated permission mode",
			parameters: [
				{
					name: "level",
					description: "off, on, ask, full",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "off, on, ask, full",
				},
			],
			similes: ["/elevated", "/elev"],
			descriptionCompressed: "Set elevated permission mode",
		},
		{
			name: "MODEL_COMMAND",
			description: "Set or show current model",
			parameters: [
				{
					name: "target",
					description:
						"small, large, coding, show, local, cloud — or a model for this room",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"small, large, coding, show, local, cloud — or a model for this room",
				},
				{
					name: "model",
					description:
						"model id — for coding, the backend (codex, claude, eliza)",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"model id — for coding, the backend (codex, claude, eliza)",
				},
				{
					name: "effort",
					description: "reasoning effort — for coding, the model id",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "reasoning effort — for coding, the model id",
				},
				{
					name: "coding-effort",
					description: "reasoning effort (coding target)",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "reasoning effort (coding target)",
				},
			],
			similes: ["/model", "/m"],
			descriptionCompressed: "Set or show current model",
		},
		{
			name: "QUEUE_COMMAND",
			description: "Set queue mode",
			parameters: [
				{
					name: "mode",
					description: "steer, followup, collect, interrupt, or options",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"steer, followup, collect, interrupt, or options",
				},
			],
			similes: ["/queue", "/q"],
			descriptionCompressed: "Set queue mode",
		},
		{
			name: "REASONING_COMMAND",
			description: "Set reasoning visibility",
			parameters: [
				{
					name: "level",
					description: "off, on, stream",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "off, on, stream",
				},
			],
			similes: ["/reasoning", "/reason"],
			descriptionCompressed: "Set reasoning visibility",
		},
		{
			name: "THINK_COMMAND",
			description: "Set thinking level",
			parameters: [
				{
					name: "level",
					description: "off, minimal, low, medium, high, xhigh",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "off, minimal, low, medium, high, xhigh",
				},
			],
			similes: ["/think", "/thinking", "/t"],
			descriptionCompressed: "Set thinking level",
		},
		{
			name: "TTS_COMMAND",
			description: "Text-to-speech settings",
			parameters: [
				{
					name: "action",
					description: "on, off, status, provider, limit, audio",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "on, off, status, provider, limit, audio",
				},
			],
			similes: ["/tts", "/voice"],
			descriptionCompressed: "Text-to-speech settings",
		},
		{
			name: "VERBOSE_COMMAND",
			description: "Set verbose output level",
			parameters: [
				{
					name: "level",
					description: "off, on, full",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "off, on, full",
				},
			],
			similes: ["/verbose", "/v"],
			descriptionCompressed: "Set verbose output level",
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
			descriptionCompressed: "Possible response actions",
		},
		{
			name: "CHARACTER",
			description:
				"Provides the agent's character definition and personality information including bio, topics, adjectives, style directions, and example conversations",
			dynamic: false,
			descriptionCompressed:
				"Provides the agent's character definition and personality information including bio, topics, adjectives, style directions, and example conversations",
		},
		{
			name: "RECENT_MESSAGES",
			description:
				"Canonical bounded transcript for the current room, including prior dialogue, post-style turns, action results, and cross-room recent interactions for memory continuity",
			position: 100,
			dynamic: true,
			descriptionCompressed:
				"Canonical bounded transcript for the current room, including prior dialogue, post-style turns, action results, and cross-room recent interactions for memory continuity",
		},
		{
			name: "ACTION_STATE",
			description:
				"Provides information about the current action state and available actions",
			dynamic: true,
			descriptionCompressed:
				"Provides information about the current action state and available actions",
		},
		{
			name: "ATTACHMENTS",
			description: "Media attachments in the current message",
			dynamic: true,
			descriptionCompressed: "Media attachments in the current message",
		},
		{
			name: "CAPABILITIES",
			description:
				"Agent capabilities including models, services, and features",
			dynamic: false,
			descriptionCompressed:
				"Agent capabilities including models, services, and features",
		},
		{
			name: "CHOICE",
			description:
				"Available choice options for selection when there are pending tasks or decisions",
			dynamic: true,
			descriptionCompressed:
				"Available choice options for selection when there are pending tasks or decisions",
		},
		{
			name: "CONTACTS",
			description:
				"Provides contact information from the relationships including categories and preferences",
			dynamic: true,
			descriptionCompressed:
				"Provides contact information from the relationships including categories and preferences",
		},
		{
			name: "CONTEXT_BENCH",
			description: "Benchmark/task context injected by a benchmark harness",
			position: 5,
			dynamic: true,
			descriptionCompressed:
				"Benchmark/task context injected by a benchmark harness",
		},
		{
			name: "ENTITIES",
			description:
				"Provides information about entities in the current context including users, agents, and participants",
			dynamic: true,
			descriptionCompressed:
				"Provides information about entities in the current context including users, agents, and participants",
		},
		{
			name: "FACTS",
			description:
				"Provides known facts about entities learned through conversation",
			dynamic: true,
			descriptionCompressed:
				"Provides known facts about entities learned through conversation",
		},
		{
			name: "FOLLOW_UPS",
			description:
				"Provides information about upcoming follow-ups and reminders scheduled for contacts",
			dynamic: true,
			descriptionCompressed:
				"Provides information about upcoming follow-ups and reminders scheduled for contacts",
		},
		{
			name: "DOCUMENTS",
			description:
				"Provides relevant snippets and recent entries from the agent document store",
			dynamic: true,
			descriptionCompressed:
				"Provides relevant snippets and recent entries from the agent document store",
		},
		{
			name: "PROVIDERS",
			description: "Available context providers",
			dynamic: false,
			descriptionCompressed: "Available context providers",
		},
		{
			name: "RELATIONSHIPS",
			description:
				"Relationships between entities observed by the agent including tags and metadata",
			dynamic: true,
			descriptionCompressed:
				"Relationships between entities observed by the agent including tags and metadata",
		},
		{
			name: "ROLES",
			description:
				"Roles assigned to entities in the current context (Admin, Owner, Member, None)",
			dynamic: true,
			descriptionCompressed:
				"Roles assigned to entities in the current context (Admin, Owner, Member, None)",
		},
		{
			name: "SETTINGS",
			description:
				"Current settings for the agent/server (filtered for security, excludes sensitive keys)",
			dynamic: true,
			descriptionCompressed:
				"Current settings for the agent/server (filtered for security, excludes sensitive keys)",
		},
		{
			name: "TIME",
			description:
				"Provides the current date and time in UTC for time-based operations or responses",
			dynamic: true,
			descriptionCompressed:
				"Provides the current date and time in UTC for time-based operations or responses",
		},
		{
			name: "WORLD",
			description:
				"Provides information about the current world context including settings and members",
			dynamic: true,
			descriptionCompressed:
				"Provides information about the current world context including settings and members",
		},
		{
			name: "LONG_TERM_MEMORY",
			description:
				"Persistent facts and preferences about the user learned and remembered across conversations",
			position: 50,
			dynamic: false,
			descriptionCompressed:
				"Persistent facts and preferences about the user learned and remembered across conversations",
		},
		{
			name: "AGENT_SETTINGS",
			description:
				"Provides the agent's current configuration settings (filtered for security)",
			dynamic: true,
			descriptionCompressed:
				"Provides the agent's current configuration settings (filtered for security)",
		},
		{
			name: "CURRENT_TIME",
			description:
				"Provides current time and date information in various formats",
			dynamic: true,
			descriptionCompressed:
				"Provides current time and date information in various formats",
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
			descriptionCompressed: "Possible response actions",
		},
		{
			name: "CHARACTER",
			description:
				"Provides the agent's character definition and personality information including bio, topics, adjectives, style directions, and example conversations",
			dynamic: false,
			descriptionCompressed:
				"Provides the agent's character definition and personality information including bio, topics, adjectives, style directions, and example conversations",
		},
		{
			name: "RECENT_MESSAGES",
			description:
				"Canonical bounded transcript for the current room, including prior dialogue, post-style turns, action results, and cross-room recent interactions for memory continuity",
			position: 100,
			dynamic: true,
			descriptionCompressed:
				"Canonical bounded transcript for the current room, including prior dialogue, post-style turns, action results, and cross-room recent interactions for memory continuity",
		},
		{
			name: "ACTION_STATE",
			description:
				"Provides information about the current action state and available actions",
			dynamic: true,
			descriptionCompressed:
				"Provides information about the current action state and available actions",
		},
		{
			name: "ATTACHMENTS",
			description: "Media attachments in the current message",
			dynamic: true,
			descriptionCompressed: "Media attachments in the current message",
		},
		{
			name: "CAPABILITIES",
			description:
				"Agent capabilities including models, services, and features",
			dynamic: false,
			descriptionCompressed:
				"Agent capabilities including models, services, and features",
		},
		{
			name: "CHOICE",
			description:
				"Available choice options for selection when there are pending tasks or decisions",
			dynamic: true,
			descriptionCompressed:
				"Available choice options for selection when there are pending tasks or decisions",
		},
		{
			name: "CONTACTS",
			description:
				"Provides contact information from the relationships including categories and preferences",
			dynamic: true,
			descriptionCompressed:
				"Provides contact information from the relationships including categories and preferences",
		},
		{
			name: "CONTEXT_BENCH",
			description: "Benchmark/task context injected by a benchmark harness",
			position: 5,
			dynamic: true,
			descriptionCompressed:
				"Benchmark/task context injected by a benchmark harness",
		},
		{
			name: "ENTITIES",
			description:
				"Provides information about entities in the current context including users, agents, and participants",
			dynamic: true,
			descriptionCompressed:
				"Provides information about entities in the current context including users, agents, and participants",
		},
		{
			name: "FACTS",
			description:
				"Provides known facts about entities learned through conversation",
			dynamic: true,
			descriptionCompressed:
				"Provides known facts about entities learned through conversation",
		},
		{
			name: "FOLLOW_UPS",
			description:
				"Provides information about upcoming follow-ups and reminders scheduled for contacts",
			dynamic: true,
			descriptionCompressed:
				"Provides information about upcoming follow-ups and reminders scheduled for contacts",
		},
		{
			name: "DOCUMENTS",
			description:
				"Provides relevant snippets and recent entries from the agent document store",
			dynamic: true,
			descriptionCompressed:
				"Provides relevant snippets and recent entries from the agent document store",
		},
		{
			name: "PROVIDERS",
			description: "Available context providers",
			dynamic: false,
			descriptionCompressed: "Available context providers",
		},
		{
			name: "RELATIONSHIPS",
			description:
				"Relationships between entities observed by the agent including tags and metadata",
			dynamic: true,
			descriptionCompressed:
				"Relationships between entities observed by the agent including tags and metadata",
		},
		{
			name: "ROLES",
			description:
				"Roles assigned to entities in the current context (Admin, Owner, Member, None)",
			dynamic: true,
			descriptionCompressed:
				"Roles assigned to entities in the current context (Admin, Owner, Member, None)",
		},
		{
			name: "SETTINGS",
			description:
				"Current settings for the agent/server (filtered for security, excludes sensitive keys)",
			dynamic: true,
			descriptionCompressed:
				"Current settings for the agent/server (filtered for security, excludes sensitive keys)",
		},
		{
			name: "TIME",
			description:
				"Provides the current date and time in UTC for time-based operations or responses",
			dynamic: true,
			descriptionCompressed:
				"Provides the current date and time in UTC for time-based operations or responses",
		},
		{
			name: "WORLD",
			description:
				"Provides information about the current world context including settings and members",
			dynamic: true,
			descriptionCompressed:
				"Provides information about the current world context including settings and members",
		},
		{
			name: "LONG_TERM_MEMORY",
			description:
				"Persistent facts and preferences about the user learned and remembered across conversations",
			position: 50,
			dynamic: false,
			descriptionCompressed:
				"Persistent facts and preferences about the user learned and remembered across conversations",
		},
		{
			name: "AGENT_SETTINGS",
			description:
				"Provides the agent's current configuration settings (filtered for security)",
			dynamic: true,
			descriptionCompressed:
				"Provides the agent's current configuration settings (filtered for security)",
		},
		{
			name: "CURRENT_TIME",
			description:
				"Provides current time and date information in various formats",
			dynamic: true,
			descriptionCompressed:
				"Provides current time and date information in various formats",
		},
	],
} as const satisfies { version: string; providers: readonly ProviderDoc[] };

export const coreActionDocs: readonly ActionDoc[] = coreActionsSpec.actions;
export const allActionDocs: readonly ActionDoc[] = allActionsSpec.actions;
export const coreProviderDocs: readonly ProviderDoc[] =
	coreProvidersSpec.providers;
export const allProviderDocs: readonly ProviderDoc[] =
	allProvidersSpec.providers;
