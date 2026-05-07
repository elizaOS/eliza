import type { Role } from "./environment";
import type { JsonValue } from "./proto.js";

export type FirstPartyAgentContext =
	| "simple"
	| "general"
	| "memory"
	| "knowledge"
	| "web"
	| "browser"
	| "code"
	| "files"
	| "terminal"
	| "email"
	| "calendar"
	| "contacts"
	| "tasks"
	| "health"
	| "screen_time"
	| "subscriptions"
	| "finance"
	| "payments"
	| "wallet"
	| "crypto"
	| "messaging"
	| "social_posting"
	| "media"
	| "automation"
	| "connectors"
	| "settings"
	| "secrets"
	| "admin"
	| "agent_internal";

export type LegacyAgentContext = "social" | "system" | "lifeops";

/**
 * Canonical domain contexts for routing and plugin/action gating.
 *
 * Plugins may still declare custom contexts while v5 first-party contexts are
 * adopted. Legacy values remain accepted for compatibility.
 */
export type AgentContext =
	| FirstPartyAgentContext
	| LegacyAgentContext
	| (string & {});

export type ContextSensitivity = "public" | "personal" | "private" | "system";

export type CacheScope =
	| "global"
	| "agent"
	| "conversation"
	| "room"
	| "entity"
	| "turn"
	| "none"
	| (string & {});

export type RoleGateRole = Role | "USER" | (string & {});

export interface RoleGate {
	/** Any one of these roles may pass. */
	roles?: RoleGateRole[];
	/** Alias for roles, useful for declarative gate objects. */
	anyOf?: RoleGateRole[];
	/** All listed roles must be present. */
	allOf?: RoleGateRole[];
	/** Any listed role denies access. */
	noneOf?: RoleGateRole[];
	/** Caller must have at least this role by rank. */
	minRole?: RoleGateRole;
}

export interface ContextGate {
	/** Backward-compatible shorthand: any listed context may pass. */
	contexts?: AgentContext[];
	/** Any one of these contexts may pass. */
	anyOf?: AgentContext[];
	/** All listed contexts must be active. */
	allOf?: AgentContext[];
	/** Any listed active context denies access. */
	noneOf?: AgentContext[];
	/** Optional role requirements layered on top of context matching. */
	roleGate?: RoleGate;
}

export interface ContextDefinition {
	id: AgentContext;
	label?: string;
	description?: string;
	/** Stage 1 routing guidance: when the messageHandler should select this context. */
	selectionGuidance?: string;
	/** Compact coverage terms shown to the messageHandler and trajectory viewer. */
	covers?: string[];
	parent?: AgentContext;
	parents?: AgentContext[];
	subcontexts?: AgentContext[];
	aliases?: string[];
	sensitivity?: ContextSensitivity;
	cacheStable?: boolean;
	cacheScope?: CacheScope;
	roleGate?: RoleGate;
	metadata?: Record<string, JsonValue | undefined>;
}
