export { draftFollowupAction } from "./actions/draftFollowup.ts";
export { draftReplyAction } from "./actions/draftReply.ts";
export { listInboxAction } from "./actions/listInbox.ts";
export { sendDraftAction } from "./actions/sendDraft.ts";
export { triageMessagesAction } from "./actions/triageMessages.ts";
export { BaseMessageAdapter } from "./adapters/base.ts";
export { DiscordMessageAdapter } from "./adapters/discord-adapter.ts";
export { GmailMessageAdapter } from "./adapters/gmail-adapter.ts";
export { IMessageMessageAdapter } from "./adapters/imessage-adapter.ts";
export { SignalMessageAdapter } from "./adapters/signal-adapter.ts";
export { TelegramMessageAdapter } from "./adapters/telegram-adapter.ts";
export { TwitterMessageAdapter } from "./adapters/twitter-adapter.ts";
export { WhatsappMessageAdapter } from "./adapters/whatsapp-adapter.ts";
export {
	__resetDefaultMessageRefStoreForTests,
	getDefaultMessageRefStore,
	MessageRefStore,
} from "./message-ref-store.ts";
export type { ScoreContext } from "./triage-engine.ts";
export {
	DEFAULT_CONTACT_WEIGHT,
	rankScored,
	resetMissingServiceWarning,
	resolveContactWeight,
	scoreMessage,
	scoreMessages,
} from "./triage-engine.ts";
export type { TriageOptions } from "./triage-service.ts";
export {
	__resetDefaultTriageServiceForTests,
	createDefaultTriageService,
	getDefaultTriageService,
	TriageService,
} from "./triage-service.ts";
export * from "./types.ts";

import type { Action } from "../../../types/index.ts";
import { draftFollowupAction } from "./actions/draftFollowup.ts";
import { draftReplyAction } from "./actions/draftReply.ts";
import { listInboxAction } from "./actions/listInbox.ts";
import { sendDraftAction } from "./actions/sendDraft.ts";
import { triageMessagesAction } from "./actions/triageMessages.ts";

export const messagingTriageActions: readonly Action[] = [
	triageMessagesAction,
	listInboxAction,
	draftReplyAction,
	draftFollowupAction,
	sendDraftAction,
];
