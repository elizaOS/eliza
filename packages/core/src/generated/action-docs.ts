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
			name: "AINEX_BOW",
			description: "Play the `bow` action group on the AiNex robot.",
			parameters: [],
			similes: ["BOW", "TAKE_A_BOW"],
			descriptionCompressed: "Play the `bow` action group on the AiNex robot.",
		},
		{
			name: "AINEX_PICK_UP",
			description:
				"Run the learned `pick_up` policy. Starts a policy.start with task='pick_up'; options: target_label (default 'red ball'), max_steps.",
			parameters: [],
			similes: ["PICK_UP", "GRAB", "GRASP_OBJECT"],
			descriptionCompressed:
				"Run the learned `pick_up` policy. Starts a policy.start with task='pick_up'. options: target_label (default 'red ball'), max_steps.",
		},
		{
			name: "AINEX_PLACE_DOWN",
			description:
				"Run the learned `place_down` policy. Starts a policy.start with task='place_down'.",
			parameters: [],
			similes: ["PLACE_DOWN", "PUT_DOWN", "RELEASE", "DROP"],
			descriptionCompressed:
				"Run the learned `place_down` policy. Starts a policy.start with task='place_down'.",
		},
		{
			name: "AINEX_RUN_ACTION_GROUP",
			description:
				"Play a named Hiwonder action group (pre-recorded multi-servo motion). Options: name (required, must match a key in the profile's actions.groups).",
			parameters: [],
			similes: ["RUN_ACTION_GROUP", "PLAY_ACTION", "PLAY_ACTION_GROUP"],
			descriptionCompressed:
				"Play a named Hiwonder action group (pre-recorded multi-servo motion). Options: name (required, must match a key in the profile's actions.groups).",
		},
		{
			name: "AINEX_RUN_RL",
			description:
				"Run a text-conditioned learned policy on the AiNex. Pass `options.text` ",
			parameters: [],
			similes: [
				"RUN_RL",
				"TEXT_COMMAND",
				"ROBOT_DO",
				"ROBOT_SAY",
				"PERFORM_TASK",
				"EXECUTE_TASK",
			],
			descriptionCompressed:
				"Run a text-conditioned learned policy on the AiNex. Pass `options.text`",
		},
		{
			name: "AINEX_SET_SERVO",
			description:
				"Drive one or more AiNex servos to target pulse positions over a duration. Options: positions=[{id, position}], duration (seconds, default 0.5).",
			parameters: [],
			similes: ["SET_SERVO", "MOVE_SERVO", "MOVE_JOINT", "SET_JOINT"],
			descriptionCompressed:
				"Drive one or more AiNex servos to target pulse positions over a duration. Options: positions=[{id, position}], duration (seconds, default 0.5).",
		},
		{
			name: "AINEX_SIDE_STEP_LEFT",
			description:
				"Strafe the AiNex robot to its left. Fire-and-forget — robot walks until AINEX_STOP.",
			parameters: [],
			similes: ["SIDE_STEP_LEFT", "STRAFE_LEFT", "SHUFFLE_LEFT"],
			descriptionCompressed:
				"Strafe the AiNex robot to its left. Fire-and-forget - robot walks until AINEX_STOP.",
		},
		{
			name: "AINEX_SIDE_STEP_RIGHT",
			description:
				"Strafe the AiNex robot to its right. Fire-and-forget — robot walks until AINEX_STOP.",
			parameters: [],
			similes: ["SIDE_STEP_RIGHT", "STRAFE_RIGHT", "SHUFFLE_RIGHT"],
			descriptionCompressed:
				"Strafe the AiNex robot to its right. Fire-and-forget - robot walks until AINEX_STOP.",
		},
		{
			name: "AINEX_SIT",
			description:
				"Play the `sit` action group — moves the AiNex into a seated pose.",
			parameters: [],
			similes: ["SIT", "SIT_DOWN", "CROUCH"],
			descriptionCompressed:
				"Play the `sit` action group - moves the AiNex into a seated pose.",
		},
		{
			name: "AINEX_STAND",
			description:
				"Play the `stand` action group — moves the AiNex into its calibrated home pose.",
			parameters: [],
			similes: ["STAND", "STAND_UP", "GET_UP"],
			descriptionCompressed:
				"Play the `stand` action group - moves the AiNex into its calibrated home pose.",
		},
		{
			name: "AINEX_STOP",
			description:
				"Stop the AiNex robot immediately. Sends walk.command:stop with preempt=true so any in-flight commands or active policy are cleared.",
			parameters: [],
			similes: ["STOP", "HALT", "FREEZE", "EMERGENCY_STOP"],
			descriptionCompressed:
				"Stop the AiNex robot immediately. Sends walk.command:stop with preempt=true so any in-flight commands or active policy are cleared.",
		},
		{
			name: "AINEX_TURN_LEFT",
			description:
				"Turn the AiNex robot in place to its left (positive yaw). Fire-and-forget — robot keeps turning until AINEX_STOP.",
			parameters: [],
			similes: ["TURN_LEFT", "ROTATE_LEFT", "SPIN_LEFT"],
			descriptionCompressed:
				"Turn the AiNex robot in place to its left (positive yaw). Fire-and-forget - robot keeps turning until AINEX_STOP.",
		},
		{
			name: "AINEX_TURN_RIGHT",
			description:
				"Turn the AiNex robot in place to its right (negative yaw). Fire-and-forget — robot keeps turning until AINEX_STOP.",
			parameters: [],
			similes: ["TURN_RIGHT", "ROTATE_RIGHT", "SPIN_RIGHT"],
			descriptionCompressed:
				"Turn the AiNex robot in place to its right (negative yaw). Fire-and-forget - robot keeps turning until AINEX_STOP.",
		},
		{
			name: "AINEX_WALK_BACKWARD",
			description:
				"Start walking the AiNex robot backward. Sends walk.set+walk.command:start to the bridge; robot keeps walking until AINEX_STOP. Options: speed (1-4).",
			parameters: [],
			similes: ["WALK_BACKWARD", "MOVE_BACKWARD", "GO_BACK", "BACK_UP"],
			descriptionCompressed:
				"Start walking the AiNex robot backward. Sends walk.set+walk.command:start to the bridge. robot keeps walking until AINEX_STOP. Options: speed (1-4).",
		},
		{
			name: "AINEX_WALK_FORWARD",
			description:
				"Start walking the AiNex robot forward. Sends walk.set+walk.command:start to the bridge; the robot keeps walking until AINEX_STOP is issued. Options: speed (1-4), x (0-0.05).",
			parameters: [],
			similes: ["WALK_FORWARD", "MOVE_FORWARD", "GO_FORWARD"],
			descriptionCompressed:
				"Start walking the AiNex robot forward. Sends walk.set+walk.command:start to the bridge. the robot keeps walking until AINEX_STOP is issued. Options: speed (1-4), x (0-0.05).",
		},
		{
			name: "AINEX_WAVE",
			description: "Play the `wave` action group on the AiNex robot.",
			parameters: [],
			similes: ["WAVE", "WAVE_HAND", "GREET", "SAY_HI"],
			descriptionCompressed: "Play the `wave` action group on the AiNex robot.",
		},
		{
			name: "ALARM",
			description:
				"Manage native macOS alarms via UNUserNotificationCenter. Subactions: set (schedule a new alarm), cancel (remove a scheduled alarm by id), list (show pending alarms). Pass the operation as the structured `action` parameter; when omitted it is inferred from the other structured params (a schedule payload → set, an id → cancel, otherwise list).",
			parameters: [
				{
					name: "action",
					description:
						"Canonical operation discriminator: set, cancel, or list. Legacy subaction/op aliases are still accepted.",
					required: false,
					schema: {
						type: "string",
						enum: ["set", "cancel", "list"],
					},
					descriptionCompressed:
						"Canonical operation discriminator: set, cancel, or list. Legacy subaction/op aliases are still accepted.",
				},
				{
					name: "subaction",
					description:
						"Operation to perform: set, cancel, or list. Inferred from the other structured parameters when omitted.",
					required: false,
					schema: {
						type: "string",
						enum: ["set", "cancel", "list"],
					},
					descriptionCompressed:
						"Operation to perform: set, cancel, or list. Inferred from the other structured params when omitted.",
				},
				{
					name: "timeIso",
					description:
						"For subaction=set: ISO-8601 timestamp when the alarm should fire.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"For subaction=set: ISO-8601 timestamp when the alarm should fire.",
				},
				{
					name: "title",
					description:
						"For subaction=set: short title displayed in the notification.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"For subaction=set: short title displayed in the notification.",
				},
				{
					name: "body",
					description:
						"For subaction=set: optional longer body text for the notification.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"For subaction=set: optional longer body text for the notification.",
				},
				{
					name: "sound",
					description: "For subaction=set: optional notification sound name.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"For subaction=set: optional notification sound name.",
				},
				{
					name: "id",
					description:
						"For subaction=set: optional explicit alarm id; for subaction=cancel: required alarm id returned from a previous set operation.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"For subaction=set: optional explicit alarm id. for subaction=cancel: required alarm id returned from a previous set operation.",
				},
			],
			descriptionCompressed:
				"macOS alarm: set / cancel / list (UNUserNotificationCenter).",
			similes: [
				"SET_ALARM_MACOS",
				"CANCEL_ALARM_MACOS",
				"LIST_ALARMS_MACOS",
				"schedule macos alarm",
				"create mac alarm",
				"set a mac alarm",
				"wake me up on mac",
				"cancel macos alarm",
				"remove mac alarm",
				"list macos alarms",
				"show pending alarms",
			],
			exampleCalls: [
				{
					user: "Use ALARM with the provided parameters.",
					actions: ["ALARM"],
					params: {
						ALARM: {
							action: "set",
							subaction: "set",
							timeIso: "example",
							title: "example",
							body: "example",
							sound: "example",
							id: "example",
						},
					},
				},
			],
		},
		{
			name: "BACKUP_APP",
			description:
				"Export a portable config snapshot (backup) of one of the user's Eliza Cloud apps so it can be saved and recreated later. Use when the user wants to back up / export an app's configuration.",
			parameters: [],
			descriptionCompressed: "Export a config backup snapshot of a Cloud app.",
			similes: [
				"EXPORT_APP",
				"SAVE_APP_CONFIG",
				"APP_BACKUP",
				"EXPORT_APP_CONFIG",
			],
		},
		{
			name: "BLOCK",
			description: "Block/unblock phone apps or desktop websites. ",
			parameters: [
				{
					name: "target",
					description:
						"app phone apps | website desktop hosts-file/SelfControl. Omit ok: infer request_permission|release|list_active -> website, params, user text.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"app phone apps | website desktop hosts-file/SelfControl. Omit ok: infer request_permission|release|list_active -> website, params, user text.",
				},
				{
					name: "action",
					description:
						"block | unblock | status | request_permission | release | list_active. request_permission|release|list_active website-only.",
					required: true,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"block | unblock | status | request_permission | release | list_active. request_permission|release|list_active website-only.",
				},
				{
					name: "intent",
					description: "Owner intent text; extract apps/hostnames + duration.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Owner intent text. extract apps/hostnames + duration.",
				},
				{
					name: "hostnames",
					description: "(target=website) Public hostnames/URLs.",
					required: false,
					schema: {
						type: "array",
						items: {
							type: "string",
						},
					},
					descriptionCompressed: "(target=website) Public hostnames/URLs.",
				},
				{
					name: "confirmed",
					description:
						"(target=website) true after owner confirmed. Without: block drafts. Required by release.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed:
						"(target=website) true after owner confirmed. without: block drafts. Required by release.",
				},
				{
					name: "ruleId",
					description: "(target=website action=release) Managed block rule id.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"(target=website action=release) Managed block rule id.",
				},
				{
					name: "reason",
					description:
						"(target=website action=release) Optional release reason; audit record.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"(target=website action=release) Optional release reason. audit record.",
				},
				{
					name: "includeLiveStatus",
					description:
						"(target=website action=list_active) Include hosts-file/SelfControl live state. Default true.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed:
						"(target=website action=list_active) Include hosts-file/SelfControl live state. Default true.",
				},
				{
					name: "includeManagedRules",
					description:
						"(target=website action=list_active) Include managed rules. Default true.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed:
						"(target=website action=list_active) Include managed rules. Default true.",
				},
				{
					name: "packageNames",
					description: "(target=app Android) Package names.",
					required: false,
					schema: {
						type: "array",
						items: {
							type: "string",
						},
					},
					descriptionCompressed: "(target=app Android) Package names.",
				},
				{
					name: "appTokens",
					description: "(target=app iOS) iPhone app tokens from selectApps().",
					required: false,
					schema: {
						type: "array",
						items: {
							type: "string",
						},
					},
					descriptionCompressed:
						"(target=app iOS) iPhone app tokens from selectApps().",
				},
				{
					name: "durationMinutes",
					description:
						"Block duration minutes. Omit/null = indefinite until manual removal.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed:
						"Block duration minutes. Omit/null = indefinite until manual removal.",
				},
			],
			descriptionCompressed:
				"BLOCK apps+websites only; NOT calendar/focus; block|unblock|status|permission|release",
			similes: [
				"SELFCONTROL",
				"SITE_BLOCKER",
				"HOSTS_BLOCK",
				"BLOCK_WEBSITE",
				"SHIELD_APPS",
				"FAMILY_CONTROLS",
				"PHONE_FOCUS",
				"PHONE_BLOCK_APPS",
				"BLOCK_APPS",
			],
			exampleCalls: [
				{
					user: "Use BLOCK with the provided parameters.",
					actions: ["BLOCK"],
					params: {
						BLOCK: {
							target: "example",
							action: "example",
							intent: "example",
							hostnames: "example",
							confirmed: false,
							ruleId: "example",
							reason: "example",
							includeLiveStatus: false,
							includeManagedRules: false,
							packageNames: "example",
							appTokens: "example",
							durationMinutes: 1,
						},
					},
				},
			],
		},
		{
			name: "BOOK_INFLUENCER",
			description:
				"Book (hire) an influencer on Eliza Cloud to promote — funds an escrowed offer from the org's credits. MONEY: the first ask only confirms intent; the booking is funded on explicit confirmation. Use when the user wants to hire/sponsor/pay an influencer.",
			parameters: [
				{
					name: "profileId",
					description: "Influencer profile id to book.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Influencer profile id to book.",
				},
				{
					name: "influencer",
					description: "Influencer display name to book (resolved via browse).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Influencer display name to book (resolved via browse).",
				},
				{
					name: "amount",
					description: "USD budget for the booking.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed: "USD budget for the booking.",
				},
				{
					name: "brief",
					description: "What the influencer should post / the campaign brief.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"What the influencer should post/the campaign brief.",
				},
				{
					name: "confirm",
					description:
						"Follow-up: true confirms the pending booking, false cancels.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed:
						"Follow-up: true confirms the pending booking, false cancels.",
				},
			],
			descriptionCompressed:
				"Book an influencer to promote (escrowed; two-step confirm).",
			similes: [
				"HIRE_INFLUENCER",
				"SPONSOR_INFLUENCER",
				"PAY_INFLUENCER",
				"PROMOTE_WITH_INFLUENCER",
			],
			exampleCalls: [
				{
					user: "Use BOOK_INFLUENCER with the provided parameters.",
					actions: ["BOOK_INFLUENCER"],
					params: {
						BOOK_INFLUENCER: {
							profileId: "example",
							influencer: "example",
							amount: 1,
							brief: "example",
							confirm: false,
						},
					},
				},
			],
		},
		{
			name: "BRIEF",
			description:
				"Compose owner LifeOpsBriefing: morning/evening/weekly; calendar feed, inbox triage, life due, money recurring charges. Subactions: compose_morning, compose_evening, compose_weekly.",
			parameters: [
				{
					name: "action",
					description:
						"Brief op: compose_morning | compose_evening | compose_weekly.",
					required: false,
					schema: {
						type: "string",
						enum: ["compose_morning", "compose_evening", "compose_weekly"],
					},
					descriptionCompressed:
						"Brief op: compose_morning | compose_evening | compose_weekly.",
				},
				{
					name: "period",
					description:
						"Brief window: today | tomorrow | this_week. Default subaction period.",
					required: false,
					schema: {
						type: "string",
						enum: ["today", "tomorrow", "this_week"],
					},
					descriptionCompressed:
						"Brief window: today | tomorrow | this_week. Default subaction period.",
				},
				{
					name: "include",
					description:
						"Include flags, default true: { calendar?, inbox?, life?, money? }.",
					required: false,
					schema: {
						type: "object",
					},
					descriptionCompressed:
						"Include flags, default true: { calendar?, inbox?, life?, money? }.",
				},
				{
					name: "format",
					description:
						"Format: narrative = LLM compose; json = LifeOpsBriefing only. Default narrative.",
					required: false,
					schema: {
						type: "string",
						enum: ["narrative", "json"],
					},
					descriptionCompressed:
						"Format: narrative = LLM compose. json = LifeOpsBriefing only. Default narrative.",
				},
			],
			descriptionCompressed:
				"BRIEF compose_morning|compose_evening|compose_weekly; LifeOpsBriefing",
			exampleCalls: [
				{
					user: "Use BRIEF with the provided parameters.",
					actions: ["BRIEF"],
					params: {
						BRIEF: {
							action: "compose_morning",
							period: "today",
							include: "example",
							format: "narrative",
						},
					},
				},
			],
		},
		{
			name: "BROWSER",
			description:
				"BROWSER action. Control registered browser target: app workspace, bridge Chrome/Safari companion, computeruse Chromium, or Stagehand fallback. BrowserService picks target if omitted. action=autofill_login + domain vault-gated autofills open workspace tab. action=wait_for_url + pattern opens an optional url then watches the tab and resumes when its URL matches (OAuth callback, deploy/CI done), streaming progress.",
			parameters: [
				{
					name: "target",
					description:
						"Optional browser target id. Common values: workspace, bridge, computeruse, stagehand.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Optional browser target id. Common values: workspace, bridge, computeruse, stagehand.",
				},
				{
					name: "streamProgress",
					description:
						"When true, emit a compact Step 1 progress callback after the browser command dispatches.",
					required: false,
					schema: {
						type: "boolean",
						default: false,
					},
					descriptionCompressed:
						"When true, emit a compact Step 1 progress callback after the browser command dispatches.",
				},
				{
					name: "rationale",
					description:
						"Optional rationale shown in streamProgress callback text.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Optional rationale shown in streamProgress callback text.",
				},
				{
					name: "action",
					description:
						"Browser action. Snake_case canonical; legacy kebab-case and subaction accepted.",
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
							"realistic_click",
							"realistic_fill",
							"realistic_type",
							"realistic_press",
							"cursor_move",
							"cursor_hide",
							"autofill_login",
							"wait_for_url",
						],
					},
					descriptionCompressed:
						"Browser action. Snake_case canonical. legacy kebab-case and subaction accepted.",
				},
				{
					name: "pattern",
					description:
						"For action=wait_for_url: substring or /regex/ to match the tab URL (e.g. callback?code=, or /\\/done$/).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"For action=wait_for_url: substring or /regex/ to match the tab URL (e.g. callback?code=, or /\\/done$/).",
				},
				{
					name: "pollIntervalMs",
					description:
						"For action=wait_for_url: poll cadence in ms. Default 2000.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed:
						"For action=wait_for_url: poll cadence in ms. Default 2000.",
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
					name: "domain",
					description:
						"Required for action=autofill_login: registrable hostname, e.g. github.com.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Required for action=autofill_login: registrable hostname, e.g. github.com.",
				},
				{
					name: "username",
					description:
						"For autofill-login: saved login username; omit for latest.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"For autofill-login: saved login username. omit for latest.",
				},
				{
					name: "submit",
					description:
						"For autofill-login: submit after filling. Default false.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed:
						"For autofill-login: submit after filling. Default false.",
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
						"User watching hint; prefer realistic-* click/fill, visible cursor, pointer events.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed:
						"User watching hint. prefer realistic-* click/fill, visible cursor, pointer events.",
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
						"For realistic-fill: replace existing input, not append.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed:
						"For realistic-fill: replace existing input, not append.",
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
				"Browser open|navigate|click|type|screenshot|state|autofill_login|wait_for_url; bridge status elsewhere",
			similes: [
				"BROWSE_SITE",
				"BROWSER_SESSION",
				"CONTROL_BROWSER",
				"CONTROL_BROWSER_SESSION",
				"MANAGE_ELIZA_BROWSER_WORKSPACE",
				"NAVIGATE_SITE",
				"OPEN_SITE",
				"USE_BROWSER",
				"BROWSER_ACTION",
				"BROWSER_AUTOFILL_LOGIN",
				"AGENT_AUTOFILL",
				"AUTOFILL_BROWSER_LOGIN",
				"AUTOFILL_LOGIN",
				"FILL_BROWSER_CREDENTIALS",
				"LOG_INTO_SITE",
				"SIGN_IN_TO_SITE",
			],
			exampleCalls: [
				{
					user: "Use BROWSER with the provided parameters.",
					actions: ["BROWSER"],
					params: {
						BROWSER: {
							target: "example",
							streamProgress: false,
							rationale: "example",
							action: "back",
							pattern: "example",
							pollIntervalMs: 1,
							tabAction: "close",
							domain: "example",
							username: "example",
							submit: false,
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
			name: "BUY_APP_DOMAIN",
			description:
				"Buy a domain through Eliza Cloud (Cloudflare registrar) and attach it to a Cloud app. MONEY-OUT: charged from the org credit balance — the first ask only quotes the price and asks for confirmation. Use when the user asks to buy, purchase, or register a domain.",
			parameters: [
				{
					name: "domain",
					description: "The domain to buy, e.g. yourbrand.com.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "The domain to buy, e.g. yourbrand.com.",
				},
				{
					name: "appName",
					description:
						"Name, slug, or id of the Cloud app the domain attaches to.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Name, slug, or id of the Cloud app the domain attaches to.",
				},
				{
					name: "confirm",
					description:
						"Follow-up confirmation. Set true only when the user is confirming the pending domain-purchase prompt; set false when canceling.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed:
						"Follow-up confirmation. Set true only when user is confirming the pending domain-purchase prompt. set false when canceling.",
				},
			],
			descriptionCompressed:
				"Buy + attach a domain to a Cloud app (money-out; two-step confirm).",
			similes: [
				"BUY_DOMAIN",
				"PURCHASE_DOMAIN",
				"REGISTER_DOMAIN",
				"GET_A_DOMAIN",
				"BUY_CUSTOM_DOMAIN",
			],
			exampleCalls: [
				{
					user: "Use BUY_APP_DOMAIN with the provided parameters.",
					actions: ["BUY_APP_DOMAIN"],
					params: {
						BUY_APP_DOMAIN: {
							domain: "example",
							appName: "example",
							confirm: false,
						},
					},
				},
			],
		},
		{
			name: "CALENDAR",
			description:
				"Live calendar: event CRUD, availability, meeting prefs. Subactions: ",
			parameters: [
				{
					name: "action",
					description:
						"Calendar op. feed, next_event, search_events, create_event, update_event, delete_event, trip_window, bulk_reschedule, check_availability, propose_times, update_preferences.",
					required: false,
					schema: {
						type: "string",
						enum: [
							"feed",
							"next_event",
							"search_events",
							"create_event",
							"update_event",
							"delete_event",
							"trip_window",
							"bulk_reschedule",
							"check_availability",
							"propose_times",
							"update_preferences",
						],
					},
					descriptionCompressed:
						"Calendar op. feed, next_event, search_events, create_event, update_event, delete_event, trip_window, bulk_reschedule, check_availability, propose_times, update_preferences.",
				},
				{
					name: "intent",
					description:
						'Natural-language request. Examples: "calendar today", "flights this week", "create meeting tomorrow 3pm".',
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						'Natural-language request. Examples: "calendar today", "flights this week", "create meeting tomorrow 3pm".',
				},
				{
					name: "title",
					description: "Event title for create_event. TOP-LEVEL flat. ",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"title TOP-LEVEL; NOT details. create_event needs title + details.start/end",
				},
				{
					name: "query",
					description:
						"Search phrase for search_events/travel_itinerary: flight, dentist, Denver.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Search phrase for search_events/travel_itinerary: flight, dentist, Denver.",
				},
				{
					name: "queries",
					description:
						"Optional search_events phrases array. Combined/deduped.",
					required: false,
					schema: {
						type: "array",
						items: {
							type: "string",
						},
					},
					descriptionCompressed:
						"Optional search_events phrases array. Combined/deduped.",
				},
				{
					name: "details",
					description:
						"Structured fields for create_event/update_event/delete_event. ",
					required: false,
					schema: {
						type: "object",
						properties: {
							calendarId: {
								type: "string",
							},
							timeMin: {
								type: "string",
							},
							timeMax: {
								type: "string",
							},
							timeZone: {
								type: "string",
							},
							forceSync: {
								type: "boolean",
							},
							windowDays: {
								type: "number",
							},
							windowPreset: {
								type: "string",
							},
							start: {
								type: "string",
							},
							end: {
								type: "string",
							},
							startAt: {
								type: "string",
							},
							endAt: {
								type: "string",
							},
							durationMinutes: {
								type: "number",
							},
							eventId: {
								type: "string",
							},
							newTitle: {
								type: "string",
							},
							description: {
								type: "string",
							},
							location: {
								type: "string",
							},
							travelOriginAddress: {
								type: "string",
							},
							attendees: {
								type: "array",
								items: {
									type: "string",
								},
							},
						},
					},
					descriptionCompressed:
						"details create|update|delete: calendarId,start/end,eventId,location; title/window TOP",
				},
				{
					name: "durationMinutes",
					description: "TOP-LEVEL flat. propose_times length minutes. ",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed:
						"TOP-LEVEL flat. propose_times length minutes.",
				},
				{
					name: "daysAhead",
					description:
						"propose_times days ahead. Default 7. Ignored with windowStart/windowEnd.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed:
						"propose_times days ahead. Default 7. Ignored with windowStart/windowEnd.",
				},
				{
					name: "slotCount",
					description: "propose_times slot count. Default 3.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed: "propose_times slot count. Default 3.",
				},
				{
					name: "windowStart",
					description: "propose_times window earliest start. ISO-8601.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"propose_times window earliest start. ISO-8601.",
				},
				{
					name: "windowEnd",
					description: "propose_times window latest end. ISO-8601.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "propose_times window latest end. ISO-8601.",
				},
				{
					name: "startAt",
					description: "TOP-LEVEL flat. check_availability start. ISO-8601. ",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"TOP-LEVEL flat. check_availability start. ISO-8601.",
				},
				{
					name: "endAt",
					description:
						"TOP-LEVEL flat. check_availability end. ISO-8601. See `startAt`.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"TOP-LEVEL flat. check_availability end. ISO-8601. See `startAt`.",
				},
				{
					name: "timeZone",
					description: "IANA timeZone for update_preferences hours.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "IANA timeZone for update_preferences hours.",
				},
				{
					name: "preferredStartLocal",
					description:
						"TOP-LEVEL flat for update_preferences. Earliest start local HH:MM 24h. ",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"TOP-LEVEL flat for update_preferences. Earliest start local HH:MM 24h.",
				},
				{
					name: "preferredEndLocal",
					description:
						"TOP-LEVEL flat for update_preferences. Latest end local HH:MM 24h. See `preferredStartLocal`.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"TOP-LEVEL flat for update_preferences. Latest end local HH:MM 24h. See `preferredStartLocal`.",
				},
				{
					name: "defaultDurationMinutes",
					description: "Default duration minutes (5–480).",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed: "Default duration minutes (5-480).",
				},
				{
					name: "travelBufferMinutes",
					description: "Buffer minutes before/after meetings (0–240).",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed:
						"Buffer minutes before/after meetings (0-240).",
				},
				{
					name: "blackoutWindows",
					description:
						"Array: { label, startLocal HH:MM, endLocal HH:MM, daysOfWeek? 0=Sun..6=Sat }.",
					required: false,
					schema: {
						type: "array",
						items: {
							type: "object",
							properties: {
								label: {
									type: "string",
								},
								startLocal: {
									type: "string",
									pattern: "^[0-2][0-9]:[0-5][0-9]$",
								},
								endLocal: {
									type: "string",
									pattern: "^[0-2][0-9]:[0-5][0-9]$",
								},
								daysOfWeek: {
									type: "array",
									items: {
										type: "number",
										minimum: 0,
										maximum: 6,
									},
								},
							},
						},
					},
					descriptionCompressed:
						"blackoutWindows[]: label startLocal HH:MM endLocal HH:MM daysOfWeek?[0..6]",
				},
			],
			descriptionCompressed:
				"calendar feed|next|search|create|update|delete|trip_window|reschedule|availability|propose",
			exampleCalls: [
				{
					user: "Use CALENDAR with the provided parameters.",
					actions: ["CALENDAR"],
					params: {
						CALENDAR: {
							action: "feed",
							intent: "example",
							title: "example",
							query: "example",
							queries: "example",
							details: "example",
							durationMinutes: 1,
							daysAhead: 1,
							slotCount: 1,
							windowStart: "example",
							windowEnd: "example",
							startAt: "example",
							endAt: "example",
							timeZone: "example",
							preferredStartLocal: "example",
							preferredEndLocal: "example",
							defaultDurationMinutes: 1,
							travelBufferMinutes: 1,
							blackoutWindows: "example",
						},
					},
				},
			],
		},
		{
			name: "CHECK_APP_DOMAIN",
			description:
				"Check whether a domain is available to register and what it costs per year (purchase + renewal). Read-only — never charges or registers. Use when the user asks if a domain is available, free, taken, or how much it costs.",
			parameters: [
				{
					name: "domain",
					description: "The domain to check, e.g. yourbrand.com.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "The domain to check, e.g. yourbrand.com.",
				},
				{
					name: "appName",
					description:
						"Optional name, slug, or id of the Cloud app the domain is for.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Optional name, slug, or id of the Cloud app the domain is for.",
				},
			],
			descriptionCompressed:
				"Check a domain's availability + yearly price (read-only).",
			similes: [
				"CHECK_DOMAIN",
				"DOMAIN_AVAILABLE",
				"DOMAIN_PRICE",
				"SEARCH_DOMAIN",
				"IS_DOMAIN_AVAILABLE",
			],
			exampleCalls: [
				{
					user: "Use CHECK_APP_DOMAIN with the provided parameters.",
					actions: ["CHECK_APP_DOMAIN"],
					params: {
						CHECK_APP_DOMAIN: {
							domain: "example",
							appName: "example",
						},
					},
				},
			],
		},
		{
			name: "CLIPBOARD",
			description:
				"CLIPBOARD action. Read or write the host system clipboard. actions: read, write. Linux requires wl-clipboard (Wayland) or xclip (X11); macOS uses pbcopy/pbpaste; Windows uses PowerShell Set-Clipboard / Get-Clipboard.",
			parameters: [
				{
					name: "action",
					description: "Clipboard operation verb.",
					required: true,
					schema: {
						type: "string",
						enum: ["read", "write"],
					},
					descriptionCompressed: "Clipboard operation verb.",
				},
				{
					name: "text",
					description: "Payload for write.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Payload for write.",
				},
			],
			descriptionCompressed: "CLIPBOARD action=read|write",
			similes: [
				"USE_CLIPBOARD",
				"CLIPBOARD_ACTION",
				"COPY",
				"PASTE",
				"READ_CLIPBOARD",
				"WRITE_CLIPBOARD",
			],
			exampleCalls: [
				{
					user: "Use CLIPBOARD with the provided parameters.",
					actions: ["CLIPBOARD"],
					params: {
						CLIPBOARD: {
							action: "read",
							text: "example",
						},
					},
				},
			],
		},
		{
			name: "COMMANDS_COMMAND",
			description: "List all commands",
			parameters: [],
			similes: ["/commands", "/cmds"],
			descriptionCompressed: "List all commands",
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
			name: "COMPUTER_USE",
			description:
				"computer_use: real desktop control on macOS/Linux/Windows. Screenshot before acting. Results include screenshot when available. Use for Finder/Desktop/native-app/browser/file/terminal on owner's machine. actions: screenshot/click/click_with_modifiers/double_click/right_click/mouse_move/middle_click/mouse_down/mouse_up/type/key/key_combo/key_down/key_up/scroll/drag/detect_elements/ocr/open/launch. mouse_down/up + key_down/up are press-and-hold primitives (button held until released); drag accepts a multi-point `path`; open(target) opens a file/URL/folder; launch(app,appArgs) starts an app and returns its pid. Also resolves pending computer-use approvals from approve:<id> / deny:<id> chat button callbacks.",
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
							"middle_click",
							"mouse_down",
							"mouse_up",
							"type",
							"key",
							"key_combo",
							"key_down",
							"key_up",
							"scroll",
							"drag",
							"get_cursor_position",
							"detect_elements",
							"ocr",
							"open",
							"launch",
							"kill_app",
							"set_value",
							"resolve_approval",
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
					name: "path",
					description:
						"Multi-point polyline [[x,y],...] (≥2 points) for drag; traces every waypoint with the button held. Supersedes startCoordinate/coordinate when present.",
					required: false,
					schema: {
						type: "array",
						items: {
							type: "array",
							items: {
								type: "number",
							},
						},
					},
					descriptionCompressed:
						"Multi-point polyline [[x,y],.] (≥2 points) for drag. traces every waypoint with the button held. Supersedes startCoordinate/coordinate when present.",
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
						"Modifier keys for click_with_modifiers, e.g. ['cmd','shift'] or ['ctrl'].",
					required: false,
					schema: {
						type: "array",
						items: {
							type: "string",
						},
					},
					descriptionCompressed:
						"Modifier keys for click_with_modifiers, e.g. ['cmd','shift'] or ['ctrl'].",
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
					description:
						"Mouse button for click_with_modifiers and mouse_down/mouse_up (default left).",
					required: false,
					schema: {
						type: "string",
						enum: ["left", "middle", "right"],
					},
					descriptionCompressed:
						"Mouse button for click_with_modifiers and mouse_down/mouse_up (default left).",
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
				{
					name: "displayId",
					description:
						"Display for coordinate. Required for coordinate actions on multi-monitor. See computerState displays[].",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed:
						"Display for coordinate. Required for coordinate actions on multi-monitor. See computerState displays[].",
				},
				{
					name: "coordSource",
					description:
						"Coordinate space: logical default matches display.bounds; backing raw retina pixels macOS only.",
					required: false,
					schema: {
						type: "string",
						enum: ["logical", "backing"],
					},
					descriptionCompressed:
						"Coordinate space: logical default matches display.bounds. backing raw retina pixels macOS only.",
				},
				{
					name: "approvalId",
					description:
						"Pending computer-use approval id for action=resolve_approval.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Pending computer-use approval id for action=resolve_approval.",
				},
				{
					name: "approved",
					description: "Approval decision for action=resolve_approval.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed:
						"Approval decision for action=resolve_approval.",
				},
				{
					name: "reason",
					description: "Optional reason for an approval decision.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Optional reason for an approval decision.",
				},
				{
					name: "target",
					description:
						"File path / URL / folder to open with the OS default handler (action=open).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"File path/URL/folder to open with the OS default handler (action=open).",
				},
				{
					name: "app",
					description:
						"Application name or executable path to launch (action=launch).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"app name or executable path to launch (action=launch).",
				},
				{
					name: "appArgs",
					description:
						"Arguments for the launched application (action=launch).",
					required: false,
					schema: {
						type: "array",
						items: {
							type: "string",
						},
					},
					descriptionCompressed:
						"Arguments for the launched app (action=launch).",
				},
			],
			descriptionCompressed:
				"Desktop: screenshot|click|double|right|middle|move|down|up|type|key|scroll|drag|detect|ocr|open|launch|approve",
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
				"APPROVE_COMPUTER_USE",
				"DENY_COMPUTER_USE",
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
							path: "example",
							text: "example",
							modifiers: "example",
							key: "example",
							button: "left",
							clicks: 1,
							scrollDirection: "up",
							scrollAmount: 3,
							displayId: 1,
							coordSource: "logical",
							approvalId: "example",
							approved: false,
							reason: "example",
							target: "example",
							app: "example",
							appArgs: "example",
						},
					},
				},
			],
		},
		{
			name: "COMPUTER_USE_AGENT",
			description:
				"computer_use_agent: autonomous desktop loop for a goal until done or maxSteps. Uses WS6 scene-builder, WS7 Brain+Actor cascade, WS5 multi-monitor coords. Prefer COMPUTER_USE for named single steps; use COMPUTER_USE_AGENT for goal-level screen tasks. Set streamProgress=true to send per-step progress updates to the originating chat.",
			parameters: [
				{
					name: "goal",
					description:
						"Natural-language goal, e.g. click save button in dialog.",
					required: true,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Natural-language goal, e.g. click save button in dialog.",
				},
				{
					name: "maxSteps",
					description:
						"Max Brain->dispatch cycles before giving up. Default 5.",
					required: false,
					schema: {
						type: "number",
						default: 5,
						minimum: 1,
						maximum: 20,
					},
					descriptionCompressed:
						"Max Brain->dispatch cycles before giving up. Default 5.",
				},
				{
					name: "streamProgress",
					description:
						"When true, emit a chat callback after each dispatched step with compact progress and the step kind/rationale.",
					required: false,
					schema: {
						type: "boolean",
						default: false,
					},
					descriptionCompressed:
						"When true, emit a chat callback after each dispatched step with compact progress and the step kind/rationale.",
				},
				{
					name: "maxDurationMs",
					description:
						"Wall-clock budget in ms; the loop aborts before a step that exceeds it.",
					required: false,
					schema: {
						type: "number",
						minimum: 0,
					},
					descriptionCompressed:
						"Wall-clock budget in ms. the loop aborts before a step that exceeds it.",
				},
				{
					name: "imageRetentionLast",
					description:
						"Keep only the N most-recent steps' screenshots in the bounded history (token control).",
					required: false,
					schema: {
						type: "number",
						minimum: 1,
					},
					descriptionCompressed:
						"Keep only the N most-recent steps' screenshots in the bounded history (token control).",
				},
			],
			descriptionCompressed:
				"Autonomous desktop loop: scene -> Brain -> cascade -> click. Pass {goal, maxSteps?, streamProgress?}.",
			similes: ["AUTOMATE_SCREEN", "RUN_COMPUTER_AGENT", "SCREEN_AGENT"],
			exampleCalls: [
				{
					user: "Use COMPUTER_USE_AGENT with the provided parameters.",
					actions: ["COMPUTER_USE_AGENT"],
					params: {
						COMPUTER_USE_AGENT: {
							goal: "example",
							maxSteps: 5,
							streamProgress: false,
							maxDurationMs: 1,
							imageRetentionLast: 1,
						},
					},
				},
			],
		},
		{
			name: "CONFLICT_DETECT",
			description:
				"Scan owner calendar overlaps. Compare proposed window vs owner feed. Subactions: scan_today, scan_week, scan_event_proposal.",
			parameters: [
				{
					name: "action",
					description:
						"Conflict op: scan_today | scan_week | scan_event_proposal.",
					required: false,
					schema: {
						type: "string",
						enum: ["scan_today", "scan_week", "scan_event_proposal"],
					},
					descriptionCompressed:
						"Conflict op: scan_today | scan_week | scan_event_proposal.",
				},
				{
					name: "range",
					description:
						"'today' | 'week' or { start, end } ISO window. Default subaction range.",
					required: false,
					schema: {
						type: "object",
					},
					descriptionCompressed:
						"'today' | 'week' or { start, end } ISO window. Default subaction range.",
				},
				{
					name: "proposal",
					description:
						"scan_event_proposal candidate: { startISO, endISO, attendees? }.",
					required: false,
					schema: {
						type: "object",
					},
					descriptionCompressed:
						"scan_event_proposal candidate: { startISO, endISO, attendees? }.",
				},
			],
			descriptionCompressed:
				"calendar conflicts: scan_today|scan_week|scan_event_proposal; severity warning|hard",
			exampleCalls: [
				{
					user: "Use CONFLICT_DETECT with the provided parameters.",
					actions: ["CONFLICT_DETECT"],
					params: {
						CONFLICT_DETECT: {
							action: "scan_today",
							range: "example",
							proposal: "example",
						},
					},
				},
			],
		},
		{
			name: "CONNECTOR",
			description:
				"Installed connector account state: connect, disconnect, verify, status, list. ",
			parameters: [
				{
					name: "connector",
					description:
						"ConnectorRegistry kind: google, x, telegram, signal, discord, imessage, whatsapp, twilio, calendly, duffel, health, browser_bridge. Optional action=list.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"ConnectorRegistry kind: google, x, telegram, signal, discord, imessage, whatsapp, twilio, calendly, duffel, health, browser_bridge. Optional action=list.",
				},
				{
					name: "action",
					description:
						"connect auth/pairing; disconnect revoke+clear grant; verify active read/send probe; status/list read-only diagnostics. Omit ok: handler LLM-extracts.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"connect auth/pairing. disconnect revoke+clear grant. verify active read/send probe. status/list read-only diagnostics. Omit ok: handler LLM-extracts.",
				},
				{
					name: "side",
					description: "owner | agent. Defaults to owner.",
					required: false,
					schema: {
						type: "string",
						enum: ["owner", "agent"],
					},
					descriptionCompressed: "owner | agent. Defaults to owner.",
				},
				{
					name: "mode",
					description:
						"local | cloud_managed | remote. Default connector-specific.",
					required: false,
					schema: {
						type: "string",
						enum: ["local", "cloud_managed", "remote"],
					},
					descriptionCompressed:
						"local | cloud_managed | remote. Default connector-specific.",
				},
				{
					name: "recentLimit",
					description: "verify only: recent messages/dialogs read limit.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed: "verify only: recent msgs/dialogs read limit.",
				},
				{
					name: "query",
					description:
						"Discord verify only: search text for browser-message reads.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Discord verify only: search text for browser-msg reads.",
				},
				{
					name: "sendTarget",
					description:
						"verify only: destination chat/recipient/channel for self-test send.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"verify only: destination chat/recipient/channel for self-test send.",
				},
				{
					name: "sendMessage",
					description: "verify only: self-test send body.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "verify only: self-test send body.",
				},
				{
					name: "browser",
					description: "browser_bridge connect only: chrome | safari.",
					required: false,
					schema: {
						type: "string",
						enum: ["chrome", "safari"],
					},
					descriptionCompressed:
						"browser_bridge connect only: chrome | safari.",
				},
				{
					name: "profileId",
					description: "browser_bridge connect only: profile id.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "browser_bridge connect only: profile id.",
				},
				{
					name: "profileLabel",
					description: "browser_bridge connect only: profile label.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "browser_bridge connect only: profile label.",
				},
				{
					name: "redirectUrl",
					description: "google/x connect only: OAuth redirect URL override.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"google/x connect only: OAuth redirect URL override.",
				},
			],
			descriptionCompressed:
				"CONNECTOR accounts: connect|disconnect|verify|status|list; plugin install/config -> PLUGIN",
			similes: [
				"CONNECT_GOOGLE",
				"CONNECT_TELEGRAM",
				"CONNECT_DISCORD",
				"DISCONNECT_SERVICE",
				"CHECK_CONNECTION",
				"SERVICE_STATUS",
				"NOTIFICATION_RESOLVE_ENDPOINTS",
			],
			exampleCalls: [
				{
					user: "Use CONNECTOR with the provided parameters.",
					actions: ["CONNECTOR"],
					params: {
						CONNECTOR: {
							connector: "example",
							action: "example",
							side: "owner",
							mode: "local",
							recentLimit: 1,
							query: "example",
							sendTarget: "example",
							sendMessage: "example",
							browser: "chrome",
							profileId: "example",
							profileLabel: "example",
							redirectUrl: "example",
						},
					},
				},
			],
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
			name: "CREATE_AD_SLOT",
			description:
				"Create an ad slot on one of the user's Eliza Cloud apps so it can earn from serving ads. Use when the user wants to monetize an app with ads / sell ad space.",
			parameters: [],
			descriptionCompressed:
				"Create an ad slot on an app to earn from serving ads.",
			similes: [
				"ADD_AD_SLOT",
				"MONETIZE_WITH_ADS",
				"SELL_AD_SPACE",
				"CREATE_AD_PLACEMENT",
			],
		},
		{
			name: "CREATE_APP",
			description:
				"Create a new Eliza Cloud app for the user from a name (and optional description / monetization intent). Use when the user asks to build, make, create, or start a new app.",
			parameters: [],
			descriptionCompressed:
				"Create a new Eliza Cloud app from the user's intent.",
			similes: ["BUILD_APP", "MAKE_APP", "NEW_APP", "CREATE_CLOUD_APP"],
		},
		{
			name: "CREATE_INFLUENCER_PROFILE",
			description:
				"Publish an influencer profile on Eliza Cloud so the agent/user can be booked by advertisers and earn. Use when the user wants to become / list as an influencer or offer promotion services.",
			parameters: [],
			descriptionCompressed:
				"Publish an influencer profile to be booked + earn.",
			similes: [
				"BECOME_INFLUENCER",
				"PUBLISH_INFLUENCER_PROFILE",
				"OFFER_INFLUENCER_SERVICES",
			],
		},
		{
			name: "CREDENTIALS",
			description:
				"Owner-only credentials. Browser autofill + OS password manager (1Password/ProtonPass). ",
			parameters: [
				{
					name: "action",
					description:
						"fill | whitelist_add | whitelist_list | search | list | inject_username | inject_password.",
					required: true,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"fill | whitelist_add | whitelist_list | search | list | inject_username | inject_password.",
				},
				{
					name: "field",
					description:
						"(action=fill) email | password | name | phone | custom.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"(action=fill) email | password | name | phone | custom.",
				},
				{
					name: "domain",
					description:
						"(action=fill|whitelist_add) Domain. fill fallback when url omitted.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"(action=fill|whitelist_add) Domain. fill fallback when url omitted.",
				},
				{
					name: "url",
					description: "(action=fill) Optional tab URL; whitelist enforcement.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"(action=fill) Optional tab URL. whitelist enforcement.",
				},
				{
					name: "intent",
					description: "(action=search) Lookup intent text.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "(action=search) Lookup intent text.",
				},
				{
					name: "query",
					description: "(action=search) Match title, URL, username, tags.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"(action=search) Match title, URL, username, tags.",
				},
				{
					name: "itemId",
					description:
						"(action=inject_username|inject_password) Password manager item id.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"(action=inject_username|inject_password) Password manager item id.",
				},
				{
					name: "limit",
					description: "(action=list) Item limit. Default 20.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed: "(action=list) Item limit. Default 20.",
				},
				{
					name: "confirmed",
					description:
						"true required for whitelist_add and inject_*; owner gate.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed:
						"true required for whitelist_add and inject_*. owner gate.",
				},
			],
			descriptionCompressed:
				"CREDENTIALS fill|whitelist_add|list|search|inject_username|inject_password; clipboard-only",
			exampleCalls: [
				{
					user: "Use CREDENTIALS with the provided parameters.",
					actions: ["CREDENTIALS"],
					params: {
						CREDENTIALS: {
							action: "example",
							field: "example",
							domain: "example",
							url: "example",
							intent: "example",
							query: "example",
							itemId: "example",
							limit: 1,
							confirmed: false,
						},
					},
				},
			],
		},
		{
			name: "DELETE_APP",
			description:
				"Delete an Eliza Cloud app. DESTRUCTIVE: tears down the app's container and tenant database. Requires an explicit confirmation — the first ask only confirms intent. Use when the user asks to delete, remove, or destroy an app.",
			parameters: [
				{
					name: "appName",
					description: "Name, slug, or id of the Cloud app to delete.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Name, slug, or id of the Cloud app to delete.",
				},
				{
					name: "confirm",
					description:
						"Follow-up confirmation. Set true only when the user is confirming the pending delete prompt for this app; set false when canceling.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed:
						"Follow-up confirmation. Set true only when user is confirming the pending delete prompt for this app. set false when canceling.",
				},
			],
			descriptionCompressed:
				"Delete a Cloud app (destructive; two-step confirm).",
			similes: [
				"REMOVE_APP",
				"DELETE_MY_APP",
				"DESTROY_APP",
				"DELETE_CLOUD_APP",
			],
			exampleCalls: [
				{
					user: "Use DELETE_APP with the provided parameters.",
					actions: ["DELETE_APP"],
					params: {
						DELETE_APP: {
							appName: "example",
							confirm: false,
						},
					},
				},
			],
		},
		{
			name: "DEPLOY_APP",
			description:
				"Deploy an existing Eliza Cloud app and confirm it is live (waits for the build to finish and verifies the public URL responds). Use when the user asks to deploy, ship, launch, or go live with an app.",
			parameters: [],
			descriptionCompressed: "Deploy a Cloud app and verify it is live.",
			similes: ["SHIP_APP", "GO_LIVE", "DEPLOY_CLOUD_APP", "LAUNCH_APP"],
		},
		{
			name: "DEPLOY_FRONTEND",
			description:
				"Publish a static frontend (built site directory or files) to an Eliza Cloud app's managed host, served with SEO + analytics. Use when the user asks to host, publish, or deploy the app's website/frontend.",
			parameters: [],
			descriptionCompressed:
				"Publish an app's static frontend to Eliza Cloud managed hosting.",
			similes: [
				"HOST_FRONTEND",
				"PUBLISH_SITE",
				"PUBLISH_FRONTEND",
				"DEPLOY_SITE",
				"HOST_SITE",
			],
		},
		{
			name: "DRAFT_PRESS_RELEASE",
			description:
				"Create a draft press release in Eliza Cloud. Use when the user asks to draft or save a PR/press release for later distribution.",
			parameters: [
				{
					name: "title",
					description: "Press release headline/title.",
					required: true,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Press release headline/title.",
				},
				{
					name: "body",
					description: "Full press release body.",
					required: true,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Full press release body.",
				},
				{
					name: "summary",
					description: "Optional short summary.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Optional short summary.",
				},
				{
					name: "targetRegions",
					description: "Optional target regions such as US or EU.",
					required: false,
					schema: {
						type: "array",
						items: {
							type: "string",
						},
					},
					descriptionCompressed: "Optional target regions such as US or EU.",
				},
			],
			descriptionCompressed: "Create a draft press release.",
			similes: ["CREATE_PRESS_RELEASE", "DRAFT_PR", "WRITE_PRESS_RELEASE"],
			exampleCalls: [
				{
					user: "Use DRAFT_PRESS_RELEASE with the provided parameters.",
					actions: ["DRAFT_PRESS_RELEASE"],
					params: {
						DRAFT_PRESS_RELEASE: {
							title: "example",
							body: "example",
							summary: "example",
							targetRegions: "example",
						},
					},
				},
			],
		},
		{
			name: "DUPLICATE_AD_CAMPAIGN",
			description:
				"Duplicate a Cloud advertising campaign config and creatives into a new draft. Requires structured campaignId; optional name sets the copy name.",
			parameters: [],
			descriptionCompressed: "Duplicate an ad campaign into a draft copy.",
			similes: ["COPY_AD_CAMPAIGN", "CLONE_AD_CAMPAIGN"],
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
			name: "ELIZAOS",
			description:
				"Call the local elizaOS Live capability broker. Supported actions: status, privacy_mode, root_status, open_persistent_storage. This is a constrained OS bridge for the Tails-based live USB; destructive root actions are intentionally not exposed.",
			parameters: [
				{
					name: "action",
					description:
						"Operation: status, privacy_mode, root_status, open_persistent_storage.",
					required: true,
					schema: {
						type: "string",
						enum: [
							"status",
							"privacy_mode",
							"root_status",
							"open_persistent_storage",
						],
					},
					descriptionCompressed:
						"Operation: status, privacy_mode, root_status, open_persistent_storage.",
				},
			],
			descriptionCompressed:
				"elizaOS Live broker: status|privacy_mode|root_status|open_persistent_storage via constrained local OS bridge",
			similes: [
				"ELIZAOS_STATUS",
				"ELIZAOS_PRIVACY_MODE",
				"ELIZAOS_ROOT_STATUS",
				"ELIZAOS_PERSISTENT_STORAGE",
				"OPEN_PERSISTENT_STORAGE",
			],
			exampleCalls: [
				{
					user: "Use ELIZAOS with the provided parameters.",
					actions: ["ELIZAOS"],
					params: {
						ELIZAOS: {
							action: "status",
						},
					},
				},
			],
		},
		{
			name: "ENTITY",
			description:
				"Owner graph: people, orgs, projects, concepts, typed relationships. Ops: create|read|set_identity|set_relationship|log_interaction|merge. Contact CRUD -> CONTACT. Identity/relationships/history -> ENTITY. Follow-up cadence -> SCHEDULED_TASKS. One-off dated call/text reminders -> OWNER_REMINDERS.",
			parameters: [
				{
					name: "action",
					description:
						"ENTITY op: create contact|read rolodex|log_interaction event|set_identity platform handle on Entity|set_relationship typed edge|merge duplicate Entities. Contact CRUD -> CONTACT. Follow-up cadence -> SCHEDULED_TASKS.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["create", "read", "set_identity"],
					descriptionCompressed:
						"ENTITY op: create | read | log_interaction | set_identity | set_relationship | merge",
				},
				{
					name: "intent",
					description: "Free-form intent; infer action if unset.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "free-form intent infer action",
				},
				{
					name: "name",
					description:
						"Contact display name; resolves existing if relationshipId omitted.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "contact display name",
				},
				{
					name: "channel",
					description:
						"Primary channel: email|telegram|discord|signal|sms|twilio_voice|imessage|whatsapp.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["email", "telegram", "imessage"],
					descriptionCompressed:
						"primary channel: email|telegram|discord|signal|sms|twilio_voice|imessage|whatsapp",
				},
				{
					name: "handle",
					description: "Primary channel handle/address.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Primary channel handle/address.",
				},
				{
					name: "email",
					description: "Optional contact email.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Optional contact email.",
				},
				{
					name: "phone",
					description: "Optional contact phone.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Optional contact phone.",
				},
				{
					name: "notes",
					description: "Free-form notes or interaction summary.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Free-form notes or interaction summary.",
				},
				{
					name: "relationshipId",
					description: "Target Relationship id.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Target Relationship id.",
				},
				{
					name: "reason",
					description: "Optional reason note.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Optional reason note.",
				},
				{
					name: "confirmed",
					description: "Optional confirmation flag.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed: "Optional confirmation flag.",
				},
				{
					name: "entityId",
					description:
						"Target Entity id: set_identity target, merge target, stable EntityStore id.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Target Entity id: set_identity target, merge target, stable EntityStore id.",
				},
				{
					name: "platform",
					description:
						"set_identity platform: telegram|slack|email|twitter|phone; pair with handle.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["telegram", "email", "phone", "slack"],
					descriptionCompressed:
						"set_identity platform e.g. telegram|slack|email|twitter|phone",
				},
				{
					name: "displayName",
					description: "Observed identity displayName for set_identity.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Observed identity displayName for set_identity.",
				},
				{
					name: "toEntityId",
					description: "Target Entity id for set_relationship.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Target Entity id for set_relationship.",
				},
				{
					name: "fromEntityId",
					description: "Source Entity id for set_relationship; default 'self'.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Source Entity id for set_relationship. default 'self'.",
				},
				{
					name: "relationshipType",
					description:
						"set_relationship edge type: manages|colleague_of|works_at|partner_of|family_of.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["manages", "colleague_of", "works_at", "partner_of"],
					descriptionCompressed:
						"set_relationship edge type label e.g. manages|colleague_of|works_at|partner_of",
				},
				{
					name: "sourceEntityIds",
					description:
						"merge source Entity ids folded into target; JSON string array.",
					required: false,
					schema: {
						type: "array",
						items: {
							type: "string",
						},
					},
					descriptionCompressed:
						"merge source Entity ids folded into target. JSON string array.",
				},
				{
					name: "evidence",
					description:
						"Evidence string for set_identity/set_relationship observations.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Evidence string for set_identity/set_relationship observations.",
				},
			],
			descriptionCompressed:
				"ENTITY people+relations create|read|set_identity|set_relationship|log_interaction|merge",
			similes: [
				"CONTACTS",
				"ROLODEX",
				"LOG_INTERACTION",
				"ADD_ENTITY",
				"ADD_PERSON",
				"MERGE_ENTITIES",
				"MERGE_CONTACTS",
				"SET_IDENTITY",
			],
			exampleCalls: [
				{
					user: "Use ENTITY with the provided parameters.",
					actions: ["ENTITY"],
					params: {
						ENTITY: {
							action: "create",
							intent: "example",
							name: "example",
							channel: "email",
							handle: "example",
							email: "example",
							phone: "example",
							notes: "example",
							relationshipId: "example",
							reason: "example",
							confirmed: false,
							entityId: "example",
							platform: "telegram",
							displayName: "example",
							toEntityId: "example",
							fromEntityId: "example",
							relationshipType: "manages",
							sourceEntityIds: "example",
							evidence: "example",
						},
					},
				},
			],
		},
		{
			name: "EVAL_CODE",
			description:
				"Run a snippet of JavaScript in an isolated QuickJS sandbox (5s deadline, ",
			parameters: [],
			similes: ["RUN_CODE", "EVALUATE_CODE", "EXEC_JS", "RUN_JS", "EVAL_JS"],
			descriptionCompressed:
				"Run a snippet of JavaScript in an isolated QuickJS sandbox (5s deadline,",
		},
		{
			name: "EXPORT_AD_CAMPAIGN_REPORT",
			description:
				"Export a Cloud advertising campaign performance report. Requires structured campaignId; optional share=true creates a public expiring report link.",
			parameters: [],
			descriptionCompressed:
				"Export or share an ad campaign performance report.",
			similes: ["GET_AD_CAMPAIGN_REPORT", "SHARE_AD_CAMPAIGN_REPORT"],
		},
		{
			name: "FACEWEAR_CONNECT",
			description:
				"Show connection instructions for a facewear device (Meta Quest, XReal, Even Realities, Apple Vision Pro).",
			parameters: [],
			similes: [
				"CONNECT_GLASSES",
				"CONNECT_HEADSET",
				"PAIR_DEVICE",
				"CONNECT_FACEWEAR",
			],
			descriptionCompressed:
				"Show connection instructions for a facewear device (Meta Quest, XReal, Even Realities, Apple Vision Pro).",
		},
		{
			name: "FACEWEAR_DEBUG",
			description: "Show diagnostics for all connected facewear devices.",
			parameters: [],
			similes: [
				"DEBUG_GLASSES",
				"DIAGNOSE_HEADSET",
				"FACEWEAR_DIAGNOSTICS",
				"CHECK_XR",
			],
			descriptionCompressed:
				"Show diagnostics for all connected facewear devices.",
		},
		{
			name: "FILE",
			description:
				"FILE action: read/write/edit/grep/glob/ls. Use target=device for device filesystem reads/writes/ls. Workspace paths absolute unless op defaults to session cwd.",
			parameters: [
				{
					name: "action",
					description: "File operation to run.",
					required: true,
					schema: {
						type: "string",
						enum: ["read", "write", "edit", "grep", "glob", "ls"],
					},
					descriptionCompressed: "File operation to run.",
				},
				{
					name: "target",
					description:
						"Target filesystem. device = relative paths via device bridge; omit for workspace.",
					required: false,
					schema: {
						type: "string",
						enum: ["workspace", "device"],
					},
					descriptionCompressed:
						"Target filesystem. device = relative paths via device bridge. omit for workspace.",
				},
				{
					name: "file_path",
					description: "Absolute path for read/write/edit operations.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Absolute path for read/write/edit operations.",
				},
				{
					name: "path",
					description:
						"File/dir path for grep/glob/ls. Default session cwd where supported.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"File/dir path for grep/glob/ls. Default session cwd where supported.",
				},
				{
					name: "content",
					description: "Full file contents for action=write.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Full file contents for action=write.",
				},
				{
					name: "old_string",
					description: "Exact substring to replace for action=edit.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Exact substring to replace for action=edit.",
				},
				{
					name: "new_string",
					description: "Replacement substring for action=edit.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Replacement substring for action=edit.",
				},
				{
					name: "replace_all",
					description: "For action=edit: replace all matches, not exactly one.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed:
						"For action=edit: replace all matches, not exactly one.",
				},
				{
					name: "pattern",
					description: "Regex for action=grep or glob pattern for action=glob.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Regex for action=grep or glob pattern for action=glob.",
				},
				{
					name: "glob",
					description: "Optional ripgrep glob filter for action=grep.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Optional ripgrep glob filter for action=grep.",
				},
				{
					name: "type",
					description: "Optional ripgrep file type for action=grep.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Optional ripgrep file type for action=grep.",
				},
				{
					name: "output_mode",
					description:
						"For action=grep: content, files_with_matches, or count.",
					required: false,
					schema: {
						type: "string",
						enum: ["content", "files_with_matches", "count"],
					},
					descriptionCompressed:
						"For action=grep: content, files_with_matches, or count.",
				},
				{
					name: "-A",
					description: "For action=grep content mode, lines after each match.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed:
						"For action=grep content mode, lines after each match.",
				},
				{
					name: "-B",
					description: "For action=grep content mode, lines before each match.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed:
						"For action=grep content mode, lines before each match.",
				},
				{
					name: "-C",
					description: "For action=grep content mode, lines around each match.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed:
						"For action=grep content mode, lines around each match.",
				},
				{
					name: "case_insensitive",
					description: "For action=grep, match case-insensitively.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed: "For action=grep, match case-insensitively.",
				},
				{
					name: "multiline",
					description: "For action=grep, enable multiline regex matching.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed:
						"For action=grep, enable multiline regex matching.",
				},
				{
					name: "head_limit",
					description: "For action=grep, truncate output to the first N lines.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed:
						"For action=grep, truncate output to the first N lines.",
				},
				{
					name: "show_line_numbers",
					description: "For action=grep: include 1-based line numbers.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed:
						"For action=grep: include 1-based line numbers.",
				},
				{
					name: "offset",
					description: "For action=read, zero-based line offset.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed: "For action=read, zero-based line offset.",
				},
				{
					name: "limit",
					description: "For action=read, max number of lines to return.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed:
						"For action=read, max number of lines to return.",
				},
				{
					name: "ignore",
					description: "For action=ls, glob patterns to exclude.",
					required: false,
					schema: {
						type: "array",
						items: {
							type: "string",
						},
					},
					descriptionCompressed: "For action=ls, glob patterns to exclude.",
				},
				{
					name: "encoding",
					description:
						"For target=device read/write: utf8 or base64. Default utf8.",
					required: false,
					schema: {
						type: "string",
						enum: ["utf8", "base64"],
					},
					descriptionCompressed:
						"For target=device read/write: utf8 or base64. Default utf8.",
				},
			],
			descriptionCompressed:
				"File operations umbrella: action=read/write/edit/grep/glob/ls, optional target=device.",
			similes: ["FILE_OPERATION", "FILE_IO"],
			exampleCalls: [
				{
					user: "Use FILE with the provided parameters.",
					actions: ["FILE"],
					params: {
						FILE: {
							action: "read",
							target: "workspace",
							file_path: "example",
							path: "example",
							content: "example",
							old_string: "example",
							new_string: "example",
							replace_all: false,
							pattern: "example",
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
							offset: 1,
							limit: 1,
							ignore: "example",
							encoding: "utf8",
						},
					},
				},
			],
		},
		{
			name: "GET_AD_CAMPAIGN_ATTRIBUTION",
			description:
				"Fetch the signed conversion pixel and webhook install instructions for an Eliza Cloud advertising campaign by campaign id.",
			parameters: [],
			descriptionCompressed:
				"Fetch signed conversion pixel/webhook install instructions for a campaign.",
			similes: [
				"GET_CONVERSION_PIXEL",
				"GET_ATTRIBUTION_PIXEL",
				"GET_CAMPAIGN_WEBHOOK",
				"INSTALL_CONVERSION_TRACKING",
			],
		},
		{
			name: "GET_APP",
			description:
				"Show details about one specific Eliza Cloud app the user owns (URL, deployment status, credits used, earnings, users). Use when the user asks about a particular app by name or id.",
			parameters: [],
			descriptionCompressed: "Show details for one Eliza Cloud app by name/id.",
			similes: [
				"APP_DETAILS",
				"SHOW_APP",
				"TELL_ME_ABOUT_APP",
				"APP_INFO",
				"DESCRIBE_APP",
			],
		},
		{
			name: "GET_APP_DEPLOY_STATUS",
			description:
				"Report the deployment status of an Eliza Cloud app (draft / building / live / failed) and its URL. Use when the user asks whether an app is live, deployed, or done building.",
			parameters: [],
			descriptionCompressed:
				"Report an app's deploy status (draft/building/live/failed).",
			similes: [
				"IS_MY_APP_LIVE",
				"DEPLOY_STATUS",
				"APP_DEPLOY_STATUS",
				"IS_APP_DEPLOYED",
			],
		},
		{
			name: "GET_APP_EARNINGS",
			description:
				"Show how much an Eliza Cloud app has earned — withdrawable balance, pending balance, lifetime earnings, and amount withdrawn. Read-only. Use when the user asks how much they've earned or about an app's revenue/earnings.",
			parameters: [],
			descriptionCompressed: "Show a Cloud app's earnings (read-only).",
			similes: [
				"HOW_MUCH_HAVE_I_EARNED",
				"MY_EARNINGS",
				"APP_EARNINGS",
				"SHOW_EARNINGS",
				"CHECK_EARNINGS",
			],
		},
		{
			name: "GET_MEETING_TRANSCRIPT",
			description:
				"Retrieve the live or final transcript of a meeting the notetaker bot attended.",
			parameters: [],
			similes: ["MEETING_NOTES", "SHOW_MEETING_TRANSCRIPT"],
			descriptionCompressed:
				"Retrieve the live or final transcript of a meeting the notetaker bot attended.",
		},
		{
			name: "GIT_PATHOLOGY",
			description:
				"Forensic git-history analysis for a path/glob surface. Returns peaks (peak quality moments), drift inflections (where rot started), and a post-mortem narrative. Use when the user asks 'when did this code get bad', 'where did rot start in X', or 'analyze git pathology for Y'. Actions: report (default), list (show cached reports).",
			parameters: [
				{
					name: "action",
					description:
						"Which gitpathologist action: report or list. Default: report.",
					required: false,
					schema: {
						type: "string",
						enum: ["report", "list"],
					},
					descriptionCompressed:
						"Which gitpathologist action: report or list. Default: report.",
				},
				{
					name: "surface",
					description:
						"Path or glob to analyze (relative to repo root). Required for action=report.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Path or glob to analyze (relative to repo root). Required for action=report.",
				},
				{
					name: "since",
					description:
						"Lookback window. ISO date or relative (e.g. '14d', '4w'). Default '14d'.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Lookback window. ISO date or relative (e.g. '14d', '4w'). Default '14d'.",
				},
				{
					name: "budget",
					description: "Max LLM narration calls per analysis. Default 20.",
					required: false,
					schema: {
						type: "integer",
						minimum: 0,
					},
					descriptionCompressed:
						"Max LLM narration calls per analysis. Default 20.",
				},
				{
					name: "cache",
					description:
						"Cache policy: auto (default), force (recompute), read-only (fail on miss).",
					required: false,
					schema: {
						type: "string",
						enum: ["auto", "force", "read-only"],
					},
					descriptionCompressed:
						"Cache policy: auto (default), force (recompute), read-only (fail on miss).",
				},
			],
			similes: [
				"ANALYZE_GIT_PATHOLOGY",
				"GIT_HEALTH",
				"GIT_FORENSICS",
				"PATHOLOGY_REPORT",
				"CODE_HISTORY_HEALTH",
				"WHERE_DID_ROT_START",
			],
			exampleCalls: [
				{
					user: "Use GIT_PATHOLOGY with the provided parameters.",
					actions: ["GIT_PATHOLOGY"],
					params: {
						GIT_PATHOLOGY: {
							action: "report",
							surface: "example",
							since: "example",
							budget: "example",
							cache: "auto",
						},
					},
				},
			],
			descriptionCompressed:
				"Forensic git-history analysis for a path/glob surface. Returns peaks (peak quality moments), drift inflections (where rot started), and a post-mortem narrative. Use when user asks 'when did this code get bad', 'where did rot start in X', or 'analyze git pathology for Y'. Actions: report (default), list (show cached reports).",
		},
		{
			name: "GITHUB",
			description:
				"GitHub umbrella for pull requests, issues, and notification triage. Use action=pr_list/pr_review/issue_create/issue_assign/issue_close/issue_reopen/issue_comment/issue_label/notification_triage.",
			parameters: [
				{
					name: "action",
					description: "GitHub operation to run.",
					required: true,
					schema: {
						type: "string",
						enum: [
							"pr_list",
							"pr_review",
							"issue_create",
							"issue_assign",
							"issue_close",
							"issue_reopen",
							"issue_comment",
							"issue_label",
							"notification_triage",
						],
					},
					descriptionCompressed: "GitHub operation to run.",
				},
				{
					name: "repo",
					description: "Repository in owner/name form.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Repository in owner/name form.",
				},
				{
					name: "number",
					description: "Pull request or issue number.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed: "Pull request or issue number.",
				},
				{
					name: "state",
					description: "PR state for pr_list: open, closed, or all.",
					required: false,
					schema: {
						type: "string",
						enum: ["open", "closed", "all"],
						default: "open",
					},
					descriptionCompressed: "PR state for pr_list: open, closed, or all.",
				},
				{
					name: "author",
					description: "Optional PR author username filter for pr_list.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Optional PR author username filter for pr_list.",
				},
				{
					name: "review_action",
					description:
						"For action=pr_review: approve, request-changes, or comment.",
					required: false,
					schema: {
						type: "string",
						enum: ["approve", "request-changes", "comment"],
					},
					descriptionCompressed:
						"For action=pr_review: approve, request-changes, or comment.",
				},
				{
					name: "title",
					description: "Issue title for action=issue_create.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Issue title for action=issue_create.",
				},
				{
					name: "body",
					description: "Issue body, issue comment body, or PR review body.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Issue body, issue comment body, or PR review body.",
				},
				{
					name: "assignees",
					description: "GitHub usernames to assign.",
					required: false,
					schema: {
						type: "array",
						items: {
							type: "string",
						},
					},
					descriptionCompressed: "GitHub usernames to assign.",
				},
				{
					name: "labels",
					description: "Labels to apply on issue create or issue_label.",
					required: false,
					schema: {
						type: "array",
						items: {
							type: "string",
						},
					},
					descriptionCompressed:
						"Labels to apply on issue create or issue_label.",
				},
				{
					name: "as",
					description: "Identity to use: agent or user.",
					required: false,
					schema: {
						type: "string",
						enum: ["agent", "user"],
						default: "agent",
					},
					descriptionCompressed: "Identity to use: agent or user.",
				},
				{
					name: "accountId",
					description:
						"Optional GitHub account id from GITHUB_ACCOUNTS. Defaults by role.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Optional GitHub account id from GITHUB_ACCOUNTS. Defaults by role.",
				},
				{
					name: "confirmed",
					description: "Must be true for GitHub write operations.",
					required: false,
					schema: {
						type: "boolean",
						default: false,
					},
					descriptionCompressed: "Must be true for GitHub write operations.",
				},
			],
			descriptionCompressed:
				"GitHub pr_list|pr_review|issue_create|assign|close|reopen|comment|label|triage",
			similes: [
				"GITHUB_PR_OP",
				"GITHUB_ISSUE_OP",
				"GITHUB_NOTIFICATION_TRIAGE",
				"GITHUB_PULL_REQUEST",
				"GITHUB_ISSUE",
				"GITHUB_NOTIFICATIONS",
			],
			exampleCalls: [
				{
					user: "Use GITHUB with the provided parameters.",
					actions: ["GITHUB"],
					params: {
						GITHUB: {
							action: "pr_list",
							repo: "example",
							number: 1,
							state: "open",
							author: "example",
							review_action: "approve",
							title: "example",
							body: "example",
							assignees: "example",
							labels: "example",
							as: "agent",
							accountId: "example",
							confirmed: false,
						},
					},
				},
			],
		},
		{
			name: "HELP_COMMAND",
			description: "Show available commands",
			parameters: [],
			similes: ["/help", "/h", "/?"],
			descriptionCompressed: "Show available commands",
		},
		{
			name: "IDENTIFY_SPEAKER",
			description:
				'Attach a name to the most recently heard, still-unidentified voice so the agent recognizes that person across sessions. Use when the owner says who a recent speaker is ("that was Jill", "this is my friend Sam").',
			parameters: [],
			similes: [
				"NAME_SPEAKER",
				"REMEMBER_VOICE",
				"THIS_IS_SPEAKER",
				"TAG_VOICE",
			],
			descriptionCompressed:
				'Attach a name to the most recently heard, still-unidentified voice so agent recognizes that person across sessions. Use when the owner says who a recent speaker is ("that was Jill", "this is my friend Sam").',
		},
		{
			name: "INBOX",
			description:
				"Inbox: Gmail, Slack, Discord, Telegram, Signal, iMessage, WhatsApp. Merge recency feed and operate the persisted triage queue. Subactions: list, search, summarize, triage (AI-classify new messages into urgent / needs_reply / notify / info / ignore, then return the prioritized queue), reply, snooze, archive, approve.",
			parameters: [
				{
					name: "action",
					description:
						"Inbox op: list | search | summarize | triage (classify new messages with the AI triage classifier, then return the pending queue) | reply | snooze | archive | approve.",
					required: false,
					schema: {
						type: "string",
						enum: [
							"list",
							"search",
							"summarize",
							"triage",
							"reply",
							"snooze",
							"archive",
							"approve",
						],
					},
					descriptionCompressed:
						"Inbox op: list | search | summarize | triage (classify new msgs with the AI triage classifier, then return the pending queue) | reply | snooze | archive | approve.",
				},
				{
					name: "platforms",
					description:
						"Optional platform filter: gmail | slack | discord | telegram | signal | imessage | whatsapp. Default all.",
					required: false,
					schema: {
						type: "array",
						items: {
							type: "string",
						},
					},
					descriptionCompressed:
						"Optional platform filter: gmail | slack | discord | telegram | signal | imessage | whatsapp. Default all.",
				},
				{
					name: "since",
					description: "receivedAt lower bound. ISO-8601.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "receivedAt lower bound. ISO-8601.",
				},
				{
					name: "limit",
					description: "Limit per platform. Default 50.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed: "Limit per platform. Default 50.",
				},
				{
					name: "query",
					description: "Required for search. Free-form query.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Required for search. Free-form query.",
				},
				{
					name: "entryId",
					description:
						"Persisted triage entry id for reply, snooze, archive, or approve.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Persisted triage entry id for reply, snooze, archive, or approve.",
				},
				{
					name: "body",
					description: "Reply body for reply/approve.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Reply body for reply/approve.",
				},
				{
					name: "until",
					description: "Snooze-until timestamp for snooze. ISO-8601.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Snooze-until timestamp for snooze. ISO-8601.",
				},
				{
					name: "confirmed",
					description: "Explicit owner confirmation for sending reply/approve.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed:
						"Explicit owner confirmation for sending reply/approve.",
				},
				{
					name: "classification",
					description:
						"Optional triage queue filter for returned persisted items: ignore | info | notify | needs_reply | urgent. Fresh messages are still classified first.",
					required: false,
					schema: {
						type: "string",
						enum: ["ignore", "info", "notify", "needs_reply", "urgent"],
					},
					descriptionCompressed:
						"Optional triage queue filter for returned persisted items: ignore | info | notify | needs_reply | urgent. Fresh msgs are still classified first.",
				},
				{
					name: "includeSnoozed",
					description:
						"When true, include snoozed triage queue entries in triage reads.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed:
						"When true, include snoozed triage queue entries in triage reads.",
				},
			],
			descriptionCompressed:
				"INBOX list|search|summarize|triage(classify urgent/needs_reply/noise)|reply|snooze|archive|approve gmail|slack|discord|telegram|signal|imessage|whatsapp",
			exampleCalls: [
				{
					user: "Use INBOX with the provided parameters.",
					actions: ["INBOX"],
					params: {
						INBOX: {
							action: "list",
							platforms: "example",
							since: "example",
							limit: 1,
							query: "example",
							entryId: "example",
							body: "example",
							until: "example",
							confirmed: false,
							classification: "ignore",
							includeSnoozed: false,
						},
					},
				},
			],
		},
		{
			name: "JOIN_MEETING",
			description:
				"Send the agent's notetaker bot into a live Google Meet, Microsoft Teams, or Zoom meeting to attend and transcribe it in real time. Use this WHENEVER the message contains a Meet / Teams / Zoom meeting link (meet.google.com, teams.microsoft.com / teams.live.com, zoom.us / app.zoom.us) and the user wants the agent to join, attend, sit in on, cover, take notes on, record, or transcribe that meeting or call. Prefer this over calendar, reminder, scheduling, or plain reply actions when a joinable meeting URL is present — those only schedule or acknowledge, whereas this actually joins the call now. Requires a meeting URL in the message or a meetingUrl parameter.",
			parameters: [],
			similes: [
				"INVITE_TO_MEETING",
				"ATTEND_MEETING",
				"TAKE_MEETING_NOTES",
				"TRANSCRIBE_MEETING",
				"RECORD_MEETING",
				"SEND_NOTETAKER",
				"JOIN_CALL",
			],
			descriptionCompressed:
				"Send agent's notetaker bot into a live Google Meet, Microsoft Teams, or Zoom meeting to attend and transcribe it in real time. Use this WHENEVER the msg contains a Meet/Teams/Zoom meeting link (meet.google.com, teams.microsoft.com/teams.live.com, zoom.us/app.zoom.us) and user wants agent to join, attend, sit in on, cover, take notes on, record, or transcribe that meeting or call. Prefer this over calendar, reminder, scheduling, or plain reply actions when a joinable meeting URL is present - those only schedule or acknowledge, whereas this joins the call now. Requires a meeting URL in the msg or a meetingUrl param.",
		},
		{
			name: "LEAVE_MEETING",
			description:
				"Leave a meeting the notetaker bot is currently attending and finalize its transcript.",
			parameters: [],
			similes: ["EXIT_MEETING", "STOP_MEETING_TRANSCRIPTION"],
			descriptionCompressed:
				"Leave a meeting the notetaker bot is attending and finalize its transcript.",
		},
		{
			name: "LINEAR",
			description:
				"Manage Linear issues/comments/activity. Ops: create_issue, get_issue, update_issue, delete_issue, create_comment, update_comment, delete_comment, list_comments, get_activity, clear_activity, search_issues. Infer op if omitted.",
			parameters: [
				{
					name: "action",
					description:
						"Operation: create_issue, get_issue, update_issue, delete_issue, create_comment, update_comment, delete_comment, list_comments, get_activity, clear_activity, search_issues. Infer if omitted.",
					required: false,
					schema: {
						type: "string",
						enum: [
							"create_issue",
							"get_issue",
							"update_issue",
							"delete_issue",
							"create_comment",
							"update_comment",
							"delete_comment",
							"list_comments",
							"get_activity",
							"clear_activity",
							"search_issues",
						],
					},
					descriptionCompressed:
						"Operation: create_issue, get_issue, update_issue, delete_issue, create_comment, update_comment, delete_comment, list_comments, get_activity, clear_activity, search_issues. Infer if omitted.",
				},
			],
			descriptionCompressed:
				"Linear: issue CRUD, comment CRUD/list, search issues, get/clear activity",
			similes: [
				"LINEAR_ISSUES",
				"LINEAR_COMMENTS",
				"LINEAR_ACTIVITY",
				"LINEAR_SEARCH",
				"MANAGE_LINEAR_ISSUE",
				"MANAGE_LINEAR_ISSUES",
				"COMMENT_LINEAR_ISSUE",
				"LINEAR_WORKFLOW_SEARCH",
			],
			exampleCalls: [
				{
					user: "Use LINEAR with the provided parameters.",
					actions: ["LINEAR"],
					params: {
						LINEAR: {
							action: "create_issue",
						},
					},
				},
			],
		},
		{
			name: "LIST_AD_SLOTS",
			description:
				"List the user's Eliza Cloud ad slots with impressions, clicks, and revenue. Use when the user asks about their ad inventory or ad earnings.",
			parameters: [],
			descriptionCompressed:
				"List the user's ad slots + their impressions/clicks/revenue.",
			similes: ["SHOW_AD_SLOTS", "MY_AD_INVENTORY", "AD_REVENUE"],
		},
		{
			name: "LIST_APP_DOMAINS",
			description:
				"List the custom domains attached to an Eliza Cloud app, with registrar, status, SSL, verification state, and renewal date. Read-only. Use when the user asks what domains an app has or whether a domain is set up/verified.",
			parameters: [
				{
					name: "appName",
					description:
						"Name, slug, or id of the Cloud app whose domains to list.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Name, slug, or id of the Cloud app whose domains to list.",
				},
			],
			descriptionCompressed: "List a Cloud app's attached domains (read-only).",
			similes: [
				"LIST_DOMAINS",
				"SHOW_DOMAINS",
				"MY_DOMAINS",
				"APP_DOMAINS",
				"WHAT_DOMAINS",
			],
			exampleCalls: [
				{
					user: "Use LIST_APP_DOMAINS with the provided parameters.",
					actions: ["LIST_APP_DOMAINS"],
					params: {
						LIST_APP_DOMAINS: {
							appName: "example",
						},
					},
				},
			],
		},
		{
			name: "LIST_CLOUD_APPS",
			description:
				"List the Eliza Cloud apps the user owns (name, URL, deployment status, and credits/earnings when present). Use when the user asks what apps they have, to see their apps, or to list their Cloud apps.",
			parameters: [],
			descriptionCompressed:
				"List the user's Eliza Cloud apps (name/url/status).",
			similes: [
				"MY_APPS",
				"GET_APPS",
				"WHAT_APPS_DO_I_HAVE",
				"MY_CLOUD_APPS",
				"LIST_APPS",
			],
		},
		{
			name: "LIST_FRONTEND_DEPLOYMENTS",
			description:
				"List an Eliza Cloud app's frontend deployment versions and which one is live. Use when the user asks about their app's frontend versions / deploy history.",
			parameters: [],
			descriptionCompressed:
				"List an app's frontend deployment versions + the live one.",
			similes: [
				"SHOW_FRONTEND_VERSIONS",
				"FRONTEND_HISTORY",
				"APP_FRONTEND_DEPLOYMENTS",
			],
		},
		{
			name: "LIST_INFLUENCERS",
			description:
				"Browse active influencer profiles on Eliza Cloud (optionally by niche) so the user can pick one to book for promotion. Use when the user wants to find / hire an influencer.",
			parameters: [],
			descriptionCompressed:
				"Browse influencer profiles to book for promotion.",
			similes: ["BROWSE_INFLUENCERS", "FIND_INFLUENCERS", "SEARCH_INFLUENCERS"],
		},
		{
			name: "LIST_PRESS_RELEASES",
			description:
				"List the user's Eliza Cloud press releases and statuses. Use before choosing a draft to submit or edit.",
			parameters: [],
			descriptionCompressed: "List press release drafts/submissions.",
			similes: ["LIST_PR_DRAFTS", "SHOW_PRESS_RELEASES", "MY_PRESS_RELEASES"],
		},
		{
			name: "MANAGE_BROWSER_BRIDGE",
			description:
				"Owner-only Agent Browser Bridge management for Chrome/Safari. Actions: refresh status/settings/connection, install build+reveal setup, reveal_folder open build folder, open_manager chrome://extensions only on explicit ask. Infer action if omitted.",
			parameters: [
				{
					name: "action",
					description:
						"Bridge action. refresh=status/settings; open_manager only explicit chrome://extensions; install setup; reveal_folder build folder. Infer if omitted.",
					required: false,
					schema: {
						type: "string",
						enum: ["install", "reveal_folder", "open_manager", "refresh"],
					},
					descriptionCompressed:
						"Bridge action. refresh=status/settings. open_manager only explicit chrome://extensions; install setup. reveal_folder build folder. Infer if omitted.",
				},
			],
			descriptionCompressed:
				"Browser Bridge: refresh|install|reveal_folder|open_manager chrome://extensions",
			similes: [
				"INSTALL_BROWSER_BRIDGE",
				"SETUP_BROWSER_BRIDGE",
				"PAIR_BROWSER",
				"CONNECT_BROWSER",
				"ADD_BROWSER_EXTENSION",
				"REVEAL_BROWSER_BRIDGE_FOLDER",
				"OPEN_BROWSER_BRIDGE_FOLDER",
				"SHOW_BROWSER_EXTENSION_FOLDER",
				"OPEN_CHROME_EXTENSIONS",
				"OPEN_BROWSER_BRIDGE_MANAGER",
				"OPEN_EXTENSION_MANAGER",
				"REFRESH_BROWSER_BRIDGE",
				"REFRESH_BROWSER_BRIDGE_CONNECTION",
				"RELOAD_BROWSER_BRIDGE_STATUS",
				"RECONNECT_BROWSER",
				"MANAGE_CHROME_EXTENSION",
				"MANAGE_SAFARI_EXTENSION",
				"BROWSER_BRIDGE_INSTALL",
				"BROWSER_BRIDGE_REVEAL_FOLDER",
				"BROWSER_BRIDGE_OPEN_MANAGER",
				"BROWSER_BRIDGE_REFRESH",
			],
			exampleCalls: [
				{
					user: "Use MANAGE_BROWSER_BRIDGE with the provided parameters.",
					actions: ["MANAGE_BROWSER_BRIDGE"],
					params: {
						MANAGE_BROWSER_BRIDGE: {
							action: "install",
						},
					},
				},
			],
		},
		{
			name: "MCP",
			description:
				"Single MCP entry point. Use action=call_tool to invoke an MCP tool, action=read_resource to read an MCP resource. Cloud runtimes also accept action=search_actions and action=list_connections.",
			parameters: [
				{
					name: "action",
					description:
						"MCP operation: call_tool | read_resource | search_actions | list_connections",
					required: false,
					schema: {
						type: "string",
						enum: [
							"call_tool",
							"read_resource",
							"search_actions",
							"list_connections",
						],
					},
					descriptionCompressed:
						"MCP operation: call_tool | read_resource | search_actions | list_connections",
				},
				{
					name: "serverName",
					description:
						"Optional MCP server name that owns the tool or resource.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Optional MCP server name that owns the tool or resource.",
				},
				{
					name: "toolName",
					description:
						"For action=call_tool: optional exact MCP tool name to call.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"For action=call_tool: optional exact MCP tool name to call.",
				},
				{
					name: "arguments",
					description:
						"For action=call_tool: optional JSON arguments to pass to the selected MCP tool.",
					required: false,
					schema: {
						type: "object",
					},
					descriptionCompressed:
						"For action=call_tool: optional JSON arguments to pass to the selected MCP tool.",
				},
				{
					name: "uri",
					description:
						"For action=read_resource: exact MCP resource URI to read.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"For action=read_resource: exact MCP resource URI to read.",
				},
				{
					name: "query",
					description:
						"Natural-language description of the tool call or resource to select; for action=search_actions, the keyword query.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Natural-language description of the tool call or resource to select. for action=search_actions, the keyword query.",
				},
				{
					name: "platform",
					description:
						"For action=search_actions: filter results to a single connected platform.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"For action=search_actions: filter results to a single connected platform.",
				},
				{
					name: "limit",
					description: "For action=search_actions: maximum results to return.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed:
						"For action=search_actions: max results to return.",
				},
				{
					name: "offset",
					description:
						"For action=search_actions: skip first N results for pagination.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed:
						"For action=search_actions: skip first N results for pagination.",
				},
			],
			descriptionCompressed:
				"MCP call_tool read_resource search_actions list_connections",
			similes: [
				"MCP_ACTION",
				"MCP_ROUTER",
				"USE_MCP",
				"CALL_MCP_TOOL",
				"CALL_TOOL",
				"USE_MCP_TOOL",
				"EXECUTE_MCP_TOOL",
				"RUN_MCP_TOOL",
				"INVOKE_MCP_TOOL",
				"READ_MCP_RESOURCE",
				"READ_RESOURCE",
				"GET_MCP_RESOURCE",
				"FETCH_MCP_RESOURCE",
				"ACCESS_MCP_RESOURCE",
			],
			exampleCalls: [
				{
					user: "Use MCP with the provided parameters.",
					actions: ["MCP"],
					params: {
						MCP: {
							action: "call_tool",
							serverName: "example",
							toolName: "example",
							arguments: "example",
							uri: "example",
							query: "example",
							platform: "example",
							limit: 1,
							offset: 1,
						},
					},
				},
			],
		},
		{
			name: "MODEL_COMMAND",
			description: "Set or show current model",
			parameters: [
				{
					name: "model",
					description: "provider/model or alias",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "provider/model or alias",
				},
			],
			similes: ["/model", "/m"],
			descriptionCompressed: "Set or show current model",
		},
		{
			name: "MODELS_COMMAND",
			description: "List available models",
			parameters: [],
			similes: ["/models"],
			descriptionCompressed: "List available models",
		},
		{
			name: "MUSIC",
			description: "Music action. Use verb-shaped action for everything: ",
			parameters: [
				{
					name: "action",
					description:
						"Verb-shaped subaction. Playback: play, pause, resume, skip, stop. ",
					required: false,
					schema: {
						type: "string",
						enum: [
							"play",
							"pause",
							"resume",
							"skip",
							"stop",
							"queue_view",
							"queue_add",
							"queue_clear",
							"playlist_play",
							"playlist_save",
							"playlist_delete",
							"playlist_add",
							"search",
							"play_query",
							"download",
							"play_audio",
							"set_routing",
							"set_zone",
							"generate",
							"extend",
							"custom_generate",
						],
					},
					descriptionCompressed:
						"Verb-shaped subaction. Playback: play, pause, resume, skip, stop.",
				},
				{
					name: "query",
					description: "Search/play/queue query depending on subaction.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Search/play/queue query depending on subaction.",
				},
				{
					name: "url",
					description: "Direct media URL when using play_audio or play.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Direct media URL when using play_audio or play.",
				},
				{
					name: "playlistName",
					description:
						"Playlist name for playlist_play / playlist_save / playlist_delete / playlist_add.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Playlist name for playlist_play/playlist_save/playlist_delete/playlist_add.",
				},
				{
					name: "song",
					description: "Song query when adding to a playlist.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Song query when adding to a playlist.",
				},
				{
					name: "limit",
					description: "Search result limit (search / library helpers).",
					required: false,
					schema: {
						type: "number",
						minimum: 1,
						maximum: 10,
					},
					descriptionCompressed:
						"Search result limit (search/library helpers).",
				},
				{
					name: "confirmed",
					description:
						"Must be true when the underlying operation requires confirmation.",
					required: false,
					schema: {
						type: "boolean",
						default: false,
					},
					descriptionCompressed:
						"Must be true when the underlying operation requires confirmation.",
				},
				{
					name: "routingAction",
					description:
						"Structured routing action when using set_routing (set_mode, start_route, status, stop_route).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Structured routing action when using set_routing (set_mode, start_route, status, stop_route).",
				},
				{
					name: "mode",
					description: "Routing mode for set_routing operations.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Routing mode for set_routing operations.",
				},
				{
					name: "sourceId",
					description: "Stream/source id for set_routing.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Stream/source id for set_routing.",
				},
				{
					name: "targetIds",
					description: "Routing target ids.",
					required: false,
					schema: {
						type: "array",
						items: {
							type: "string",
						},
					},
					descriptionCompressed: "Routing target ids.",
				},
				{
					name: "targetId",
					description: "Single routing or zone target id.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Single routing or zone target id.",
				},
				{
					name: "prompt",
					description:
						"Suno generation prompt for action=generate/custom_generate.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Suno generation prompt for action=generate/custom_generate.",
				},
				{
					name: "audio_id",
					description: "Existing Suno audio id when action=extend.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Existing Suno audio id when action=extend.",
				},
				{
					name: "duration",
					description:
						"Generation length in seconds for action=generate/custom_generate, or extension seconds for action=extend.",
					required: false,
					schema: {
						type: "number",
						default: 30,
					},
					descriptionCompressed:
						"Generation length in seconds for action=generate/custom_generate, or extension seconds for action=extend.",
				},
				{
					name: "style",
					description: "Style hint for action=custom_generate (Suno).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Style hint for action=custom_generate (Suno).",
				},
				{
					name: "reference_audio",
					description: "Reference audio URL for action=custom_generate (Suno).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Reference audio URL for action=custom_generate (Suno).",
				},
				{
					name: "bpm",
					description: "Target BPM for action=custom_generate (Suno).",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed:
						"Target BPM for action=custom_generate (Suno).",
				},
				{
					name: "key",
					description: "Musical key for action=custom_generate (Suno).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Musical key for action=custom_generate (Suno).",
				},
			],
			descriptionCompressed:
				"Verb-shaped: play/pause/resume/skip/stop, queue_view/queue_add/queue_clear, playlist_play/playlist_save/playlist_delete/playlist_add, search/play_query/download/play_audio, set_routing/set_zone, generate/extend/custom_generate.",
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
					user: "Use MUSIC with the provided parameters.",
					actions: ["MUSIC"],
					params: {
						MUSIC: {
							action: "play",
							query: "example",
							url: "example",
							playlistName: "example",
							song: "example",
							limit: 1,
							confirmed: false,
							routingAction: "example",
							mode: "example",
							sourceId: "example",
							targetIds: "example",
							targetId: "example",
							prompt: "example",
							audio_id: "example",
							duration: 30,
							style: "example",
							reference_audio: "example",
							bpm: 1,
							key: "example",
						},
					},
				},
			],
		},
		{
			name: "NEW_COMMAND",
			description: "Start a new conversation",
			parameters: [],
			similes: ["/new"],
			descriptionCompressed: "Start a new convo",
		},
		{
			name: "OSWORLD",
			description:
				"OSWorld desktop-control router. Bridges OSWorld pyautogui semantics (click, type, key, scroll, drag, screenshot, wait, done, fail) into a structured eliza action.",
			parameters: [
				{
					name: "action",
					description: "OSWorld desktop operation to execute.",
					required: true,
					schema: {
						type: "string",
						enum: [
							"click",
							"double_click",
							"right_click",
							"type",
							"key",
							"scroll",
							"drag",
							"screenshot",
							"wait",
							"done",
							"fail",
						],
					},
					descriptionCompressed: "OSWorld desktop operation to execute.",
				},
				{
					name: "x",
					description: "Pointer x coordinate in screen pixels.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed: "Pointer x coordinate in screen pixels.",
				},
				{
					name: "y",
					description: "Pointer y coordinate in screen pixels.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed: "Pointer y coordinate in screen pixels.",
				},
				{
					name: "text",
					description:
						"For type — the literal text to type into the focused element.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"For type - the literal text to type into the focused element.",
				},
				{
					name: "key",
					description:
						"For key — the key or chord to press (e.g. 'enter', 'ctrl+s').",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"For key - the key or chord to press (e.g. 'enter', 'ctrl+s').",
				},
				{
					name: "direction",
					description: "For scroll/drag — direction of motion.",
					required: false,
					schema: {
						type: "string",
						enum: ["up", "down", "left", "right"],
					},
					descriptionCompressed: "For scroll/drag - direction of motion.",
				},
				{
					name: "amount",
					description:
						"For scroll/drag — magnitude of motion in steps or pixels.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed:
						"For scroll/drag - magnitude of motion in steps or pixels.",
				},
			],
			descriptionCompressed:
				"OSWorld click|double|right|type|key|scroll|drag|screenshot|wait|done|fail",
			similes: [
				"OSWORLD_CLICK",
				"OSWORLD_TYPE",
				"OSWORLD_PRESS",
				"OSWORLD_SCREENSHOT",
				"COMPUTER_USE",
				"COMPUTER_USE_CLICK",
				"COMPUTER_USE_TYPE",
				"PYAUTOGUI",
			],
			exampleCalls: [
				{
					user: "Use OSWORLD with the provided parameters.",
					actions: ["OSWORLD"],
					params: {
						OSWORLD: {
							action: "click",
							x: 1,
							y: 1,
							text: "example",
							key: "example",
							direction: "up",
							amount: 1,
						},
					},
				},
			],
		},
		{
			name: "OWNER_ALARMS",
			description:
				"Owner alarms: create/update/delete/complete/skip/snooze/review alarm reminders.",
			parameters: [],
			descriptionCompressed:
				"owner alarms: action=create|update|delete|complete|skip|snooze|review",
			similes: ["ALARM", "ALARMS", "WAKE_ME", "WAKE_UP"],
		},
		{
			name: "OWNER_DOCUMENTS",
			description:
				"Owner documents: signature requests, approvals, deadlines, portal uploads, ID/form collection, close-out. Ops: request_signature|request_approval|track_deadline|upload_asset|collect_id|close_request.",
			parameters: [
				{
					name: "action",
					description:
						"Document op: request_signature|request_approval|track_deadline|upload_asset|collect_id|close_request.",
					required: false,
					schema: {
						type: "string",
						enum: [
							"request_signature",
							"request_approval",
							"track_deadline",
							"upload_asset",
							"collect_id",
							"close_request",
						],
					},
					descriptionCompressed:
						"Document op: request_signature|request_approval|track_deadline|upload_asset|collect_id|close_request.",
				},
				{
					name: "documentRequestId",
					description:
						"Existing DocumentRequest id; required track_deadline/close_request.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Existing DocumentRequest id. required track_deadline/close_request.",
				},
				{
					name: "requesteeEntityId",
					description:
						"Requestee Entity id; required request_signature/collect_id.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Requestee Entity id. required request_signature/collect_id.",
				},
				{
					name: "documentTitle",
					description: "Short doc label.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Short doc label.",
				},
				{
					name: "deadline",
					description: "Deadline ISO-8601.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Deadline ISO-8601.",
				},
				{
					name: "portalUrl",
					description:
						"Portal URL; required upload_asset, optional collect_id.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Portal URL. required upload_asset, optional collect_id.",
				},
				{
					name: "assetPath",
					description: "Asset path/URL; required upload_asset.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Asset path/URL. required upload_asset.",
				},
				{
					name: "assetKind",
					description:
						"Asset kind deck|headshot|id|form|etc.; required upload_asset/collect_id.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Asset kind deck|headshot|id|form|etc. required upload_asset/collect_id.",
				},
				{
					name: "signatureUrl",
					description: "Optional signing portal URL: DocuSign|HelloSign|etc.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Optional signing portal URL: DocuSign|HelloSign|etc.",
				},
				{
					name: "approvalReason",
					description: "request_approval reason label.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "request_approval reason label.",
				},
				{
					name: "note",
					description: "Free-form DocumentRequest note.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Free-form DocumentRequest note.",
				},
				{
					name: "resolution",
					description:
						"close_request only: completed|expired|cancelled; default completed.",
					required: false,
					schema: {
						type: "string",
						enum: ["completed", "expired", "cancelled"],
					},
					descriptionCompressed:
						"close_request only: completed|expired|cancelled. default completed.",
				},
			],
			descriptionCompressed:
				"OWNER_DOCUMENTS signature|approval|deadline|upload_asset|collect_id|close_request",
			exampleCalls: [
				{
					user: "Use OWNER_DOCUMENTS with the provided parameters.",
					actions: ["OWNER_DOCUMENTS"],
					params: {
						OWNER_DOCUMENTS: {
							action: "request_signature",
							documentRequestId: "example",
							requesteeEntityId: "example",
							documentTitle: "example",
							deadline: "example",
							portalUrl: "example",
							assetPath: "example",
							assetKind: "example",
							signatureUrl: "example",
							approvalReason: "example",
							note: "example",
							resolution: "completed",
						},
					},
				},
			],
		},
		{
			name: "OWNER_FINANCES",
			description:
				"Owner finances: sources, imports, spending, recurring charges, subscriptions.",
			parameters: [
				{
					name: "action",
					description: "Owner finance op.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Owner finance op.",
				},
			],
			descriptionCompressed:
				"owner finances dashboard|sources|csv|transactions|spending|recurring|subscription",
			similes: ["FINANCES"],
			exampleCalls: [
				{
					user: "Use OWNER_FINANCES with the provided parameters.",
					actions: ["OWNER_FINANCES"],
					params: {
						OWNER_FINANCES: {
							action: "example",
						},
					},
				},
			],
		},
		{
			name: "OWNER_GOALS",
			description:
				"Manage the owner's long-horizon life goals. Actions: create, update, delete, review, checkin. Goals carry a horizon (e.g. quarter, year, life), feed routine + reminder generation, and cadenced goals get scheduled check-ins whose responses are recorded via checkin.",
			parameters: [
				{
					name: "action",
					description: "Action: create | update | delete | review.",
					required: true,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Action: create | update | delete | review.",
				},
				{
					name: "id",
					description: "Goal id (update/delete/review).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Goal id (update/delete/review).",
				},
				{
					name: "title",
					description: "Goal title (create/update).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Goal title (create/update).",
				},
				{
					name: "description",
					description: "Longer goal description (create/update).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Longer goal description (create/update).",
				},
				{
					name: "note",
					description: "Owner's check-in note (checkin).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Owner's check-in note (checkin).",
				},
				{
					name: "progress",
					description: "Reported goal progress (checkin).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Reported goal progress (checkin).",
				},
			],
			descriptionCompressed:
				"owner goals: create|update|delete|review|checkin; long-horizon, drives routines",
			similes: [
				"GOALS",
				"LIFE_GOALS",
				"SET_GOAL",
				"UPDATE_GOAL",
				"REVIEW_GOALS",
			],
			exampleCalls: [
				{
					user: "Use OWNER_GOALS with the provided parameters.",
					actions: ["OWNER_GOALS"],
					params: {
						OWNER_GOALS: {
							action: "example",
							id: "example",
							title: "example",
							description: "example",
							note: "example",
							progress: "example",
						},
					},
				},
			],
		},
		{
			name: "OWNER_REMINDERS",
			description:
				"Owner reminders: create/update/delete/complete/skip/snooze/review one-off/recurring.",
			parameters: [],
			descriptionCompressed:
				"owner reminders: action=create|update|delete|complete|skip|snooze|review",
			similes: [
				"REMINDER",
				"REMINDERS",
				"SET_REMINDER",
				"REMIND_ME",
				"REMIND_ME_TO",
				"CREATE_REMINDER",
				"DAILY_REMINDER",
				"RECURRING_REMINDER",
			],
		},
		{
			name: "OWNER_ROUTINES",
			description:
				'Owner habits & routines: save a new recurring habit/routine from chat ("brush my teeth at 8 am and 9 pm every day", "meditate daily") — builds the habit definition + reminder plan; also update/delete/complete/skip/snooze/review; passive schedule inference.',
			parameters: [
				{
					name: "action",
					description:
						"Routine op: create|update|delete|complete|skip|snooze|review|schedule_summary|schedule_inspect.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Routine op: create|update|delete|complete|skip|snooze|review|schedule_summary|schedule_inspect.",
				},
			],
			descriptionCompressed:
				"owner habits/routines: create new habit from chat (daily/weekly times + reminder plan)|update|delete|complete|skip|snooze|review|schedule_summary|inspect",
			similes: [
				"HABIT",
				"HABITS",
				"ROUTINE",
				"ROUTINES",
				"SAVE_HABIT",
				"CREATE_HABIT",
				"NEW_HABIT",
				"DAILY_HABIT",
				"TRACK_HABIT",
				"CREATE_ROUTINE",
				"RECURRING_TASK",
				"CREATE_RECURRING_TASK",
				"DAILY_TASK",
				"WEEKLY_TASK",
			],
			exampleCalls: [
				{
					user: "Use OWNER_ROUTINES with the provided parameters.",
					actions: ["OWNER_ROUTINES"],
					params: {
						OWNER_ROUTINES: {
							action: "example",
						},
					},
				},
			],
		},
		{
			name: "OWNER_TODOS",
			description:
				"Owner todos: create/update/delete/complete/skip/snooze/review personal.",
			parameters: [],
			descriptionCompressed:
				"owner todos: action=create|update|delete|complete|skip|snooze|review",
			similes: [
				"OWNER_TODO",
				"PERSONAL_TODO",
				"PERSONAL_TODOS",
				"PERSONAL_TASK",
			],
		},
		{
			name: "PERPETUAL_MARKET",
			description:
				"Use registered perpetual market providers. target selects the provider; Hyperliquid is registered today. action=read reads public state with kind: status, markets, market, positions, or funding. action=place_order reports trading readiness; signed order placement is disabled in this read-only app.",
			parameters: [
				{
					name: "target",
					description: "Perpetual market provider.",
					required: false,
					schema: {
						type: "string",
						enum: ["hyperliquid"],
						default: "hyperliquid",
					},
					descriptionCompressed: "Perpetual market provider.",
				},
				{
					name: "action",
					description: "Perpetual market operation: read or place_order.",
					required: false,
					schema: {
						type: "string",
						enum: ["read", "place_order"],
					},
					descriptionCompressed:
						"Perpetual market operation: read or place_order.",
				},
				{
					name: "subaction",
					description: "Alias for action (read | place_order | place-order).",
					required: false,
					schema: {
						type: "string",
						enum: ["read", "place_order", "place-order"],
					},
					descriptionCompressed:
						"Alias for action (read | place_order | place-order).",
				},
				{
					name: "kind",
					description:
						"read only: status | markets | market | positions | funding.",
					required: false,
					schema: {
						type: "string",
						enum: ["status", "markets", "market", "positions", "funding"],
					},
					descriptionCompressed:
						"read only: status | markets | market | positions | funding.",
				},
				{
					name: "coin",
					description: "market only: Hyperliquid coin/asset symbol (e.g. BTC).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"market only: Hyperliquid coin/asset symbol (e.g. BTC).",
				},
				{
					name: "side",
					description: "place_order only: intended side, buy or sell.",
					required: false,
					schema: {
						type: "string",
						enum: ["buy", "sell"],
					},
					descriptionCompressed:
						"place_order only: intended side, buy or sell.",
				},
				{
					name: "asset",
					description: "place_order only: Hyperliquid asset symbol.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "place_order only: Hyperliquid asset symbol.",
				},
				{
					name: "size",
					description: "place_order only: intended order size.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed: "place_order only: intended order size.",
				},
			],
			descriptionCompressed:
				"Perpetual market router: target hyperliquid; action read or place_order.",
			exampleCalls: [
				{
					user: "Use PERPETUAL_MARKET with the provided parameters.",
					actions: ["PERPETUAL_MARKET"],
					params: {
						PERPETUAL_MARKET: {
							target: "hyperliquid",
							action: "read",
							subaction: "read",
							kind: "status",
							coin: "example",
							side: "buy",
							asset: "example",
							size: 1,
						},
					},
				},
			],
		},
		{
			name: "PERSONAL_ASSISTANT",
			description:
				"Owner personal-assistant workflows: action=book_travel travel booking; action=scheduling negotiation; action=sign_document signature, owner approval queue.",
			parameters: [
				{
					name: "action",
					description: "Assistant op: book_travel|scheduling|sign_document.",
					required: true,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Assistant op: book_travel|scheduling|sign_document.",
				},
			],
			descriptionCompressed:
				"personal assistant workflows: action=book_travel|scheduling|sign_document",
			similes: [
				"ASSISTANT",
				"SCHEDULING",
				"SIGN_DOCUMENT",
				"DOCUSIGN",
				"TRAVEL_CAPTURE_PREFERENCES",
				"TRAVEL_BOOK_FLIGHT",
				"TRAVEL_BOOK_HOTEL",
				"TRAVEL_SYNC_ITINERARY_TO_CALENDAR",
				"TRAVEL_REBOOK_AFTER_CONFLICT",
			],
			exampleCalls: [
				{
					user: "Use PERSONAL_ASSISTANT with the provided parameters.",
					actions: ["PERSONAL_ASSISTANT"],
					params: {
						PERSONAL_ASSISTANT: {
							action: "example",
						},
					},
				},
			],
		},
		{
			name: "PRIORITIZE",
			description:
				"Rank owner open todos, message threads, pending decisions by urgency × importance. LLM pass. Subactions: rank_todos, rank_threads, rank_decisions.",
			parameters: [
				{
					name: "action",
					description:
						"Prioritize op: rank_todos | rank_threads | rank_decisions.",
					required: false,
					schema: {
						type: "string",
						enum: ["rank_todos", "rank_threads", "rank_decisions"],
					},
					descriptionCompressed:
						"Prioritize op: rank_todos | rank_threads | rank_decisions.",
				},
				{
					name: "subject",
					description:
						"Alt selector: todos | threads | decisions. Maps to subaction.",
					required: false,
					schema: {
						type: "string",
						enum: ["todos", "threads", "decisions"],
					},
					descriptionCompressed:
						"Alt selector: todos | threads | decisions. Maps to subaction.",
				},
				{
					name: "topN",
					description: "Top item count. Default 5.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed: "Top item count. Default 5.",
				},
				{
					name: "criteria",
					description: "Owner weighting criteria.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Owner weighting criteria.",
				},
			],
			descriptionCompressed:
				"prioritize: rank_todos|rank_threads|rank_decisions; topN ranking by urgency × importance",
			exampleCalls: [
				{
					user: "Use PRIORITIZE with the provided parameters.",
					actions: ["PRIORITIZE"],
					params: {
						PRIORITIZE: {
							action: "rank_todos",
							subject: "todos",
							topN: 1,
							criteria: "example",
						},
					},
				},
			],
		},
		{
			name: "PROXY_STATUS",
			description:
				"Report current Anthropic proxy status: mode (inline/shared/off), bound URL, ",
			parameters: [],
			descriptionCompressed:
				"anthropic-proxy-status: mode, url, listening, requests, token expiry, upstream check",
			similes: [
				"ANTHROPIC_PROXY_STATUS",
				"CLAUDE_MAX_PROXY_STATUS",
				"CHECK_PROXY",
			],
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
			name: "REGENERATE_APP_API_KEY",
			description:
				"Regenerate (rotate) an Eliza Cloud app's API key. SECURITY-SENSITIVE: invalidates the current key immediately. Requires an explicit confirmation — the first ask only confirms intent. Use when the user asks to rotate, regenerate, reset, or get a new API key for an app.",
			parameters: [
				{
					name: "appName",
					description:
						"Name, slug, or id of the Cloud app whose API key to rotate.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Name, slug, or id of the Cloud app whose API key to rotate.",
				},
				{
					name: "confirm",
					description:
						"Follow-up confirmation. Set true only when the user is confirming the pending API-key rotation prompt for this app; set false when canceling.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed:
						"Follow-up confirmation. Set true only when user is confirming the pending API-key rotation prompt for this app. set false when canceling.",
				},
			],
			descriptionCompressed:
				"Rotate a Cloud app's API key (security; two-step confirm).",
			similes: [
				"ROTATE_KEY",
				"NEW_API_KEY",
				"REGENERATE_API_KEY",
				"RESET_API_KEY",
				"ROTATE_APP_KEY",
			],
			exampleCalls: [
				{
					user: "Use REGENERATE_APP_API_KEY with the provided parameters.",
					actions: ["REGENERATE_APP_API_KEY"],
					params: {
						REGENERATE_APP_API_KEY: {
							appName: "example",
							confirm: false,
						},
					},
				},
			],
		},
		{
			name: "RESET_COMMAND",
			description: "Reset session state",
			parameters: [],
			similes: ["/reset"],
			descriptionCompressed: "Reset session state",
		},
		{
			name: "RESOLVE_REQUEST",
			description:
				"Approve/reject pending owner-confirmation action: send_email, send_message, book_travel, voice_call, etc. ",
			parameters: [
				{
					name: "action",
					description: "approve | reject.",
					required: false,
					schema: {
						type: "string",
						enum: ["approve", "reject"],
					},
					descriptionCompressed: "approve | reject.",
				},
				{
					name: "requestId",
					description:
						"Approval request id. Optional when user references pending request.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Approval request id. Optional when user references pending request.",
				},
				{
					name: "reason",
					description: "Optional approve/reject reason, user language.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Optional approve/reject reason, user language.",
				},
			],
			descriptionCompressed:
				"approve|reject queue; requestId optional; send_email|send_message|book_travel|voice_call",
			similes: [
				"APPROVE",
				"REJECT",
				"CONFIRM",
				"DENY",
				"YES_DO_IT",
				"NO_DONT",
				"ACCEPT_REQUEST",
				"DECLINE_REQUEST",
				"ADMIN_REJECT_APPROVAL",
				"REJECT_APPROVAL",
				"DENY_APPROVAL",
				"DECLINE_APPROVAL",
			],
			exampleCalls: [
				{
					user: "Use RESOLVE_REQUEST with the provided parameters.",
					actions: ["RESOLVE_REQUEST"],
					params: {
						RESOLVE_REQUEST: {
							action: "approve",
							requestId: "example",
							reason: "example",
						},
					},
				},
			],
		},
		{
			name: "ROLLBACK_FRONTEND",
			description:
				"Roll an Eliza Cloud app's frontend back to a previous deployment (make an earlier version live again). Use when the user wants to revert / undo / roll back an app's frontend to an earlier version.",
			parameters: [
				{
					name: "appName",
					description: "Name/slug/id of the app to roll back.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Name/slug/id of the app to roll back.",
				},
				{
					name: "version",
					description:
						"Specific frontend version number to restore. Omit to roll back to the previous one.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed:
						"Specific frontend version number to restore. Omit to roll back to the previous one.",
				},
			],
			descriptionCompressed:
				"Roll an app's frontend back to a previous version.",
			similes: [
				"REVERT_FRONTEND",
				"RESTORE_FRONTEND_VERSION",
				"UNDO_FRONTEND_DEPLOY",
			],
			exampleCalls: [
				{
					user: "Use ROLLBACK_FRONTEND with the provided parameters.",
					actions: ["ROLLBACK_FRONTEND"],
					params: {
						ROLLBACK_FRONTEND: {
							appName: "example",
							version: 1,
						},
					},
				},
			],
		},
		{
			name: "SCHEDULED_TASKS",
			description:
				"Low-level admin surface over LifeOps ScheduledTask records. Kinds: reminder, checkin, followup, approval, recap, watcher, output, custom. Ops: list|get|create|update|snooze|skip|complete|acknowledge|dismiss|cancel|reopen|history. create schedules a raw task and requires an explicit structural trigger — it is NOT the flow for saving a habit/routine/recurring personal reminder the owner asks for in chat; OWNER_ROUTINES / OWNER_REMINDERS action=create own that (definition + reminder plan).",
			parameters: [
				{
					name: "action",
					description:
						"ScheduledTask op: list|get|create|update|snooze|skip|complete|acknowledge|dismiss|cancel|reopen|history.",
					required: false,
					schema: {
						type: "string",
						enum: [
							"list",
							"get",
							"create",
							"update",
							"snooze",
							"skip",
							"complete",
							"acknowledge",
							"dismiss",
							"cancel",
							"reopen",
							"history",
						],
					},
					descriptionCompressed:
						"ScheduledTask op: list|get|create|update|snooze|skip|complete|acknowledge|dismiss|cancel|reopen|history.",
				},
				{
					name: "taskId",
					description:
						"Target taskId for get/update/snooze/skip/complete/acknowledge/dismiss/cancel/reopen/history.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Target taskId for get/update/snooze/skip/complete/acknowledge/dismiss/cancel/reopen/history.",
				},
				{
					name: "kind",
					description:
						"ScheduledTaskKind create/filter: reminder|checkin|followup|approval|recap|watcher|output|custom.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"ScheduledTaskKind create/filter: reminder|checkin|followup|approval|recap|watcher|output|custom.",
				},
				{
					name: "status",
					description:
						"List status filter string|string[]: scheduled|fired|acknowledged|completed|skipped|expired|failed|dismissed.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"List status filter string|string[]: scheduled|fired|acknowledged|completed|skipped|expired|failed|dismissed.",
				},
				{
					name: "subjectKind",
					description:
						"ScheduledTaskSubject.kind: entity|relationship|thread|document|calendar_event|self.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"ScheduledTaskSubject.kind: entity|relationship|thread|document|calendar_event|self.",
				},
				{
					name: "subjectId",
					description: "ScheduledTaskSubject.id paired with subjectKind.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"ScheduledTaskSubject.id paired with subjectKind.",
				},
				{
					name: "ownerVisibleOnly",
					description: "true: list ownerVisible tasks only.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed: "true: list ownerVisible tasks only.",
				},
				{
					name: "promptInstructions",
					description:
						"create-only: promptInstructions stored on ScheduledTask.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"create-only: promptInstructions stored on ScheduledTask.",
				},
				{
					name: "trigger",
					description:
						"create-only: ScheduledTaskTrigger once/cron/interval/relative_to_anchor/during_window/event/manual/after_task.",
					required: false,
					schema: {
						type: "object",
					},
					descriptionCompressed:
						"create-only: ScheduledTaskTrigger once/cron/interval/relative_to_anchor/during_window/event/manual/after_task.",
				},
				{
					name: "contextRequest",
					description:
						"create-only: contextRequest facts/entities/relationships/recent task states/event payload.",
					required: false,
					schema: {
						type: "object",
					},
					descriptionCompressed:
						"create-only: contextRequest facts/entities/relationships/recent task states/event payload.",
				},
				{
					name: "shouldFire",
					description:
						"create-only: structural shouldFire gates; gate refs, no prompt text conditions.",
					required: false,
					schema: {
						type: "object",
					},
					descriptionCompressed:
						"create-only: structural shouldFire gates. gate refs, no prompt text conditions.",
				},
				{
					name: "completionCheck",
					description:
						"create-only: structural completionCheck: user_replied_within|user_acknowledged|subject_updated|health_signal_observed.",
					required: false,
					schema: {
						type: "object",
					},
					descriptionCompressed:
						"create-only: structural completionCheck: user_replied_within|user_acknowledged|subject_updated|health_signal_observed.",
				},
				{
					name: "output",
					description:
						"create-only: output destination/target, e.g. channel -> in_app:<roomId>.",
					required: false,
					schema: {
						type: "object",
					},
					descriptionCompressed:
						"create-only: output destination/target, e.g. channel -> in_app:<roomId>.",
				},
				{
					name: "pipeline",
					description:
						"create-only: pipeline child ScheduledTask refs: onComplete|onSkip|onFail.",
					required: false,
					schema: {
						type: "object",
					},
					descriptionCompressed:
						"create-only: pipeline child ScheduledTask refs: onComplete|onSkip|onFail.",
				},
				{
					name: "escalation",
					description: "create-only: escalation ladder/channel steps.",
					required: false,
					schema: {
						type: "object",
					},
					descriptionCompressed:
						"create-only: escalation ladder/channel steps.",
				},
				{
					name: "metadata",
					description: "create-only: structured task metadata.",
					required: false,
					schema: {
						type: "object",
					},
					descriptionCompressed: "create-only: structured task metadata.",
				},
				{
					name: "idempotencyKey",
					description: "create-only: stable dedupe key for repeated schedules.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"create-only: stable dedupe key for repeated schedules.",
				},
				{
					name: "priority",
					description: "create-only: low|medium|high; default medium.",
					required: false,
					schema: {
						type: "string",
						enum: ["low", "medium", "high"],
					},
					descriptionCompressed:
						"create-only: low|medium|high. default medium.",
				},
				{
					name: "respectsGlobalPause",
					description: "create-only: true skips during global pause.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed: "create-only: true skips during global pause.",
				},
				{
					name: "ownerVisible",
					description: "create-only: true shows in owner views.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed: "create-only: true shows in owner views.",
				},
				{
					name: "source",
					description:
						"create-only: source default_pack|user_chat|first_run|plugin.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"create-only: source default_pack|user_chat|first_run|plugin.",
				},
				{
					name: "minutes",
					description: "snooze-only: defer next fire N minutes.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed: "snooze-only: defer next fire N minutes.",
				},
				{
					name: "untilIso",
					description: "snooze-only: defer next fire until ISO-8601 timestamp.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"snooze-only: defer next fire until ISO-8601 timestamp.",
				},
				{
					name: "reason",
					description:
						"skip/complete/acknowledge/dismiss/reopen: reason on state log.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"skip/complete/acknowledge/dismiss/reopen: reason on state log.",
				},
				{
					name: "patch",
					description:
						"update-only: shallow patch editable ScheduledTask fields.",
					required: false,
					schema: {
						type: "object",
					},
					descriptionCompressed:
						"update-only: shallow patch editable ScheduledTask fields.",
				},
				{
					name: "sinceIso",
					description: "history-only: occurredAtIso >= ISO-8601.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "history-only: occurredAtIso >= ISO-8601.",
				},
				{
					name: "untilHistoryIso",
					description: "history-only: occurredAtIso <= ISO-8601.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "history-only: occurredAtIso <= ISO-8601.",
				},
				{
					name: "includeRollups",
					description:
						"history-only: include daily rollups; default false/raw only.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed:
						"history-only: include daily rollups. default false/raw only.",
				},
				{
					name: "limit",
					description: "history-only: row cap (default 100).",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed: "history-only: row cap (default 100).",
				},
			],
			descriptionCompressed:
				"low-level scheduled-item admin list|get|create|update|snooze|skip|complete|ack|dismiss|cancel|history; NOT new-habit/routine creation (-> OWNER_ROUTINES/OWNER_REMINDERS create)",
			exampleCalls: [
				{
					user: "Use SCHEDULED_TASKS with the provided parameters.",
					actions: ["SCHEDULED_TASKS"],
					params: {
						SCHEDULED_TASKS: {
							action: "list",
							taskId: "example",
							kind: "example",
							status: "example",
							subjectKind: "example",
							subjectId: "example",
							ownerVisibleOnly: false,
							promptInstructions: "example",
							trigger: "example",
							contextRequest: "example",
							shouldFire: "example",
							completionCheck: "example",
							output: "example",
							pipeline: "example",
							escalation: "example",
							metadata: "example",
							idempotencyKey: "example",
							priority: "low",
							respectsGlobalPause: false,
							ownerVisible: false,
							source: "example",
							minutes: 1,
							untilIso: "example",
							reason: "example",
							patch: "example",
							sinceIso: "example",
							untilHistoryIso: "example",
							includeRollups: false,
							limit: 1,
						},
					},
				},
			],
		},
		{
			name: "SET_AD_CAMPAIGN_DAYPARTING",
			description:
				"Set a Cloud advertising campaign's dayparting delivery schedule. Requires structured campaignId and dayparting { timezone, windows } parameters.",
			parameters: [],
			descriptionCompressed:
				"Set dayparting delivery windows for an ad campaign.",
			similes: [
				"SCHEDULE_AD_CAMPAIGN",
				"SET_AD_DELIVERY_WINDOWS",
				"UPDATE_AD_DAYPARTING",
			],
		},
		{
			name: "SETUP_XR_RUNTIME",
			description:
				"Check whether a desktop OpenXR runtime (Monado/SteamVR/WMR) is installed for WebXR, and show how to install one if not.",
			parameters: [],
			similes: [
				"INSTALL_OPENXR",
				"SETUP_VR_RUNTIME",
				"SETUP_AR_RUNTIME",
				"CHECK_VR_RUNTIME",
				"FIX_WEBXR",
			],
			descriptionCompressed:
				"Check whether a desktop OpenXR runtime (Monado/SteamVR/WMR) is installed for WebXR, and show how to install one if not.",
		},
		{
			name: "SHELL",
			description:
				"Shell action. action=run executes command via local shell. action=clear_history clears conversation command history. action=view_history returns recent commands. command required only for run. Prefer bounded commands; avoid recursive whole-filesystem scans unless explicitly requested. Omit cwd unless the user supplied an exact directory or the session was explicitly moved; do not invent cwd from remembered repo paths. For questions about the currently running agent/runtime/source, use the default session cwd and inspect current process/service evidence before reporting git metadata. For JSON API inspection, prefer jq or node; if Python is needed, call python3 rather than assuming a python alias exists. For public unauthenticated API reads, quote URLs and prefer stable no-key endpoints; avoid deprecated, region-blocked, or exchange-gated endpoints when a neutral data API can answer the same question. For crypto spot prices, prefer neutral no-key APIs such as CoinGecko simple price or Coinbase spot before exchange-gated APIs; do not start with legacy Coindesk or Binance when the same value can be fetched elsewhere. If a command exits 0 with empty stdout/stderr, the command produced no output; try another source or parser when data is still needed instead of claiming the shell did not return output. For disk checks, use df for every requested mount/path (for root plus home: df -h / /home) plus targeted du on likely cleanup directories; when asked for cleanup candidates, inspect one readable largest directory one level deeper before ranking candidates. Use separators that still allow later inspection commands to run when du hits expected permission-denied paths.",
			parameters: [
				{
					name: "action",
					description: "Shell operation: run | clear_history | view_history.",
					required: false,
					schema: {
						type: "string",
						enum: ["run", "clear_history", "view_history"],
					},
					descriptionCompressed:
						"Shell operation: run | clear_history | view_history.",
				},
				{
					name: "command",
					description:
						"For action=run: shell command, executed via /bin/bash -c. Keep routine inspection commands bounded; avoid broad scans like du -sh /* when a targeted path is enough. For JSON API data, prefer jq or node; use python3, not python, unless the environment explicitly shows python exists. For public unauthenticated API reads, quote URLs and prefer stable no-key endpoints; avoid deprecated, region-blocked, or exchange-gated endpoints when a neutral data API can answer the same question. For crypto spot prices, prefer CoinGecko simple price or Coinbase spot before exchange-gated APIs; avoid legacy Coindesk and Binance when a neutral source can answer. If stdout/stderr are marked empty, the command produced no output; try a different command/source when the user still needs a value. Include every requested path in df, e.g. df -h / /home. For cleanup candidates, follow the first bounded du result with a targeted du on the largest readable directory before answering; avoid && between du probes when permission-denied paths are expected.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"For action=run: shell command, executed via /bin/bash -c. Keep routine inspection commands bounded. avoid broad scans like du -sh /* when a targeted path is enough. For JSON API data, prefer jq or node. use python3, not python, unless the environment explicitly shows python exists. For public unauthenticated API reads, quote URLs and prefer stable no-key endpoints. avoid deprecated, region-blocked, or exchange-gated endpoints when a neutral data API can answer the same question. For crypto spot prices, prefer CoinGecko simple price or Coinbase spot before exchange-gated APIs. avoid legacy Coindesk and Binance when a neutral source can answer. If stdout/stderr are marked empty, the command produced no output. try a different command/source when user still needs a value. Include every requested path in df, e.g. df -h//home. For cleanup candidates, follow the first bounded du result with a targeted du on the largest readable directory before answering. avoid && between du probes when permission-denied paths are expected.",
				},
				{
					name: "description",
					description: "5-10 word human-readable command summary.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "5-10 word human-readable command summary.",
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
						"Absolute cwd; must not resolve under blocked path. Omit unless the user supplied this exact directory or the session was explicitly moved; default session cwd is safer than remembered paths.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Absolute cwd. must not resolve under blocked path. Omit unless user supplied this exact directory or the session was explicitly moved. default session cwd is safer than remembered paths.",
				},
				{
					name: "limit",
					description: "For action=view_history: max recorded commands.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed:
						"For action=view_history: max recorded commands.",
				},
			],
			descriptionCompressed: "Run shell commands; clear/view shell history.",
			similes: ["BASH", "EXEC", "RUN_COMMAND"],
			exampleCalls: [
				{
					user: "Use SHELL with the provided parameters.",
					actions: ["SHELL"],
					params: {
						SHELL: {
							action: "run",
							command: "example",
							description: "example",
							timeout: 1,
							cwd: "example",
							limit: 1,
						},
					},
				},
			],
		},
		{
			name: "SHOPIFY",
			description:
				"Manage a Shopify store. Actions: search (read-only catalog browsing across products, orders, and customers), products (CRUD on products), inventory (stock adjustments), orders (list/update orders), customers (CRUD on customers). Action is inferred from the message text when not explicitly provided.",
			parameters: [
				{
					name: "action",
					description:
						"Operation to perform. One of: search, products, inventory, orders, customers. Inferred from message text when omitted.",
					required: false,
					schema: {
						type: "string",
						enum: ["search", "products", "inventory", "orders", "customers"],
					},
					descriptionCompressed:
						"Operation to perform. One of: search, products, inventory, orders, customers. Inferred from msg text when omitted.",
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
					name: "scope",
					description:
						"Search scope for action=search: all, products, orders, or customers.",
					required: false,
					schema: {
						type: "string",
						enum: ["all", "products", "orders", "customers"],
					},
					descriptionCompressed:
						"Search scope for action=search: all, products, orders, or customers.",
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
			descriptionCompressed:
				"Shopify: search, products, inventory, orders, customers.",
			similes: [
				"MANAGE_SHOPIFY_PRODUCTS",
				"MANAGE_SHOPIFY_INVENTORY",
				"MANAGE_SHOPIFY_ORDERS",
				"MANAGE_SHOPIFY_CUSTOMERS",
				"LIST_PRODUCTS",
				"CREATE_PRODUCT",
				"UPDATE_PRODUCT",
				"SEARCH_PRODUCTS",
				"CHECK_INVENTORY",
				"ADJUST_INVENTORY",
				"CHECK_STOCK",
				"UPDATE_STOCK",
				"LIST_ORDERS",
				"CHECK_ORDERS",
				"FULFILL_ORDER",
				"ORDER_STATUS",
				"LIST_CUSTOMERS",
				"FIND_CUSTOMER",
				"SEARCH_CUSTOMERS",
			],
			exampleCalls: [
				{
					user: "Use SHOPIFY with the provided parameters.",
					actions: ["SHOPIFY"],
					params: {
						SHOPIFY: {
							action: "search",
							query: "example",
							scope: "all",
							limit: 1,
						},
					},
				},
			],
		},
		{
			name: "SKILL",
			description:
				"Manage skill catalog. Ops: search, details, sync, toggle, install, uninstall. Use USE_SKILL to invoke enabled skill.",
			parameters: [
				{
					name: "action",
					description:
						"Operation: search, details, sync, toggle, install, uninstall. Infer if omitted.",
					required: false,
					schema: {
						type: "string",
						enum: [
							"search",
							"details",
							"sync",
							"toggle",
							"install",
							"uninstall",
						],
					},
					descriptionCompressed:
						"Operation: search, details, sync, toggle, install, uninstall. Infer if omitted.",
				},
				{
					name: "slug",
					description: "Skill slug for details, install, toggle, or uninstall.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Skill slug for details, install, toggle, or uninstall.",
				},
				{
					name: "enabled",
					description: "For action=toggle: true enables; false disables.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed:
						"For action=toggle: true enables. false disables.",
				},
			],
			descriptionCompressed:
				"Skill catalog: search, details, sync, toggle, install, uninstall.",
			similes: [
				"MANAGE_SKILL",
				"MANAGE_SKILLS",
				"SKILL_CATALOG",
				"SKILLS",
				"AGENT_SKILL",
				"AGENT_SKILLS",
				"INSTALL_SKILL",
				"UNINSTALL_SKILL",
				"SEARCH_SKILLS",
				"SYNC_SKILL_CATALOG",
				"TOGGLE_SKILL",
			],
			exampleCalls: [
				{
					user: "Use SKILL with the provided parameters.",
					actions: ["SKILL"],
					params: {
						SKILL: {
							action: "search",
							slug: "example",
							enabled: false,
						},
					},
				},
			],
		},
		{
			name: "START_TRANSCRIPTION",
			description:
				"Start long-form voice transcription (record-only) on the user's device. Use when the user asks to start transcribing/recording a conversation or meeting.",
			parameters: [],
			similes: ["BEGIN_TRANSCRIPTION", "START_RECORDING", "RECORD_TRANSCRIPT"],
			descriptionCompressed:
				"Start long-form voice transcription (record-only) on user's device. Use when user asks to start transcribing/recording a convo or meeting.",
		},
		{
			name: "STATUS_COMMAND",
			description: "Show current session status",
			parameters: [],
			similes: ["/status", "/s"],
			descriptionCompressed: "Show current session status",
		},
		{
			name: "STOP_TRANSCRIPTION",
			description:
				"Stop the long-form voice transcription currently running on the user's device.",
			parameters: [],
			similes: ["END_TRANSCRIPTION", "STOP_RECORDING", "FINISH_TRANSCRIPT"],
			descriptionCompressed:
				"Stop the long-form voice transcription running on user's device.",
		},
		{
			name: "SUBMIT_PRESS_RELEASE",
			description:
				"Submit a press release for paid/provider-backed distribution. Requires explicit confirmation before calling the Cloud submit route.",
			parameters: [
				{
					name: "releaseId",
					description: "Press release id to submit.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Press release id to submit.",
				},
				{
					name: "title",
					description: "Press release title to resolve.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Press release title to resolve.",
				},
				{
					name: "confirm",
					description:
						"Follow-up: true confirms the pending submit, false cancels.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed:
						"Follow-up: true confirms the pending submit, false cancels.",
				},
			],
			descriptionCompressed:
				"Submit a press release for provider-backed distribution; requires confirm.",
			similes: ["SUBMIT_PR", "DISTRIBUTE_PRESS_RELEASE", "SEND_PRESS_RELEASE"],
			exampleCalls: [
				{
					user: "Use SUBMIT_PRESS_RELEASE with the provided parameters.",
					actions: ["SUBMIT_PRESS_RELEASE"],
					params: {
						SUBMIT_PRESS_RELEASE: {
							releaseId: "example",
							title: "example",
							confirm: false,
						},
					},
				},
			],
		},
		{
			name: "TASKS",
			description:
				"Planner surface for orchestrator workspace operations and coding task delegation to dedicated ACP coding sub-agents (elizaos / pi-agent / opencode / claude / codex). ",
			parameters: [
				{
					name: "action",
					description:
						"Task operation: create, spawn_agent, send, stop_agent, list_agents, cancel, history, control, share, provision_workspace, submit_workspace, manage_issues, archive, reopen.",
					required: false,
					schema: {
						type: "string",
						enum: [
							"create",
							"spawn_agent",
							"send",
							"stop_agent",
							"list_agents",
							"cancel",
							"history",
							"control",
							"share",
							"provision_workspace",
							"submit_workspace",
							"manage_issues",
							"archive",
							"reopen",
						],
					},
					descriptionCompressed:
						"Task operation: create, spawn_agent, send, stop_agent, list_agents, cancel, history, control, share, provision_workspace, submit_workspace, manage_issues, archive, reopen.",
				},
				{
					name: "op",
					description: "Planner alias for action.",
					required: false,
					schema: {
						type: "string",
						enum: [
							"create",
							"spawn_agent",
							"send",
							"stop_agent",
							"list_agents",
							"cancel",
							"history",
							"control",
							"share",
							"provision_workspace",
							"submit_workspace",
							"manage_issues",
							"archive",
							"reopen",
						],
					},
					descriptionCompressed: "Planner alias for action.",
				},
				{
					name: "subaction",
					description: "Planner alias for action.",
					required: false,
					schema: {
						type: "string",
						enum: [
							"create",
							"spawn_agent",
							"send",
							"stop_agent",
							"list_agents",
							"cancel",
							"history",
							"control",
							"share",
							"provision_workspace",
							"submit_workspace",
							"manage_issues",
							"archive",
							"reopen",
						],
					},
					descriptionCompressed: "Planner alias for action.",
				},
				{
					name: "operation",
					description: "Planner alias for action.",
					required: false,
					schema: {
						type: "string",
						enum: [
							"create",
							"spawn_agent",
							"send",
							"stop_agent",
							"list_agents",
							"cancel",
							"history",
							"control",
							"share",
							"provision_workspace",
							"submit_workspace",
							"manage_issues",
							"archive",
							"reopen",
						],
					},
					descriptionCompressed: "Planner alias for action.",
				},
				{
					name: "task",
					description:
						"Task prompt for create / spawn_agent / send (as new task).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Task prompt for create/spawn_agent/send (as new task).",
				},
				{
					name: "agentType",
					description:
						"Heuristic backend guess (elizaos, pi-agent, opencode, codex, or claude) for create / spawn_agent / control.resume. This is a weak hint — it loses to the operator default/pin and to character routing. To honor an EXPLICIT user request use requestedBackend instead.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Heuristic backend guess (elizaos, pi-agent, opencode, codex, or claude) for create/spawn_agent/control.resume. This is a weak hint - it loses to the operator default/pin and to character routing. To honor an EXPLICIT user request use requestedBackend instead.",
				},
				{
					name: "appMonetized",
					description:
						"Set true when the user wants the app to EARN MONEY / charge for access — e.g. 'people pay $1 to chat with X', 'charge per message', 'a paid app', 'monetized', a paywall, or per-use pricing. Judge the user's INTENT, not specific keywords. When true the sub-agent gets the monetized Eliza Cloud contract (register for an appId, inference markup, OAuth + affiliate billing) instead of a free static page. Leave unset for a normal free app or non-app task.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed:
						"Set true when user wants the app to EARN MONEY/charge for access - e.g. 'people pay $1 to chat with X', 'charge per msg', 'a paid app', 'monetized', a paywall, or per-use pricing. Judge user's INTENT, not specific keywords. When true the sub-agent gets the monetized Eliza Cloud contract (register for an appId, inference markup, OAuth + affiliate billing) instead of a free static page. Leave unset for a normal free app or non-app task.",
				},
				{
					name: "requestedBackend",
					description:
						"Set ONLY when the user EXPLICITLY named a coding backend for THIS task (e.g. 'use codex', 'have claude build it') — one of elizaos, pi-agent, opencode, codex, claude. Leave unset if the user did not name one; never guess. Unlike agentType this overrides the configured default/pin.",
					required: false,
					schema: {
						type: "string",
						enum: ["elizaos", "pi-agent", "opencode", "codex", "claude"],
					},
					descriptionCompressed:
						"Set ONLY when user EXPLICITLY named a coding backend for THIS task (e.g. 'use codex', 'have claude build it') - one of elizaos, pi-agent, opencode, codex, claude. Leave unset if user did not name one. never guess. Unlike agentType this overrides the configured default/pin.",
				},
				{
					name: "taskComplexity",
					description:
						"Your honest assessment of this coding task's difficulty: 'simple' (small/routine), 'moderate', or 'hard' (large, subtle, multi-file, or architectural). Used only to route to whichever backend the character configured for that difficulty (character.routing.coding.byTag). Judge the task itself — do not echo words from the user.",
					required: false,
					schema: {
						type: "string",
						enum: ["simple", "moderate", "hard"],
					},
					descriptionCompressed:
						"Your honest assessment of this coding task's difficulty: 'simple' (small/routine), 'moderate', or 'hard' (large, subtle, multi-file, or architectural). Used only to route to whichever backend the character configured for that difficulty (character.routing.coding.byTag). Judge the task itself - do not echo words from user.",
				},
				{
					name: "agents",
					description:
						"Pipe-delimited multi-agent task list for action=create.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Pipe-delimited multi-agent task list for action=create.",
				},
				{
					name: "repo",
					description:
						"Repository URL/slug for action=create / action=manage_issues / action=provision_workspace.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Repository URL/slug for action=create/action=manage_issues/action=provision_workspace.",
				},
				{
					name: "workdir",
					description:
						"Working directory for action=create / action=spawn_agent.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Working directory for action=create/action=spawn_agent.",
				},
				{
					name: "memoryContent",
					description:
						"Additional memory/context for action=create / action=spawn_agent.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Additional memory/context for action=create/action=spawn_agent.",
				},
				{
					name: "label",
					description:
						"Task label for action=create / action=spawn_agent / action=send.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Task label for action=create/action=spawn_agent/action=send.",
				},
				{
					name: "approvalPreset",
					description:
						"Approval preset for action=create / action=spawn_agent.",
					required: false,
					schema: {
						type: "string",
						enum: ["readonly", "standard", "permissive", "autonomous"],
					},
					descriptionCompressed:
						"Approval preset for action=create/action=spawn_agent.",
				},
				{
					name: "keepAliveAfterComplete",
					description:
						"Keep session alive after completion for action=spawn_agent.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed:
						"Keep session alive after completion for action=spawn_agent.",
				},
				{
					name: "deferUserReply",
					description:
						"For action=spawn_agent, suppress the immediate visible acknowledgement when the user explicitly requested no interim reply, such as 'reply only after verification'. The sub-agent completion router will post the final result.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed:
						"For action=spawn_agent, suppress the immediate visible acknowledgement when user explicitly requested no interim reply, such as 'reply only after verification'. The sub-agent completion router will post the final result.",
				},
				{
					name: "input",
					description:
						"Text input to send to a running session for action=send.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Text input to send to a running session for action=send.",
				},
				{
					name: "keys",
					description: "Key sequence to send for action=send.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Key sequence to send for action=send.",
				},
				{
					name: "sessionId",
					description:
						"Target session id for action=send / action=stop_agent / action=cancel / action=control / action=share.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Target session id for action=send/action=stop_agent/action=cancel/action=control/action=share.",
				},
				{
					name: "threadId",
					description:
						"Target task-thread id for action=cancel / action=control / action=share / action=archive / action=reopen.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Target task-thread id for action=cancel/action=control/action=share/action=archive/action=reopen.",
				},
				{
					name: "taskId",
					description:
						"Alias for threadId; preferred for action=archive / action=reopen.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Alias for threadId. preferred for action=archive/action=reopen.",
				},
				{
					name: "all",
					description:
						"Apply to all sessions for action=stop_agent / action=cancel.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed:
						"Apply to all sessions for action=stop_agent/action=cancel.",
				},
				{
					name: "search",
					description:
						"Free-text search for thread/task lookup in action=cancel / action=control / action=history / action=share.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Free-text search for thread/task lookup in action=cancel/action=control/action=history/action=share.",
				},
				{
					name: "reason",
					description: "Cancellation reason for action=cancel.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Cancellation reason for action=cancel.",
				},
				{
					name: "metric",
					description:
						"History query mode for action=history: list (default), count, or detail.",
					required: false,
					schema: {
						type: "string",
						enum: ["list", "count", "detail"],
					},
					descriptionCompressed:
						"History query mode for action=history: list (default), count, or detail.",
				},
				{
					name: "window",
					description: "Relative window for action=history.",
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
					descriptionCompressed: "Relative window for action=history.",
				},
				{
					name: "statuses",
					description: "Status filter list for action=history.",
					required: false,
					schema: {
						type: "array",
						items: {
							type: "string",
						},
					},
					descriptionCompressed: "Status filter list for action=history.",
				},
				{
					name: "limit",
					description: "Result limit for action=history.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed: "Result limit for action=history.",
				},
				{
					name: "includeArchived",
					description: "Include archived threads in action=history.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed: "Include archived threads in action=history.",
				},
				{
					name: "controlAction",
					description:
						"Child action for action=control: pause | resume | stop | continue | archive | reopen.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Child action for action=control: pause | resume | stop | continue | archive | reopen.",
				},
				{
					name: "issueAction",
					description:
						"Child action for action=manage_issues: create | list | get | update | comment | close | reopen | add_labels.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Child action for action=manage_issues: create | list | get | update | comment | close | reopen | add_labels.",
				},
				{
					name: "note",
					description:
						"Optional note for action=control with controlAction=pause|stop.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Optional note for action=control with controlAction=pause|stop.",
				},
				{
					name: "instruction",
					description:
						"Follow-up instruction for action=control with controlAction=resume|continue.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Follow-up instruction for action=control with controlAction=resume|continue.",
				},
				{
					name: "baseBranch",
					description:
						"Base branch for action=provision_workspace / action=submit_workspace.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Base branch for action=provision_workspace/action=submit_workspace.",
				},
				{
					name: "useWorktree",
					description: "Use worktree mode for action=provision_workspace.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed:
						"Use worktree mode for action=provision_workspace.",
				},
				{
					name: "parentWorkspaceId",
					description:
						"Parent workspace id for action=provision_workspace worktree mode.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Parent workspace id for action=provision_workspace worktree mode.",
				},
				{
					name: "workspaceId",
					description: "Workspace id for action=submit_workspace.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Workspace id for action=submit_workspace.",
				},
				{
					name: "commitMessage",
					description: "Commit message for action=submit_workspace.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Commit msg for action=submit_workspace.",
				},
				{
					name: "prTitle",
					description: "PR title for action=submit_workspace.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "PR title for action=submit_workspace.",
				},
				{
					name: "prBody",
					description: "PR body for action=submit_workspace.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "PR body for action=submit_workspace.",
				},
				{
					name: "draft",
					description: "Create draft PR for action=submit_workspace.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed: "Create draft PR for action=submit_workspace.",
				},
				{
					name: "skipPR",
					description: "Skip PR creation for action=submit_workspace.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed:
						"Skip PR creation for action=submit_workspace.",
				},
				{
					name: "title",
					description:
						"Issue title for action=manage_issues with issueAction=create|update.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Issue title for action=manage_issues with issueAction=create|update.",
				},
				{
					name: "body",
					description:
						"Issue body for action=manage_issues with issueAction=create|update|comment.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Issue body for action=manage_issues with issueAction=create|update|comment.",
				},
				{
					name: "issueNumber",
					description:
						"Issue number for action=manage_issues with issueAction=get|update|comment|close|reopen|add_labels.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed:
						"Issue number for action=manage_issues with issueAction=get|update|comment|close|reopen|add_labels.",
				},
				{
					name: "labels",
					description:
						"Labels (csv string or array) for action=manage_issues with issueAction=create|update|add_labels|list.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Labels (csv string or array) for action=manage_issues with issueAction=create|update|add_labels|list.",
				},
				{
					name: "state",
					description:
						"State filter (open|closed|all) for action=manage_issues with issueAction=list.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"State filter (open|closed|all) for action=manage_issues with issueAction=list.",
				},
				{
					name: "validator",
					description: "Optional verifier for action=create.",
					required: false,
					schema: {
						type: "object",
					},
					descriptionCompressed: "Optional verifier for action=create.",
				},
				{
					name: "maxRetries",
					description: "Verifier retry count for action=create.",
					required: false,
					schema: {
						type: "integer",
						minimum: 0,
					},
					descriptionCompressed: "Verifier retry count for action=create.",
				},
				{
					name: "onVerificationFail",
					description: "Verifier failure behavior for action=create.",
					required: false,
					schema: {
						type: "string",
						enum: ["retry", "escalate"],
					},
					descriptionCompressed: "Verifier failure behavior for action=create.",
				},
				{
					name: "metadata",
					description:
						"Additional metadata for action=create / action=spawn_agent.",
					required: false,
					schema: {
						type: "object",
					},
					descriptionCompressed:
						"Additional metadata for action=create/action=spawn_agent.",
				},
				{
					name: "taskRoomId",
					description:
						"Optional task-owner swarm room id for action=create / action=spawn_agent.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Optional task-owner swarm room id for action=create/action=spawn_agent.",
				},
				{
					name: "worktreeRoomId",
					description:
						"Optional worktree coordination swarm room id for action=create / action=spawn_agent.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Optional worktree coordination swarm room id for action=create/action=spawn_agent.",
				},
			],
			descriptionCompressed:
				"ACP coding sub-agent elizaos|pi-agent|opencode|claude|codex: spawn|send|control|list|history",
			similes: [
				"CREATE_AGENT_TASK",
				"CREATE_TASK",
				"START_CODING_TASK",
				"LAUNCH_CODING_TASK",
				"RUN_CODING_TASK",
				"START_AGENT_TASK",
				"SPAWN_AND_PROVISION",
				"CODE_THIS",
				"LAUNCH_TASK",
				"CREATE_SUBTASK",
				"SPAWN_AGENT",
				"SPAWN_CODING_AGENT",
				"START_CODING_AGENT",
				"LAUNCH_CODING_AGENT",
				"CREATE_CODING_AGENT",
				"SPAWN_CODER",
				"RUN_CODING_AGENT",
				"SPAWN_SUB_AGENT",
				"START_TASK_AGENT",
				"CREATE_AGENT",
				"SEND_TO_AGENT",
				"SEND_TO_CODING_AGENT",
				"MESSAGE_CODING_AGENT",
				"INPUT_TO_AGENT",
				"RESPOND_TO_AGENT",
				"TELL_CODING_AGENT",
				"MESSAGE_AGENT",
				"TELL_TASK_AGENT",
				"STOP_AGENT",
				"STOP_CODING_AGENT",
				"KILL_CODING_AGENT",
				"TERMINATE_AGENT",
				"END_CODING_SESSION",
				"CANCEL_AGENT",
				"CANCEL_TASK_AGENT",
				"STOP_SUB_AGENT",
				"LIST_AGENTS",
				"LIST_CODING_AGENTS",
				"SHOW_CODING_AGENTS",
				"GET_ACTIVE_AGENTS",
				"LIST_SESSIONS",
				"SHOW_CODING_SESSIONS",
				"SHOW_TASK_AGENTS",
				"LIST_SUB_AGENTS",
				"SHOW_TASK_STATUS",
				"CANCEL_TASK",
				"STOP_TASK",
				"ABORT_TASK",
				"KILL_TASK",
				"STOP_SUBTASK",
				"TASK_HISTORY",
				"LIST_TASK_HISTORY",
				"GET_TASK_HISTORY",
				"SHOW_TASKS",
				"COUNT_TASKS",
				"TASK_STATUS_HISTORY",
				"TASK_CONTROL",
				"CONTROL_TASK",
				"PAUSE_TASK",
				"RESUME_TASK",
				"CONTINUE_TASK",
				"ARCHIVE_TASK",
				"REOPEN_TASK",
				"TASK_SHARE",
				"SHARE_TASK_RESULT",
				"SHOW_TASK_ARTIFACT",
				"VIEW_TASK_OUTPUT",
				"CAN_I_SEE_IT",
				"PULL_IT_UP",
				"CREATE_WORKSPACE",
				"PROVISION_WORKSPACE",
				"CLONE_REPO",
				"SETUP_WORKSPACE",
				"PREPARE_WORKSPACE",
				"SUBMIT_WORKSPACE",
				"FINALIZE_WORKSPACE",
				"COMMIT_AND_PR",
				"CREATE_PR",
				"SUBMIT_CHANGES",
				"FINISH_WORKSPACE",
				"MANAGE_ISSUES",
				"CREATE_ISSUE",
				"LIST_ISSUES",
				"CLOSE_ISSUE",
				"COMMENT_ISSUE",
				"UPDATE_ISSUE",
				"GET_ISSUE",
				"ARCHIVE_CODING_TASK",
				"CLOSE_CODING_TASK",
				"ARCHIVE_TASK_THREAD",
				"REOPEN_CODING_TASK",
				"UNARCHIVE_CODING_TASK",
				"RESUME_CODING_TASK",
			],
			exampleCalls: [
				{
					user: "Use TASKS with the provided parameters.",
					actions: ["TASKS"],
					params: {
						TASKS: {
							action: "create",
							op: "create",
							subaction: "create",
							operation: "create",
							task: "example",
							agentType: "example",
							appMonetized: false,
							requestedBackend: "elizaos",
							taskComplexity: "simple",
							agents: "example",
							repo: "example",
							workdir: "example",
							memoryContent: "example",
							label: "example",
							approvalPreset: "readonly",
							keepAliveAfterComplete: false,
							deferUserReply: false,
							input: "example",
							keys: "example",
							sessionId: "example",
							threadId: "example",
							taskId: "example",
							all: false,
							search: "example",
							reason: "example",
							metric: "list",
							window: "active",
							statuses: "example",
							limit: 1,
							includeArchived: false,
							controlAction: "example",
							issueAction: "example",
							note: "example",
							instruction: "example",
							baseBranch: "example",
							useWorktree: false,
							parentWorkspaceId: "example",
							workspaceId: "example",
							commitMessage: "example",
							prTitle: "example",
							prBody: "example",
							draft: false,
							skipPR: false,
							title: "example",
							body: "example",
							issueNumber: 1,
							labels: "example",
							state: "example",
							validator: "example",
							maxRetries: "example",
							onVerificationFail: "retry",
							metadata: "example",
							taskRoomId: "example",
							worktreeRoomId: "example",
						},
					},
				},
			],
		},
		{
			name: "TAU_BENCH_TOOL",
			description:
				"tau-bench pass-through tool router. Tools are dynamic per task (retail/airline domains); set tool_name to the desired tool and arguments to its JSON payload.",
			parameters: [
				{
					name: "tool_name",
					description:
						"Name of the tau-bench tool to invoke (e.g. get_order_details, search_flights, cancel_order).",
					required: true,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Name of the tau-bench tool to invoke (e.g. get_order_details, search_flights, cancel_order).",
				},
				{
					name: "arguments",
					description: "JSON object with the tool's argument payload.",
					required: false,
					schema: {
						type: "object",
					},
					descriptionCompressed:
						"JSON object with the tool's argument payload.",
				},
			],
			descriptionCompressed:
				"tau-bench dynamic tool call {tool_name,arguments} passthrough",
			similes: [
				"TAU_BENCH",
				"TAU_RETAIL",
				"TAU_AIRLINE",
				"GET_ORDER_DETAILS",
				"GET_ORDER_STATUS",
				"SEARCH_FLIGHTS",
				"BOOK_FLIGHT",
				"GET_USER_DETAILS",
				"UPDATE_ORDER_ADDRESS",
				"CANCEL_ORDER",
				"RETURN_ITEMS",
				"EXCHANGE_ITEMS",
			],
			exampleCalls: [
				{
					user: "Use TAU_BENCH_TOOL with the provided parameters.",
					actions: ["TAU_BENCH_TOOL"],
					params: {
						TAU_BENCH_TOOL: {
							tool_name: "example",
							arguments: "example",
						},
					},
				},
			],
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
			name: "TODO",
			description:
				"Manage the user's todo list. Actions: write (replace the list with `todos:[{id?, content, status, activeForm?}]`), create (add one), update (change by id), complete, cancel, delete, list, clear. Todos are user-scoped (entityId), persistent, and shared across rooms for the same user.",
			parameters: [
				{
					name: "action",
					description:
						"Action: write, create, update, complete, cancel, delete, list, clear.",
					required: true,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Action: write, create, update, complete, cancel, delete, list, clear.",
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
						"Imperative form, e.g. 'Add tests' (create/update).",
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
						"Present-continuous form, e.g. 'Adding tests' (create/update).",
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
						"Array of {id?, content, status, activeForm?} for action=write. Replaces the user's list for this conversation.",
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
						"Array of {id?, content, status, activeForm?} for action=write. Replaces user's list for this convo.",
				},
				{
					name: "includeCompleted",
					description:
						"Include completed/cancelled todos in action=list output.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed:
						"Include completed/cancelled todos in action=list output.",
				},
				{
					name: "limit",
					description: "Max rows to return for action=list.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed: "Max rows to return for action=list.",
				},
			],
			descriptionCompressed:
				"todos: write|create|update|complete|cancel|delete|list|clear; user-scoped (entityId)",
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
							action: "example",
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
			name: "TUNNEL",
			description:
				"Tunnel operations dispatched by `action`: start, stop, status. The `start` action accepts an optional `port` (defaults to 3000); `stop` and `status` take no parameters. Backed by whichever tunnel plugin is active (local Tailscale CLI, Eliza Cloud headscale, or ngrok).",
			parameters: [
				{
					name: "action",
					description:
						"Which tunnel sub-operation to run. One of: start, stop, status.",
					required: true,
					schema: {
						type: "string",
						enum: ["start", "stop", "status"],
					},
					descriptionCompressed:
						"Which tunnel sub-operation to run. One of: start, stop, status.",
				},
				{
					name: "parameters",
					description:
						"Parameters forwarded to the selected sub-op. For `start`, optionally `{ port: number }`. `stop` and `status` take no parameters.",
					required: false,
					schema: {
						type: "object",
					},
					descriptionCompressed:
						"params forwarded to the selected sub-op. For `start`, optionally `{ port: number }`. `stop` and `status` take no params.",
				},
			],
			similes: [
				"OPEN_TUNNEL",
				"CREATE_TUNNEL",
				"CLOSE_TUNNEL",
				"CHECK_TUNNEL",
				"TUNNEL_INFO",
			],
			exampleCalls: [
				{
					user: "Use TUNNEL with the provided parameters.",
					actions: ["TUNNEL"],
					params: {
						TUNNEL: {
							action: "start",
							parameters: "example",
						},
					},
				},
			],
			descriptionCompressed:
				"Tunnel operations dispatched by `action`: start, stop, status. The `start` action accepts an optional `port` (defaults to 3000). `stop` and `status` take no params. Backed by whichever tunnel plugin is active (local Tailscale CLI, Eliza Cloud headscale, or ngrok).",
		},
		{
			name: "UPDATE_APP",
			description:
				"Update an existing Eliza Cloud app's details — rename it, or change its description, logo, website, or contact email. Use when the user asks to rename, edit, or change an app's settings (not its monetization).",
			parameters: [],
			descriptionCompressed: "Rename or edit a Cloud app's details.",
			similes: ["RENAME_APP", "EDIT_APP", "UPDATE_CLOUD_APP", "CHANGE_APP"],
		},
		{
			name: "UPDATE_MONETIZATION",
			description:
				"Change an Eliza Cloud app's monetization — turn it on or off, set the inference markup percentage, or set the purchase share percentage. Use when the user asks to monetize, set a price/markup, or enable/disable earning on an app.",
			parameters: [],
			descriptionCompressed:
				"Set a Cloud app's monetization (markup / on-off).",
			similes: [
				"SET_PRICE",
				"CHANGE_MARKUP",
				"ENABLE_MONETIZATION",
				"DISABLE_MONETIZATION",
				"SET_MARKUP",
			],
		},
		{
			name: "USAGE_COMMAND",
			description: "Show token usage",
			parameters: [],
			similes: ["/usage"],
			descriptionCompressed: "Show token usage",
		},
		{
			name: "USE_SKILL",
			description:
				"Invoke an enabled skill by slug. The skill's instructions or script run and the result returns to the conversation.",
			parameters: [
				{
					name: "slug",
					description:
						"Enabled skill slug. Must match enabled_skills provider.",
					required: true,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Enabled skill slug. Must match enabled_skills provider.",
				},
				{
					name: "mode",
					description:
						"Invoke mode: script runs executable, guidance loads SKILL.md, auto picks by scripts.",
					required: false,
					schema: {
						type: "string",
						enum: ["guidance", "script", "auto"],
						default: "auto",
					},
					descriptionCompressed:
						"Invoke mode: script runs executable, guidance loads SKILL.md, auto picks by scripts.",
				},
				{
					name: "script",
					description:
						"Script filename for mode=script/auto when multiple scripts. Default first script.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Script filename for mode=script/auto when multiple scripts. Default first script.",
				},
				{
					name: "args",
					description:
						"Script args: string array or JSON object values as positional args.",
					required: false,
					schema: {
						type: "object",
					},
					descriptionCompressed:
						"Script args: string array or JSON object values as positional args.",
				},
			],
			descriptionCompressed: "Invoke an enabled skill by slug.",
			similes: [
				"INVOKE_SKILL",
				"RUN_SKILL",
				"EXECUTE_SKILL",
				"CALL_SKILL",
				"USE_AGENT_SKILL",
				"RUN_AGENT_SKILL",
			],
			exampleCalls: [
				{
					user: "Use USE_SKILL with the provided parameters.",
					actions: ["USE_SKILL"],
					params: {
						USE_SKILL: {
							slug: "example",
							mode: "auto",
							script: "example",
							args: "example",
						},
					},
				},
			],
		},
		{
			name: "VENDING_MACHINE",
			description:
				"Vending-bench tool router. action selects the operation against the vending environment.",
			parameters: [
				{
					name: "action",
					description: "Vending-bench operation to execute.",
					required: true,
					schema: {
						type: "string",
						enum: [
							"view_state",
							"view_suppliers",
							"place_order",
							"restock_slot",
							"set_price",
							"collect_cash",
							"update_notes",
							"check_deliveries",
							"advance_day",
						],
					},
					descriptionCompressed: "Vending-bench operation to execute.",
				},
				{
					name: "slot_id",
					description: "Slot identifier within the vending machine grid.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Slot id within the vending machine grid.",
				},
				{
					name: "product_id",
					description: "Catalogue product identifier (SKU).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Catalogue product id (SKU).",
				},
				{
					name: "supplier_id",
					description:
						"Identifier for the supplier when placing or inspecting orders.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"id for the supplier when placing or inspecting orders.",
				},
				{
					name: "price",
					description: "Unit price (in machine-local currency units).",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed:
						"Unit price (in machine-local currency units).",
				},
				{
					name: "quantity",
					description: "Quantity to order, restock, or collect.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed: "Quantity to order, restock, or collect.",
				},
				{
					name: "notes",
					description: "Free-form note text attached to the operation.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Free-form note text attached to the operation.",
				},
			],
			descriptionCompressed:
				"Vending-machine ops: view_state, place_order, restock, set_price, collect_cash, …",
			similes: [
				"VENDING_MACHINE_VIEW_BUSINESS_STATE",
				"VIEW_BUSINESS_STATE",
				"VIEW_STATE",
				"VIEW_SUPPLIERS",
				"PLACE_ORDER",
				"RESTOCK_SLOT",
				"SET_PRICE",
				"COLLECT_CASH",
				"UPDATE_NOTES",
				"CHECK_DELIVERIES",
				"ADVANCE_DAY",
			],
			exampleCalls: [
				{
					user: "Use VENDING_MACHINE with the provided parameters.",
					actions: ["VENDING_MACHINE"],
					params: {
						VENDING_MACHINE: {
							action: "view_state",
							slot_id: "example",
							product_id: "example",
							supplier_id: "example",
							price: 1,
							quantity: 1,
							notes: "example",
						},
					},
				},
			],
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
		{
			name: "VISUALWEBBENCH_TASK",
			description:
				"VisualWebBench task router. action selects the sub-task (web_caption, webqa, heading_ocr, element_ocr, element_ground, action_prediction, action_ground).",
			parameters: [
				{
					name: "action",
					description: "VisualWebBench sub-task to execute.",
					required: true,
					schema: {
						type: "string",
						enum: [
							"web_caption",
							"webqa",
							"heading_ocr",
							"element_ocr",
							"element_ground",
							"action_prediction",
							"action_ground",
						],
					},
					descriptionCompressed: "VisualWebBench sub-task to execute.",
				},
				{
					name: "answer_text",
					description: "Free-text answer for caption / QA / OCR tasks.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Free-text answer for caption/QA/OCR tasks.",
				},
				{
					name: "choice_index",
					description:
						"Selected choice index (0-based) for multiple-choice tasks.",
					required: false,
					schema: {
						type: "integer",
					},
					descriptionCompressed:
						"Selected choice index (0-based) for multiple-choice tasks.",
				},
				{
					name: "bbox",
					description:
						"Bounding box [x1, y1, x2, y2] in pixels for grounding tasks.",
					required: false,
					schema: {
						type: "array",
						items: {
							type: "number",
						},
					},
					descriptionCompressed:
						"Bounding box [x1, y1, x2, y2] in pixels for grounding tasks.",
				},
			],
			descriptionCompressed:
				"VisualWebBench web_caption|webqa|heading_ocr|element_ocr|ground|action_predict",
			similes: [
				"VISUALWEBBENCH",
				"WEB_CAPTION",
				"WEBQA",
				"ELEMENT_GROUND",
				"ACTION_PREDICTION",
				"ACTION_GROUND",
			],
			exampleCalls: [
				{
					user: "Use VISUALWEBBENCH_TASK with the provided parameters.",
					actions: ["VISUALWEBBENCH_TASK"],
					params: {
						VISUALWEBBENCH_TASK: {
							action: "web_caption",
							answer_text: "example",
							choice_index: "example",
							bbox: "example",
						},
					},
				},
			],
		},
		{
			name: "VOICE_CALL",
			description:
				"Owner-only outbound voice call via registered provider. Action dial; recipientKind=owner|external|e164. ",
			parameters: [
				{
					name: "action",
					description: "dial.",
					required: false,
					schema: {
						type: "string",
						enum: ["dial"],
					},
					descriptionCompressed: "dial.",
				},
				{
					name: "recipientKind",
					description:
						"owner escalation env number | external RelationshipStore lookup + allow-list | e164 raw E.164 phoneNumber.",
					required: true,
					schema: {
						type: "string",
						enum: ["owner", "external", "e164"],
					},
					descriptionCompressed:
						"owner escalation env number | external RelationshipStore lookup + allow-list | e164 raw E.164 phoneNumber.",
				},
				{
					name: "phoneNumber",
					description: "recipientKind=e164: destination E.164 phoneNumber.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"recipientKind=e164: destination E.164 phoneNumber.",
				},
				{
					name: "recipient",
					description:
						"recipientKind=external: contact name or E.164; names via RelationshipStore.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"recipientKind=external: contact name or E.164. names via RelationshipStore.",
				},
				{
					name: "bodyText",
					description: "Optional spoken message on connect.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Optional spoken msg on connect.",
				},
				{
					name: "confirmed",
					description:
						"true required to place call. Without: draft/approval-queue.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed:
						"true required to place call. without: draft/approval-queue.",
				},
				{
					name: "reason",
					description: "Optional call reason; approval task audit.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Optional call reason. approval task audit.",
				},
			],
			descriptionCompressed:
				"Twilio voice dial: recipientKind=owner|external|e164; draft-confirm; approval-queue",
			similes: [
				"CALL_ME",
				"ESCALATE_TO_USER",
				"CALL_THIRD_PARTY",
				"PHONE_SOMEONE",
				"DIAL",
			],
			exampleCalls: [
				{
					user: "Use VOICE_CALL with the provided parameters.",
					actions: ["VOICE_CALL"],
					params: {
						VOICE_CALL: {
							action: "dial",
							recipientKind: "owner",
							phoneNumber: "example",
							recipient: "example",
							bodyText: "example",
							confirmed: false,
							reason: "example",
						},
					},
				},
			],
		},
		{
			name: "WEBSHOP",
			description:
				"WebShop benchmark router. Mirrors the WebShop environment shape: search[query], click[ID], select_option[name,value], back, and buy.",
			parameters: [
				{
					name: "action",
					description: "WebShop operation to execute.",
					required: true,
					schema: {
						type: "string",
						enum: ["search", "click", "select_option", "back", "buy"],
					},
					descriptionCompressed: "WebShop operation to execute.",
				},
				{
					name: "query",
					description:
						"For search — the free-text query string used as search[query].",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"For search - the free-text query string used as search[query].",
				},
				{
					name: "product_id",
					description:
						"For click — the product or element identifier used as click[ID].",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"For click - the product or element id used as click[ID].",
				},
				{
					name: "option_name",
					description:
						"For select_option — the option name used as select_option[name,value].",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"For select_option - the option name used as select_option[name,value].",
				},
				{
					name: "option_value",
					description:
						"For select_option — the option value used as select_option[name,value].",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"For select_option - the option value used as select_option[name,value].",
				},
			],
			descriptionCompressed:
				"WebShop ops: search, click, select_option, back, buy.",
			similes: [
				"WEBSHOP_SEARCH",
				"WEBSHOP_CLICK",
				"WEBSHOP_SELECT_OPTION",
				"WEBSHOP_BACK",
				"WEBSHOP_BUY",
				"SHOP",
				"SHOPPING",
				"NAVIGATE_SHOP",
			],
			exampleCalls: [
				{
					user: "Use WEBSHOP with the provided parameters.",
					actions: ["WEBSHOP"],
					params: {
						WEBSHOP: {
							action: "search",
							query: "example",
							product_id: "example",
							option_name: "example",
							option_value: "example",
						},
					},
				},
			],
		},
		{
			name: "WHOAMI_COMMAND",
			description: "Show your identity information",
			parameters: [],
			similes: ["/whoami", "/who"],
			descriptionCompressed: "Show your identity info",
		},
		{
			name: "WINDOW",
			description:
				"WINDOW action. Manage local desktop windows via computer-use service. actions: list, focus, switch, arrange, move, minimize, maximize, restore, close. Pointer/keyboard use COMPUTER_USE; file/shell use FILE/SHELL.",
			parameters: [
				{
					name: "action",
					description: "Window operation verb.",
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
							"get_current_window_id",
							"get_application_windows",
							"set_bounds",
							"get_window_size",
							"get_window_position",
						],
					},
					descriptionCompressed: "Window operation verb.",
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
					description: "Window title or app-name query.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Window title or app-name query.",
				},
				{
					name: "arrangement",
					description: "For arrange: tile, cascade, vertical, horizontal.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"For arrange: tile, cascade, vertical, horizontal.",
				},
				{
					name: "x",
					description: "Target X coordinate for window move / set_bounds.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed:
						"Target X coordinate for window move/set_bounds.",
				},
				{
					name: "y",
					description: "Target Y coordinate for window move / set_bounds.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed:
						"Target Y coordinate for window move/set_bounds.",
				},
				{
					name: "width",
					description: "Window width for set_bounds.",
					required: false,
					schema: {
						type: "number",
						minimum: 1,
					},
					descriptionCompressed: "Window width for set_bounds.",
				},
				{
					name: "height",
					description: "Window height for set_bounds.",
					required: false,
					schema: {
						type: "number",
						minimum: 1,
					},
					descriptionCompressed: "Window height for set_bounds.",
				},
			],
			descriptionCompressed:
				"WINDOW action=list|focus|switch|arrange|move|minimize|maximize|restore|close",
			similes: ["MANAGE_WINDOW", "WINDOW", "USE_WINDOW", "WINDOW_ACTION"],
			exampleCalls: [
				{
					user: "Use WINDOW with the provided parameters.",
					actions: ["WINDOW"],
					params: {
						WINDOW: {
							action: "list",
							windowId: "example",
							windowTitle: "example",
							arrangement: "example",
							x: 1,
							y: 1,
							width: 1,
							height: 1,
						},
					},
				},
			],
		},
		{
			name: "WITHDRAW_APP_EARNINGS",
			description:
				"Withdraw (cash out) an Eliza Cloud app's earnings. MONEY-OUT: requires an explicit confirmation — the first ask only confirms intent and hands off a dashboard link. Use when the user asks to withdraw, cash out, or request a payout of an app's earnings.",
			parameters: [
				{
					name: "appName",
					description:
						"Name, slug, or id of the Cloud app whose earnings to withdraw.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Name, slug, or id of the Cloud app whose earnings to withdraw.",
				},
				{
					name: "amount",
					description:
						"Optional USD amount to withdraw on the first ask. Omit to withdraw the full available balance.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed:
						"Optional USD amount to withdraw on the first ask. Omit to withdraw the full available balance.",
				},
				{
					name: "confirm",
					description:
						"Follow-up confirmation. Set true only when the user is confirming the pending withdrawal prompt for this app and amount; set false when canceling.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed:
						"Follow-up confirmation. Set true only when user is confirming the pending withdrawal prompt for this app and amount. set false when canceling.",
				},
			],
			descriptionCompressed:
				"Withdraw a Cloud app's earnings (money-out; two-step confirm).",
			similes: [
				"CASH_OUT",
				"PAYOUT",
				"WITHDRAW_EARNINGS",
				"REQUEST_PAYOUT",
				"CASH_OUT_APP",
			],
			exampleCalls: [
				{
					user: "Use WITHDRAW_APP_EARNINGS with the provided parameters.",
					actions: ["WITHDRAW_APP_EARNINGS"],
					params: {
						WITHDRAW_APP_EARNINGS: {
							appName: "example",
							amount: 1,
							confirm: false,
						},
					},
				},
			],
		},
		{
			name: "WORK_THREAD",
			description:
				"Owner work-thread lifecycle: create, steer, stop, wait, complete, merge, attach source refs, schedule follow-up. Use only thread lifecycle/routing; domain work -> task/messaging/workflow actions.",
			parameters: [
				{
					name: "operations",
					description:
						"Thread lifecycle ops array. Item: type, optional workThreadId, sourceWorkThreadIds, instruction, reason, title, summary, sourceRef, trigger for schedule_followup.",
					required: true,
					schema: {
						type: "array",
						items: {
							type: "object",
						},
					},
					descriptionCompressed:
						"Thread lifecycle ops array. Item: type, optional workThreadId, sourceWorkThreadIds, instruction, reason, title, summary, sourceRef, trigger for schedule_followup.",
				},
			],
			descriptionCompressed:
				"work-thread lifecycle: create|steer|stop|waiting|completed|merge|attach_source|followup",
			exampleCalls: [
				{
					user: "Use WORK_THREAD with the provided parameters.",
					actions: ["WORK_THREAD"],
					params: {
						WORK_THREAD: {
							operations: "example",
						},
					},
				},
			],
		},
		{
			name: "WORKFLOW",
			description:
				"Manage workflows. Action-based dispatch - provide an `action` parameter:\n",
			parameters: [
				{
					name: "action",
					description:
						"Operation: list, get, search, create, modify, activate, deactivate, toggle_active, delete, run, executions, revisions, restore, diagnose, eval_samples.",
					required: true,
					schema: {
						type: "string",
						enum: [
							"list",
							"search",
							"get",
							"create",
							"modify",
							"activate",
							"deactivate",
							"toggle_active",
							"delete",
							"run",
							"executions",
							"revisions",
							"restore",
							"diagnose",
							"eval_samples",
						],
					},
					descriptionCompressed:
						"Operation: list, get, search, create, modify, activate, deactivate, toggle_active, delete, run, executions, revisions, restore, diagnose, eval_samples.",
				},
				{
					name: "query",
					description:
						"Free text to match a workflow by name / node type for action=search.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Free text to match a workflow by name/node type for action=search.",
				},
				{
					name: "workflowId",
					description: "Workflow id.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Workflow id.",
				},
				{
					name: "executionId",
					description: "Workflow execution id for action=diagnose.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Workflow execution id for action=diagnose.",
				},
				{
					name: "workflowName",
					description: "Workflow name fragment for fuzzy matching.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Workflow name fragment for fuzzy matching.",
				},
				{
					name: "seedPrompt",
					description: "Natural-language description for action=create.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Natural-language description for action=create.",
				},
				{
					name: "name",
					description: "Optional explicit name for created workflow.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Optional explicit name for created workflow.",
				},
				{
					name: "active",
					description:
						"Target state for action=toggle_active (true to activate).",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed:
						"Target state for action=toggle_active (true to activate).",
				},
				{
					name: "limit",
					description:
						"Max executions/revisions/evaluation samples to return (default 10).",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed:
						"Max executions/revisions/evaluation samples to return (default 10).",
				},
				{
					name: "versionId",
					description: "Workflow version id for action=restore.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Workflow version id for action=restore.",
				},
			],
			descriptionCompressed:
				"workflow list|get|create|modify|activate|deactivate|toggle_active|delete|run|executions|revisions|restore|diagnose|eval_samples",
			similes: [
				"LIST_WORKFLOWS",
				"SHOW_WORKFLOWS",
				"GET_WORKFLOW",
				"REVIEW_WORKFLOW",
				"CREATE_WORKFLOW",
				"DELETE_WORKFLOW",
				"RUN_WORKFLOW",
				"RUN_WORKFLOW_NOW",
				"TOGGLE_WORKFLOW_ACTIVE",
				"ACTIVATE_WORKFLOW",
				"DEACTIVATE_WORKFLOW",
				"ENABLE_WORKFLOW",
				"DISABLE_WORKFLOW",
				"PAUSE_WORKFLOW",
				"RESUME_WORKFLOW",
				"MODIFY_WORKFLOW",
				"UPDATE_WORKFLOW",
				"EDIT_WORKFLOW",
				"EDIT_EXISTING_WORKFLOW",
				"UPDATE_EXISTING_WORKFLOW",
				"CHANGE_EXISTING_WORKFLOW",
				"LOAD_WORKFLOW_FOR_EDIT",
				"GET_WORKFLOW_EXECUTIONS",
				"GET_EXECUTIONS",
				"SHOW_EXECUTIONS",
				"EXECUTION_HISTORY",
				"WORKFLOW_RUNS",
				"WORKFLOW_EXECUTIONS",
				"WORKFLOW_REVISIONS",
				"RESTORE_WORKFLOW",
				"ROLL_BACK_WORKFLOW",
				"ROLLBACK_WORKFLOW",
				"DIAGNOSE_WORKFLOW",
				"TROUBLESHOOT_WORKFLOW",
				"EXPLAIN_WORKFLOW_FAILURE",
				"GET_WORKFLOW_DIAGNOSTICS",
				"WORKFLOW_RUN_DIAGNOSTICS",
				"WORKFLOW_EVAL_SAMPLES",
				"GENERATE_WORKFLOW_TRAINING_SAMPLES",
				"GENERATE_WORKFLOW_EVAL_CASES",
				"GEPA_WORKFLOW_SAMPLES",
				"OPTIMIZE_WORKFLOW_SAMPLES",
			],
			exampleCalls: [
				{
					user: "Use WORKFLOW with the provided parameters.",
					actions: ["WORKFLOW"],
					params: {
						WORKFLOW: {
							action: "list",
							query: "example",
							workflowId: "example",
							executionId: "example",
							workflowName: "example",
							seedPrompt: "example",
							name: "example",
							active: false,
							limit: 1,
							versionId: "example",
						},
					},
				},
			],
		},
		{
			name: "WORKTREE",
			description:
				"Manage current git worktree stack. action=enter creates/switches isolated worktree; action=exit leaves and optionally removes it.",
			parameters: [
				{
					name: "action",
					description: "Worktree operation to run.",
					required: true,
					schema: {
						type: "string",
						enum: ["enter", "exit"],
					},
					descriptionCompressed: "Worktree operation to run.",
				},
				{
					name: "name",
					description:
						"For action=enter: worktree branch/dir name. Default auto-*.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"For action=enter: worktree branch/dir name. Default auto-*.",
				},
				{
					name: "path",
					description:
						"For action=enter: absolute worktree dir within sandbox roots.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"For action=enter: absolute worktree dir within sandbox roots.",
				},
				{
					name: "base",
					description: "For action=enter, optional base ref. Defaults to HEAD.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"For action=enter, optional base ref. Defaults to HEAD.",
				},
				{
					name: "cleanup",
					description:
						"For action=exit: remove popped worktree dir with git worktree remove --force.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed:
						"For action=exit: remove popped worktree dir with git worktree remove --force.",
				},
			],
			descriptionCompressed: "Git worktree umbrella: action=enter/exit.",
			similes: ["GIT_WORKTREE"],
			exampleCalls: [
				{
					user: "Use WORKTREE with the provided parameters.",
					actions: ["WORKTREE"],
					params: {
						WORKTREE: {
							action: "enter",
							name: "example",
							path: "example",
							base: "example",
							cleanup: false,
						},
					},
				},
			],
		},
		{
			name: "XR_CLOSE_VIEW",
			description: "Closes a specific view panel on the connected XR headset.",
			parameters: [],
			similes: ["CLOSE_XR_VIEW", "HIDE_XR_PANEL", "XR_CLOSE", "XR_DISMISS"],
			descriptionCompressed:
				"Closes a specific view panel on the connected XR headset.",
		},
		{
			name: "XR_LIST_VIEWS",
			description:
				"Lists all views available on the XR device and optionally sends a launcher catalog to the headset. Use this before XR_OPEN_VIEW.",
			parameters: [],
			similes: [
				"LIST_XR_VIEWS",
				"XR_VIEWS",
				"WHAT_XR_VIEWS",
				"SHOW_XR_LAUNCHER",
			],
			descriptionCompressed:
				"Lists all views available on the XR device and optionally sends a launcher catalog to the headset. Use this before XR_OPEN_VIEW.",
		},
		{
			name: "XR_OPEN_VIEW",
			description:
				"Opens a view panel on the connected XR headset by view id. Use XR_LIST_VIEWS first to discover available view ids.",
			parameters: [],
			similes: ["OPEN_XR_VIEW", "SHOW_XR_PANEL", "XR_SHOW", "XR_LAUNCH"],
			descriptionCompressed:
				"Opens a view panel on the connected XR headset by view id. Use XR_LIST_VIEWS first to discover available view ids.",
		},
		{
			name: "XR_QUERY_VISION",
			description:
				"Describe what the user is currently looking at through their XR headset camera. Use this when the user asks 'what do you see', 'look at this', or any question about their surroundings.",
			parameters: [],
			descriptionCompressed:
				"Describe what user is looking at through their XR headset camera. Use when user asks 'what do you see', 'look at this', or any question about their surroundings.",
		},
		{
			name: "XR_RESIZE_VIEW",
			description:
				"Resizes or repositions the active XR view panel. Set scale (0.5 = half, 1.0 = default, 2.0 = double), distance in meters (1.5 = default, smaller = closer), or fullscreen.",
			parameters: [
				{
					name: "scale",
					description:
						"Panel scale multiplier — e.g. 1.5 for bigger, 0.6 for smaller, 1.0 default.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed:
						"Panel scale multiplier - e.g. 1.5 for bigger, 0.6 for smaller, 1.0 default.",
				},
				{
					name: "distance",
					description:
						"Panel distance from the user in meters — e.g. 0.8 for closer, 2.5 for farther, 1.5 default.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed:
						"Panel distance from user in meters - e.g. 0.8 for closer, 2.5 for farther, 1.5 default.",
				},
				{
					name: "fullscreen",
					description: "Set true to fullscreen the panel.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed: "Set true to fullscreen the panel.",
				},
				{
					name: "viewId",
					description:
						"Optional id of the view/panel to resize; defaults to the active panel.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Optional id of the view/panel to resize. defaults to the active panel.",
				},
			],
			similes: [
				"RESIZE_XR_PANEL",
				"XR_MAKE_BIGGER",
				"XR_MAKE_SMALLER",
				"XR_SCALE",
			],
			exampleCalls: [
				{
					user: "Use XR_RESIZE_VIEW with the provided parameters.",
					actions: ["XR_RESIZE_VIEW"],
					params: {
						XR_RESIZE_VIEW: {
							scale: 1,
							distance: 1,
							fullscreen: false,
							viewId: "example",
						},
					},
				},
			],
			descriptionCompressed:
				"Resizes or repositions the active XR view panel. Set scale (0.5 = half, 1.0 = default, 2.0 = double), distance in meters (1.5 = default, smaller = closer), or fullscreen.",
		},
		{
			name: "XR_SWITCH_VIEW",
			description:
				"Switches the active (foreground) view on the XR headset without closing others.",
			parameters: [],
			similes: ["SWITCH_XR_VIEW", "XR_GO_TO", "XR_NAVIGATE"],
			descriptionCompressed:
				"Switches the active (foreground) view on the XR headset without closing others.",
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
