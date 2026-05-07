/**
 * First-party context taxonomy for elizaOS v5 native tool calling.
 *
 * The taxonomy follows research/native-tool-calling/PLAN.md §4.3.
 *
 * Each definition declares:
 * - id: stable lowercase context id (matches FirstPartyAgentContext)
 * - label: human-readable label shown in prompts and UI
 * - description: short purpose statement included in the Stage 1 prompt
 * - sensitivity: data sensitivity tier (public/personal/private/system)
 * - cacheScope: how long context-derived providers may be cached
 * - roleGate: minimum sender role required (PLAN §4.3 column "Gate")
 * - aliases: legacy strings that should resolve to this id
 * - parents/subcontexts: the v5 taxonomy graph
 *
 * The default registration is intended to be byte-identical across runtime
 * boots, so that the Stage 1 prompt prefix stays cache-stable.
 */
import type { ContextDefinition } from "../types/contexts";

export const DEFAULT_CONTEXT_DEFINITIONS: readonly ContextDefinition[] =
	Object.freeze([
		{
			id: "simple",
			label: "Simple",
			description:
				"Direct reply with no tools, no external data, and no other contexts. Pick this as the only context when the agent can answer from its own knowledge.",
			selectionGuidance:
				"Select only when the user needs a plain response and no provider, action, connector, file, memory, knowledge-base, or external data is needed.",
			covers: ["direct answers", "small talk", "simple explanations"],
			sensitivity: "public",
			cacheStable: true,
			cacheScope: "global",
			aliases: ["direct", "shortcut"],
		},
		{
			id: "general",
			label: "General",
			description:
				"Normal conversation and public agent behavior. Use when the reply needs general agent state but no tool work.",
			selectionGuidance:
				"Select for conversational responses that may need character or recent-message context but do not require a specialized domain.",
			covers: ["conversation", "agent persona", "recent message context"],
			sensitivity: "public",
			cacheStable: true,
			cacheScope: "global",
			aliases: ["chat", "conversation"],
		},
		{
			id: "memory",
			label: "Memory",
			description:
				"Read, write, and recall agent memories and long-term facts.",
			selectionGuidance:
				"Select when the user asks what the agent remembers, wants the agent to remember something, or needs long-term user/relationship facts.",
			covers: ["long-term memories", "remembered user facts", "memory writes"],
			sensitivity: "personal",
			cacheScope: "agent",
			roleGate: { minRole: "USER" },
		},
		{
			id: "knowledge",
			label: "Knowledge",
			description:
				"Compressed knowledge-base context for stored documents, uploaded files, learned notes, RAG search, and knowledge ingestion.",
			selectionGuidance:
				"Select when the user asks to search, use, add, update, delete, or ingest knowledge-base material, documents, learned notes, URLs, PDFs, or grounded reference content. Do not select files/web/browser merely because a knowledge action may read a file or URL; selecting knowledge explodes the knowledge sub-actions.",
			covers: [
				"RAG search",
				"stored documents",
				"knowledge ingestion",
				"knowledge document updates",
				"knowledge document deletion",
			],
			sensitivity: "personal",
			cacheScope: "agent",
			roleGate: { minRole: "USER" },
		},
		{
			id: "web",
			label: "Web",
			description: "Web search and reading public internet pages.",
			selectionGuidance:
				"Select when the user needs current or public internet information, not when they are specifically adding a URL into the knowledge base.",
			covers: ["web search", "public pages", "current information"],
			sensitivity: "public",
			cacheScope: "turn",
			subcontexts: ["browser"],
			roleGate: { minRole: "USER" },
		},
		{
			id: "browser",
			label: "Browser",
			description:
				"Drive a browser session: navigate, click, type, and extract page state.",
			selectionGuidance:
				"Select when the request requires an interactive browser session, page state, clicking, typing, or logged-in website workflows.",
			covers: ["browser automation", "page state", "logged-in web apps"],
			parent: "web",
			sensitivity: "personal",
			cacheScope: "turn",
			roleGate: { minRole: "ADMIN" },
		},
		{
			id: "code",
			label: "Code",
			description:
				"Read, edit, run, or review code, including spawned coding sub-agents.",
			selectionGuidance:
				"Select for codebase analysis, implementation, debugging, tests, reviews, or delegated coding work.",
			covers: ["code reading", "code editing", "tests", "debugging"],
			sensitivity: "personal",
			cacheScope: "conversation",
			subcontexts: ["files", "terminal"],
			roleGate: { minRole: "ADMIN" },
		},
		{
			id: "files",
			label: "Files",
			description:
				"Local file and document operations: read, write, list, attach.",
			selectionGuidance:
				"Select when the user asks to manipulate local files or attachments directly outside of knowledge-base ingestion.",
			covers: ["local files", "attachments", "documents"],
			parent: "code",
			sensitivity: "private",
			cacheScope: "turn",
			roleGate: { minRole: "ADMIN" },
		},
		{
			id: "terminal",
			label: "Terminal",
			description: "Execute shell commands and inspect local processes.",
			selectionGuidance:
				"Select when command execution, process inspection, package scripts, or shell output is required.",
			covers: ["shell commands", "processes", "local scripts"],
			parent: "code",
			sensitivity: "private",
			cacheScope: "turn",
			roleGate: { minRole: "OWNER" },
		},
		{
			id: "email",
			label: "Email",
			description:
				"Read, send, draft, triage, and search the user's email accounts.",
			selectionGuidance:
				"Select for inbox search, email drafting/sending, threads, unread mail, or email triage.",
			covers: ["inbox", "email threads", "drafts", "send email"],
			sensitivity: "private",
			cacheScope: "turn",
			roleGate: { minRole: "ADMIN" },
		},
		{
			id: "calendar",
			label: "Calendar",
			description:
				"Check availability, view events, schedule meetings, manage invites.",
			selectionGuidance:
				"Select for availability, scheduling, meeting creation, event lookup, invites, Calendly, or calendar preferences.",
			covers: ["availability", "events", "meetings", "invites", "Calendly"],
			sensitivity: "private",
			cacheScope: "turn",
			roleGate: { minRole: "ADMIN" },
		},
		{
			id: "contacts",
			label: "Contacts",
			description:
				"Look up, add, or update people in the user's contacts and relationship graph.",
			selectionGuidance:
				"Select when the request depends on people, contact records, relationships, identity resolution, or recipient lookup.",
			covers: ["people", "contacts", "relationships", "recipient lookup"],
			sensitivity: "private",
			cacheScope: "agent",
			roleGate: { minRole: "ADMIN" },
		},
		{
			id: "tasks",
			label: "Tasks",
			description:
				"Reminders, todos, goals, habits, and scheduled actions for the user.",
			selectionGuidance:
				"Select for reminders, todos, follow-ups, goals, routines, habits, or task scheduling.",
			covers: ["reminders", "todos", "follow-ups", "goals", "habits"],
			sensitivity: "personal",
			cacheScope: "agent",
			roleGate: { minRole: "ADMIN" },
		},
		{
			id: "health",
			label: "Health",
			description: "Personal health metrics and wellness data.",
			selectionGuidance:
				"Select for health, sleep, wellness, vitals, exercise, or personal health connectors.",
			covers: ["health data", "sleep", "wellness", "exercise"],
			sensitivity: "private",
			cacheScope: "turn",
			roleGate: { minRole: "OWNER" },
		},
		{
			id: "screen_time",
			label: "Screen Time",
			description: "Device, app, and screen-time controls and reporting.",
			selectionGuidance:
				"Select for app usage, device limits, website blocking, screen-time summaries, or focus controls.",
			covers: ["app usage", "device controls", "website blocking", "focus"],
			sensitivity: "private",
			cacheScope: "turn",
			aliases: ["screen-time", "screentime"],
			roleGate: { minRole: "OWNER" },
		},
		{
			id: "subscriptions",
			label: "Subscriptions",
			description: "Recurring services, billing awareness, and renewals.",
			selectionGuidance:
				"Select for subscription detection, recurring charges, renewal review, or cancellation workflows.",
			covers: ["subscriptions", "recurring charges", "renewals"],
			sensitivity: "private",
			cacheScope: "turn",
			roleGate: { minRole: "OWNER" },
		},
		{
			id: "finance",
			label: "Finance",
			description:
				"Money, balances, portfolio value, accounts, invoices, and financial overview questions.",
			selectionGuidance:
				"Select for broad money questions, including wallet balance questions. When the user asks how much money they have in a wallet, select finance plus wallet and crypto.",
			covers: ["money", "balances", "portfolio value", "accounts", "invoices"],
			sensitivity: "private",
			cacheScope: "turn",
			aliases: ["money", "balance", "balances", "portfolio"],
			subcontexts: ["payments", "wallet", "crypto"],
			roleGate: { minRole: "OWNER" },
		},
		{
			id: "payments",
			label: "Payments",
			description: "Payment methods, invoices, and financial workflows.",
			selectionGuidance:
				"Select for payment methods, invoices, checkout, billing workflows, or payment reconciliation.",
			covers: ["payments", "invoices", "billing workflows"],
			parent: "finance",
			sensitivity: "private",
			cacheScope: "turn",
			roleGate: { minRole: "OWNER" },
		},
		{
			id: "wallet",
			label: "Wallet",
			description:
				"Wallet and account operations: balances, transfers, swaps, signing, and portfolio holdings.",
			selectionGuidance:
				"Select for wallet balances, holdings, transfers, swaps, signing, or portfolio questions. Pair with finance and crypto for natural-language money-in-wallet questions.",
			covers: ["wallet balances", "holdings", "transfers", "swaps", "signing"],
			parents: ["finance"],
			sensitivity: "private",
			cacheScope: "turn",
			aliases: ["account_balance", "wallet_balance"],
			subcontexts: ["crypto"],
			roleGate: { minRole: "OWNER" },
		},
		{
			id: "crypto",
			label: "Crypto",
			description:
				"Crypto assets, tokens, DeFi positions, wallet balances, swaps, bridges, and on-chain transfers.",
			selectionGuidance:
				"Select for tokens, DeFi, on-chain assets, crypto wallets, swaps, bridges, or crypto-denominated balances. Pair with finance and wallet for wallet money questions.",
			covers: ["tokens", "DeFi", "on-chain transfers", "bridges", "swaps"],
			parents: ["finance", "wallet"],
			sensitivity: "private",
			cacheScope: "turn",
			aliases: ["web3", "defi", "token", "tokens", "onchain", "on-chain"],
			roleGate: { minRole: "OWNER" },
		},
		{
			id: "messaging",
			label: "Messaging",
			description:
				"Send and read messages on Discord, Slack, Telegram, Signal, iMessage, and similar.",
			selectionGuidance:
				"Select for private or workspace messages, DMs, channels, unread messages, or sending through chat connectors.",
			covers: ["DMs", "channels", "unread messages", "send messages"],
			sensitivity: "private",
			cacheScope: "turn",
			roleGate: { minRole: "ADMIN" },
		},
		{
			id: "phone",
			label: "Phone",
			description:
				"Phone-based messaging and voice calls (SMS, iMessage, RCS, dialing).",
			selectionGuidance:
				"Select for SMS or text messages by phone number, iMessage on macOS/iOS, or for placing or receiving phone calls.",
			covers: ["SMS", "text messages", "iMessage", "phone calls"],
			sensitivity: "private",
			cacheScope: "turn",
			parent: "messaging",
			aliases: ["sms", "voice"],
			roleGate: { minRole: "ADMIN" },
		},
		{
			id: "social_posting",
			label: "Social Posting",
			description: "Public posts and social actions on platforms like X.",
			selectionGuidance:
				"Select for public posting, profile updates, social timelines, replies, or public social engagement.",
			covers: ["public posts", "timelines", "profiles", "social replies"],
			sensitivity: "private",
			cacheScope: "turn",
			aliases: ["social-posting", "posting"],
			roleGate: { minRole: "ADMIN" },
		},
		{
			id: "media",
			label: "Media",
			description:
				"Generate or process images, audio, and video. Includes screenshots and transcription.",
			selectionGuidance:
				"Select for images, audio, video, screenshots, transcription, music generation, or visual analysis.",
			covers: ["images", "audio", "video", "screenshots", "transcription"],
			sensitivity: "personal",
			cacheScope: "turn",
			roleGate: { minRole: "USER" },
		},
		{
			id: "automation",
			label: "Automation",
			description:
				"Workflows, cron jobs, triggers, and scheduled agent automations.",
			selectionGuidance:
				"Select for creating, editing, running, or inspecting workflows, automations, triggers, and scheduled jobs.",
			covers: ["workflows", "triggers", "scheduled jobs", "automations"],
			sensitivity: "personal",
			cacheScope: "agent",
			roleGate: { minRole: "ADMIN" },
		},
		{
			id: "connectors",
			label: "Connectors",
			description:
				"MCP, OAuth, and integration connectors: list, configure, connect, disconnect.",
			selectionGuidance:
				"Select for connecting accounts, OAuth, MCP tools/resources, connector status, setup, or disconnecting integrations.",
			covers: ["OAuth", "MCP", "integrations", "connector setup"],
			sensitivity: "private",
			cacheScope: "agent",
			roleGate: { minRole: "ADMIN" },
		},
		{
			id: "settings",
			label: "Settings",
			description:
				"Agent and user settings, capability toggles, identity, and AI provider config.",
			selectionGuidance:
				"Select for preferences, feature toggles, identity settings, provider configuration, or capability settings.",
			covers: ["preferences", "feature toggles", "identity", "provider config"],
			sensitivity: "private",
			cacheScope: "agent",
			roleGate: { minRole: "ADMIN" },
		},
		{
			id: "secrets",
			label: "Secrets",
			description: "Credentials, API keys, and session tokens.",
			selectionGuidance:
				"Select for storing, requesting, validating, or checking credentials, API keys, tokens, or secret setup.",
			covers: ["credentials", "API keys", "tokens", "secret setup"],
			sensitivity: "system",
			cacheScope: "none",
			roleGate: { minRole: "OWNER" },
		},
		{
			id: "admin",
			label: "Admin",
			description:
				"Role and system administration, plugin management, trust changes.",
			selectionGuidance:
				"Select for role changes, trust policy, plugin installation/removal, system administration, or privileged agent management.",
			covers: ["roles", "trust", "plugins", "system administration"],
			sensitivity: "system",
			cacheScope: "none",
			roleGate: { minRole: "OWNER" },
		},
		{
			id: "agent_internal",
			label: "Agent Internal",
			description:
				"Scratchpad, self-management, and internal autonomous tasks not intended for users.",
			selectionGuidance:
				"Select only for owner-visible agent self-management, scratchpad operations, trajectory annotation, or autonomous maintenance.",
			covers: ["scratchpad", "self-management", "trajectory annotation"],
			sensitivity: "system",
			cacheScope: "none",
			aliases: ["internal", "self"],
			roleGate: { minRole: "OWNER" },
		},
	]) satisfies readonly ContextDefinition[];

/**
 * Return the canonical default context registration, frozen so callers cannot
 * mutate the shared array. The order is stable and deterministic, which is
 * required for cache-stable Stage 1 prompt prefixes.
 */
export function getDefaultContextDefinitions(): readonly ContextDefinition[] {
	return DEFAULT_CONTEXT_DEFINITIONS;
}
