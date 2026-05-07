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
			sensitivity: "personal",
			cacheScope: "agent",
			roleGate: { minRole: "USER" },
		},
		{
			id: "knowledge",
			label: "Knowledge",
			description:
				"Compressed knowledge-base context for stored documents, uploaded files, learned notes, RAG search, and knowledge ingestion.",
			sensitivity: "personal",
			cacheScope: "agent",
			roleGate: { minRole: "USER" },
		},
		{
			id: "web",
			label: "Web",
			description: "Web search and reading public internet pages.",
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
			parent: "code",
			sensitivity: "private",
			cacheScope: "turn",
			roleGate: { minRole: "ADMIN" },
		},
		{
			id: "terminal",
			label: "Terminal",
			description: "Execute shell commands and inspect local processes.",
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
			sensitivity: "private",
			cacheScope: "turn",
			roleGate: { minRole: "ADMIN" },
		},
		{
			id: "calendar",
			label: "Calendar",
			description:
				"Check availability, view events, schedule meetings, manage invites.",
			sensitivity: "private",
			cacheScope: "turn",
			roleGate: { minRole: "ADMIN" },
		},
		{
			id: "contacts",
			label: "Contacts",
			description:
				"Look up, add, or update people in the user's contacts and relationship graph.",
			sensitivity: "private",
			cacheScope: "agent",
			roleGate: { minRole: "ADMIN" },
		},
		{
			id: "tasks",
			label: "Tasks",
			description:
				"Reminders, todos, goals, habits, and scheduled actions for the user.",
			sensitivity: "personal",
			cacheScope: "agent",
			roleGate: { minRole: "ADMIN" },
		},
		{
			id: "health",
			label: "Health",
			description: "Personal health metrics and wellness data.",
			sensitivity: "private",
			cacheScope: "turn",
			roleGate: { minRole: "OWNER" },
		},
		{
			id: "screen_time",
			label: "Screen Time",
			description: "Device, app, and screen-time controls and reporting.",
			sensitivity: "private",
			cacheScope: "turn",
			aliases: ["screen-time", "screentime"],
			roleGate: { minRole: "OWNER" },
		},
		{
			id: "subscriptions",
			label: "Subscriptions",
			description: "Recurring services, billing awareness, and renewals.",
			sensitivity: "private",
			cacheScope: "turn",
			roleGate: { minRole: "OWNER" },
		},
		{
			id: "finance",
			label: "Finance",
			description:
				"Money, balances, portfolio value, accounts, invoices, and financial overview questions.",
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
			sensitivity: "private",
			cacheScope: "turn",
			roleGate: { minRole: "ADMIN" },
		},
		{
			id: "phone",
			label: "Phone",
			description:
				"Phone-based messaging and voice calls (SMS, iMessage, RCS, dialing).",
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
			sensitivity: "personal",
			cacheScope: "turn",
			roleGate: { minRole: "USER" },
		},
		{
			id: "automation",
			label: "Automation",
			description:
				"Workflows, cron jobs, triggers, and scheduled agent automations.",
			sensitivity: "personal",
			cacheScope: "agent",
			roleGate: { minRole: "ADMIN" },
		},
		{
			id: "connectors",
			label: "Connectors",
			description:
				"MCP, OAuth, and integration connectors: list, configure, connect, disconnect.",
			sensitivity: "private",
			cacheScope: "agent",
			roleGate: { minRole: "ADMIN" },
		},
		{
			id: "settings",
			label: "Settings",
			description:
				"Agent and user settings, capability toggles, identity, and AI provider config.",
			sensitivity: "private",
			cacheScope: "agent",
			roleGate: { minRole: "ADMIN" },
		},
		{
			id: "secrets",
			label: "Secrets",
			description: "Credentials, API keys, and session tokens.",
			sensitivity: "system",
			cacheScope: "none",
			roleGate: { minRole: "OWNER" },
		},
		{
			id: "admin",
			label: "Admin",
			description:
				"Role and system administration, plugin management, trust changes.",
			sensitivity: "system",
			cacheScope: "none",
			roleGate: { minRole: "OWNER" },
		},
		{
			id: "agent_internal",
			label: "Agent Internal",
			description:
				"Scratchpad, self-management, and internal autonomous tasks not intended for users.",
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
