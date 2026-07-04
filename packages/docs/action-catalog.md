---
title: "Action Catalog"
sidebarTitle: "Action Catalog"
description: "Generated reference for canonical Eliza action and provider prompt docs."
---

# Action Catalog

This catalog is generated from `packages/prompts/specs/**` by `bun run --cwd packages/prompts build:action-docs`. Do not edit it by hand; change the source spec or generator instead.

## Summary

- **Canonical actions:** 23
- **Core actions:** 14
- **Plugin overlay actions:** 9
- **Canonical providers:** 23
- **Core providers:** 23

## Actions

### REPLY

Send a direct chat reply in the current conversation/thread. Default if the agent is responding with a message and no other action. Use REPLY at the beginning of a chain of actions as an acknowledgement, and at the end of a chain of actions as a final response. Do NOT use REPLY to send to a different channel/person or to run an email/inbox workflow — use MESSAGE (action=send) for a directed send to another channel or DM, MESSAGE inbox operations for triage/drafts, and POST to publish to a public feed.

- **Aliases:** GREET, RESPOND, RESPONSE

### IGNORE

Call this action if ignoring the user. If the user is aggressive, creepy or is finished with the conversation, use this action. In group conversations, use IGNORE when the latest message is addressed to someone else and not to the agent. Or, if both you and the user have already said goodbye, use this action instead of saying bye again. Use IGNORE any time the conversation has naturally ended. Do not use IGNORE if the user has engaged directly, or if something went wrong and you need to tell them. Only ignore if the user should be ignored.

- **Aliases:** STOP_TALKING, STOP_CHATTING, STOP_CONVERSATION

### NONE

Respond but perform no additional action. This is the default if the agent is speaking and not doing anything additional.

- **Aliases:** NO_ACTION, NO_RESPONSE, NO_REACTION, NOOP, PASS

### MESSAGE

Primary action for addressed messaging surfaces: DMs, group chats, channels, rooms, threads, servers, users, inboxes, drafts, and owner message workflows. Choose action=send, read_channel, read_with_contact, search, list_channels, list_servers, react, edit, delete, pin, join, leave, get_user, triage, list_inbox, search_inbox, draft_reply, draft_followup, respond, send_draft, schedule_draft_send, or manage. Public feed publishing belongs to POST.

- **Aliases:** DM, DIRECT_MESSAGE, CHAT, CHANNEL, ROOM

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| `action` | no | string | Message action: send, read_channel, read_with_contact, search, list_channels, list_servers, react, edit, delete, pin, join, leave, get_user, triage, list_inbox, search_inbox, draft_reply, draft_followup, respond, send_draft, schedule_draft_send, or manage. |
| `source` | no | string | Connector or inbox source such as discord, slack, signal, whatsapp, telegram, x, imessage, matrix, line, google-chat, feishu, instagram, wechat, gmail, calendly, or browser_bridge. |
| `accountId` | no | string | Optional connector account id for multi-account message connectors. |
| `sources` | no | array | Optional inbox sources for action=triage, list_inbox, or search_inbox. |
| `target` | no | string | Loose target reference: user, handle, channel, room, group, server, contact, phone, email, or platform-specific ID. |
| `channel` | no | string | Loose channel, room, or group name/reference. |
| `server` | no | string | Loose server, guild, workspace, or team name/reference. |
| `message` | no | string | Message text for action=send or replacement text for action=edit. |
| `query` | no | string | Search term for action=search or action=search_inbox. |
| `content` | no | string | Inbox search text or message lookup hint for draft/respond/manage operations. |
| `sender` | no | string | Sender identifier, handle, or display name for inbox search or reply lookup. |
| `body` | no | string | Draft or response body for action=draft_reply, draft_followup, or respond. |
| `to` | no | array | Recipient identifiers for action=draft_followup. |
| `subject` | no | string | Optional subject for email-like draft operations. |
| `messageId` | no | string | Platform message ID, full message ID, or stored memory ID for react/edit/delete/pin/respond/manage. |
| `draftId` | no | string | Draft identifier for action=send_draft or action=schedule_draft_send. |
| `confirmed` | no | boolean | Whether the user explicitly confirmed sending for action=send_draft. |
| `sendAt` | no | string | Scheduled send time for action=schedule_draft_send. |
| `emoji` | no | string | Reaction value for action=react. |
| `pin` | no | boolean | Pin state for action=pin. Use false to unpin when supported. |
| `manageOperation` | no | string | Management action for action=manage, such as archive, trash, spam, mark_read, label_add, label_remove, tag_add, tag_remove, mute_thread, or unsubscribe. |
| `label` | no | string | Label for action=manage when adding or removing labels. |
| `tag` | no | string | Tag for action=manage when adding or removing tags. |
| `limit` | no | integer | Maximum number of messages/channels/servers/inbox items to return. |
| `cursor` | no | string | Opaque pagination cursor for read/search/list operations. |
| `sinceMs` | no | number | Start timestamp in milliseconds for inbox list/search/triage operations. |
| `since` | no | string | Start timestamp or parseable date for action=search_inbox. |
| `until` | no | string | End timestamp or parseable date for action=read_channel range=dates or action=search_inbox. |

