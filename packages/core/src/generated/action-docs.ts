/**
 * Auto-generated canonical action/provider docs.
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
			name: "APP",
			description:
				"Unified app control. action=launch starts a registered app; action=relaunch stops then launches (optionally with verify); action=list shows installed + running apps; action=load_from_directory registers apps from an absolute folder; action=create runs the multi-turn create-or-edit flow that searches existing apps, asks new/edit/cancel, scaffolds from the min-app template, and dispatches a coding agent with AppVerificationService validator.",
			parameters: [
				{
					name: "action",
					description:
						"Operation: launch | relaunch | load_from_directory | list | create.",
					required: true,
					schema: {
						type: "string",
						enum: [
							"launch",
							"relaunch",
							"load_from_directory",
							"list",
							"create",
						],
					},
					descriptionCompressed:
						"Operation: launch | relaunch | load_from_directory | list | create.",
				},
				{
					name: "mode",
					description: "Legacy alias for action.",
					required: false,
					schema: {
						type: "string",
						enum: [
							"launch",
							"relaunch",
							"load_from_directory",
							"list",
							"create",
						],
					},
					descriptionCompressed: "Legacy alias for action.",
				},
				{
					name: "app",
					description:
						"App name, slug, or display name (launch / relaunch / create-edit).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"App name, slug, or display name (launch/relaunch/create-edit).",
				},
				{
					name: "name",
					description: "Alias for `app`.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Alias for `app`.",
				},
				{
					name: "runId",
					description:
						"Specific run id to stop before relaunching (relaunch mode).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Specific run id to stop before relaunching (relaunch mode).",
				},
				{
					name: "verify",
					description:
						"When true, runs AppVerificationService (fast profile) after relaunch.",
					required: false,
					schema: {
						type: "boolean",
						default: false,
					},
					descriptionCompressed:
						"When true, runs AppVerificationService (fast profile) after relaunch.",
				},
				{
					name: "workdir",
					description:
						"Absolute workdir for verify (relaunch) or for explicit edit (create).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Absolute workdir for verify (relaunch) or for explicit edit (create).",
				},
				{
					name: "directory",
					description: "Absolute directory to scan (load_from_directory mode).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Absolute directory to scan (load_from_directory mode).",
				},
				{
					name: "intent",
					description:
						"Free-form description of the app to build (create mode). Defaults to the user message text.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Free-form description of the app to build (create mode). Defaults to user msg text.",
				},
				{
					name: "editTarget",
					description:
						"Skip the picker and edit this installed app directly (create mode).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Skip the picker and edit this installed app directly (create mode).",
				},
				{
					name: "choice",
					description:
						"Override choice reply (`new` | `edit-N` | `cancel`) for create mode follow-up turns.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Override choice reply (`new` | `edit-N` | `cancel`) for create mode follow-up turns.",
				},
			],
			descriptionCompressed:
				"Manage apps: launch/relaunch/list/load folder/create; create scaffolds min app, runs coding agent, verifies result.",
			similes: ["APP_CONTROL", "MANAGE_APPS"],
			exampleCalls: [
				{
					user: "Use APP with the provided parameters.",
					actions: ["APP"],
					params: {
						APP: {
							action: "launch",
							mode: "launch",
							app: "example",
							name: "example",
							runId: "example",
							verify: false,
							workdir: "example",
							directory: "example",
							intent: "example",
							editTarget: "example",
							choice: "example",
						},
					},
				},
			],
		},
		{
			name: "BLOCK",
			description: "Block or unblock phone apps and desktop websites. ",
			parameters: [
				{
					name: "target",
					description:
						"Which surface to act on: 'app' (phone apps) or 'website' (desktop hosts-file/SelfControl). ",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Which surface to act on: 'app' (phone apps) or 'website' (desktop hosts-file/SelfControl).",
				},
				{
					name: "action",
					description:
						"One of: block, unblock, status, request_permission, release, list_active. ",
					required: true,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"One of: block, unblock, status, request_permission, release, list_active.",
				},
				{
					name: "intent",
					description:
						"Free-form description of what the owner wants. Used by the block action to extract apps/hostnames + duration.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Free-form description of what the owner wants. Used by the block action to extract apps/hostnames + duration.",
				},
				{
					name: "hostnames",
					description:
						"(target=website) Public hostnames or URLs to block, e.g. ['x.com','twitter.com'].",
					required: false,
					schema: {
						type: "array",
						items: {
							type: "string",
						},
					},
					descriptionCompressed:
						"(target=website) Public hostnames or URLs to block, e. g. ['x. com', 'twitter. com'].",
				},
				{
					name: "confirmed",
					description:
						"(target=website) Set true only when the owner has explicitly confirmed the block. Without it, block returns a draft confirmation request. Required by release.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed:
						"(target=website) Set true only when the owner has explicitly confirmed the block. without it, block returns a draft confirmation request. Required by release.",
				},
				{
					name: "ruleId",
					description:
						"(target=website, action=release) ID of the managed block rule to release.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"(target=website, action=release) ID of the managed block rule to release.",
				},
				{
					name: "reason",
					description:
						"(target=website, action=release) Optional reason recorded on the rule when released.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"(target=website, action=release) Optional reason recorded on the rule when released.",
				},
				{
					name: "includeLiveStatus",
					description:
						"(target=website, action=list_active) Include the current hosts-file/SelfControl live block state. Default true.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed:
						"(target=website, action=list_active) Include the current hosts-file/SelfControl live block state. Default true.",
				},
				{
					name: "includeManagedRules",
					description:
						"(target=website, action=list_active) Include managed owner block rules. Default true.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed:
						"(target=website, action=list_active) Include managed owner block rules. Default true.",
				},
				{
					name: "packageNames",
					description:
						"(target=app, Android) Package names to block, e.g. ['com.twitter.android'].",
					required: false,
					schema: {
						type: "array",
						items: {
							type: "string",
						},
					},
					descriptionCompressed:
						"(target=app, Android) Package names to block, e. g. ['com. twitter. android'].",
				},
				{
					name: "appTokens",
					description:
						"(target=app, iOS) iPhone app tokens from a previous selectApps() call.",
					required: false,
					schema: {
						type: "array",
						items: {
							type: "string",
						},
					},
					descriptionCompressed:
						"(target=app, iOS) iPhone app tokens from a previous selectApps() call.",
				},
				{
					name: "durationMinutes",
					description:
						"How long to block, in minutes. Omit/null for an indefinite block that stays active until manually removed.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed:
						"How long to block, in minutes. Omit/null for an indefinite block that stays active until manually removed.",
				},
			],
			descriptionCompressed:
				"block/unblock apps+websites; actions block|unblock|status|request_permission|release|list_active; web requires confirmed:true",
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
			name: "BROWSER",
			description:
				"Single BROWSER action — control whichever browser target is registered. Targets are pluggable: `workspace` (electrobun-embedded BrowserView, the default; falls back to a JSDOM web mode when the desktop bridge isn't configured), `bridge` (the user's real Chrome/Safari via the Agent Browser Bridge companion extension), and `computeruse` (a local puppeteer-driven Chromium via plugin-computeruse). The agent uses what is available — the BrowserService picks the active target when none is specified. Use `action: \"autofill_login\"` with `domain` (and optional `username`, `submit`) to vault-gated autofill into an open workspace tab.",
			parameters: [
				{
					name: "action",
					description:
						"Browser action to perform. Snake_case values are canonical; legacy kebab-case and subaction are also accepted.",
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
						],
					},
					descriptionCompressed:
						"Browser action to perform. Snake_case values are canonical. legacy kebab-case and subaction are also accepted.",
				},
				{
					name: "subaction",
					description: "Legacy alias for action.",
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
							"autofill-login",
						],
					},
					descriptionCompressed: "Legacy alias for action.",
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
						"Required when action is autofill_login: registrable hostname (e.g. `github.com`).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Required when action is autofill_login: registrable hostname (e. g. `github.com`).",
				},
				{
					name: "username",
					description:
						"When using autofill-login: specific saved login; omit for most recently modified.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"When using autofill-login: specific saved login. omit for most recently modified.",
				},
				{
					name: "submit",
					description:
						"When using autofill-login: submit the form after filling (default false).",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed:
						"When using autofill-login: submit the form after filling (default false).",
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
				"Browser tab/page control: open/navigate/click/type/screenshot/state; action autofill_login + domain autofill vault-gated credential into workspace tab pre-authorized in Settings Vault Logins. Bridge settings/status use MANAGE_BROWSER_BRIDGE.",
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
							action: "back",
							subaction: "back",
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
			name: "CALENDAR",
			description:
				"Manage live calendar events plus availability and meeting preferences. Subactions: ",
			parameters: [
				{
					name: "action",
					description:
						"Which calendar operation to run. Calendar: feed, next_event, search_events, create_event, update_event, delete_event, trip_window, bulk_reschedule. Availability: check_availability, propose_times. Preferences: update_preferences.",
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
						"Which calendar operation to run. Calendar: feed, next_event, search_events, create_event, update_event, delete_event, trip_window, bulk_reschedule...",
				},
				{
					name: "intent",
					description:
						'Natural-language description of the calendar request (e.g. "what is on my calendar today", "do i have any flights this week", "create a meeting tomorrow at 3pm").',
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						'Natural-language description of the calendar request (e. g. "what is on my calendar today", "do i have any flights this week", "create a meeting tomorrow at...',
				},
				{
					name: "title",
					description: "Event title when creating a calendar event.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Event title when creating a calendar event.",
				},
				{
					name: "query",
					description:
						"Search phrase for search_events / travel_itinerary (e.g. flight, dentist, Denver).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Search phrase for search_events/travel_itinerary (e. g. flight, dentist, Denver).",
				},
				{
					name: "queries",
					description:
						"Optional array of search phrases for search_events. Combined and deduped.",
					required: false,
					schema: {
						type: "array",
						items: {
							type: "string",
						},
					},
					descriptionCompressed:
						"Optional array of search phrases for search_events. Combined and deduped.",
				},
				{
					name: "details",
					description:
						"Structured calendar fields — time bounds, timezone, calendar id, create-event timing, location, and attendees.",
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
						"calendar details: calendarId timeMin timeMax timeZone startAt endAt durationMinutes eventId newTitle description location travelOriginAddress windowDays windowPreset forceSync",
				},
				{
					name: "durationMinutes",
					description: "Meeting length in minutes. Used by propose_times.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed:
						"Meeting length in minutes. Used by propose_times.",
				},
				{
					name: "daysAhead",
					description:
						"Days ahead for propose_times search window (defaults to 7, ignored when windowStart/windowEnd are supplied).",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed:
						"Days ahead for propose_times search window (defaults to 7, ignored when windowStart/windowEnd are supplied).",
				},
				{
					name: "slotCount",
					description:
						"Number of candidate slots for propose_times (defaults to 3).",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed:
						"Number of candidate slots for propose_times (defaults to 3).",
				},
				{
					name: "windowStart",
					description:
						"ISO-8601 earliest start of the propose_times search window.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"ISO-8601 earliest start of the propose_times search window.",
				},
				{
					name: "windowEnd",
					description:
						"ISO-8601 latest end of the propose_times search window.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"ISO-8601 latest end of the propose_times search window.",
				},
				{
					name: "startAt",
					description: "ISO-8601 start time. Used by check_availability.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"ISO-8601 start time. Used by check_availability.",
				},
				{
					name: "endAt",
					description: "ISO-8601 end time. Used by check_availability.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"ISO-8601 end time. Used by check_availability.",
				},
				{
					name: "timeZone",
					description:
						"IANA time zone for update_preferences (interprets preferred hours).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"IANA time zone for update_preferences (interprets preferred hours).",
				},
				{
					name: "preferredStartLocal",
					description:
						"Earliest preferred meeting start time-of-day (local HH:MM, 24h).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Earliest preferred meeting start time-of-day (local HH:MM, 24h).",
				},
				{
					name: "preferredEndLocal",
					description:
						"Latest preferred meeting end time-of-day (local HH:MM, 24h).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Latest preferred meeting end time-of-day (local HH:MM, 24h).",
				},
				{
					name: "defaultDurationMinutes",
					description: "Default meeting duration in minutes (5–480).",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed: "Default meeting duration in minutes (5-480).",
				},
				{
					name: "travelBufferMinutes",
					description: "Minutes to reserve before/after each meeting (0–240).",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed:
						"Minutes to reserve before/after each meeting (0-240).",
				},
				{
					name: "blackoutWindows",
					description:
						"Array of { label, startLocal (HH:MM), endLocal (HH:MM), daysOfWeek? (0=Sun..6=Sat) }.",
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
				"calendar event CRUD + availability + prefs; subactions create_event|update_event|delete_event|search_events|propose_times|check_availability|next_event|feed",
			similes: ["CALENDAR", "SCHEDULE", "MEETING"],
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
			name: "CALENDLY",
			description:
				"Work with Calendly specifically (calendly.com / api.calendly.com). ",
			parameters: [
				{
					name: "action",
					description:
						"One of: list_event_types, availability, upcoming_events, single_use_link. When omitted, the handler runs an LLM extraction over the conversation to recover it.",
					required: true,
					schema: {
						type: "string",
						enum: [
							"list_event_types",
							"availability",
							"upcoming_events",
							"single_use_link",
						],
					},
					examples: ["list_event_types", "availability"],
					descriptionCompressed:
						"calendly op: list_event_types|availability|upcoming_events|single_use_link",
				},
				{
					name: "subaction",
					description: "Legacy alias for action.",
					required: false,
					schema: {
						type: "string",
						enum: [
							"list_event_types",
							"availability",
							"upcoming_events",
							"single_use_link",
						],
					},
					examples: ["list_event_types", "availability"],
					descriptionCompressed: "legacy calendly op alias",
				},
				{
					name: "intent",
					description: "Optional free-form description of the user's intent.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "free-form intent",
				},
				{
					name: "eventTypeUri",
					description:
						"Calendly event type URI. Required for availability and single_use_link.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["https://api.calendly.com/event_types/ABCDEFGH"],
					descriptionCompressed:
						"calendly event type URI (availability|single_use_link)",
				},
				{
					name: "startDate",
					description:
						"ISO date (YYYY-MM-DD) for range-based queries (availability, upcoming_events).",
					required: false,
					schema: {
						type: "string",
						pattern: "^\\d{4}-\\d{2}-\\d{2}$",
					},
					examples: ["2026-05-12"],
					descriptionCompressed: "YYYY-MM-DD range start",
				},
				{
					name: "endDate",
					description: "ISO date (YYYY-MM-DD) for range-based queries.",
					required: false,
					schema: {
						type: "string",
						pattern: "^\\d{4}-\\d{2}-\\d{2}$",
					},
					examples: ["2026-05-19"],
					descriptionCompressed: "YYYY-MM-DD range end",
				},
				{
					name: "timezone",
					description: "IANA timezone, e.g. America/Los_Angeles.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["America/Los_Angeles", "UTC"],
					descriptionCompressed: "IANA tz",
				},
			],
			descriptionCompressed:
				"calendly: list_event_types|availability|upcoming_events|single_use_link; route here for calendly.com URLs",
			similes: [
				"CALENDLY_LIST_EVENT_TYPES",
				"CALENDLY_AVAILABILITY",
				"CALENDLY_UPCOMING",
				"CALENDLY_BOOKING_LINK",
				"CALENDLY_ACTION",
				"CALENDLY_EVENT_TYPES",
				"CALENDLY_SCHEDULED_EVENTS",
			],
			exampleCalls: [
				{
					user: "Use CALENDLY with the provided parameters.",
					actions: ["CALENDLY"],
					params: {
						CALENDLY: {
							action: "list_event_types",
							subaction: "list_event_types",
							intent: "example",
							eventTypeUri: "https://api.calendly.com/event_types/ABCDEFGH",
							startDate: "2026-05-12",
							endDate: "2026-05-19",
							timezone: "America/Los_Angeles",
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
			name: "CONNECTOR",
			description:
				"Manage **account** state for installed connectors: connect (log in), ",
			parameters: [
				{
					name: "connector",
					description:
						"Which connector to manage (kind from ConnectorRegistry, e.g. google, x, telegram, signal, discord, imessage, whatsapp, twilio, calendly, duffel, health, browser_bridge). Optional when subaction=list.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Which connector to manage (kind from ConnectorRegistry, e. g. google, x, telegram, signal, discord, imessage, whatsapp, twilio, calendly, duffel, health...",
				},
				{
					name: "action",
					description:
						"Lifecycle operation. connect (start auth/pairing); disconnect (revoke + clear grant); verify (active read/send probe where available). status/list are read-only diagnostics for explicit troubleshooting; prefer provider/core registry context when available. Strongly preferred - when omitted, the handler runs an LLM extraction over the conversation to recover it.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Lifecycle operation. connect (start auth/pairing). disconnect (revoke + clear grant). verify (active read/send probe where available). status/list are...",
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
						"Connection mode: local | cloud_managed | remote. Defaults vary by connector.",
					required: false,
					schema: {
						type: "string",
						enum: ["local", "cloud_managed", "remote"],
					},
					descriptionCompressed:
						"Connection mode: local | cloud_managed | remote. Defaults vary by connector.",
				},
				{
					name: "recentLimit",
					description:
						"verify only — how many recent messages/dialogs to read where the connector supports passive reads.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed:
						"verify only - how many recent msgs/dialogs to read where the connector supports passive reads.",
				},
				{
					name: "query",
					description:
						"Discord verify only — optional search text to prove browser-message reads.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Discord verify only - optional search text to prove browser-msg reads.",
				},
				{
					name: "sendTarget",
					description:
						"verify only — destination chat/recipient/channel for the self-test send.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"verify only - destination chat/recipient/channel for the self-test send.",
				},
				{
					name: "sendMessage",
					description: "verify only — text body for the self-test send.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"verify only - text body for the self-test send.",
				},
				{
					name: "browser",
					description: "browser_bridge connect only — chrome | safari.",
					required: false,
					schema: {
						type: "string",
						enum: ["chrome", "safari"],
					},
					descriptionCompressed:
						"browser_bridge connect only - chrome | safari.",
				},
				{
					name: "profileId",
					description:
						"browser_bridge connect only — profile identifier within the browser.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"browser_bridge connect only - profile id within the browser.",
				},
				{
					name: "profileLabel",
					description:
						"browser_bridge connect only — human-readable profile label.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"browser_bridge connect only - human-readable profile label.",
				},
				{
					name: "redirectUrl",
					description:
						"google/x connect only — optional OAuth redirect URL override.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"google/x connect only - optional OAuth redirect URL override.",
				},
			],
			descriptionCompressed:
				"account-level connector lifecycle: connect(log in)|disconnect(log out)|verify|status|list; registry-driven kinds; for plugin install/uninstall use PLUGIN",
			similes: [
				"CONNECT_GOOGLE",
				"CONNECT_TELEGRAM",
				"CONNECT_DISCORD",
				"DISCONNECT_SERVICE",
				"CHECK_CONNECTION",
				"SERVICE_STATUS",
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
			name: "CREDENTIALS",
			description:
				"Owner-only password and autofill operations across browser autofill (LifeOps extension) and the OS password manager (1Password / ProtonPass). ",
			parameters: [
				{
					name: "action",
					description:
						"fill | whitelist_add | whitelist_list (autofill) | search | list | inject_username | inject_password (password manager).",
					required: true,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"fill | whitelist_add | whitelist_list (autofill) | search | list | inject_username | inject_password (password manager).",
				},
				{
					name: "field",
					description:
						"(action=fill) One of email, password, name, phone, custom. Tells the password manager which field to resolve.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"(action=fill) One of email, password, name, phone, custom. Tells the password manager which field to resolve.",
				},
				{
					name: "domain",
					description:
						"(action=fill | whitelist_add) Domain to act on. For fill, used as the tab URL when url is omitted.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"(action=fill | whitelist_add) Domain to act on. For fill, used as the tab URL when url is omitted.",
				},
				{
					name: "url",
					description:
						"(action=fill) Optional explicit tab URL (used for whitelist enforcement).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"(action=fill) Optional explicit tab URL (used for whitelist enforcement).",
				},
				{
					name: "intent",
					description:
						"(action=search) Natural-language description of the lookup intent.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"(action=search) Natural-language description of the lookup intent.",
				},
				{
					name: "query",
					description:
						"(action=search) Search string matched against item title, URL, username, and tags.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"(action=search) Search string matched against item title, URL, username, and tags.",
				},
				{
					name: "itemId",
					description:
						"(action=inject_username | inject_password) Password manager item id.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"(action=inject_username | inject_password) Password manager item id.",
				},
				{
					name: "limit",
					description: "(action=list) Optional item limit (default 20).",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed:
						"(action=list) Optional item limit (default 20).",
				},
				{
					name: "confirmed",
					description:
						"Required true for whitelist_add and for either inject_* action. Ensures the owner approved the change.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed:
						"Required true for whitelist_add and for either inject_* action. Ensures the owner approved the change.",
				},
			],
			descriptionCompressed:
				"credentials: fill|whitelist_add|whitelist_list|search|list|inject_username|inject_password; clipboard-only; confirmed:true required for inject and whitelist_add",
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
			name: "ENTITY",
			description:
				"Manage people, organizations, projects, and concepts the owner cares about, plus typed relationships between them. Subactions: add, list, set_identity, set_relationship, log_interaction, merge. Use SCHEDULED_TASK for follow-up cadence; use LIFE for one-off dated reminders to call/text someone.",
			parameters: [
				{
					name: "action",
					description:
						"Which ENTITY operation to run: add (new contact), list (read rolodex), log_interaction (record contact event), set_identity (force-merge a platform handle onto an entity), set_relationship (typed edge between entities), merge (collapse duplicate entities). Follow-up cadence belongs to SCHEDULED_TASKS.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["add", "list", "set_identity"],
					descriptionCompressed:
						"ENTITY op: add | list | log_interaction | set_identity | set_relationship | merge",
				},
				{
					name: "intent",
					description:
						"Free-form user intent used to infer action when not set.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "free-form intent infer action",
				},
				{
					name: "name",
					description:
						"Contact display name. When relationshipId is omitted, the handler resolves an existing contact by this name.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "contact display name",
				},
				{
					name: "channel",
					description:
						"Primary channel for the contact (email, telegram, discord, signal, sms, twilio_voice, imessage, whatsapp).",
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
					description: "Primary handle/address on the chosen channel.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Primary handle/address on the chosen channel.",
				},
				{
					name: "email",
					description: "Optional email address for the contact.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Optional email address for the contact.",
				},
				{
					name: "phone",
					description: "Optional phone number for the contact.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Optional phone number for the contact.",
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
					description: "Target relationship id.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Target relationship id.",
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
					description: "Optional explicit confirmation flag.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed: "Optional explicit confirmation flag.",
				},
				{
					name: "entityId",
					description:
						"Target entity id. Used by set_identity (force a new identity onto a known entity), merge (target id), and any operation that needs a stable EntityStore id.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Target entity id. Used by set_identity (force a new identity onto a known entity), merge (target id), and any operation that needs a stable EntityStore id.",
				},
				{
					name: "platform",
					description:
						"Identity platform for set_identity (e.g. telegram, slack, email, twitter). Combine with handle.",
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
					description:
						"Display name shown alongside an observed identity (set_identity).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Display name shown alongside an observed identity (set_identity).",
				},
				{
					name: "toEntityId",
					description: "Target entity id for set_relationship.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Target entity id for set_relationship.",
				},
				{
					name: "fromEntityId",
					description:
						"Source entity id for set_relationship. Defaults to 'self' when omitted.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Source entity id for set_relationship. Defaults to 'self' when omitted.",
				},
				{
					name: "relationshipType",
					description:
						"Edge type label for set_relationship (e.g. manages, colleague_of, works_at, partner_of, family_of).",
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
						"Entity ids being folded into the target entity (merge). Provide as a JSON array of strings.",
					required: false,
					schema: {
						type: "array",
						items: {
							type: "string",
						},
					},
					descriptionCompressed:
						"Entity ids being folded into the target entity (merge). Provide as a JSON array of strings.",
				},
				{
					name: "evidence",
					description:
						"Free-form evidence string captured alongside set_identity / set_relationship observations.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Free-form evidence string captured alongside set_identity/set_relationship observations.",
				},
			],
			descriptionCompressed:
				"people+relationships: add|list|set_identity|set_relationship|log_interaction|merge; follow-up cadence → SCHEDULED_TASK",
			similes: [
				"RELATIONSHIP",
				"CONTACTS",
				"ROLODEX",
				"LOG_INTERACTION",
				"ADD_ENTITY",
				"ADD_PERSON",
				"MERGE_ENTITIES",
				"MERGE_CONTACTS",
				"SET_IDENTITY",
				"SET_RELATIONSHIP",
			],
			exampleCalls: [
				{
					user: "Use ENTITY with the provided parameters.",
					actions: ["ENTITY"],
					params: {
						ENTITY: {
							action: "add",
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
			name: "FILE",
			description:
				"Read, write, edit, search, find, or list workspace files through one FILE action. Choose action=read/write/edit/grep/glob/ls. All paths must be absolute unless an operation explicitly defaults to the session cwd.",
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
						"Absolute file or directory path for grep/glob/ls. Defaults to the session cwd where supported.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Absolute file or directory path for grep/glob/ls. Defaults to the session cwd where supported.",
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
					description:
						"For action=edit, replace every occurrence instead of requiring one match.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed:
						"For action=edit, replace every occurrence instead of requiring one match.",
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
					description:
						"For action=grep, include 1-based line numbers in content output.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed:
						"For action=grep, include 1-based line numbers in content output.",
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
			],
			descriptionCompressed:
				"File operations umbrella: action=read/write/edit/grep/glob/ls.",
			similes: [
				"READ",
				"WRITE",
				"EDIT",
				"GREP",
				"GLOB",
				"LS",
				"READ_FILE",
				"WRITE_FILE",
				"EDIT_FILE",
				"FILE_OPERATION",
				"FILE_IO",
			],
			exampleCalls: [
				{
					user: "Use FILE with the provided parameters.",
					actions: ["FILE"],
					params: {
						FILE: {
							action: "read",
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
						},
					},
				},
			],
		},
		{
			name: "FORM",
			description:
				"Form session router. action=restore rehydrates the most recent stashed form for the current user.",
			parameters: [
				{
					name: "action",
					description: "Form verb: restore. Defaults to restore when omitted.",
					required: false,
					schema: {
						type: "string",
						enum: ["restore"],
					},
					descriptionCompressed:
						"Form verb: restore. Defaults to restore when omitted.",
				},
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
			descriptionCompressed: "Form session router (restore).",
			similes: ["FORM_RESTORE", "RESUME_FORM", "CONTINUE_FORM"],
			exampleCalls: [
				{
					user: "Use FORM with the provided parameters.",
					actions: ["FORM"],
					params: {
						FORM: {
							action: "restore",
							sessionId: "example",
						},
					},
				},
			],
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
				"GitHub: pr_list|pr_review|issue_create|issue_assign|issue_close|issue_reopen|issue_comment|issue_label|notification_triage",
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
			name: "LINEAR",
			description:
				"Manage Linear issues, comments, and activity. Operations: create_issue, get_issue, update_issue, delete_issue, create_comment, update_comment, delete_comment, list_comments, get_activity, clear_activity, search_issues. The op is inferred from the message text when not explicitly provided.",
			parameters: [
				{
					name: "action",
					description:
						"Operation to perform. One of: create_issue, get_issue, update_issue, delete_issue, create_comment, update_comment, delete_comment, list_comments, get_activity, clear_activity, search_issues. Inferred from message text when omitted.",
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
							action: "create_issue",
						},
					},
				},
			],
		},
		{
			name: "LIQUIDITY",
			description:
				"Single LP/liquidity management action. action=onboard|list_pools|open|close|reposition|list_positions|get_position|set_preferences. dex=orca|raydium|meteora|uniswap|aerodrome|pancakeswap selects the protocol; chain=solana|evm is inferred from dex when omitted.",
			parameters: [
				{
					name: "action",
					description:
						"Liquidity operation: onboard, list_pools, open, close, reposition, list_positions, get_position, set_preferences.",
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
						"Liquidity operation: onboard, list_pools, open, close, reposition, list_positions, get_position, set_preferences.",
				},
				{
					name: "subaction",
					description: "Legacy alias for action.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Legacy alias for action.",
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
				"Manage LP positions by action, chain, dex, pool, position, amount, range, token filters.",
			similes: [
				"lp_management",
				"LP_MANAGEMENT",
				"LIQUIDITY_POOL_MANAGEMENT",
				"LP_MANAGER",
				"MANAGE_LP",
				"MANAGE_LIQUIDITY",
				"MANAGE_LP_POSITIONS",
				"manage_positions",
				"manage_raydium_positions",
				"AUTOMATE_REBALANCING",
				"AUTOMATE_POSITIONS",
				"START_MANAGING_POSITIONS",
				"AUTOMATE_RAYDIUM_REBALANCING",
				"AUTOMATE_RAYDIUM_POSITIONS",
				"START_MANAGING_RAYDIUM_POSITIONS",
			],
			exampleCalls: [
				{
					user: "Use LIQUIDITY with the provided parameters.",
					actions: ["LIQUIDITY"],
					params: {
						LIQUIDITY: {
							action: "onboard",
							subaction: "example",
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
			name: "MANAGE_BROWSER_BRIDGE",
			description:
				"Owner-only management of the Agent Browser Bridge companion extension that connects Eliza to the user's Chrome and Safari browsers. Actions: refresh (show settings/status/connection state), install (build and reveal the extension for setup), reveal_folder (open the built extension folder), open_manager (open chrome://extensions only when the owner explicitly asks). The action parameter is inferred from message text when omitted; show/settings/status maps to refresh and 'open chrome extensions' maps to open_manager. Prefer the browser-bridge provider for passive companion status and use this action's refresh child action only for an explicit live refresh.",
			parameters: [
				{
					name: "action",
					description:
						"Bridge management action. Use refresh for show/settings/status/connection-state requests. Use open_manager only for explicit chrome://extensions or extension-manager requests. install builds/reveals/opens setup; reveal_folder opens the build folder. Inferred from message text if omitted.",
					required: false,
					schema: {
						type: "string",
						enum: ["install", "reveal_folder", "open_manager", "refresh"],
					},
					descriptionCompressed:
						"Bridge management action. Use refresh for show/settings/status/connection-state requests. Use open_manager only for explicit chrome://extensions or...",
				},
				{
					name: "subaction",
					description: "Legacy alias for action.",
					required: false,
					schema: {
						type: "string",
						enum: ["install", "reveal_folder", "open_manager", "refresh"],
					},
					descriptionCompressed: "Legacy alias for action.",
				},
			],
			descriptionCompressed:
				"Manage LifeOps Browser Bridge: refresh shows settings/status; install setup; reveal_folder build folder; open_manager chrome://extensions.",
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
							subaction: "install",
						},
					},
				},
			],
		},
		{
			name: "MC",
			description:
				"Drive a Minecraft bot. Choose one action: connect (host?,port?,username?,auth?,version?), disconnect, goto (x,y,z), stop, look (yaw,pitch), control (control,state,durationMs?), waypoint_goto (name), dig (x,y,z), place (x,y,z,face), chat (message), attack (entityId), waypoint_set (name), waypoint_delete (name).",
			parameters: [
				{
					name: "action",
					description: "Operation to run.",
					required: true,
					schema: {
						type: "string",
						enum: [
							"connect",
							"disconnect",
							"goto",
							"stop",
							"look",
							"control",
							"waypoint_goto",
							"dig",
							"place",
							"chat",
							"attack",
							"waypoint_set",
							"waypoint_delete",
						],
					},
					descriptionCompressed: "Action.",
				},
				{
					name: "subaction",
					description: "Legacy alias for action.",
					required: false,
					schema: {
						type: "string",
						enum: [
							"connect",
							"disconnect",
							"goto",
							"stop",
							"look",
							"control",
							"waypoint_goto",
							"dig",
							"place",
							"chat",
							"attack",
							"waypoint_set",
							"waypoint_delete",
						],
					},
					descriptionCompressed: "Legacy action alias.",
				},
				{
					name: "params",
					description:
						"Optional JSON object containing the fields required by the chosen op.",
					required: false,
					schema: {
						type: "object",
					},
					descriptionCompressed: "Op fields.",
				},
			],
			descriptionCompressed:
				"minecraft ops: connect|disconnect|goto|stop|look|control|waypoint_*|dig|place|chat|attack",
			exampleCalls: [
				{
					user: "Use MC with the provided parameters.",
					actions: ["MC"],
					params: {
						MC: {
							action: "connect",
							subaction: "connect",
							params: "example",
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
				"USE_TOOL",
				"USE_MCP_TOOL",
				"EXECUTE_TOOL",
				"EXECUTE_MCP_TOOL",
				"RUN_TOOL",
				"RUN_MCP_TOOL",
				"INVOKE_TOOL",
				"INVOKE_MCP_TOOL",
				"READ_MCP_RESOURCE",
				"READ_RESOURCE",
				"GET_RESOURCE",
				"GET_MCP_RESOURCE",
				"FETCH_RESOURCE",
				"FETCH_MCP_RESOURCE",
				"ACCESS_RESOURCE",
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
			name: "MUSIC",
			description:
				"Unified music action. Use verb-shaped action for everything: ",
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
					description: "Playlist name for playlist_play / playlist_save.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Playlist name for playlist_play/playlist_save.",
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
					name: "operation",
					description:
						"Structured routing operation when using set_routing (set_mode, start_route, …).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Structured routing operation when using set_routing (set_mode, start_route, …).",
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
				"Verb-shaped: play/pause/resume/skip/stop, queue_view/queue_add/queue_clear, playlist_play/playlist_save, search/play_query/download/play_audio, set_routing/set_zone, generate/extend/custom_generate.",
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
							operation: "example",
							mode: "example",
							sourceId: "example",
							targetIds: "example",
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
			name: "MYSTICISM_PAYMENT",
			description:
				"Payment router for the active mysticism reading session. Set action to 'check' to read payment status, or 'request' to ask the user to pay (set amount or include $X.XX in the message).",
			parameters: [
				{
					name: "action",
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
					user: "Use MYSTICISM_PAYMENT with the provided parameters.",
					actions: ["MYSTICISM_PAYMENT"],
					params: {
						MYSTICISM_PAYMENT: {
							action: "check",
							amount: "example",
							entityId: "example",
							roomId: "example",
						},
					},
				},
			],
		},
		{
			name: "MYSTICISM_READING",
			description:
				"Mystical reading router. Set type to tarot, astrology, or iching, and action to start (begin a new reading), followup (reveal the next element), or deepen (more interpretation for the most-recent element).",
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
					name: "action",
					description: "Action: start, followup, or deepen.",
					required: true,
					schema: {
						type: "string",
						enum: ["start", "followup", "deepen"],
					},
					descriptionCompressed: "Action: start, followup, or deepen.",
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
				"Mystical readings: tarot, astrology, iching; actions: start, followup, deepen.",
			similes: [
				"READING",
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
					user: "Use MYSTICISM_READING with the provided parameters.",
					actions: ["MYSTICISM_READING"],
					params: {
						MYSTICISM_READING: {
							type: "tarot",
							action: "start",
							question: "example",
							context: "example",
						},
					},
				},
			],
		},
		{
			name: "OWNER_FINANCES",
			description:
				"Owner finances: payment sources, transaction imports, spending summaries, recurring charges, and subscription audits.",
			parameters: [
				{
					name: "action",
					description: "Owner finance action.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Owner finance action.",
				},
			],
			descriptionCompressed:
				"owner finances: dashboard|list_sources|add_source|remove_source|import_csv|list_transactions|spending_summary|recurring_charges|subscription_audit|subscription_cancel|subscription_status",
			similes: ["MONEY", "FINANCES", "SUBSCRIPTIONS"],
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
			name: "OWNER_HEALTH",
			description:
				"Owner health telemetry reads across HealthKit, Google Fit, Strava, Fitbit, Withings, or Oura. Actions: today, trend, by_metric, status.",
			parameters: [
				{
					name: "action",
					description:
						"Owner health read action: today, trend, by_metric, or status.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Owner health read action: today, trend, by_metric, or status.",
				},
			],
			descriptionCompressed:
				"owner health: today|trend|by_metric|status; read-only telemetry",
			similes: ["HEALTH", "FITNESS", "WELLNESS"],
			exampleCalls: [
				{
					user: "Use OWNER_HEALTH with the provided parameters.",
					actions: ["OWNER_HEALTH"],
					params: {
						OWNER_HEALTH: {
							action: "example",
						},
					},
				},
			],
		},
		{
			name: "OWNER_SCREENTIME",
			description:
				"Owner screen-time and activity analytics across local activity, app usage, and browser reports.",
			parameters: [
				{
					name: "action",
					description: "Owner screentime read action.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Owner screentime read action.",
				},
			],
			descriptionCompressed:
				"owner screentime: summary|today|weekly|by_app|by_website|activity_report|time_on_app|time_on_site|browser_activity",
			similes: ["SCREENTIME", "SCREEN_TIME", "ACTIVITY_REPORT"],
			exampleCalls: [
				{
					user: "Use OWNER_SCREENTIME with the provided parameters.",
					actions: ["OWNER_SCREENTIME"],
					params: {
						OWNER_SCREENTIME: {
							action: "example",
						},
					},
				},
			],
		},
		{
			name: "PERPETUAL_MARKET",
			description:
				"Use registered perpetual market providers. target selects the provider; Hyperliquid is registered today. action=read reads public state with kind: status, markets, market, positions, or funding. action=place_order reports trading readiness; signed order placement is disabled in this app scaffold.",
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
					description:
						"Legacy alias for action. Accepts place-order as place_order.",
					required: false,
					schema: {
						type: "string",
						enum: ["read", "place_order", "place-order"],
					},
					descriptionCompressed:
						"Legacy alias for action. Accepts place-order as place_order.",
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
						"market only: Hyperliquid coin/asset symbol (e. g. BTC).",
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
				"Owner personal-assistant workflows. Use action=book_travel for real travel booking, action=scheduling for scheduling negotiation, and action=sign_document for document-signature flows that must be queued for owner approval.",
			parameters: [
				{
					name: "action",
					description: "Assistant workflow to run.",
					required: true,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Assistant workflow to run.",
				},
			],
			descriptionCompressed:
				"personal assistant workflows: action=book_travel|scheduling|sign_document",
			similes: [
				"ASSISTANT",
				"BOOK_TRAVEL",
				"SCHEDULING",
				"SCHEDULING_NEGOTIATION",
				"SIGN_DOCUMENT",
				"DOCUSIGN",
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
			name: "PROPOSE_MEETING_TIMES",
			description:
				"Propose concrete meeting time slots to offer to another person. This is ",
			parameters: [
				{
					name: "durationMinutes",
					description:
						"Meeting length in minutes. Defaults to the owner's configured default duration.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed:
						"Meeting length in minutes. Defaults to the owner's configured default duration.",
				},
				{
					name: "daysAhead",
					description:
						"Number of days ahead to search. Defaults to 7. Ignored when windowStart/windowEnd are supplied.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed:
						"Number of days ahead to search. Defaults to 7. Ignored when windowStart/windowEnd are supplied.",
				},
				{
					name: "slotCount",
					description: "Number of candidate slots to return. Defaults to 3.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed:
						"Number of candidate slots to return. Defaults to 3.",
				},
				{
					name: "windowStart",
					description:
						"Optional ISO-8601 earliest start for the search window.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Optional ISO-8601 earliest start for the search window.",
				},
				{
					name: "windowEnd",
					description: "Optional ISO-8601 latest end for the search window.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Optional ISO-8601 latest end for the search window.",
				},
				{
					name: "timeZone",
					description:
						"Optional IANA time zone override when the user is temporarily traveling and wants proposals shown in that local time.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Optional IANA time zone override when user is temporarily traveling and wants proposals shown in that local time.",
				},
			],
			descriptionCompressed:
				"Propose available meeting slots from the owner's calendar and meeting preferences; not calendar CRUD or negotiation tracking.",
			similes: [
				"SUGGEST_MEETING_TIMES",
				"OFFER_MEETING_SLOTS",
				"FIND_MEETING_SLOTS",
				"PROPOSE_SLOTS",
				"BUNDLE_MEETINGS_WHILE_TRAVELING",
				"BULK_RESCHEDULE_MEETINGS",
				"RESCHEDULE_MEETINGS",
			],
			exampleCalls: [
				{
					user: "Use PROPOSE_MEETING_TIMES with the provided parameters.",
					actions: ["PROPOSE_MEETING_TIMES"],
					params: {
						PROPOSE_MEETING_TIMES: {
							durationMinutes: 1,
							daysAhead: 1,
							slotCount: 1,
							windowStart: "example",
							windowEnd: "example",
							timeZone: "example",
						},
					},
				},
			],
		},
		{
			name: "REMOTE_DESKTOP",
			description:
				"Manage remote-desktop sessions so the owner can connect to this machine from another device. ",
			parameters: [
				{
					name: "action",
					description: "One of: start, status, end, list, revoke.",
					required: false,
					schema: {
						type: "string",
						enum: ["start", "status", "end", "list", "revoke"],
					},
					examples: ["start", "list", "revoke"],
					descriptionCompressed:
						"remote-desktop action: start|status|end|list|revoke",
				},
				{
					name: "sessionId",
					description:
						"Session id - required for status, end, and revoke actions.",
					required: false,
					schema: {
						type: "string",
					},
					examples: ["rs_abc123"],
					descriptionCompressed: "session id (status|end|revoke)",
				},
				{
					name: "confirmed",
					description: "Must be true for start (security sensitive).",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed: "true required for start (security)",
				},
				{
					name: "pairingCode",
					description:
						"6-digit one-time pairing code for start. Required unless ELIZA_REMOTE_LOCAL_MODE=1.",
					required: false,
					schema: {
						type: "string",
						pattern: "^[0-9]{6}$",
					},
					examples: ["482193"],
					descriptionCompressed:
						"6-digit pairing code (start; skipped in local mode)",
				},
				{
					name: "requesterIdentity",
					description:
						"Identifier for who is asking (entity id, friend name, device id). Logged for audit on start.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "audit: requester id (start)",
				},
				{
					name: "intent",
					description:
						"Freeform owner intent / reason for the session. Logged for audit.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "audit: owner reason",
				},
			],
			descriptionCompressed:
				"remote-desktop sessions: start|status|end|list|revoke; start requires confirmed:true (+ pairing code in cloud mode)",
			similes: [
				"REMOTE_SESSION",
				"VNC_SESSION",
				"REMOTE_CONTROL",
				"PHONE_REMOTE_ACCESS",
				"CONNECT_FROM_PHONE",
			],
			exampleCalls: [
				{
					user: "Use REMOTE_DESKTOP with the provided parameters.",
					actions: ["REMOTE_DESKTOP"],
					params: {
						REMOTE_DESKTOP: {
							action: "start",
							sessionId: "rs_abc123",
							confirmed: false,
							pairingCode: "482193",
							requesterIdentity: "example",
							intent: "example",
						},
					},
				},
			],
		},
		{
			name: "RESOLVE_REQUEST",
			description:
				"Approve or reject a pending action queued for owner confirmation (send_email, send_message, book_travel, voice_call, etc.). Subactions: approve, reject. requestId is optional — the handler inspects the pending queue and infers the target from owner intent, or asks a follow-up.",
			parameters: [
				{
					name: "action",
					description: "One of: approve, reject.",
					required: false,
					schema: {
						type: "string",
						enum: ["approve", "reject"],
					},
					descriptionCompressed: "One of: approve, reject.",
				},
				{
					name: "requestId",
					description:
						"Approval request id to approve or reject. Optional: omit it when the user references the pending request in natural language.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Approval request id to approve or reject. Optional: omit it when user references the pending request in natural language.",
				},
				{
					name: "reason",
					description:
						"Optional short reason for the approval or rejection, in the user's language.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Optional short reason for the approval or rejection, in user's language.",
				},
			],
			descriptionCompressed:
				"approve|reject queued action; requestId optional; covers send_email|send_message|book_travel|voice_call",
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
			name: "ROBLOX",
			description:
				"Route Roblox game integration with action message, execute, or get_player.",
			parameters: [
				{
					name: "action",
					description: "Roblox operation: message, execute, or get_player.",
					required: true,
					schema: {
						type: "string",
						enum: ["message", "execute", "get_player"],
					},
					descriptionCompressed: "Roblox action.",
				},
				{
					name: "message",
					description: "Message content for the message subaction.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "message text",
				},
				{
					name: "actionName",
					description: "Game-side action name for execute.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "game action name",
				},
				{
					name: "parameters",
					description: "Game-side action parameters for execute.",
					required: false,
					schema: {
						type: "object",
					},
					descriptionCompressed: "game action params",
				},
				{
					name: "targetPlayerIds",
					description: "Roblox player IDs to target for message or execute.",
					required: false,
					schema: {
						type: "array",
						items: {
							type: "number",
						},
					},
					descriptionCompressed: "target player ids",
				},
				{
					name: "playerId",
					description: "Roblox player/user ID for lookup or targeting.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed: "Roblox user id",
				},
				{
					name: "username",
					description: "Roblox username for lookup.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Roblox username",
				},
			],
			descriptionCompressed:
				"Route Roblox action: message, execute, or get_player.",
			similes: ["ROBLOX", "ROBLOX_ROUTER", "ROBLOX_GAME_ACTION"],
			exampleCalls: [
				{
					user: "Use ROBLOX with the provided parameters.",
					actions: ["ROBLOX"],
					params: {
						ROBLOX: {
							action: "message",
							message: "example",
							actionName: "example",
							parameters: "example",
							targetPlayerIds: "example",
							playerId: 1,
							username: "example",
						},
					},
				},
			],
		},
		{
			name: "RS_2004",
			description:
				"Drive the 2004scape game agent. Choose one action (walk_to, chop, mine, fish, burn, cook, fletch, craft, smith, drop, pickup, equip, unequip, use, use_on_item, use_on_object, open, close, deposit, withdraw, buy, sell, attack, cast_spell, set_style, eat, talk, navigate_dialog, interact_object, open_door, pickpocket). For open/close, set target='bank' or target='shop' (or include npc to imply shop). Per-action fields go in params.",
			parameters: [
				{
					name: "action",
					description: "Operation to run.",
					required: true,
					schema: {
						type: "string",
						enum: [
							"walk_to",
							"chop",
							"mine",
							"fish",
							"burn",
							"cook",
							"fletch",
							"craft",
							"smith",
							"drop",
							"pickup",
							"equip",
							"unequip",
							"use",
							"use_on_item",
							"use_on_object",
							"open",
							"close",
							"deposit",
							"withdraw",
							"buy",
							"sell",
							"attack",
							"cast_spell",
							"set_style",
							"eat",
							"talk",
							"navigate_dialog",
							"interact_object",
							"open_door",
							"pickpocket",
						],
					},
					descriptionCompressed: "Action.",
				},
				{
					name: "subaction",
					description: "Legacy alias for action.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Legacy op alias.",
				},
				{
					name: "params",
					description:
						"Optional JSON object containing the fields required by the chosen op.",
					required: false,
					schema: {
						type: "object",
					},
					descriptionCompressed: "Action fields.",
				},
			],
			descriptionCompressed:
				"rs_2004 actions (walk_to, skills, inventory, bank, shop, combat, interact)",
			exampleCalls: [
				{
					user: "Use RS_2004 with the provided parameters.",
					actions: ["RS_2004"],
					params: {
						RS_2004: {
							action: "walk_to",
							subaction: "example",
							params: "example",
						},
					},
				},
			],
		},
		{
			name: "SCAPE",
			description:
				"Drive the 'scape (xRSPS) game agent. Pick one action: walk_to (x,z,run?), attack (npcId), chat_public (message), eat (item?), drop (item), set_goal (title,notes?), complete_goal (status?,goalId?,notes?), remember (notes,kind?,weight?). Returns success and a short status message; the autonomous loop already handles its own dispatch — this is the planner-facing surface.",
			parameters: [
				{
					name: "action",
					description: "Operation to run.",
					required: true,
					schema: {
						type: "string",
						enum: [
							"walk_to",
							"attack",
							"chat_public",
							"eat",
							"drop",
							"set_goal",
							"complete_goal",
							"remember",
						],
					},
					descriptionCompressed: "Action.",
				},
				{
					name: "subaction",
					description: "Legacy alias for action.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Legacy op alias.",
				},
				{
					name: "params",
					description:
						"Optional JSON object containing the fields required by the chosen action.",
					required: false,
					schema: {
						type: "object",
					},
					descriptionCompressed: "Action fields.",
				},
			],
			descriptionCompressed:
				"scape actions: walk_to|attack|chat_public|eat|drop|set_goal|complete_goal|remember",
			similes: [
				"SCAPE_WALK_TO",
				"MOVE_TO",
				"GO_TO",
				"TRAVEL_TO",
				"HEAD_TO",
				"ATTACK_NPC",
				"FIGHT_NPC",
				"KILL_NPC",
				"ENGAGE",
				"CHAT_PUBLIC",
				"SAY",
				"SPEAK",
				"TALK",
				"BROADCAST",
				"JOURNAL",
				"INVENTORY",
				"SET_GOAL",
				"COMPLETE_GOAL",
				"REMEMBER",
				"EAT_FOOD",
				"DROP_ITEM",
			],
			exampleCalls: [
				{
					user: "Use SCAPE with the provided parameters.",
					actions: ["SCAPE"],
					params: {
						SCAPE: {
							action: "walk_to",
							subaction: "example",
							params: "example",
						},
					},
				},
			],
		},
		{
			name: "SCHEDULED_TASKS",
			description:
				"Manage the owner's scheduled-task spine: reminders, check-ins, follow-ups, approvals, recaps, watchers, outputs, and custom tasks. Actions: list, get, create, update, snooze, skip, complete, acknowledge, dismiss, cancel, reopen, history.",
			parameters: [
				{
					name: "action",
					description:
						"Which scheduled-task operation to run: list | get | create | update | snooze | skip | complete | acknowledge | dismiss | cancel | reopen | history.",
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
						"Which scheduled-task operation to run: list | get | create | update | snooze | skip | complete | acknowledge | dismiss | cancel | reopen | history.",
				},
				{
					name: "taskId",
					description:
						"Target taskId for get / update / snooze / skip / complete / acknowledge / dismiss / cancel / reopen / history.",
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
						"ScheduledTaskKind for create + filter for list. One of reminder, checkin, followup, approval, recap, watcher, output, custom.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"ScheduledTaskKind for create + filter for list. One of reminder, checkin, followup, approval, recap, watcher, output, custom.",
				},
				{
					name: "status",
					description:
						"Status filter for list (string or string[]). One of scheduled, fired, acknowledged, completed, skipped, expired, failed, dismissed.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Status filter for list (string or string[]). One of scheduled, fired, acknowledged, completed, skipped, expired, failed, dismissed.",
				},
				{
					name: "subjectKind",
					description:
						"ScheduledTaskSubject.kind: entity | relationship | thread | document | calendar_event | self.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"ScheduledTaskSubject. kind: entity | relationship | thread | document | calendar_event | self.",
				},
				{
					name: "subjectId",
					description: "ScheduledTaskSubject.id paired with subjectKind.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"ScheduledTaskSubject. id paired with subjectKind.",
				},
				{
					name: "ownerVisibleOnly",
					description: "When true, list returns only ownerVisible tasks.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed:
						"When true, list returns only ownerVisible tasks.",
				},
				{
					name: "promptInstructions",
					description: "create-only: prompt instructions stored on the task.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"create-only: prompt instructions stored on the task.",
				},
				{
					name: "trigger",
					description:
						"create-only: ScheduledTaskTrigger object (once / cron / interval / relative_to_anchor / during_window / event / manual / after_task).",
					required: false,
					schema: {
						type: "object",
					},
					descriptionCompressed:
						"create-only: ScheduledTaskTrigger object (once/cron/interval/relative_to_anchor/during_window/event/manual/after_task).",
				},
				{
					name: "contextRequest",
					description:
						"create-only: structured context request for owner facts, entities, relationships, recent task states, or event payload.",
					required: false,
					schema: {
						type: "object",
					},
					descriptionCompressed:
						"create-only: structured context request for owner facts, entities, relationships, recent task states, or event payload.",
				},
				{
					name: "shouldFire",
					description:
						"create-only: structural gate composition; use gate refs rather than prompt text conditions.",
					required: false,
					schema: {
						type: "object",
					},
					descriptionCompressed:
						"create-only: structural gate composition. use gate refs rather than prompt text conditions.",
				},
				{
					name: "completionCheck",
					description:
						"create-only: structural completion check such as user_replied_within, user_acknowledged, subject_updated, or health_signal_observed.",
					required: false,
					schema: {
						type: "object",
					},
					descriptionCompressed:
						"create-only: structural completion check such as user_replied_within, user_acknowledged, subject_updated, or health_signal_observed.",
				},
				{
					name: "output",
					description:
						"create-only: output destination/target, e.g. { destination: 'channel', target: 'in_app:<roomId>' }.",
					required: false,
					schema: {
						type: "object",
					},
					descriptionCompressed:
						"create-only: output destination/target, e. g. { destination: 'channel', target: 'in_app:<roomId>' }.",
				},
				{
					name: "pipeline",
					description:
						"create-only: child ScheduledTask refs for onComplete/onSkip/onFail.",
					required: false,
					schema: {
						type: "object",
					},
					descriptionCompressed:
						"create-only: child ScheduledTask refs for onComplete/onSkip/onFail.",
				},
				{
					name: "escalation",
					description:
						"create-only: escalation ladder or explicit channel steps.",
					required: false,
					schema: {
						type: "object",
					},
					descriptionCompressed:
						"create-only: escalation ladder or explicit channel steps.",
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
					description:
						"create-only: stable key for deduping repeated schedules.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"create-only: stable key for deduping repeated schedules.",
				},
				{
					name: "priority",
					description: "create-only: low | medium | high (default medium).",
					required: false,
					schema: {
						type: "string",
						enum: ["low", "medium", "high"],
					},
					descriptionCompressed:
						"create-only: low | medium | high (default medium).",
				},
				{
					name: "respectsGlobalPause",
					description:
						"create-only: when true, the task skips during global pause.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed:
						"create-only: when true, the task skips during global pause.",
				},
				{
					name: "ownerVisible",
					description:
						"create-only: when true, the task surfaces in owner views.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed:
						"create-only: when true, the task surfaces in owner views.",
				},
				{
					name: "source",
					description:
						"create-only: task source (default_pack | user_chat | first_run | plugin).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"create-only: task source (default_pack | user_chat | first_run | plugin).",
				},
				{
					name: "minutes",
					description: "snooze-only: minutes to defer next fire.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed: "snooze-only: minutes to defer next fire.",
				},
				{
					name: "untilIso",
					description: "snooze-only: ISO-8601 timestamp to defer next fire to.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"snooze-only: ISO-8601 timestamp to defer next fire to.",
				},
				{
					name: "reason",
					description:
						"skip / complete / acknowledge / dismiss / reopen: free-form reason recorded on the state log.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"skip/complete/acknowledge/dismiss/reopen: free-form reason recorded on the state log.",
				},
				{
					name: "patch",
					description:
						"update-only: shallow patch of editable ScheduledTask fields.",
					required: false,
					schema: {
						type: "object",
					},
					descriptionCompressed:
						"update-only: shallow patch of editable ScheduledTask fields.",
				},
				{
					name: "sinceIso",
					description:
						"history-only: ISO-8601 lower bound on log occurredAtIso.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"history-only: ISO-8601 lower bound on log occurredAtIso.",
				},
				{
					name: "untilHistoryIso",
					description:
						"history-only: ISO-8601 upper bound on log occurredAtIso.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"history-only: ISO-8601 upper bound on log occurredAtIso.",
				},
				{
					name: "includeRollups",
					description:
						"history-only: include rolled-up daily summary log rows (default false; raw rows only).",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed:
						"history-only: include rolled-up daily summary log rows (default false. raw rows only).",
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
				"scheduled tasks: list|get|create|update|snooze|skip|complete|acknowledge|dismiss|cancel|reopen|history; kinds reminder|checkin|followup|approval|recap|watcher|output|custom",
			similes: [
				"TASKS",
				"SCHEDULED_TASK",
				"REMINDER_TASK",
				"SCHEDULED_REMINDER",
				"SCHEDULED_FOLLOWUP",
				"TASK_SNOOZE",
				"TASK_COMPLETE",
				"TASK_ACKNOWLEDGE",
				"TASK_DISMISS",
				"ADD_FOLLOW_UP",
				"COMPLETE_FOLLOW_UP",
				"FOLLOW_UP_LIST",
				"DAYS_SINCE",
				"LIST_OVERDUE_FOLLOWUPS",
				"MARK_FOLLOWUP_DONE",
				"SET_FOLLOWUP_THRESHOLD",
			],
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
			name: "SHELL",
			description:
				"Execute a shell command via the configured local shell. Runs synchronously in the session cwd by default. Returns stdout, stderr, and exit code. Hard timeout kills the command. Paths under the configured blocklist are off-limits as cwd.",
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
			similes: ["BASH", "EXEC", "RUN_COMMAND"],
			exampleCalls: [
				{
					user: "Use SHELL with the provided parameters.",
					actions: ["SHELL"],
					params: {
						SHELL: {
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
			name: "SHELL_HISTORY",
			description:
				"Shell command-history router. action=clear wipes the recorded history; action=view returns recent commands; action=disable is reserved for future use.",
			parameters: [
				{
					name: "action",
					description:
						"Operation: clear | view | disable. Inferred from message text when omitted (defaults to clear).",
					required: false,
					schema: {
						type: "string",
						enum: ["clear", "view", "disable"],
					},
					descriptionCompressed:
						"Operation: clear | view | disable. Inferred from msg text when omitted (defaults to clear).",
				},
				{
					name: "limit",
					description:
						"For action=view: maximum number of history entries to return (default 20).",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed:
						"For action=view: max number of history entries to return (default 20).",
				},
			],
			descriptionCompressed: "Shell history: clear | view | disable.",
			similes: [
				"CLEAR_HISTORY",
				"CLEAR_SHELL_HISTORY",
				"RESET_SHELL",
				"CLEAR_TERMINAL",
				"RESET_HISTORY",
				"VIEW_SHELL_HISTORY",
				"SHOW_SHELL_HISTORY",
				"LIST_SHELL_HISTORY",
			],
			exampleCalls: [
				{
					user: "Use SHELL_HISTORY with the provided parameters.",
					actions: ["SHELL_HISTORY"],
					params: {
						SHELL_HISTORY: {
							action: "clear",
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
					name: "subaction",
					description: "Legacy alias for action.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Legacy alias for action.",
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
							subaction: "example",
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
				"Manage skill catalog. Operations: search (browse available skills), details (info about a specific skill), sync (refresh catalog from registry), toggle (enable/disable installed skill), install (install from registry), uninstall (remove non-bundled skill). For invoking an enabled skill, use USE_SKILL instead.",
			parameters: [
				{
					name: "action",
					description:
						"Operation to perform. One of: search, details, sync, toggle, install, uninstall. Inferred from message text when omitted.",
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
						"Operation to perform. One of: search, details, sync, toggle, install, uninstall. Inferred from msg text when omitted.",
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
						},
					},
				},
			],
		},
		{
			name: "TASKS",
			description:
				"Single planner-visible surface for the orchestrator's task-agent and workspace lifecycle. ",
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
						"Task operation: create, spawn_agent, send, stop_agent, list_agents, cancel, history, control, share, provision_workspace, submit_workspace, manage_issues...",
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
						"Agent type (codex, claude, etc.) for create / spawn_agent / control.resume.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Agent type (codex, claude, etc.) for create/spawn_agent/control. resume.",
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
					description: "Additional metadata for action=create.",
					required: false,
					schema: {
						type: "object",
					},
					descriptionCompressed: "Additional metadata for action=create.",
				},
			],
			descriptionCompressed:
				"tasks: action=create|spawn_agent|send|stop_agent|list_agents|cancel|history|control|share|provision_workspace|submit_workspace|manage_issues|archive|reopen",
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
							task: "example",
							agentType: "example",
							agents: "example",
							repo: "example",
							workdir: "example",
							memoryContent: "example",
							label: "example",
							approvalPreset: "readonly",
							keepAliveAfterComplete: false,
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
						},
					},
				},
			],
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
					name: "subaction",
					description: "Legacy alias for action.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Legacy alias for action.",
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
							subaction: "example",
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
				"TAILSCALE",
				"START_TAILSCALE",
				"STOP_TAILSCALE",
				"GET_TAILSCALE_STATUS",
				"START_TUNNEL",
				"OPEN_TUNNEL",
				"CREATE_TUNNEL",
				"TAILSCALE_UP",
				"STOP_TUNNEL",
				"CLOSE_TUNNEL",
				"TAILSCALE_DOWN",
				"TAILSCALE_STATUS",
				"CHECK_TUNNEL",
				"TUNNEL_INFO",
				"TUNNEL_STATUS",
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
				"Tunnel operations dispatched by `action`: start, stop, status. The `start` action accepts an optional `port` (defaults to 3000). `stop` and `status` take no...",
		},
		{
			name: "UPDATE_MEETING_PREFERENCES",
			description:
				"Persist the owner's meeting scheduling preferences: preferred start/end ",
			parameters: [
				{
					name: "timeZone",
					description: "IANA time zone used to interpret preferred hours.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"IANA time zone used to interpret preferred hours.",
				},
				{
					name: "preferredStartLocal",
					description:
						"Earliest preferred meeting start time-of-day (local HH:MM, 24h).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Earliest preferred meeting start time-of-day (local HH:MM, 24h).",
				},
				{
					name: "preferredEndLocal",
					description:
						"Latest preferred meeting end time-of-day (local HH:MM, 24h).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Latest preferred meeting end time-of-day (local HH:MM, 24h).",
				},
				{
					name: "defaultDurationMinutes",
					description: "Default meeting duration in minutes (5–480).",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed: "Default meeting duration in minutes (5-480).",
				},
				{
					name: "travelBufferMinutes",
					description: "Minutes to reserve before/after each meeting (0–240).",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed:
						"Minutes to reserve before/after each meeting (0-240).",
				},
				{
					name: "blackoutWindows",
					description:
						"Array of { label, startLocal (HH:MM), endLocal (HH:MM), daysOfWeek? (0=Sun..6=Sat) }.",
					required: false,
					schema: {
						type: "array",
					},
					descriptionCompressed:
						"Array of { label, startLocal (HH:MM), endLocal (HH:MM), daysOfWeek? (0=Sun. 6=Sat) }.",
				},
			],
			descriptionCompressed:
				"Persist owner meeting preferences: preferred hours, blackout windows, default duration, and travel buffer.",
			similes: [
				"SET_MEETING_PREFERENCES",
				"SAVE_MEETING_PREFERENCES",
				"SET_PREFERRED_TIMES",
				"SET_BLACKOUT_WINDOWS",
				"SLEEP_WINDOW",
				"NO_CALL_HOURS",
				"PROTECT_SLEEP",
			],
			exampleCalls: [
				{
					user: "Use UPDATE_MEETING_PREFERENCES with the provided parameters.",
					actions: ["UPDATE_MEETING_PREFERENCES"],
					params: {
						UPDATE_MEETING_PREFERENCES: {
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
			name: "USE_SKILL",
			description:
				"Invoke an enabled skill by slug. The skill's instructions or script run and the result returns to the conversation.",
			parameters: [
				{
					name: "slug",
					description:
						"Slug (canonical name) of an enabled skill to invoke. Must match a skill returned by the enabled_skills provider.",
					required: true,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Slug (canonical name) of an enabled skill to invoke. Must match a skill returned by the enabled_skills provider.",
				},
				{
					name: "mode",
					description:
						"How to invoke the skill: 'script' to run the bundled executable, 'guidance' to load the SKILL.md instructions, or 'auto' to pick automatically based on whether the skill ships scripts.",
					required: false,
					schema: {
						type: "string",
						enum: ["guidance", "script", "auto"],
						default: "auto",
					},
					descriptionCompressed:
						"How to invoke the skill: 'script' to run the bundled executable, 'guidance' to load the SKILL. md instructions, or 'auto' to pick automatically based on...",
				},
				{
					name: "script",
					description:
						"Optional script filename to run (used with mode='script' or mode='auto' when the skill has multiple scripts). Defaults to the first script in the skill.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Optional script filename to run (used with mode='script' or mode='auto' when the skill has multiple scripts). Defaults to the first script in the skill.",
				},
				{
					name: "args",
					description:
						"Optional arguments to pass to the skill's script. Either an array of strings or a JSON object whose values become positional arguments.",
					required: false,
					schema: {
						type: "object",
					},
					descriptionCompressed:
						"Optional arguments to pass to the skill's script. Either an array of strings or a JSON object whose values become positional arguments.",
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
				"USE_CAPABILITY",
				"RUN_CAPABILITY",
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
			name: "VOICE_CALL",
			description:
				"Owner-only. Place an outbound voice call via a registered provider. Action: `dial` with recipientKind=owner|external|e164. Current dispatch provider is Twilio; Android/app-phone is implementation-only until wired as a VOICE_CALL provider. Owner uses the env-configured owner number + standing escalation policy; external resolves a contact name via relationships then checks the allow-list; e164 dials a raw phone number. All paths draft first, require confirmed:true to dispatch, and use the approval queue.",
			parameters: [
				{
					name: "action",
					description: "Single canonical verb: `dial`.",
					required: false,
					schema: {
						type: "string",
						enum: ["dial"],
					},
					descriptionCompressed: "Single canonical verb: `dial`.",
				},
				{
					name: "recipientKind",
					description:
						"Recipient discriminator: `owner` (escalation; uses owner number env), `external` (third party; recipient name resolved via relationships, allow-list checked), or `e164` (raw E.164 phone in `phoneNumber`).",
					required: true,
					schema: {
						type: "string",
						enum: ["owner", "external", "e164"],
					},
					descriptionCompressed:
						"Recipient discriminator: `owner` (escalation. uses owner number env), `external` (third party. recipient name resolved via relationships, allow-list...",
				},
				{
					name: "phoneNumber",
					description:
						"For recipientKind=e164: destination phone number in E.164 format (e.g. +15551234567).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"For recipientKind=e164: destination phone number in E. 164 format (e. g. +15551234567).",
				},
				{
					name: "recipient",
					description:
						"For recipientKind=external: contact name or E.164 phone number. Names resolve via the relationships store.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"For recipientKind=external: contact name or E. 164 phone number. Names resolve via the relationships store.",
				},
				{
					name: "bodyText",
					description: "Optional spoken message played when the call connects.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Optional spoken msg played when the call connects.",
				},
				{
					name: "confirmed",
					description:
						"Must be true to actually place the call. Without it the action returns a draft / approval-queue entry.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed:
						"Must be true to place the call. without it the action returns a draft/approval-queue entry.",
				},
				{
					name: "reason",
					description:
						"Optional reason describing why the call is being placed (recorded with the approval task).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Optional reason describing why the call is being placed (recorded with the approval task).",
				},
			],
			descriptionCompressed:
				"Twilio voice dial: recipientKind=owner|external|e164; draft-confirm; approval-queue",
			similes: [
				"PLACE_CALL",
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
			name: "WINDOW",
			description:
				"Single WINDOW action — manages local desktop windows through the computer-use service. ",
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
						],
					},
					descriptionCompressed: "Window operation verb.",
				},
				{
					name: "subaction",
					description: "Legacy alias for action.",
					required: false,
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
					descriptionCompressed: "Legacy alias for action.",
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
					description:
						"Layout for window arrange: tile, cascade, vertical, or horizontal.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Layout for window arrange: tile, cascade, vertical, or horizontal.",
				},
				{
					name: "x",
					description: "Target X coordinate for window move.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed: "Target X coordinate for window move.",
				},
				{
					name: "y",
					description: "Target Y coordinate for window move.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed: "Target Y coordinate for window move.",
				},
			],
			descriptionCompressed:
				"Single WINDOW action; action=list|focus|switch|arrange|move|minimize|maximize|restore|close manages local desktop windows.",
			similes: ["MANAGE_WINDOW", "WINDOW", "USE_WINDOW", "WINDOW_ACTION"],
			exampleCalls: [
				{
					user: "Use WINDOW with the provided parameters.",
					actions: ["WINDOW"],
					params: {
						WINDOW: {
							action: "list",
							subaction: "list",
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
			name: "WORK_THREAD",
			description:
				"Create, steer, stop, wait, complete, merge, attach source refs to, or schedule follow-up work for owner work threads. Use only for thread lifecycle/routing; domain work stays on existing task/messaging/workflow actions.",
			parameters: [
				{
					name: "operations",
					description:
						"Array of thread lifecycle operations. Each item has type, optional workThreadId, sourceWorkThreadIds, instruction, reason, title, summary, sourceRef, and trigger for schedule_followup.",
					required: true,
					schema: {
						type: "array",
						items: {
							type: "object",
						},
					},
					descriptionCompressed:
						"Array of thread lifecycle operations. Each item has type, optional workThreadId, sourceWorkThreadIds, instruction, reason, title, summary, sourceRef, and...",
				},
			],
			descriptionCompressed:
				"work-thread lifecycle: create|steer|stop|mark_waiting|mark_completed|merge|attach_source|schedule_followup",
			similes: [
				"THREAD_CONTROL",
				"STEER_THREAD",
				"STOP_THREAD",
				"CREATE_THREAD",
				"SCHEDULE_THREAD_FOLLOWUP",
			],
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
						"Operation: create, modify, activate, deactivate, toggle_active, delete, executions.",
					required: true,
					schema: {
						type: "string",
						enum: [
							"create",
							"modify",
							"activate",
							"deactivate",
							"toggle_active",
							"delete",
							"executions",
						],
					},
					descriptionCompressed:
						"Operation: create, modify, activate, deactivate, toggle_active, delete, executions.",
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
						"Max executions to return for action=executions (default 10).",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed:
						"Max executions to return for action=executions (default 10).",
				},
			],
			descriptionCompressed:
				"manage workflows; action-based dispatch (create modify activate deactivate toggle_active delete executions)",
			similes: [
				"CREATE_WORKFLOW",
				"DELETE_WORKFLOW",
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
			],
			exampleCalls: [
				{
					user: "Use WORKFLOW with the provided parameters.",
					actions: ["WORKFLOW"],
					params: {
						WORKFLOW: {
							action: "create",
							workflowId: "example",
							workflowName: "example",
							seedPrompt: "example",
							name: "example",
							active: false,
							limit: 1,
						},
					},
				},
			],
		},
		{
			name: "WORKTREE",
			description:
				"Manage the current git worktree stack. Choose action=enter to create and switch into an isolated worktree, or action=exit to leave the current worktree and optionally remove it.",
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
						"For action=enter, optional worktree branch/dir name. Defaults to auto-*.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"For action=enter, optional worktree branch/dir name. Defaults to auto-*.",
				},
				{
					name: "path",
					description:
						"For action=enter, optional absolute worktree directory within sandbox roots.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"For action=enter, optional absolute worktree directory within sandbox roots.",
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
						"For action=exit, remove the popped worktree directory with git worktree remove --force.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed:
						"For action=exit, remove the popped worktree directory with git worktree remove --force.",
				},
			],
			descriptionCompressed: "Git worktree umbrella: action=enter/exit.",
			similes: [
				"ENTER_WORKTREE",
				"EXIT_WORKTREE",
				"GIT_WORKTREE_ADD",
				"GIT_WORKTREE_REMOVE",
			],
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
