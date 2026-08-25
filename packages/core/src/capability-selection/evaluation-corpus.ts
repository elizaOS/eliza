/**
 * Built-in evaluation corpus for capability retrieval and account selection.
 * The catalog models representative Wave 2-5 normalized capabilities (email,
 * calendar, messaging, files, payments, contacts, commerce, health, code);
 * the cases cover unambiguous intents, cross-domain ambiguous intents,
 * designed-empty intents, unavailable and policy-blocked accounts, cost and
 * health gating, and wrong-account prevention for pinned account requests.
 * All identifiers are synthetic; no credentials or provider data appear here.
 */
import {
	type ConnectedAccount,
	type ConnectedAccountCapability,
	type ConnectedAccountMode,
	type ConnectedAccountStatus,
	PROVIDER_INTEGRATION_CONTRACT_VERSION,
} from "../types/provider-integrations";
import type {
	AccountSelectionPolicy,
	AccountSelectionSignal,
} from "./account-selection";
import type { CapabilitySelectionEvalCase } from "./evaluation";
import type { CapabilityCatalogEntry } from "./retrieval";

export const CAPABILITY_EVALUATION_CATALOG: readonly CapabilityCatalogEntry[] =
	Object.freeze([
		{
			capabilityId: "email.message.send",
			domain: "email",
			summary: "Send or reply to an email message from a connected mailbox.",
			keywords: ["email", "send", "compose", "reply"],
			operations: ["send", "reply"],
			promptTokenEstimate: 120,
		},
		{
			capabilityId: "email.message.search",
			domain: "email",
			summary: "Search email messages in a connected mailbox.",
			keywords: ["email", "inbox", "search", "find"],
			operations: ["search"],
			promptTokenEstimate: 90,
		},
		{
			capabilityId: "calendar.event.create",
			domain: "calendar",
			summary: "Create a calendar event with attendees and reminders.",
			keywords: ["calendar", "event", "schedule", "meeting"],
			operations: ["create"],
			promptTokenEstimate: 110,
		},
		{
			capabilityId: "messaging.chat.send",
			domain: "messaging",
			summary: "Send a chat message to a channel or person.",
			keywords: ["message", "chat", "dm", "send"],
			operations: ["send"],
			promptTokenEstimate: 100,
		},
		{
			capabilityId: "files.document.search",
			domain: "files",
			summary: "Search documents and files in connected storage.",
			keywords: ["file", "document", "drive", "search"],
			operations: ["search"],
			promptTokenEstimate: 95,
		},
		{
			capabilityId: "payments.transfer.create",
			domain: "payments",
			summary: "Create a money transfer between linked accounts.",
			keywords: ["payment", "transfer", "money", "pay"],
			operations: ["create"],
			promptTokenEstimate: 140,
		},
		{
			capabilityId: "contacts.person.search",
			domain: "contacts",
			summary: "Search people in the connected address book.",
			keywords: ["contact", "person", "people", "address"],
			operations: ["search"],
			promptTokenEstimate: 80,
		},
		{
			capabilityId: "commerce.order.create",
			domain: "commerce",
			summary: "Place a purchase order from a connected storefront.",
			keywords: ["order", "purchase", "buy", "cart"],
			operations: ["create"],
			promptTokenEstimate: 130,
		},
		{
			capabilityId: "health.metrics.read",
			domain: "health",
			summary: "Read step, sleep, and heart-rate metrics from a device.",
			keywords: ["health", "steps", "sleep", "metrics"],
			operations: ["read"],
			promptTokenEstimate: 85,
		},
		{
			capabilityId: "code.repository.search",
			domain: "code",
			summary: "Search source code in connected repositories.",
			keywords: ["code", "repository", "repo", "commit"],
			operations: ["search"],
			promptTokenEstimate: 105,
		},
	]);

function account(input: {
	accountId: string;
	providerId: string;
	mode?: ConnectedAccountMode;
	status?: ConnectedAccountStatus;
	capabilities: readonly ConnectedAccountCapability[];
	lastUsedAt?: string | null;
}): ConnectedAccount {
	return Object.freeze({
		contractVersion: PROVIDER_INTEGRATION_CONTRACT_VERSION,
		accountId: input.accountId,
		providerId: input.providerId,
		mode: input.mode ?? "cloud",
		status: input.status ?? "connected",
		displayName: null,
		capabilities: Object.freeze([...input.capabilities]),
		lastUsedAt: input.lastUsedAt ?? null,
	});
}

