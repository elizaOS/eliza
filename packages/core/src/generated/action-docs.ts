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
				"Primary action for addressed messaging surfaces: DMs, group chats, channels, rooms, threads, servers, users, inboxes, drafts, and owner message workflows. Choose operation=send, read_channel, read_with_contact, search, list_channels, list_servers, react, edit, delete, pin, join, leave, get_user, triage, list_inbox, search_inbox, draft_reply, draft_followup, respond, send_draft, schedule_draft_send, or manage. Public feed publishing belongs to POST.",
			similes: ["DM", "DIRECT_MESSAGE", "CHAT", "CHANNEL", "ROOM"],
			parameters: [
				{
					name: "operation",
					description:
						"Message subaction: send, read_channel, read_with_contact, search, list_channels, list_servers, react, edit, delete, pin, join, leave, get_user, triage, list_inbox, search_inbox, draft_reply, draft_followup, respond, send_draft, schedule_draft_send, or manage.",
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
					descriptionCompressed: "message operation",
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
						"Optional inbox sources for operation=triage, list_inbox, or search_inbox.",
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
						"Message text for operation=send or replacement text for operation=edit.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "message text",
				},
				{
					name: "query",
					description:
						"Search term for operation=search or operation=search_inbox.",
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
						"Draft or response body for operation=draft_reply, draft_followup, or respond.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "draft body",
				},
				{
					name: "to",
					description: "Recipient identifiers for operation=draft_followup.",
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
						"Draft identifier for operation=send_draft or operation=schedule_draft_send.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "draft id",
				},
				{
					name: "confirmed",
					description:
						"Whether the user explicitly confirmed sending for operation=send_draft.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed: "send confirmed",
				},
				{
					name: "sendAt",
					description: "Scheduled send time for operation=schedule_draft_send.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "send time",
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
					name: "manageOperation",
					description:
						"Management operation for operation=manage, such as archive, trash, spam, mark_read, label_add, label_remove, tag_add, tag_remove, mute_thread, or unsubscribe.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "manage operation",
				},
				{
					name: "label",
					description:
						"Label for operation=manage when adding or removing labels.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "message label",
				},
				{
					name: "tag",
					description: "Tag for operation=manage when adding or removing tags.",
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
						"Start timestamp or parseable date for operation=search_inbox.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "search start",
				},
				{
					name: "until",
					description:
						"End timestamp or parseable date for operation=read_channel range=dates or operation=search_inbox.",
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
							operation: "send",
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
							operation: "triage",
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
				"Primary action for public feed surfaces and timelines. Choose op=send to publish a post, op=read to fetch recent feed posts, or op=search to search public posts. Addressed DMs, groups, channels, rooms, and inbox/draft workflows belong to MESSAGE.",
			similes: ["TWEET", "CAST", "PUBLISH", "FEED_POST", "TIMELINE"],
			parameters: [
				{
					name: "op",
					description: "Post subaction: send, read, or search.",
					required: false,
					schema: {
						type: "string",
						enum: ["send", "read", "search"],
					},
					descriptionCompressed: "post op",
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
						"Loose feed target for operation=send/read, such as a user, channel, media id, or connector-specific reference.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "feed target",
				},
				{
					name: "feed",
					description:
						"Feed convention for operation=read, such as home, user, hashtag, channel, or connector-specific feed.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "feed",
				},
				{
					name: "query",
					description: "Search term for operation=search.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "post search query",
				},
				{
					name: "replyTo",
					description: "Post/comment/reply target for operation=send.",
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
						"Opaque pagination cursor for operation=read or operation=search.",
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
							op: "send",
						},
					},
				},
			],
			descriptionCompressed:
				"primary post action ops send read search public feed timeline posts",
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
				"Primary action for addressed messaging surfaces: DMs, group chats, channels, rooms, threads, servers, users, inboxes, drafts, and owner message workflows. Choose operation=send, read_channel, read_with_contact, search, list_channels, list_servers, react, edit, delete, pin, join, leave, get_user, triage, list_inbox, search_inbox, draft_reply, draft_followup, respond, send_draft, schedule_draft_send, or manage. Public feed publishing belongs to POST.",
			similes: ["DM", "DIRECT_MESSAGE", "CHAT", "CHANNEL", "ROOM"],
			parameters: [
				{
					name: "operation",
					description:
						"Message subaction: send, read_channel, read_with_contact, search, list_channels, list_servers, react, edit, delete, pin, join, leave, get_user, triage, list_inbox, search_inbox, draft_reply, draft_followup, respond, send_draft, schedule_draft_send, or manage.",
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
					descriptionCompressed: "message operation",
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
						"Optional inbox sources for operation=triage, list_inbox, or search_inbox.",
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
						"Message text for operation=send or replacement text for operation=edit.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "message text",
				},
				{
					name: "query",
					description:
						"Search term for operation=search or operation=search_inbox.",
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
						"Draft or response body for operation=draft_reply, draft_followup, or respond.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "draft body",
				},
				{
					name: "to",
					description: "Recipient identifiers for operation=draft_followup.",
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
						"Draft identifier for operation=send_draft or operation=schedule_draft_send.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "draft id",
				},
				{
					name: "confirmed",
					description:
						"Whether the user explicitly confirmed sending for operation=send_draft.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed: "send confirmed",
				},
				{
					name: "sendAt",
					description: "Scheduled send time for operation=schedule_draft_send.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "send time",
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
					name: "manageOperation",
					description:
						"Management operation for operation=manage, such as archive, trash, spam, mark_read, label_add, label_remove, tag_add, tag_remove, mute_thread, or unsubscribe.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "manage operation",
				},
				{
					name: "label",
					description:
						"Label for operation=manage when adding or removing labels.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "message label",
				},
				{
					name: "tag",
					description: "Tag for operation=manage when adding or removing tags.",
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
						"Start timestamp or parseable date for operation=search_inbox.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "search start",
				},
				{
					name: "until",
					description:
						"End timestamp or parseable date for operation=read_channel range=dates or operation=search_inbox.",
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
							operation: "send",
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
							operation: "triage",
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
				"Primary action for public feed surfaces and timelines. Choose op=send to publish a post, op=read to fetch recent feed posts, or op=search to search public posts. Addressed DMs, groups, channels, rooms, and inbox/draft workflows belong to MESSAGE.",
			similes: ["TWEET", "CAST", "PUBLISH", "FEED_POST", "TIMELINE"],
			parameters: [
				{
					name: "op",
					description: "Post subaction: send, read, or search.",
					required: false,
					schema: {
						type: "string",
						enum: ["send", "read", "search"],
					},
					descriptionCompressed: "post op",
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
						"Loose feed target for operation=send/read, such as a user, channel, media id, or connector-specific reference.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "feed target",
				},
				{
					name: "feed",
					description:
						"Feed convention for operation=read, such as home, user, hashtag, channel, or connector-specific feed.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "feed",
				},
				{
					name: "query",
					description: "Search term for operation=search.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "post search query",
				},
				{
					name: "replyTo",
					description: "Post/comment/reply target for operation=send.",
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
						"Opaque pagination cursor for operation=read or operation=search.",
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
							op: "send",
						},
					},
				},
			],
			descriptionCompressed:
				"primary post action ops send read search public feed timeline posts",
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
			name: "BROWSER",
			description:
				"Single BROWSER action — control whichever browser target is registered. Targets are pluggable: `workspace` (electrobun-embedded BrowserView, the default; falls back to a JSDOM web mode when the desktop bridge isn't configured), `bridge` (the user's real Chrome/Safari via the Agent Browser Bridge companion extension), and `computeruse` (a local puppeteer-driven Chromium via plugin-computeruse). The agent uses what is available — the BrowserService picks the active target when none is specified. Use `subaction: \"autofill-login\"` with `domain` (and optional `username`, `submit`) to vault-gated autofill into an open workspace tab.",
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
							"autofill-login",
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
							"autofill-login",
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
			name: "DESKTOP",
			description:
				"Single DESKTOP action — dispatches local desktop operations through the computer-use service. ",
			parameters: [
				{
					name: "op",
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
							op: "screenshot",
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
			name: "FILE",
			description:
				"File operations: read, write, or edit a file at an absolute path. ",
			parameters: [],
			descriptionCompressed: "File read/write/edit at absolute path.",
			similes: [
				"READ_FILE",
				"WRITE_FILE",
				"EDIT_FILE",
				"FILE_OPERATION",
				"FILE_IO",
			],
		},
		{
			name: "FIRST_RUN",
			description:
				"Owner-only. Run the first-run capability with path = defaults | customize | replay. ",
			parameters: [
				{
					name: "path",
					description: "defaults | customize | replay",
					required: true,
					schema: {
						type: "string",
					},
					descriptionCompressed: "defaults | customize | replay",
				},
				{
					name: "partialAnswers",
					description:
						"Optional object carrying answers from prior turns (resume support).",
					required: false,
					schema: {
						type: "object",
					},
					descriptionCompressed:
						"Optional object carrying answers from prior turns (resume support).",
				},
			],
			descriptionCompressed:
				"owner first-run: defaults|customize|replay; defaults asks wake time once",
			similes: [
				"RUN_FIRST_RUN",
				"ONBOARDING",
				"ONBOARD_USER",
				"RUN_ONBOARDING",
				"SETUP_DEFAULTS",
				"RUN_SETUP",
				"RESET_SETUP",
			],
			exampleCalls: [
				{
					user: "Use FIRST_RUN with the provided parameters.",
					actions: ["FIRST_RUN"],
					params: {
						FIRST_RUN: {
							path: "example",
							partialAnswers: "example",
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
			name: "GET_TUNNEL_STATUS",
			description:
				"Get the current status of the ngrok tunnel including URL, port, and uptime information. Supports action chaining by providing tunnel metadata for monitoring workflows, health checks, or conditional tunnel management.",
			parameters: [],
			similes: ["TUNNEL_STATUS", "CHECK_TUNNEL", "NGROK_STATUS", "TUNNEL_INFO"],
			descriptionCompressed:
				"Get the current status of the ngrok tunnel including URL, port, and uptime info. Supports action chaining by providing tunnel metadata for monitoring...",
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
			name: "LIFEOPS",
			description:
				"Owner-only. Verbs: pause (vacation mode — skip respectsGlobalPause tasks until endIso or resume), ",
			parameters: [
				{
					name: "verb",
					description: "pause | resume | wipe",
					required: true,
					schema: {
						type: "string",
					},
					descriptionCompressed: "pause | resume | wipe",
				},
				{
					name: "startIso",
					description:
						"ISO-8601 start. Defaults to now when verb=pause and unset.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"ISO-8601 start. Defaults to now when verb=pause and unset.",
				},
				{
					name: "endIso",
					description: "ISO-8601 end (optional — open-ended pause if absent).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"ISO-8601 end (optional - open-ended pause if absent).",
				},
				{
					name: "reason",
					description: "Optional reason ('vacation', 'sick', etc).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Optional reason ('vacation', 'sick', etc).",
				},
				{
					name: "confirmed",
					description:
						"Required true for verb=wipe. Without it, wipe returns a confirmation prompt.",
					required: false,
					schema: {
						type: "boolean",
					},
					descriptionCompressed:
						"Required true for verb=wipe. without it, wipe returns a confirmation prompt.",
				},
				{
					name: "confirmation",
					description:
						"Alternative confirmation token — must equal 'wipe' for verb=wipe.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Alternative confirmation token - must equal 'wipe' for verb=wipe.",
				},
			],
			descriptionCompressed:
				"owner LIFEOPS verb: pause|resume|wipe; wipe requires confirmed:true",
			similes: [
				"PAUSE_LIFEOPS",
				"RESUME_LIFEOPS",
				"WIPE_LIFEOPS",
				"VACATION_MODE",
				"LIFEOPS_PAUSE",
				"LIFEOPS_RESUME",
				"LIFEOPS_WIPE",
			],
			exampleCalls: [
				{
					user: "Use LIFEOPS with the provided parameters.",
					actions: ["LIFEOPS"],
					params: {
						LIFEOPS: {
							verb: "example",
							startIso: "example",
							endIso: "example",
							reason: "example",
							confirmed: false,
							confirmation: "example",
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
			name: "LIQUIDITY",
			description:
				"Single LP/liquidity management action. op=onboard|list_pools|open|close|reposition|list_positions|get_position|set_preferences. dex=orca|raydium|meteora|uniswap|aerodrome|pancakeswap selects the protocol; chain=solana|evm is inferred from dex when omitted.",
			parameters: [
				{
					name: "op",
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
				"Manage LP positions by op, chain, dex, pool, position, amount, range, token filters.",
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
							op: "onboard",
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
			name: "MCP",
			description:
				"Single MCP entry point. Use op=call_tool to invoke an MCP tool, op=read_resource to read an MCP resource. Cloud runtimes also accept op=search_actions and op=list_connections.",
			parameters: [
				{
					name: "op",
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
						"For op=call_tool: optional exact MCP tool name to call.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"For op=call_tool: optional exact MCP tool name to call.",
				},
				{
					name: "arguments",
					description:
						"For op=call_tool: optional JSON arguments to pass to the selected MCP tool.",
					required: false,
					schema: {
						type: "object",
					},
					descriptionCompressed:
						"For op=call_tool: optional JSON arguments to pass to the selected MCP tool.",
				},
				{
					name: "uri",
					description: "For op=read_resource: exact MCP resource URI to read.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"For op=read_resource: exact MCP resource URI to read.",
				},
				{
					name: "query",
					description:
						"Natural-language description of the tool call or resource to select; for op=search_actions, the keyword query.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Natural-language description of the tool call or resource to select. for op=search_actions, the keyword query.",
				},
				{
					name: "platform",
					description:
						"For op=search_actions: filter results to a single connected platform.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"For op=search_actions: filter results to a single connected platform.",
				},
				{
					name: "limit",
					description: "For op=search_actions: maximum results to return.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed:
						"For op=search_actions: max results to return.",
				},
				{
					name: "offset",
					description:
						"For op=search_actions: skip first N results for pagination.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed:
						"For op=search_actions: skip first N results for pagination.",
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
							op: "call_tool",
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
			name: "MESSAGE.handoff",
			description:
				"Multi-party room handoff control. verb=enter flips the current room into handoff mode (agent stops contributing until the resume condition fires); verb=resume exits handoff; verb=status reports state.",
			parameters: [
				{
					name: "verb",
					description: "enter | resume | status",
					required: true,
					schema: {
						type: "string",
					},
					descriptionCompressed: "enter | resume | status",
				},
				{
					name: "reason",
					description:
						"Why the agent is stepping back (logged in HandoffStore).",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Why agent is stepping back (logged in HandoffStore).",
				},
				{
					name: "resumeKind",
					description:
						"mention | explicit_resume | silence_minutes | user_request_help",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"mention | explicit_resume | silence_minutes | user_request_help",
				},
				{
					name: "silenceMinutes",
					description: "Required when resumeKind=silence_minutes.",
					required: false,
					schema: {
						type: "number",
					},
					descriptionCompressed: "Required when resumeKind=silence_minutes.",
				},
				{
					name: "userId",
					description: "Required when resumeKind=user_request_help.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Required when resumeKind=user_request_help.",
				},
				{
					name: "roomId",
					description:
						"Override the room to operate on; defaults to message.roomId.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed:
						"Override the room to operate on. defaults to msg. roomId.",
				},
			],
			descriptionCompressed:
				"MESSAGE.handoff verb: enter|resume|status; gates agent contributions per resumeOn condition.",
			similes: [
				"HANDOFF",
				"HAND_OFF",
				"STEP_BACK",
				"LET_HUMAN_TAKE_OVER",
				"AGENT_STAND_DOWN",
				"RESUME_AGENT",
				"AGENT_COME_BACK",
			],
			exampleCalls: [
				{
					user: "Use MESSAGE.handoff with the provided parameters.",
					actions: ["MESSAGE.handoff"],
					params: {
						"MESSAGE.handoff": {
							verb: "example",
							reason: "example",
							resumeKind: "example",
							silenceMinutes: 1,
							userId: "example",
							roomId: "example",
						},
					},
				},
			],
		},
		{
			name: "MUSIC",
			description:
				"Unified music action. Use flat op for everything: library (playlist, play_query, search_youtube, download), playback transport (pause, resume, skip, stop, queue), play_audio, routing, zones. ",
			parameters: [
				{
					name: "op",
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
							op: "playlist",
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
						enum: [
							"playlist",
							"play-query",
							"play_query",
							"search-youtube",
							"search_youtube",
							"download",
						],
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
			name: "RS_2004",
			description:
				"Drive the 2004scape game agent. Choose one op (walk_to, chop, mine, fish, burn, cook, fletch, craft, smith, drop, pickup, equip, unequip, use, use_on_item, use_on_object, open, close, deposit, withdraw, buy, sell, attack, cast_spell, set_style, eat, talk, navigate_dialog, interact_object, open_door, pickpocket). For open/close, set target='bank' or target='shop' (or include npc to imply shop). Per-op fields go in params.",
			parameters: [
				{
					name: "op",
					description: "Operation to run.",
					required: true,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Op.",
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
				"rs_2004 ops (walk_to, skills, inventory, bank, shop, combat, interact)",
			exampleCalls: [
				{
					user: "Use RS_2004 with the provided parameters.",
					actions: ["RS_2004"],
					params: {
						RS_2004: {
							op: "example",
							params: "example",
						},
					},
				},
			],
		},
		{
			name: "SCAPE",
			description:
				"Drive the 'scape (xRSPS) game agent. Pick one op: walk_to (x,z,run?), attack (npcId), chat_public (message), eat (item?), drop (item), set_goal (title,notes?), complete_goal (status?,goalId?,notes?), remember (notes,kind?,weight?). Returns success and a short status message; the autonomous loop already handles its own dispatch — this is the planner-facing surface.",
			parameters: [
				{
					name: "op",
					description: "Operation to run.",
					required: true,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Op.",
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
				"scape ops: walk_to|attack|chat_public|eat|drop|set_goal|complete_goal|remember",
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
							op: "example",
							params: "example",
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
				"Manage a Shopify store. Operations: search (read-only catalog browsing across products, orders, and customers), products (CRUD on products), inventory (stock adjustments), orders (list/update orders), customers (CRUD on customers). Op is inferred from the message text when not explicitly provided.",
			parameters: [
				{
					name: "op",
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
					name: "query",
					description: "Search term for op=search.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Search term for op=search.",
				},
				{
					name: "scope",
					description:
						"Search scope for op=search: all, products, orders, or customers.",
					required: false,
					schema: {
						type: "string",
						enum: ["all", "products", "orders", "customers"],
					},
					descriptionCompressed:
						"Search scope for op=search: all, products, orders, or customers.",
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
							op: "example",
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
			name: "START_TUNNEL",
			description:
				"Start an ngrok tunnel to expose a local port to the internet. Supports action chaining by providing tunnel metadata that can be used for webhook configuration, API testing, or remote access workflows.",
			parameters: [],
			similes: ["OPEN_TUNNEL", "CREATE_TUNNEL", "NGROK_START", "TUNNEL_UP"],
			descriptionCompressed:
				"Start an ngrok tunnel to expose a local port to the internet. Supports action chaining by providing tunnel metadata that can be used for webhook config, API...",
		},
		{
			name: "STOP_TUNNEL",
			description:
				"Stop the running ngrok tunnel and clean up resources. Can be chained with START_TUNNEL actions for tunnel rotation workflows or combined with deployment actions for automated service management.",
			parameters: [],
			similes: ["CLOSE_TUNNEL", "SHUTDOWN_TUNNEL", "NGROK_STOP", "TUNNEL_DOWN"],
			descriptionCompressed:
				"Stop the running ngrok tunnel and clean up resources. Can be chained with START_TUNNEL actions for tunnel rotation workflows or combined with deployment...",
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
			name: "TUNNEL",
			description:
				"Tunnel operations dispatched by `op`: start, stop, status. The `start` op accepts an optional `port` (defaults to 3000); `stop` and `status` take no parameters. Backed by whichever tunnel plugin is active (local Tailscale CLI, Eliza Cloud headscale, or ngrok).",
			parameters: [
				{
					name: "op",
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
							op: "example",
							parameters: "example",
						},
					},
				},
			],
			descriptionCompressed:
				"Tunnel operations dispatched by `op`: start, stop, status. The `start` op accepts an optional `port` (defaults to 3000). `stop` and `status` take no params...",
		},
		{
			name: "UPDATE_LINEAR_ISSUE",
			description:
				"Update an existing Linear issue (title, priority, assignee, status, labels, team)",
			parameters: [
				{
					name: "issueId",
					description: "Linear issue id or identifier to update.",
					required: false,
					schema: {
						type: "string",
					},
					descriptionCompressed: "Linear issue id or id to update.",
				},
			],
			descriptionCompressed: "update Linear issue",
			similes: [
				"update-linear-issue",
				"edit-linear-issue",
				"modify-linear-issue",
			],
			exampleCalls: [
				{
					user: "Use UPDATE_LINEAR_ISSUE with the provided parameters.",
					actions: ["UPDATE_LINEAR_ISSUE"],
					params: {
						UPDATE_LINEAR_ISSUE: {
							issueId: "example",
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
