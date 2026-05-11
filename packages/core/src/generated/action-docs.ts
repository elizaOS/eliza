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
			name: "BROWSER",
			description:
				"Single BROWSER action — control whichever browser target is registered. Targets are pluggable: `workspace` (electrobun-embedded BrowserView, the default; falls back to a JSDOM web mode when the desktop bridge isn't configured), `bridge` (the user's real Chrome/Safari via the Agent Browser Bridge companion extension), and `computeruse` (a local puppeteer-driven Chromium via plugin-computeruse). The agent uses what is available — the BrowserService picks the active target when none is specified. Use `subaction: \"autofill-login\"` with `domain` (and optional `username`, `submit`) to vault-gated autofill into an open workspace tab.",
			parameters: [
				{
					name: "action",
					description:
						"Browser action to perform. Legacy subaction is also accepted.",
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
							"autofill-login",
						],
					},
					descriptionCompressed:
						"Browser action to perform. Legacy subaction is also accepted.",
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
						"Required when subaction is autofill-login: registrable hostname (e.g. `github.com`).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Required when subaction is autofill-login: registrable hostname (e. g. `github.com`).",
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
				"Browser tab/page control: open/navigate/click/type/screenshot/state; subaction autofill-login + domain autofill vault-gated credential into workspace tab pre-authorized in Settings Vault Logins. Bridge settings/status use MANAGE_BROWSER_BRIDGE.",
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
			name: "DESKTOP",
			description:
				"Single DESKTOP action — dispatches local desktop operations through the computer-use service. ",
			parameters: [
				{
					name: "subaction",
					description:
						"Desktop operation group. Reserved future values: screenshot, ocr, detect_elements (currently on COMPUTER_USE).",
					required: true,
					schema: {
						type: "string",
						enum: ["screenshot", "ocr", "detect_elements"],
					},
					descriptionCompressed:
						"Desktop operation group. Reserved future values: screenshot, ocr, detect_elements (on COMPUTER_USE).",
				},
				{
					name: "action",
					description:
						"Sub-op verb for the chosen op (e.g. read/write for file, list/focus for window, execute for terminal).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Sub-op verb for the chosen op (e. g. read/write for file, list/focus for window, execute for terminal).",
				},
				{
					name: "path",
					description: "Primary file or directory path (file op).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Primary file or directory path (file op).",
				},
				{
					name: "filepath",
					description: "Upstream alias for path (file op).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Upstream alias for path (file op).",
				},
				{
					name: "dirpath",
					description: "Upstream alias for directory path (file op).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Upstream alias for directory path (file op).",
				},
				{
					name: "content",
					description: "Content for write, append, or upload (file op).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Content for write, append, or upload (file op).",
				},
				{
					name: "encoding",
					description: "Encoding for read/download (file op).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Encoding for read/download (file op).",
				},
				{
					name: "oldText",
					description: "Replacement source text for edit (file op).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Replacement source text for edit (file op).",
				},
				{
					name: "newText",
					description: "Replacement destination text for edit (file op).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Replacement destination text for edit (file op).",
				},
				{
					name: "old_text",
					description: "Upstream edit source text (file op).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Upstream edit source text (file op).",
				},
				{
					name: "new_text",
					description: "Upstream edit destination text (file op).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Upstream edit destination text (file op).",
				},
				{
					name: "find",
					description: "Upstream alias for old_text (file op).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Upstream alias for old_text (file op).",
				},
				{
					name: "replace",
					description: "Upstream alias for new_text (file op).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Upstream alias for new_text (file op).",
				},
				{
					name: "windowId",
					description: "Window identifier (window op).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Window id (window op).",
				},
				{
					name: "windowTitle",
					description: "Window title or app-name query (window op).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Window title or app-name query (window op).",
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
				{
					name: "command",
					description: "Shell command (terminal op execute / execute_command).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Shell command (terminal op execute/execute_command).",
				},
				{
					name: "cwd",
					description: "Working directory for terminal connect or execute.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Working directory for terminal connect or execute.",
				},
				{
					name: "sessionId",
					description: "Terminal session ID alias.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Terminal session ID alias.",
				},
				{
					name: "session_id",
					description: "Upstream terminal session ID alias.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Upstream terminal session ID alias.",
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
					description: "Timeout in seconds (terminal op).",
					required: false,
					schema: {
						type: "number",
						default: 30,
					},
					descriptionCompressed: "Timeout in seconds (terminal op).",
				},
				{
					name: "timeoutSeconds",
					description: "Alias for timeout (terminal op).",
					required: false,
					schema: {
						type: "number",
						default: 30,
					},
					descriptionCompressed: "Alias for timeout (terminal op).",
				},
			],
			descriptionCompressed:
				"Single DESKTOP action; op=file|window|terminal dispatches to the matching computer-use op (screenshot/ocr/detect_elements reserved).",
			similes: [
				"FILE_ACTION",
				"MANAGE_WINDOW",
				"TERMINAL_ACTION",
				"DESKTOP",
				"USE_DESKTOP",
				"DESKTOP_ACTION",
			],
			exampleCalls: [
				{
					user: "Use DESKTOP with the provided parameters.",
					actions: ["DESKTOP"],
					params: {
						DESKTOP: {
							subaction: "screenshot",
							action: "example",
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
							windowId: "example",
							windowTitle: "example",
							arrangement: "example",
							x: 1,
							y: 1,
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
							action: "example",
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
							action: "example",
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
							action: "example",
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
				"Unified music action. Use flat action for everything: library (playlist, play_query, search_youtube, download), playback transport (pause, resume, skip, stop, queue), play_audio, routing, zones. ",
			parameters: [
				{
					name: "action",
					description:
						"Flat operation: playlist | play_query | search_youtube | download | pause | resume | skip | stop | queue | play_audio | routing | zones (hyphens and legacy aliases accepted).",
					required: false,
					schema: {
						type: "string",
						enum: [
							"playlist",
							"play_query",
							"search_youtube",
							"download",
							"pause",
							"resume",
							"skip",
							"stop",
							"queue",
							"play_audio",
							"routing",
							"zones",
						],
					},
					descriptionCompressed:
						"Flat operation: playlist | play_query | search_youtube | download | pause | resume | skip | stop | queue | play_audio | routing | zones (hyphens and legacy...",
				},
				{
					name: "subaction",
					description:
						"Playlist subaction when op=playlist (save, load, delete, add, …).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Playlist subaction when op=playlist (save, load, delete, add, …).",
				},
				{
					name: "query",
					description: "Search/play/queue query depending on op.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Search/play/queue query depending on op.",
				},
				{
					name: "url",
					description: "Direct media URL when using play_audio.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Direct media URL when using play_audio.",
				},
				{
					name: "playlistName",
					description: "Playlist name for playlist ops.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Playlist name for playlist ops.",
				},
				{
					name: "song",
					description: "Song query for playlist add.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Song query for playlist add.",
				},
				{
					name: "limit",
					description: "Search result limit (YouTube / library helpers).",
					required: false,
					schema: {
						type: "number",
						minimum: 1,
						maximum: 10,
					},
					descriptionCompressed:
						"Search result limit (YouTube/library helpers).",
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
						"Structured routing operation when using routing (set_mode, start_route, …).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Structured routing operation when using routing (set_mode, start_route, …).",
				},
				{
					name: "mode",
					description: "Routing mode for routing operations.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Routing mode for routing operations.",
				},
				{
					name: "sourceId",
					description: "Stream/source id for routing.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Stream/source id for routing.",
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
			],
			descriptionCompressed:
				"Flat op: playlist/play_query/search_youtube/download/pause/resume/skip/stop/queue/play_audio/routing/zones.",
			exampleCalls: [
				{
					user: "Use MUSIC with the provided parameters.",
					actions: ["MUSIC"],
					params: {
						MUSIC: {
							action: "playlist",
							subaction: "example",
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
						},
					},
				},
			],
		},
		{
			name: "MUSIC_GENERATION",
			description:
				"Generate music through Suno. Use action generate for a simple prompt, custom for style/BPM/key/reference parameters, or extend for an existing audio_id and duration.",
			parameters: [
				{
					name: "action",
					description: "Suno operation: generate, custom, or extend.",
					required: false,
					schema: {
						type: "string",
						enum: ["generate", "custom", "extend"],
					},
					descriptionCompressed: "Suno operation: generate, custom, or extend.",
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
				"Suno music generation router action: generate, custom, extend.",
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
							action: "generate",
							subaction: "example",
							prompt: "example",
							audio_id: "example",
							duration: 30,
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
				"PAYMENT",
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
			name: "OWNER_FINANCES",
			description:
				"Owner finances: payment sources, transaction imports, spending summaries, recurring charges, and subscription audits.",
			parameters: [],
			descriptionCompressed:
				"owner finances: dashboard|list_sources|add_source|remove_source|import_csv|list_transactions|spending_summary|recurring_charges|subscription_audit|subscription_cancel|subscription_status",
			similes: ["MONEY", "FINANCES", "PAYMENTS", "SUBSCRIPTIONS"],
		},
		{
			name: "OWNER_HEALTH",
			description:
				"Owner health telemetry reads across HealthKit, Google Fit, Strava, Fitbit, Withings, or Oura. Actions: today, trend, by_metric, status.",
			parameters: [],
			descriptionCompressed:
				"owner health: today|trend|by_metric|status; read-only telemetry",
			similes: ["HEALTH", "FITNESS", "WELLNESS"],
		},
		{
			name: "OWNER_SCREENTIME",
			description:
				"Owner screen-time and activity analytics across local activity, app usage, and browser reports.",
			parameters: [],
			descriptionCompressed:
				"owner screentime: summary|today|weekly|by_app|by_website|activity_report|time_on_app|time_on_site|browser_activity",
			similes: ["SCREENTIME", "SCREEN_TIME", "ACTIVITY_REPORT"],
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
			name: "READING",
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
							action: "start",
							question: "example",
							context: "example",
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
							action: "example",
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
							action: "example",
							subaction: "example",
							params: "example",
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
							action: "example",
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
							action: "example",
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
							action: "example",
							parameters: "example",
						},
					},
				},
			],
			descriptionCompressed:
				"Tunnel operations dispatched by `action`: start, stop, status. The `start` action accepts an optional `port` (defaults to 3000). `stop` and `status` take no...",
		},
		{
			name: "USE_SKILL",
			description:
				"Invoke an enabled skill by slug. The skill's instructions or script run and the result returns to the conversation.",
			parameters: [],
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
		},
		{
			name: "VOICE_CALL",
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
			similes: [
				"PLACE_CALL",
				"CALL",
				"DIAL",
				"RING",
				"PHONE_CALL",
				"MAKE_CALL",
			],
			exampleCalls: [
				{
					user: "Use VOICE_CALL with the provided parameters.",
					actions: ["VOICE_CALL"],
					params: {
						VOICE_CALL: {
							phoneNumber: "example",
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
							action: "example",
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