const EMAIL_CAPS: readonly ConnectedAccountCapability[] = Object.freeze([
	{ capabilityId: "email.message.send", riskLevel: "R2", status: "available" },
	{
		capabilityId: "email.message.search",
		riskLevel: "R1",
		status: "available",
	},
]);

const EMAIL_WORK = account({
	accountId: "acct-email-work",
	providerId: "google-mail",
	capabilities: EMAIL_CAPS,
	lastUsedAt: "2026-08-01T00:00:00.000Z",
});
const EMAIL_PERSONAL = account({
	accountId: "acct-email-personal",
	providerId: "google-mail",
	capabilities: EMAIL_CAPS,
	lastUsedAt: "2026-08-10T00:00:00.000Z",
});
const EMAIL_LEGACY = account({
	accountId: "acct-email-legacy",
	providerId: "microsoft-mail",
	status: "revoked",
	capabilities: EMAIL_CAPS,
});
const BANK_PRIMARY = account({
	accountId: "acct-bank-primary",
	providerId: "plaid",
	capabilities: [
		{
			capabilityId: "payments.transfer.create",
			riskLevel: "R3",
			status: "available",
		},
	],
});

function signal(
	accountId: string,
	overrides: Partial<Omit<AccountSelectionSignal, "accountId">> = {},
): AccountSelectionSignal {
	return {
		accountId,
		healthy: overrides.healthy ?? true,
		region: overrides.region ?? "us",
		unitCostMicros: overrides.unitCostMicros ?? 10,
	};
}

const OPEN_POLICY: AccountSelectionPolicy = Object.freeze({
	allowedModes: null,
	allowedProviderIds: null,
	blockedAccountIds: Object.freeze([]),
	maxRiskLevel: "R2",
	preferredRegion: null,
	maxUnitCostMicros: null,
});

const EMAIL_SEND_INTENT = {
	capabilityId: "email.message.send",
	riskLevel: "R2",
	requestedAccountId: null,
} as const;

const EMAIL_RETRIEVAL = {
	topCapabilityId: "email.message.send",
	mustInclude: ["email.message.send"],
	expectAmbiguous: false,
} as const;

