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
				"Respond without additional action. Default when speaking only.",
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
					descriptionCompressed: "message action",
				},
				{
					name: "source",
					description:
						"Connector or inbox source such as discord, slack, signal, whatsapp, telegram, x, imessage, matrix, line, google-chat, feishu, instagram, wechat, gmail, calendly, or browser_bridge.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "connector or inbox source",
				},
				{
					name: "accountId",
					description:
						"Optional connector account id for multi-account message connectors.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "connector account id",
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
					descriptionCompressed: "inbox sources",
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
					name: "channel",
					description: "Loose channel, room, or group name/reference.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "channel reference",
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
					name: "message",
					description:
						"Message text for action=send or replacement text for action=edit.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "message text",
				},
				{
					name: "query",
					description: "Search term for action=search or action=search_inbox.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "search query",
				},
				{
					name: "content",
					description:
						"Inbox search text or message lookup hint for draft/respond/manage operations.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "message lookup text",
				},
				{
					name: "sender",
					description:
						"Sender identifier, handle, or display name for inbox search or reply lookup.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "sender lookup",
				},
				{
					name: "body",
					description:
						"Draft or response body for action=draft_reply, draft_followup, or respond.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "draft body",
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
					descriptionCompressed: "draft recipients",
				},
				{
					name: "subject",
					description: "Optional subject for email-like draft operations.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "draft subject",
				},
				{
					name: "messageId",
					description:
						"Platform message ID, full message ID, or stored memory ID for react/edit/delete/pin/respond/manage.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "message id",
				},
				{
					name: "draftId",
					description:
						"Draft identifier for action=send_draft or action=schedule_draft_send.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "draft id",
				},
				{
					name: "confirmed",
					description:
						"Whether the user explicitly confirmed sending for action=send_draft.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed: "send confirmed",
				},
				{
					name: "sendAt",
					description: "Scheduled send time for action=schedule_draft_send.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "send time",
				},
				{
					name: "emoji",
					description: "Reaction value for action=react.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "reaction emoji",
				},
				{
					name: "pin",
					description:
						"Pin state for action=pin. Use false to unpin when supported.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed: "pin state",
				},
				{
					name: "manageOperation",
					description:
						"Management action for action=manage, such as archive, trash, spam, mark_read, label_add, label_remove, tag_add, tag_remove, mute_thread, or unsubscribe.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "manage operation",
				},
				{
					name: "label",
					description:
						"Label for action=manage when adding or removing labels.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "message label",
				},
				{
					name: "tag",
					description: "Tag for action=manage when adding or removing tags.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "message tag",
				},
				{
					name: "limit",
					description:
						"Maximum number of messages/channels/servers/inbox items to return.",
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
					name: "sinceMs",
					description:
						"Start timestamp in milliseconds for inbox list/search/triage operations.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed: "since timestamp",
				},
				{
					name: "since",
					description:
						"Start timestamp or parseable date for action=search_inbox.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "search start",
				},
				{
					name: "until",
					description:
						"End timestamp or parseable date for action=read_channel range=dates or action=search_inbox.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "search end",
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
				"primary message action operations send read_channel read_with_contact search list_channels list_servers react edit delete pin join leave get_user triage list_inbox search_inbox draft_reply draft_followup respond send_draft schedule_draft_send manage dm group channel room thread user server inbox draft",
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
					descriptionCompressed: "post action",
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
					name: "accountId",
					description:
						"Optional connector account id for multi-account post connectors.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "post account id",
				},
				{
					name: "text",
					description: "Public post text for action=send.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "post text",
				},
				{
					name: "target",
					description:
						"Loose feed target for action=send/read, such as a user, channel, media id, or connector-specific reference.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "feed target",
				},
				{
					name: "feed",
					description:
						"Feed convention for action=read, such as home, user, hashtag, channel, or connector-specific feed.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "feed",
				},
				{
					name: "query",
					description: "Search term for action=search.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "post search query",
				},
				{
					name: "replyTo",
					description: "Post/comment/reply target for action=send.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "reply target",
				},
				{
					name: "mediaId",
					description:
						"Media id for connector-specific comment surfaces such as Instagram.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "media id",
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
						"Opaque pagination cursor for action=read or action=search.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "pagination cursor",
				},
				{
					name: "attachments",
					description: "Optional post attachments.",
					required: false,
					schema: {
						type: "array",
					},
					descriptionCompressed: "post attachments",
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
				"primary post action ops send read search public feed timeline posts",
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
				"Room action=follow|unfollow|mute|unmute; current room by default.",
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
					descriptionCompressed: "Role operation. update.",
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
			descriptionCompressed: "Role action=update; assign trust role to entity.",
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
					descriptionCompressed: "max number of results to return.",
				},
			],
			descriptionCompressed: "Search prior experiences/memory by query.",
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
			descriptionCompressed: "Character action=modify|persist|update_identity.",
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
					descriptionCompressed: "Attachment operation.",
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
					descriptionCompressed: "Attachment id.",
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
					descriptionCompressed: "Store read result in task clipboard.",
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
					descriptionCompressed: "Saved document title.",
				},
			],
			descriptionCompressed:
				"Attachment action=read or save_as_document; current/recent files, link previews, extracted text, transcripts, media descriptions.",
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
					descriptionCompressed: "Payment operation.",
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
					descriptionCompressed: "Payment provider.",
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
					descriptionCompressed: "Amount in cents/minor units.",
				},
				{
					name: "currency",
					description: "For action=create_request, ISO 4217 currency.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["USD"],
					descriptionCompressed: "ISO currency.",
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
					descriptionCompressed: "Payer constraint.",
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
					descriptionCompressed: "Reason.",
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
					descriptionCompressed: "TTL milliseconds.",
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
					descriptionCompressed: "Payment request id.",
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
					descriptionCompressed: "Delivery target.",
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
					descriptionCompressed: "Target channel id.",
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
					descriptionCompressed: "Provider proof payload.",
				},
				{
					name: "strategy",
					description: "For action=settle, optional settler strategy hint.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["webhook"],
					descriptionCompressed: "Settlement strategy.",
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
					descriptionCompressed: "Wait timeout ms.",
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
				"Payment create_request|deliver_link|verify_payload|settle|await_callback|cancel_request.",
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
						"Optional target entity name (evaluate). Name-only lookups return a bounded failure. provide entityId where possible.",
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
				"Trust system: action=evaluate|record_interaction|request_elevation|update_role.",
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
				"Respond without additional action. Default when speaking only.",
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
					descriptionCompressed: "message action",
				},
				{
					name: "source",
					description:
						"Connector or inbox source such as discord, slack, signal, whatsapp, telegram, x, imessage, matrix, line, google-chat, feishu, instagram, wechat, gmail, calendly, or browser_bridge.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "connector or inbox source",
				},
				{
					name: "accountId",
					description:
						"Optional connector account id for multi-account message connectors.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "connector account id",
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
					descriptionCompressed: "inbox sources",
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
					name: "channel",
					description: "Loose channel, room, or group name/reference.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "channel reference",
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
					name: "message",
					description:
						"Message text for action=send or replacement text for action=edit.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "message text",
				},
				{
					name: "query",
					description: "Search term for action=search or action=search_inbox.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "search query",
				},
				{
					name: "content",
					description:
						"Inbox search text or message lookup hint for draft/respond/manage operations.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "message lookup text",
				},
				{
					name: "sender",
					description:
						"Sender identifier, handle, or display name for inbox search or reply lookup.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "sender lookup",
				},
				{
					name: "body",
					description:
						"Draft or response body for action=draft_reply, draft_followup, or respond.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "draft body",
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
					descriptionCompressed: "draft recipients",
				},
				{
					name: "subject",
					description: "Optional subject for email-like draft operations.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "draft subject",
				},
				{
					name: "messageId",
					description:
						"Platform message ID, full message ID, or stored memory ID for react/edit/delete/pin/respond/manage.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "message id",
				},
				{
					name: "draftId",
					description:
						"Draft identifier for action=send_draft or action=schedule_draft_send.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "draft id",
				},
				{
					name: "confirmed",
					description:
						"Whether the user explicitly confirmed sending for action=send_draft.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed: "send confirmed",
				},
				{
					name: "sendAt",
					description: "Scheduled send time for action=schedule_draft_send.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "send time",
				},
				{
					name: "emoji",
					description: "Reaction value for action=react.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "reaction emoji",
				},
				{
					name: "pin",
					description:
						"Pin state for action=pin. Use false to unpin when supported.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed: "pin state",
				},
				{
					name: "manageOperation",
					description:
						"Management action for action=manage, such as archive, trash, spam, mark_read, label_add, label_remove, tag_add, tag_remove, mute_thread, or unsubscribe.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "manage operation",
				},
				{
					name: "label",
					description:
						"Label for action=manage when adding or removing labels.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "message label",
				},
				{
					name: "tag",
					description: "Tag for action=manage when adding or removing tags.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "message tag",
				},
				{
					name: "limit",
					description:
						"Maximum number of messages/channels/servers/inbox items to return.",
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
					name: "sinceMs",
					description:
						"Start timestamp in milliseconds for inbox list/search/triage operations.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed: "since timestamp",
				},
				{
					name: "since",
					description:
						"Start timestamp or parseable date for action=search_inbox.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "search start",
				},
				{
					name: "until",
					description:
						"End timestamp or parseable date for action=read_channel range=dates or action=search_inbox.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "search end",
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
				"primary message action operations send read_channel read_with_contact search list_channels list_servers react edit delete pin join leave get_user triage list_inbox search_inbox draft_reply draft_followup respond send_draft schedule_draft_send manage dm group channel room thread user server inbox draft",
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
					descriptionCompressed: "post action",
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
					name: "accountId",
					description:
						"Optional connector account id for multi-account post connectors.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "post account id",
				},
				{
					name: "text",
					description: "Public post text for action=send.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "post text",
				},
				{
					name: "target",
					description:
						"Loose feed target for action=send/read, such as a user, channel, media id, or connector-specific reference.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "feed target",
				},
				{
					name: "feed",
					description:
						"Feed convention for action=read, such as home, user, hashtag, channel, or connector-specific feed.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "feed",
				},
				{
					name: "query",
					description: "Search term for action=search.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "post search query",
				},
				{
					name: "replyTo",
					description: "Post/comment/reply target for action=send.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "reply target",
				},
				{
					name: "mediaId",
					description:
						"Media id for connector-specific comment surfaces such as Instagram.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "media id",
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
						"Opaque pagination cursor for action=read or action=search.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "pagination cursor",
				},
				{
					name: "attachments",
					description: "Optional post attachments.",
					required: false,
					schema: {
						type: "array",
					},
					descriptionCompressed: "post attachments",
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
				"primary post action ops send read search public feed timeline posts",
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
				"Room action=follow|unfollow|mute|unmute; current room by default.",
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
					descriptionCompressed: "Role operation. update.",
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
			descriptionCompressed: "Role action=update; assign trust role to entity.",
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
					descriptionCompressed: "max number of results to return.",
				},
			],
			descriptionCompressed: "Search prior experiences/memory by query.",
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
			descriptionCompressed: "Character action=modify|persist|update_identity.",
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
					descriptionCompressed: "Attachment operation.",
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
					descriptionCompressed: "Attachment id.",
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
					descriptionCompressed: "Store read result in task clipboard.",
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
					descriptionCompressed: "Saved document title.",
				},
			],
			descriptionCompressed:
				"Attachment action=read or save_as_document; current/recent files, link previews, extracted text, transcripts, media descriptions.",
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
					descriptionCompressed: "Payment operation.",
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
					descriptionCompressed: "Payment provider.",
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
					descriptionCompressed: "Amount in cents/minor units.",
				},
				{
					name: "currency",
					description: "For action=create_request, ISO 4217 currency.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["USD"],
					descriptionCompressed: "ISO currency.",
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
					descriptionCompressed: "Payer constraint.",
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
					descriptionCompressed: "Reason.",
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
					descriptionCompressed: "TTL milliseconds.",
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
					descriptionCompressed: "Payment request id.",
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
					descriptionCompressed: "Delivery target.",
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
					descriptionCompressed: "Target channel id.",
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
					descriptionCompressed: "Provider proof payload.",
				},
				{
					name: "strategy",
					description: "For action=settle, optional settler strategy hint.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["webhook"],
					descriptionCompressed: "Settlement strategy.",
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
					descriptionCompressed: "Wait timeout ms.",
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
				"Payment create_request|deliver_link|verify_payload|settle|await_callback|cancel_request.",
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
						"Optional target entity name (evaluate). Name-only lookups return a bounded failure. provide entityId where possible.",
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
				"Trust system: action=evaluate|record_interaction|request_elevation|update_role.",
		},
		{
			name: "COMPACT_COMMAND",
			description: "Compact conversation history",
			parameters: [
				{
					name: "instructions",
					description: "Optional compaction instructions",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Optional compaction instructions",
				},
			],
			similes: ["/compact"],
			descriptionCompressed: "Compact convo history",
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
			descriptionCompressed: "Show current context info",
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
						"small, large, coding, show, local, cloud - or a model for this room",
				},
				{
					name: "model",
					description:
						"model id — for coding, the backend (codex, claude, opencode, elizaos)",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"model id - for coding, the backend (codex, claude, opencode, elizaos)",
				},
				{
					name: "effort",
					description: "reasoning effort — for coding, the model id",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "reasoning effort - for coding, the model id",
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
				"Canonical bounded transcript for the current room, including prior dialogue, post-style turns, action results, and cross-room recent interactions for memory continuity",
			position: 100,
			dynamic: true,
			descriptionCompressed:
				"Canonical current-room transcript: dialogue, posts, action results, recent interactions.",
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
				"Canonical bounded transcript for the current room, including prior dialogue, post-style turns, action results, and cross-room recent interactions for memory continuity",
			position: 100,
			dynamic: true,
			descriptionCompressed:
				"Canonical current-room transcript: dialogue, posts, action results, recent interactions.",
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

export const coreActionDocs: readonly ActionDoc[] = coreActionsSpec.actions;
export const allActionDocs: readonly ActionDoc[] = allActionsSpec.actions;
export const coreProviderDocs: readonly ProviderDoc[] =
	coreProvidersSpec.providers;
export const allProviderDocs: readonly ProviderDoc[] =
	allProvidersSpec.providers;
