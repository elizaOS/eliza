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
				"Direct reply with no tools, no external data, and no other contexts. Pick this as the only context when the agent can answer from general context.",
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
			id: "documents",
			label: "Documents",
			description:
				"Read, write, edit, search, and list stored documents. Use whenever the user asks to save findings, notes, summaries, files, or any persisted text artifact, or to search and recall prior documents and uploaded files.",
			sensitivity: "personal",
			cacheScope: "agent",
			subcontexts: ["knowledge", "research"],
			roleGate: { minRole: "USER" },
		},
		{
			id: "knowledge",
			label: "Knowledge",
			description:
				"Stored knowledge, notes, facts, semantic recall, RAG, and memory-backed answers. Use for retrieve/answer-from-knowledge requests, not live web lookup.",
			parent: "documents",
			sensitivity: "personal",
			cacheScope: "agent",
			roleGate: { minRole: "USER" },
		},
		{
			id: "research",
			label: "Research",
			description:
				"Multi-step investigation, source gathering, synthesis, citations, and research artifacts. Use when the user asks to investigate, compare, produce findings, or save research.",
			parent: "documents",
			sensitivity: "personal",
			cacheScope: "conversation",
			roleGate: { minRole: "USER" },
		},
		{
			id: "web",
			label: "Web",
			description:
				"Live/current public internet lookup: search, open pages, read URLs, verify facts, prices, laws, news, docs, schedules, or anything likely to change.",
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
				"Admin-only local filesystem operations: read, write, list, attach raw files on disk. NOT for saving documents/notes/research — use the 'documents' context for that.",
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
				"Availability, events, meetings, appointments, invites, travel time, scheduling constraints, reschedules, and calendar-derived reminders.",
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
				"Personal-assistant action requests of any kind: any imperative ('remind me to…', 'set up a habit…', 'create a routine…', 'block apps when I work', 'every morning do X', 'twice a week', 'cancel that habit'), any habit/routine/reminder/alarm/goal/todo/recurring-task setup or change, any time-bound or recurring schedule the user owns, any 'every day / every week / on weekdays / at 9am / before bed / after lunch' framing, hygiene/health/exercise/medication/hydration routines, screen-time / app-block / focus rules, calendar event creation/move/cancel that the user explicitly asks for, follow-ups they want surfaced later, check-in cadence, status of their own todos and habits. Pick this whenever the user is asking the assistant to *do* something on their behalf (set, schedule, remind, cancel, complete, snooze, track) rather than chat or look up an external fact.",
			sensitivity: "personal",
			cacheScope: "agent",
			subcontexts: ["todos", "productivity"],
			roleGate: { minRole: "ADMIN" },
		},
		{
			id: "todos",
			label: "Todos",
			description:
				"Concrete task-list operations: create, list, update, complete, delete, prioritize, defer, or review todos and reminders.",
			parent: "tasks",
			sensitivity: "personal",
			cacheScope: "agent",
			roleGate: { minRole: "ADMIN" },
		},
		{
			id: "productivity",
			label: "Productivity",
			description:
				"Work planning and personal operations spanning tasks, calendar, documents, contacts, workflows, and prioritization.",
			parent: "tasks",
			sensitivity: "personal",
			cacheScope: "conversation",
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
				"Read, send, draft, search, triage, mute, follow, or manage private/group messages across Discord, Slack, Telegram, Signal, iMessage, WhatsApp, X DMs, and similar.",
			sensitivity: "private",
			cacheScope: "turn",
			subcontexts: ["phone", "social"],
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
			description:
				"Public social posts, feeds, replies, searches, timelines, and posting actions on platforms like X. Use messaging for DMs.",
			sensitivity: "private",
			cacheScope: "turn",
			aliases: ["social-posting", "posting"],
			roleGate: { minRole: "ADMIN" },
		},
		{
			id: "social",
			label: "Social",
			description:
				"Social platforms broadly: public feed/search/posting plus private DMs when platform-specific intent is ambiguous.",
			parents: ["messaging", "social_posting"],
			sensitivity: "private",
			cacheScope: "turn",
			aliases: ["social_media", "social-media"],
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
				"Automations, workflows, triggers, cron/heartbeat jobs, recurring runs, monitors, reminders that execute later, and proactive follow-up tasks.",
			sensitivity: "personal",
			cacheScope: "agent",
			roleGate: { minRole: "ADMIN" },
		},
		{
			id: "connectors",
			label: "Connectors",
			description:
				"MCP, OAuth, app integrations, connector accounts, scopes, auth state, connection repair, list/configure/connect/disconnect flows.",
			sensitivity: "private",
			cacheScope: "agent",
			roleGate: { minRole: "ADMIN" },
		},
		{
			id: "settings",
			label: "Settings",
			description:
				"Agent/user preferences, capability toggles, identity, profile, model/provider config, app settings, saved-login lookup, and non-secret configuration.",
			sensitivity: "private",
			cacheScope: "agent",
			subcontexts: ["character"],
			roleGate: { minRole: "ADMIN" },
		},
		{
			id: "character",
			label: "Character",
			description:
				"Agent personality, name, voice, style, system prompt, bio, behavior, and persistent character/profile edits.",
			parent: "settings",
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
				"Owner/admin-only control plane: roles, permissions, plugins, trust, policy, system configuration, and dangerous/private management actions.",
			sensitivity: "system",
			cacheScope: "none",
			subcontexts: ["system"],
			roleGate: { minRole: "OWNER" },
		},
		{
			id: "system",
			label: "System",
			description:
				"Runtime/system internals, diagnostics, process state, platform control, and owner-only operational commands.",
			parent: "admin",
			sensitivity: "system",
			cacheScope: "none",
			subcontexts: ["state", "world"],
			roleGate: { minRole: "OWNER" },
		},
		{
			id: "state",
			label: "State",
			description:
				"Current runtime, room, device, app, workflow, or game state inspection/mutation when the request is about state rather than user content.",
			parent: "system",
			sensitivity: "system",
			cacheScope: "turn",
			roleGate: { minRole: "ADMIN" },
		},
		{
			id: "world",
			label: "World",
			description:
				"World/server/room membership, environment topology, channels, participants, simulation state, and shared-world operations.",
			parent: "system",
			sensitivity: "private",
			cacheScope: "turn",
			subcontexts: ["game"],
			roleGate: { minRole: "ADMIN" },
		},
		{
			id: "game",
			label: "Game",
			description:
				"Game/session commands and game-state tools. Use only when there is an active game/simulation/world interaction or the user is controlling gameplay.",
			parent: "world",
			sensitivity: "personal",
			cacheScope: "turn",
			roleGate: { minRole: "USER" },
		},
		{
			id: "agent_internal",
			label: "Agent Internal",
			description:
				"Self-management and internal autonomous tasks not intended for users.",
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