export const CAPABILITY_EVALUATION_CORPUS: readonly CapabilitySelectionEvalCase[] =
	Object.freeze([
		{
			name: "unambiguous email send selects the cheapest healthy account",
			intentText: "send an email to sam about the offsite",
			retrieval: EMAIL_RETRIEVAL,
			selection: {
				intent: EMAIL_SEND_INTENT,
				accounts: [EMAIL_WORK, EMAIL_PERSONAL],
				signals: [
					signal("acct-email-work", { unitCostMicros: 10 }),
					signal("acct-email-personal", { region: "eu", unitCostMicros: 5 }),
				],
				policy: OPEN_POLICY,
				expected: { outcome: "selected", accountId: "acct-email-personal" },
			},
		},
		{
			name: "region preference outranks cost",
			intentText: "send an email to sam about the offsite",
			retrieval: EMAIL_RETRIEVAL,
			selection: {
				intent: EMAIL_SEND_INTENT,
				accounts: [EMAIL_WORK, EMAIL_PERSONAL],
				signals: [
					signal("acct-email-work", { unitCostMicros: 10 }),
					signal("acct-email-personal", { region: "eu", unitCostMicros: 5 }),
				],
				policy: { ...OPEN_POLICY, preferredRegion: "us" },
				expected: { outcome: "selected", accountId: "acct-email-work" },
			},
		},
		{
			name: "ambiguous cross-domain send intent is flagged, never auto-resolved",
			intentText: "send a message",
			retrieval: {
				topCapabilityId: "messaging.chat.send",
				mustInclude: ["messaging.chat.send", "email.message.send"],
				expectAmbiguous: true,
			},
			selection: null,
		},
		{
			name: "unrelated intent retrieves nothing instead of the full catalog",
			intentText: "zzqx flibberwock unrelated gibberish",
			retrieval: {
				topCapabilityId: null,
				mustInclude: [],
				expectAmbiguous: false,
			},
			selection: null,
		},
		{
			name: "pinned blocked account is denied, never substituted",
			intentText: "send an email from my personal account",
			retrieval: EMAIL_RETRIEVAL,
			selection: {
				intent: {
					...EMAIL_SEND_INTENT,
					requestedAccountId: "acct-email-personal",
				},
				accounts: [EMAIL_WORK, EMAIL_PERSONAL],
				signals: [signal("acct-email-work"), signal("acct-email-personal")],
				policy: { ...OPEN_POLICY, blockedAccountIds: ["acct-email-personal"] },
				expected: { outcome: "denied", reasonCode: "account_policy_denied" },
			},
		},
		{
			name: "pinned unknown account is not_configured",
			intentText: "send an email from my old account",
			retrieval: EMAIL_RETRIEVAL,
			selection: {
				intent: { ...EMAIL_SEND_INTENT, requestedAccountId: "acct-missing" },
				accounts: [EMAIL_WORK],
				signals: [signal("acct-email-work")],
				policy: OPEN_POLICY,
				expected: {
					outcome: "unavailable",
					code: "not_configured",
					retryable: false,
				},
			},
		},
		{
			name: "high-risk transfer above the policy ceiling is deterministically denied",
			intentText: "transfer money to my savings account",
			retrieval: {
				topCapabilityId: "payments.transfer.create",
				mustInclude: ["payments.transfer.create"],
				expectAmbiguous: false,
			},
			selection: {
				intent: {
					capabilityId: "payments.transfer.create",
					riskLevel: "R3",
					requestedAccountId: null,
				},
				accounts: [BANK_PRIMARY],
				signals: [signal("acct-bank-primary")],
				policy: OPEN_POLICY,
				expected: { outcome: "denied", reasonCode: "risk_policy_denied" },
			},
		},
		{
			name: "only-revoked accounts surface account_revoked",
			intentText: "search email from legacy inbox",
			retrieval: {
				topCapabilityId: "email.message.search",
				mustInclude: ["email.message.search"],
				expectAmbiguous: false,
			},
			selection: {
				intent: {
					capabilityId: "email.message.search",
					riskLevel: "R1",
					requestedAccountId: null,
				},
				accounts: [EMAIL_LEGACY],
				signals: [signal("acct-email-legacy")],
				policy: OPEN_POLICY,
				expected: {
					outcome: "unavailable",
					code: "account_revoked",
					retryable: false,
				},
			},
		},
		{
			name: "cost policy blocks every account as cost_blocked",
			intentText: "send an email to sam about the offsite",
			retrieval: EMAIL_RETRIEVAL,
			selection: {
				intent: EMAIL_SEND_INTENT,
				accounts: [EMAIL_WORK, EMAIL_PERSONAL],
				signals: [
					signal("acct-email-work", { unitCostMicros: 10 }),
					signal("acct-email-personal", { unitCostMicros: 8 }),
				],
				policy: { ...OPEN_POLICY, maxUnitCostMicros: 3 },
				expected: {
					outcome: "unavailable",
					code: "cost_blocked",
					retryable: false,
				},
			},
		},
		{
			name: "unhealthy cheapest account loses to the healthy alternative",
			intentText: "send an email to sam about the offsite",
			retrieval: EMAIL_RETRIEVAL,
			selection: {
				intent: EMAIL_SEND_INTENT,
				accounts: [EMAIL_WORK, EMAIL_PERSONAL],
				signals: [
					signal("acct-email-work", { unitCostMicros: 10 }),
					signal("acct-email-personal", { unitCostMicros: 5, healthy: false }),
				],
				policy: OPEN_POLICY,
				expected: { outcome: "selected", accountId: "acct-email-work" },
			},
		},
		{
			name: "capability lacking on every account is unsupported",
			intentText: "create a calendar event for friday",
			retrieval: {
				topCapabilityId: "calendar.event.create",
				mustInclude: ["calendar.event.create"],
				expectAmbiguous: false,
			},
			selection: {
				intent: {
					capabilityId: "calendar.event.create",
					riskLevel: "R1",
					requestedAccountId: null,
				},
				accounts: [EMAIL_WORK],
				signals: [signal("acct-email-work")],
				policy: OPEN_POLICY,
				expected: {
					outcome: "unavailable",
					code: "unsupported",
					retryable: false,
				},
			},
		},
		{
			name: "equal candidates fall back to most-recent use then accountId",
			intentText: "send an email to sam about the offsite",
			retrieval: EMAIL_RETRIEVAL,
			selection: {
				intent: EMAIL_SEND_INTENT,
				accounts: [EMAIL_WORK, EMAIL_PERSONAL],
				signals: [signal("acct-email-work"), signal("acct-email-personal")],
				policy: OPEN_POLICY,
				expected: { outcome: "selected", accountId: "acct-email-personal" },
			},
		},
	]);