### POST

Primary action for public feed surfaces and timelines. Choose action=send to publish a post, action=read to fetch recent feed posts, or action=search to search public posts. Addressed DMs, groups, channels, rooms, and inbox/draft workflows belong to MESSAGE.

- **Aliases:** TWEET, CAST, PUBLISH, FEED_POST, TIMELINE

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| `action` | no | string | Post action: send, read, or search. |
| `source` | no | string | Post connector source such as x, bluesky, farcaster, nostr, or instagram. |
| `accountId` | no | string | Optional connector account id for multi-account post connectors. |
| `text` | no | string | Public post text for action=send. |
| `target` | no | string | Loose feed target for action=send/read, such as a user, channel, media id, or connector-specific reference. |
| `feed` | no | string | Feed convention for action=read, such as home, user, hashtag, channel, or connector-specific feed. |
| `query` | no | string | Search term for action=search. |
| `replyTo` | no | string | Post/comment/reply target for action=send. |
| `mediaId` | no | string | Media id for connector-specific comment surfaces such as Instagram. |
| `limit` | no | integer | Maximum number of posts to return. |
| `cursor` | no | string | Opaque pagination cursor for action=read or action=search. |
| `attachments` | no | array | Optional post attachments. |

### ROOM

Manage current room participation state. Use action=follow to opt into a room, action=unfollow to stop following, action=mute to ignore messages unless mentioned, or action=unmute to resume normal room activity.

- **Aliases:** FOLLOW_ROOM, UNFOLLOW_ROOM, MUTE_ROOM, UNMUTE_ROOM, ROOM_FOLLOW, ROOM_MUTE

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| `action` | yes | string | Room operation: follow, unfollow, mute, or unmute. |
| `roomId` | no | string | Optional target room id. Defaults to the current room when omitted. |

### ROLE

Assign or update trust roles for users. Use action=update with entityId and role when the owner explicitly asks to change permissions.

- **Aliases:** UPDATE_ROLE, SET_ROLE, CHANGE_ROLE, ASSIGN_ROLE, MAKE_ADMIN, GRANT_ROLE

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| `action` | no | string | Role operation. Currently update. |
| `entityId` | yes | string | Entity id whose role should be updated. |
| `role` | yes | string | Role to assign. |

### SEARCH_EXPERIENCES

Search the agent experience store for prior events, decisions, summaries, or memories relevant to the current request.

- **Aliases:** SEARCH_MEMORY, SEARCH_EXPERIENCE, SEARCH_PRIOR_CONTEXT, FIND_EXPERIENCES

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| `query` | yes | string | Search query. |
| `limit` | no | integer | Maximum number of results to return. |

### CHARACTER

Manage the agent character profile and identity. Use action=modify for temporary changes, action=persist to save approved changes, or action=update_identity for identity-level updates.

- **Aliases:** CHARACTER_MODIFY, CHARACTER_PERSIST, CHARACTER_UPDATE_IDENTITY, UPDATE_CHARACTER, EDIT_CHARACTER

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| `action` | yes | string | Character operation: modify, persist, or update_identity. |
| `updates` | no | string | Structured or textual character updates. |

### CHOOSE_OPTION

Select an option for a pending task that has multiple options.

- **Aliases:** SELECT_OPTION, PICK_OPTION, SELECT_TASK, PICK_TASK, SELECT, PICK, CHOOSE

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| `taskId` | yes | string | The pending task id. |
| `option` | yes | string | The selected option name exactly as listed. |

### ATTACHMENT

Read current or recent attachments and link previews, or save readable attachment content as a document. Use action=read for extracted text, transcripts, page content, or media descriptions. Use action=save_as_document to store readable attachment content in the document store.

- **Aliases:** READ_ATTACHMENT, SAVE_ATTACHMENT_AS_DOCUMENT, OPEN_ATTACHMENT, INSPECT_ATTACHMENT, READ_URL, OPEN_URL, READ_WEBPAGE

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| `action` | no | string | Attachment operation: read or save_as_document. |
| `attachmentId` | no | string | Optional attachment ID to read or save. Omit to use the current or most recent attachment. |
| `addToClipboard` | no | boolean | When true with action=read, store the attachment content in bounded task clipboard state. |
| `title` | no | string | Optional title when saving attachment content as a document. |

