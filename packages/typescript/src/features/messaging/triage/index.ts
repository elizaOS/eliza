export * from "./types.ts";
export {
	DEFAULT_CONTACT_WEIGHT,
	rankScored,
	resetMissingServiceWarning,
	resolveContactWeight,
	scoreMessage,
	scoreMessages,
} from "./triage-engine.ts";
export type { ScoreContext } from "./triage-engine.ts";
export {
	MessageRefStore,
	__resetDefaultMessageRefStoreForTests,
	getDefaultMessageRefStore,
} from "./message-ref-store.ts";
export {
	TriageService,
	__resetDefaultTriageServiceForTests,
	createDefaultTriageService,
	getDefaultTriageService,
} from "./triage-service.ts";
export type { TriageOptions } from "./triage-service.ts";

export { BaseMessageAdapter } from "./adapters/base.ts";
export { DiscordMessageAdapter } from "./adapters/discord-adapter.ts";
export { GmailMessageAdapter } from "./adapters/gmail-adapter.ts";
export { IMessageMessageAdapter } from "./adapters/imessage-adapter.ts";
export { SignalMessageAdapter } from "./adapters/signal-adapter.ts";
export { TelegramMessageAdapter } from "./adapters/telegram-adapter.ts";
export { TwitterMessageAdapter } from "./adapters/twitter-adapter.ts";
export { WhatsappMessageAdapter } from "./adapters/whatsapp-adapter.ts";

export { triageMessagesAction } from "./actions/triageMessages.ts";
export { listUnifiedInboxAction } from "./actions/listUnifiedInbox.ts";
export { draftReplyAction } from "./actions/draftReply.ts";
export { draftFollowupAction } from "./actions/draftFollowup.ts";
export { sendDraftAction } from "./actions/sendDraft.ts";

import { draftFollowupAction } from "./actions/draftFollowup.ts";
import { draftReplyAction } from "./actions/draftReply.ts";
import { listUnifiedInboxAction } from "./actions/listUnifiedInbox.ts";
import { sendDraftAction } from "./actions/sendDraft.ts";
import { triageMessagesAction } from "./actions/triageMessages.ts";
import type { Action } from "../../../types/index.ts";

export const messagingTriageActions: readonly Action[] = [
	triageMessagesAction,
	listUnifiedInboxAction,
	draftReplyAction,
	draftFollowupAction,
	sendDraftAction,
];
