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
- **Registered runtime actions:** 188

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
| `target` | no | string | small, large, coding, show, local, cloud — or a model for this room |
| `model` | no | string | model id — for coding, the backend (codex, claude, opencode, elizaos) |
| `effort` | no | string | reasoning effort — for coding, the model id |
| `coding-effort` | no | string | reasoning effort (coding target) |

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

## Registered runtime actions

The canonical sections above are the *curated prompt docs* — a deliberately
small subset the model is taught up front. The list below is the **full
registered action surface** scanned from source
(`packages/prompts/scripts/registered-action-inventory.js`): every `Action`
declaration under `packages/core`, `packages/agent`, and `plugins/*`, plus
view-scoped actions. An action can be real and registered without having a
canonical spec entry — before concluding an action "does not exist", check this
list. CI (`node packages/scripts/view-action-ratchet.mjs`) fails when this
section drifts from source.

- `ACTIVATE_PLUGIN_IF_READY` — `packages/core/src/features/plugin-config/actions/activate-plugin-if-ready.ts`
- `AGENT_SWITCH` — `plugins/plugin-app-control/src/actions/agent-switch.ts`
- `ALARM` — `plugins/plugin-native-macosalarm/src/actions.ts`
- `APP` — `plugins/plugin-app-control/src/actions/app.ts`
- `ATTACH_TO_CHAT` — `packages/agent/src/actions/knowledge.ts`
- `ATTACHMENT` — `packages/core/src/features/working-memory/readAttachmentAction.ts`
- `AWAIT_CHILD_AGENT_DECISION` — `packages/core/src/features/sub-agent-credentials/actions/await-child-agent-decision.ts`
- `AWAIT_OAUTH_CALLBACK` — `packages/core/src/features/oauth/actions/await-oauth-callback.ts`
- `BACKGROUND` — `plugins/plugin-app-control/src/actions/background.ts`
- `BACKUP_APP` — `plugins/plugin-cloud-apps/src/actions/backup-app.ts`
- `BIND_OAUTH_CREDENTIAL` — `packages/core/src/features/oauth/actions/bind-oauth-credential.ts`
- `BLOCK` — `plugins/plugin-personal-assistant/src/actions/block.ts`
- `BOOK_INFLUENCER` — `plugins/plugin-cloud-apps/src/actions/book-influencer.ts`
- `BRIEF` — `plugins/plugin-personal-assistant/src/actions/brief.ts`
- `BROWSER` — `plugins/plugin-browser/src/actions/browser.ts`
- `BUY_APP_DOMAIN` — `plugins/plugin-cloud-apps/src/actions/buy-app-domain.ts`
- `CALENDAR` — `plugins/plugin-calendar/src/actions/calendar.ts`, `plugins/plugin-personal-assistant/src/actions/calendar.ts`
- `CALENDLY` — `plugins/plugin-personal-assistant/src/actions/lib/calendly-handler.ts`
- `CHARACTER` — `packages/core/src/features/advanced-capabilities/personality/actions/character.ts`
- `CHECK_APP_DOMAIN` — `plugins/plugin-cloud-apps/src/actions/check-app-domain.ts`
- `CLEAR_LINEAR_ACTIVITY` — `plugins/plugin-linear/src/actions/clearActivity.ts`
- `CLIPBOARD` — `plugins/plugin-computeruse/src/actions/clipboard.ts`
- `CLOSE_ALL_VIEWS` — `plugins/plugin-app-control/src/actions/views.ts`
- `CLOSE_VIEW` — `plugins/plugin-app-control/src/actions/views.ts`
- `CLOUD_ACCOUNT_STATUS` — `plugins/plugin-elizacloud/src/actions/cloud-account-status.ts`
- `CLOUD_CREATE_API_KEY` — `plugins/plugin-elizacloud/src/actions/create-cloud-api-key.ts`
- `CLOUD_LIST_AGENTS` — `plugins/plugin-elizacloud/src/actions/list-cloud-agents.ts`
- `COMPACT_CONVERSATION` — `packages/agent/src/actions/compact-conversation.ts`
- `COMPUTER_USE` — `plugins/plugin-computeruse/src/actions/use-computer.ts`
- `COMPUTER_USE_AGENT` — `plugins/plugin-computeruse/src/actions/use-computer-agent.ts`
- `CONFLICT_DETECT` — `plugins/plugin-calendar/src/actions/conflict-detect.ts`, `plugins/plugin-personal-assistant/src/actions/conflict-detect.ts`
- `CONNECT_ACCOUNT` — `packages/agent/src/actions/connect-account.ts`
- `CONNECTOR` — `plugins/plugin-personal-assistant/src/actions/connector.ts`
- `CONTACT` — `packages/agent/src/actions/contact.ts`
- `CREATE_AD_SLOT` — `plugins/plugin-cloud-apps/src/actions/ad-inventory.ts`
- `CREATE_APP` — `plugins/plugin-cloud-apps/src/actions/create-app.ts`
- `CREATE_INFLUENCER_PROFILE` — `plugins/plugin-cloud-apps/src/actions/influencer.ts`
- `CREATE_LINEAR_COMMENT` — `plugins/plugin-linear/src/actions/createComment.ts`
- `CREATE_LINEAR_ISSUE` — `plugins/plugin-linear/src/actions/createIssue.ts`
- `CREATE_OAUTH_INTENT` — `packages/core/src/features/oauth/actions/create-oauth-intent.ts`
- `CREATIVE_DRAFT` — `plugins/plugin-personal-assistant/src/actions/creative-draft.ts`
- `CREDENTIALS` — `plugins/plugin-personal-assistant/src/actions/credentials.ts`
- `DATABASE` — `packages/agent/src/actions/database.ts`
- `DECLARE_SUB_AGENT_CREDENTIAL_SCOPE` — `packages/core/src/features/sub-agent-credentials/actions/declare-sub-agent-credential-scope.ts`
- `DELETE_APP` — `plugins/plugin-cloud-apps/src/actions/delete-app.ts`
- `DELETE_LINEAR_COMMENT` — `plugins/plugin-linear/src/actions/deleteComment.ts`
- `DELETE_LINEAR_ISSUE` — `plugins/plugin-linear/src/actions/deleteIssue.ts`
- `DELIVER_OAUTH_LINK` — `packages/core/src/features/oauth/actions/deliver-oauth-link.ts`
- `DELIVER_PLUGIN_CONFIG_FORM` — `packages/core/src/features/plugin-config/actions/deliver-plugin-config-form.ts`
- `DEPLOY_APP` — `plugins/plugin-cloud-apps/src/actions/deploy-app.ts`
- `DEPLOY_FRONTEND` — `plugins/plugin-cloud-apps/src/actions/deploy-frontend.ts`
- `DISABLE_AUTONOMOUS_MODE` — `packages/core/src/features/autonomy/action.ts`
- `DOCUMENT` — `packages/core/src/features/documents/actions.ts`
- `DRAFT_PRESS_RELEASE` — `plugins/plugin-cloud-apps/src/actions/press-releases.ts`
- `DUPLICATE_AD_CAMPAIGN` — `plugins/plugin-cloud-apps/src/actions/ad-campaigns.ts`
- `ENABLE_AUTONOMOUS_MODE` — `packages/core/src/features/autonomy/action.ts`
- `ENTITY` — `plugins/plugin-personal-assistant/src/actions/entity.ts`
- `ESCALATE` — `packages/core/src/features/autonomy/action.ts`
- `EXPERIENCE` — `packages/core/src/features/advanced-capabilities/experience/actions/manage-experience.ts`
- `EXPORT_AD_CAMPAIGN_REPORT` — `plugins/plugin-cloud-apps/src/actions/ad-campaigns.ts`
- `FACEWEAR_CONNECT` — `plugins/plugin-facewear/src/actions/facewear-connect.ts`
- `FACEWEAR_DEBUG` — `plugins/plugin-facewear/src/actions/facewear-debug.ts`
- `FILE` — `plugins/plugin-coding-tools/src/actions/file.ts`
- `FILES` — `packages/agent/src/actions/files.ts`
- `FORM` — `plugins/plugin-form/src/actions/form.ts`
- `GENERATE_MEDIA` — `plugins/plugin-local-inference/src/actions/generate-media.ts`
- `GET_AD_CAMPAIGN_ATTRIBUTION` — `plugins/plugin-cloud-apps/src/actions/ad-attribution.ts`
- `GET_APP` — `plugins/plugin-cloud-apps/src/actions/get-app.ts`
- `GET_APP_DEPLOY_STATUS` — `plugins/plugin-cloud-apps/src/actions/get-app-deploy-status.ts`
- `GET_APP_EARNINGS` — `plugins/plugin-cloud-apps/src/actions/get-app-earnings.ts`
- `GET_LINEAR_ACTIVITY` — `plugins/plugin-linear/src/actions/getActivity.ts`
- `GET_LINEAR_ISSUE` — `plugins/plugin-linear/src/actions/getIssue.ts`
- `GET_MEETING_TRANSCRIPT` — `plugins/plugin-meetings/src/actions/get-meeting-transcript.ts`
- `GIT_PATHOLOGY` — `plugins/plugin-gitpathologist/src/actions/git-pathology.ts`
- `GITHUB` — `plugins/plugin-github/src/actions/github.ts`
- `IDENTIFY_SPEAKER` — `plugins/plugin-local-inference/src/actions/identify-speaker.ts`
- `INBOX` — `plugins/plugin-inbox/src/actions/inbox.ts`
- `JOIN_MEETING` — `plugins/plugin-meetings/src/actions/join-meeting.ts`
- `LEAVE_MEETING` — `plugins/plugin-meetings/src/actions/leave-meeting.ts`
- `LINEAR` — `plugins/plugin-linear/src/actions/linear.ts`
- `LIQUIDITY` — `plugins/plugin-wallet/src/lp/actions/liquidity.ts`
- `LIST_AD_SLOTS` — `plugins/plugin-cloud-apps/src/actions/ad-inventory.ts`
- `LIST_APP_DOMAINS` — `plugins/plugin-cloud-apps/src/actions/list-app-domains.ts`
- `LIST_CLOUD_APPS` — `plugins/plugin-cloud-apps/src/actions/list-cloud-apps.ts`
- `LIST_FRONTEND_DEPLOYMENTS` — `plugins/plugin-cloud-apps/src/actions/rollback-frontend.ts`
- `LIST_INFLUENCERS` — `plugins/plugin-cloud-apps/src/actions/influencer.ts`
- `LIST_LINEAR_COMMENTS` — `plugins/plugin-linear/src/actions/listComments.ts`
- `LIST_OVERDUE_FOLLOWUPS` — `plugins/plugin-personal-assistant/src/followup/actions/listOverdueFollowups.ts`
- `LIST_PRESS_RELEASES` — `plugins/plugin-cloud-apps/src/actions/press-releases.ts`
- `LOCAL_INFERENCE` — `plugins/plugin-local-inference/src/actions/local-inference-management.ts`
- `LOGS` — `packages/agent/src/actions/logs.ts`
- `MANAGE_BROWSER_BRIDGE` — `plugins/plugin-browser/src/actions/manage-browser-bridge.ts`
- `MANAGE_PLUGINS` — `packages/core/src/features/plugin-manager/actions/plugin.ts`
- `MARK_FOLLOWUP_DONE` — `plugins/plugin-personal-assistant/src/followup/actions/markFollowupDone.ts`
- `MCP` — `plugins/plugin-mcp/src/actions/mcp.ts`
- `MEMORY` — `packages/agent/src/actions/memories.ts`
- `MESSAGE` — `packages/core/src/features/advanced-capabilities/actions/message.ts`, `packages/core/src/features/messaging/triage/actions/draftFollowup.ts`, `packages/core/src/features/messaging/triage/actions/draftReply.ts`, `packages/core/src/features/messaging/triage/actions/listInbox.ts`, `packages/core/src/features/messaging/triage/actions/manageMessage.ts`, `packages/core/src/features/messaging/triage/actions/respondToMessage.ts`, `packages/core/src/features/messaging/triage/actions/scheduleDraftSend.ts`, `packages/core/src/features/messaging/triage/actions/searchMessages.ts`, `packages/core/src/features/messaging/triage/actions/sendDraft.ts`, `packages/core/src/features/messaging/triage/actions/triageMessages.ts`
- `MODEL_SWITCH` — `plugins/plugin-app-control/src/actions/model-switch.ts`
- `MUSIC` — `plugins/plugin-music/src/actions/music.ts`
- `MUSIC_LIBRARY` — `plugins/plugin-music/src/actions/musicLibrary.ts`
- `NOTIFY` — `packages/agent/src/actions/notify.ts`
- `ORCHESTRATOR_STATUS_COMMAND` — `plugins/plugin-task-coordinator/src/orchestrator-command.ts`
- `OSWORLD` — `plugins/plugin-benchmarks/src/actions/osworld.ts`
- `OWNER_ALARMS` — `plugins/plugin-personal-assistant/src/actions/owner-surfaces.ts`
- `OWNER_DOCUMENTS` — `plugins/plugin-personal-assistant/src/actions/document.ts`
- `OWNER_FINANCES` — `plugins/plugin-personal-assistant/src/actions/owner-surfaces.ts`
- `OWNER_GOALS` — `plugins/plugin-goals/src/actions/goals.ts`, `plugins/plugin-personal-assistant/src/actions/owner-surfaces.ts`
- `OWNER_HEALTH` — `plugins/plugin-health/src/actions/health.ts`
- `OWNER_REMINDERS` — `plugins/plugin-personal-assistant/src/actions/owner-surfaces.ts`
- `OWNER_ROUTINES` — `plugins/plugin-personal-assistant/src/actions/owner-surfaces.ts`
- `OWNER_SCREENTIME` — `plugins/plugin-health/src/actions/screen-time.ts`
- `OWNER_TODOS` — `plugins/plugin-personal-assistant/src/actions/owner-surfaces.ts`
- `PAIR_OWNER_ACCOUNT` — `packages/agent/src/actions/pair-owner-account.ts`
- `PAYMENT` — `packages/core/src/features/payments/actions/payment.ts`
- `PERPETUAL_MARKET` — `plugins/plugin-hyperliquid/src/actions/perpetual-market.ts`
- `PERSONAL_ASSISTANT` — `plugins/plugin-personal-assistant/src/actions/owner-surfaces.ts`
- `PERSONALITY` — `packages/core/src/features/advanced-capabilities/personality/actions/personality.ts`
- `PLAN` — `packages/core/src/features/advanced-planning/actions/plan.ts`
- `PLAY_AUDIO` — `plugins/plugin-music/src/actions/playAudio.ts`
- `PLAYBACK` — `plugins/plugin-music/src/actions/playbackOp.ts`
- `PLUGIN` — `packages/agent/src/actions/plugin.ts`
- `POLL_PLUGIN_CONFIG_STATUS` — `packages/core/src/features/plugin-config/actions/poll-plugin-config-status.ts`
- `POST` — `packages/core/src/features/advanced-capabilities/actions/post.ts`
- `PREDICTION_MARKET` — `plugins/plugin-polymarket/src/actions.ts`
- `PRIORITIZE` — `plugins/plugin-personal-assistant/src/actions/prioritize.ts`
- `PROBE_PLUGIN_CONFIG_REQUIREMENTS` — `packages/core/src/features/plugin-config/actions/probe-plugin-config-requirements.ts`
- `PROXY_STATUS` — `plugins/plugin-anthropic-proxy/src/actions/proxy-status.action.ts`
- `REDACT_TRANSCRIPT` — `plugins/plugin-local-inference/src/actions/transcript-permissioning.ts`
- `REGENERATE_APP_API_KEY` — `plugins/plugin-cloud-apps/src/actions/regenerate-app-api-key.ts`
- `RESOLVE_REFERENT` — `plugins/plugin-personal-assistant/src/actions/resolve-referent.ts`
- `RESOLVE_REQUEST` — `plugins/plugin-personal-assistant/src/actions/resolve-request.ts`
- `RETRIEVE_CHILD_AGENT_RESULTS` — `packages/core/src/features/sub-agent-credentials/actions/retrieve-child-agent-results.ts`
- `REVOKE_OAUTH_CREDENTIAL` — `packages/core/src/features/oauth/actions/revoke-oauth-credential.ts`
- `ROLE` — `packages/core/src/features/advanced-capabilities/actions/role.ts`
- `ROLLBACK_FRONTEND` — `plugins/plugin-cloud-apps/src/actions/rollback-frontend.ts`
- `ROOM` — `packages/core/src/features/advanced-capabilities/actions/room.ts`
- `RUNTIME` — `packages/agent/src/actions/runtime.ts`
- `SCHEDULED_TASKS` — `plugins/plugin-personal-assistant/src/actions/scheduled-task.ts`
- `SEARCH_CHANNEL_TOPICS` — `packages/core/src/features/basic-capabilities/actions/channel-topic-search.ts`
- `SEARCH_EXPERIENCES` — `packages/core/src/features/advanced-capabilities/experience/actions/search-experiences.ts`
- `SEARCH_KNOWLEDGE` — `packages/agent/src/actions/knowledge.ts`
- `SEARCH_LINEAR_ISSUES` — `plugins/plugin-linear/src/actions/searchIssues.ts`
- `SECRETS` — `packages/core/src/features/secrets/actions/manage-secret.ts`
- `SECRETS_UPDATE_SETTINGS` — `packages/core/src/features/secrets/setup/action.ts`
- `SECURITY_EVALUATOR` — `packages/core/src/features/trust/evaluators/securityEvaluator.ts`
- `SEND_MEDIA_TO` — `packages/agent/src/actions/knowledge.ts`
- `SET_AD_CAMPAIGN_DAYPARTING` — `plugins/plugin-cloud-apps/src/actions/ad-campaigns.ts`
- `SET_FOLLOWUP_THRESHOLD` — `plugins/plugin-personal-assistant/src/followup/actions/setFollowupThreshold.ts`
- `SETTINGS` — `packages/agent/src/actions/settings-actions.ts`, `plugins/plugin-app-control/src/actions/settings.ts`
- `SHARE_TRANSCRIPT` — `plugins/plugin-local-inference/src/actions/transcript-permissioning.ts`
- `SHELL` — `plugins/plugin-coding-tools/src/actions/bash.ts`
- `SKILL` — `plugins/plugin-agent-skills/src/actions/skill.ts`
- `SMARTGLASSES_CONTROL` — `plugins/plugin-facewear/src/actions/facewear-control.ts`
- `SMARTGLASSES_DISPLAY_TEXT` — `plugins/plugin-facewear/src/actions/display-text.ts`
- `SMARTGLASSES_MICROPHONE` — `plugins/plugin-facewear/src/actions/microphone.ts`
- `SMARTGLASSES_STATUS` — `plugins/plugin-facewear/src/actions/facewear-status.ts`
- `START_TRANSCRIPTION` — `plugins/plugin-local-inference/src/actions/transcription-control.ts`
- `STOP_TRANSCRIPTION` — `plugins/plugin-local-inference/src/actions/transcription-control.ts`
- `STREAM` — `plugins/plugin-streaming/src/core.ts`
- `SUBMIT_PRESS_RELEASE` — `plugins/plugin-cloud-apps/src/actions/press-releases.ts`
- `TASKS` — `plugins/plugin-agent-orchestrator/src/actions/tasks.ts`
- `TAU_BENCH_TOOL` — `plugins/plugin-benchmarks/src/actions/tau-bench.ts`
- `TERMINAL_SHELL` — `packages/agent/src/actions/terminal.ts`
- `TODO` — `plugins/plugin-todos/src/actions/todo.ts`
- `TRADE` — `plugins/plugin-wallet/src/actions/trade-action.ts`
- `TRIGGER` — `packages/agent/src/actions/trigger.ts`
- `TRUST` — `packages/core/src/features/trust/actions/trust.ts`
- `TUNNEL_CREDENTIAL_TO_CHILD_SESSION` — `packages/core/src/features/sub-agent-credentials/actions/tunnel-credential-to-child-session.ts`
- `UPDATE_APP` — `plugins/plugin-cloud-apps/src/actions/update-app.ts`
- `UPDATE_LINEAR_ISSUE` — `plugins/plugin-linear/src/actions/updateIssue.ts`
- `UPDATE_MONETIZATION` — `plugins/plugin-cloud-apps/src/actions/update-monetization.ts`
- `USE_SKILL` — `plugins/plugin-agent-skills/src/actions/use-skill.ts`
- `VENDING_MACHINE` — `plugins/plugin-benchmarks/src/actions/vending-machine.ts`
- `VIEW_CHARACTER_ADD_MESSAGE_EXAMPLE` — `packages/agent/src/api/builtin-views.ts`
- `VIEW_CHARACTER_ADD_STYLE_RULE` — `packages/agent/src/api/builtin-views.ts`
- `VIEW_CHARACTER_FILL_BIO` — `packages/agent/src/api/builtin-views.ts`
- `VIEWS` — `plugins/plugin-app-control/src/actions/views.ts`
- `VISION` — `plugins/plugin-vision/src/action.ts`
- `VISUALWEBBENCH_TASK` — `plugins/plugin-benchmarks/src/actions/visualwebbench.ts`
- `VOICE_CALL` — `plugins/plugin-personal-assistant/src/actions/voice-call.ts`
- `WALLET` — `plugins/plugin-wallet/src/chains/wallet-action.ts`
- `WEB_FETCH` — `plugins/plugin-coding-tools/src/actions/web-fetch.ts`
- `WEB_SEARCH` — `plugins/plugin-coding-tools/src/actions/web-search.ts`
- `WEBSHOP` — `plugins/plugin-benchmarks/src/actions/webshop.ts`
- `WINDOW` — `plugins/plugin-computeruse/src/actions/window.ts`
- `WITHDRAW_APP_EARNINGS` — `plugins/plugin-cloud-apps/src/actions/withdraw-app-earnings.ts`
- `WORK_THREAD` — `plugins/plugin-personal-assistant/src/actions/work-thread.ts`
- `WORKTREE` — `plugins/plugin-coding-tools/src/actions/worktree.ts`

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