### GENERATE_MEDIA

Generates media based on a prompt and media type. Use GENERATE_MEDIA when the agent needs to create an image, video, music, sound effect, or speech audio for the user.

- **Aliases:** GENERATE_IMAGE, GENERATE_VIDEO, GENERATE_AUDIO, GENERATE_MEDIA_IMAGE, DRAW, CREATE_IMAGE, RENDER_IMAGE, VISUALIZE, MAKE_IMAGE, PAINT, IMAGE, CREATE_VIDEO, MAKE_VIDEO, ANIMATE, COMPOSE, MAKE_MUSIC, TEXT_TO_SPEECH, SOUND_EFFECT

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| `mediaType` | yes | string | The kind of media to generate. |
| `prompt` | yes | string | Detailed generation prompt describing the desired media. |
| `audioKind` | no | string | For audio generation, choose music, sfx, or tts. |
| `duration` | no | number | Optional target duration in seconds for video or audio. |
| `aspectRatio` | no | string | Optional video aspect ratio such as 16:9, 9:16, or 1:1. |
| `size` | no | string | Optional image size or image provider size preset. |

### PAYMENT

Payment operations. Use action=create_request to create a payment request, deliver_link to send a payment link, verify_payload to verify a provider proof, settle to finalize a payment, await_callback to wait for settlement, and cancel_request to void a pending request.

- **Aliases:** NEW_PAYMENT_REQUEST, OPEN_PAYMENT_REQUEST, SEND_PAYMENT_LINK, DISPATCH_PAYMENT_LINK, VERIFY_PAYMENT_PROOF, CHECK_PAYMENT_PROOF, FINALIZE_PAYMENT, CONFIRM_PAYMENT, WAIT_FOR_PAYMENT, AWAIT_PAYMENT_SETTLEMENT, VOID_PAYMENT_REQUEST, ABORT_PAYMENT_REQUEST

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| `action` | yes | string | Payment operation: create_request, deliver_link, verify_payload, settle, await_callback, or cancel_request. |
| `provider` | no | string | For action=create_request, provider key: stripe, oxapay, x402, or wallet_native. |
| `amountCents` | no | number | For action=create_request, amount in minor currency units. |
| `currency` | no | string | For action=create_request, ISO 4217 currency. |
| `paymentContext` | no | object | For action=create_request, payer constraint. kind can be any_payer, verified_payer, or specific_payer; scope can be one_time, session, or recurring. |
| `reason` | no | string | For action=create_request or cancel_request, payment or cancellation reason. |
| `expiresInMs` | no | number | For action=create_request, optional time-to-live override in milliseconds. |
| `paymentRequestId` | no | string | For deliver_link, verify_payload, settle, await_callback, and cancel_request: payment request ID. |
| `target` | no | string | For action=deliver_link, delivery channel. |
| `targetChannelId` | no | string | For action=deliver_link, optional delivery channel override. |
| `proof` | no | object | For action=verify_payload or settle, provider proof payload. |
| `strategy` | no | string | For action=settle, optional settler strategy hint. |
| `timeoutMs` | no | number | For action=await_callback, wait timeout in milliseconds. Default is 600000. |

### TRUST

Trust system control. action=evaluate reads a trust profile for an entity; record_interaction logs a trust-affecting event; request_elevation requests temporary permissions; update_role assigns OWNER / ADMIN / NONE roles within a world.

- **Aliases:** TRUST_MANAGEMENT, TRUST_OPERATION, TRUST_PROFILE, TRUST_INTERACTION, ELEVATE_PERMISSIONS, ASSIGN_ROLE, CHANGE_ROLE, MAKE_ADMIN, SET_PERMISSIONS

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| `action` | yes | string | Action: evaluate \| record_interaction \| request_elevation \| update_role. |
| `entityId` | no | string | Target entity ID. evaluate: defaults to sender. record_interaction: target of the interaction (defaults to agent). |
| `entityName` | no | string | Optional target entity name (evaluate). Name-only lookups return a bounded failure; provide entityId where possible. |
| `detailed` | no | boolean | Whether evaluate should return detailed dimensions (default false). |
| `type` | no | string | Trust evidence type (record_interaction). |
| `impact` | no | number | Numerical trust impact (record_interaction). Default 10. |
| `description` | no | string | Optional interaction description (record_interaction). |
| `permissionAction` | no | string | Permission action being requested (request_elevation). |
| `resource` | no | string | Resource scope for elevation (request_elevation). |
| `justification` | no | string | Reason elevation is needed (request_elevation). |
| `duration` | no | number | Requested duration in hours (request_elevation). Defaults to 60. |
| `roleAssignments` | no | array | Role assignments (update_role). |

### COMPACT_COMMAND

Compact conversation history

- **Aliases:** /compact

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| `instructions` | no | string | Optional compaction instructions |

### CONTEXT_COMMAND

Show current context information

- **Aliases:** /context, /ctx

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| `mode` | no | string | Output mode (list, detail, json) |

### ELEVATED_COMMAND

Set elevated permission mode

- **Aliases:** /elevated, /elev

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| `level` | no | string | off, on, ask, full |

### MODEL_COMMAND

Set or show current model

- **Aliases:** /model, /m

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| `model` | no | string | provider/model or alias |

### QUEUE_COMMAND

Set queue mode

- **Aliases:** /queue, /q

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| `mode` | no | string | steer, followup, collect, interrupt, or options |

### REASONING_COMMAND

Set reasoning visibility

- **Aliases:** /reasoning, /reason

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| `level` | no | string | off, on, stream |

### THINK_COMMAND

Set thinking level

- **Aliases:** /think, /thinking, /t

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| `level` | no | string | off, minimal, low, medium, high, xhigh |

### TTS_COMMAND

Text-to-speech settings

- **Aliases:** /tts, /voice

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| `action` | no | string | on, off, status, provider, limit, audio |

### VERBOSE_COMMAND

Set verbose output level

- **Aliases:** /verbose, /v

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| `level` | no | string | off, on, full |

## Providers

### ACTIONS

Possible response actions

- **Position:** -1
- **Dynamic:** no

### CHARACTER

Provides the agent's character definition and personality information including bio, topics, adjectives, style directions, and example conversations

- **Position:** -
- **Dynamic:** no

### RECENT_MESSAGES

Canonical bounded transcript for the current room, including prior dialogue, post-style turns, action results, and cross-room recent interactions for memory continuity

- **Position:** 100
- **Dynamic:** yes

### ACTION_STATE

Provides information about the current action state and available actions

- **Position:** -
- **Dynamic:** yes

### ATTACHMENTS

Media attachments in the current message

- **Position:** -
- **Dynamic:** yes

### CAPABILITIES

Agent capabilities including models, services, and features

- **Position:** -
- **Dynamic:** no

### CHOICE

Available choice options for selection when there are pending tasks or decisions

- **Position:** -
- **Dynamic:** yes

### CONTACTS

Provides contact information from the relationships including categories and preferences

- **Position:** -
- **Dynamic:** yes

### CONTEXT_BENCH

Benchmark/task context injected by a benchmark harness

- **Position:** 5
- **Dynamic:** yes

### ENTITIES

Provides information about entities in the current context including users, agents, and participants

- **Position:** -
- **Dynamic:** yes

### FACTS

Provides known facts about entities learned through conversation

- **Position:** -
- **Dynamic:** yes

### FOLLOW_UPS

Provides information about upcoming follow-ups and reminders scheduled for contacts

- **Position:** -
- **Dynamic:** yes

### DOCUMENTS

Provides relevant snippets and recent entries from the agent document store

- **Position:** -
- **Dynamic:** yes

### PROVIDERS

Available context providers

- **Position:** -
- **Dynamic:** no

### RELATIONSHIPS

Relationships between entities observed by the agent including tags and metadata

- **Position:** -
- **Dynamic:** yes

### ROLES

Roles assigned to entities in the current context (Admin, Owner, Member, None)

- **Position:** -
- **Dynamic:** yes

### SETTINGS

Current settings for the agent/server (filtered for security, excludes sensitive keys)

- **Position:** -
- **Dynamic:** yes

### TIME

Provides the current date and time in UTC for time-based operations or responses

- **Position:** -
- **Dynamic:** yes

### WORLD

Provides information about the current world context including settings and members

- **Position:** -
- **Dynamic:** yes

### LONG_TERM_MEMORY

Persistent facts and preferences about the user learned and remembered across conversations

- **Position:** 50
- **Dynamic:** no

### SUMMARIZED_CONTEXT

Provides summarized context from previous conversations for optimized context usage

- **Position:** 96
- **Dynamic:** no

### AGENT_SETTINGS

Provides the agent's current configuration settings (filtered for security)

- **Position:** -
- **Dynamic:** yes

### CURRENT_TIME

Provides current time and date information in various formats

- **Position:** -
- **Dynamic:** yes
