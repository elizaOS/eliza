/**
 * Agent-context taxonomy and gating types: the `FirstPartyAgentContext` union of
 * named capability contexts (memory, documents, messaging, finance, …), context
 * sensitivity/cache scopes, and the `RoleGate` / `ContextGate` shapes that decide
 * which contexts and providers apply to a given turn.
 */
import type { Role } from "./environment";
import type { JsonValue } from "./primitives";

export type FirstPartyAgentContext =
	| "simple"
	| "general"
	| "memory"
	| "documents"
	| "knowledge"
	| "research"
	| "web"
	| "browser"
	| "code"
	| "files"
	| "terminal"
	| "email"
	| "calendar"
	| "contacts"
	| "tasks"
	| "todos"
	| "productivity"
	| "health"
	| "screen_time"
	| "subscriptions"
	| "finance"
	| "payments"
	| "wallet"
	| "crypto"
	| "messaging"
	| "phone"
	| "social"
	| "social_posting"
	| "media"
	| "automation"
	| "connectors"
	| "settings"
	| "character"
	| "secrets"
	| "admin"
	| "system"
	| "state"
	| "world"
	| "game"
	| "agent_internal";

/**
 * Canonical domain contexts for routing and plugin/action gating.
 *
 * Plugins may still declare custom contexts while v5 first-party contexts are
 * adopted; the open string branch keeps `string & {}` so custom strings are
 * allowed without weakening literal-type inference.
 */
export type AgentContext = FirstPartyAgentContext | (string & {});

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

/**
 * Canonical role tiers for gate declarations (#9948). Spans both historical
 * vocabularies — the environment `Role` (OWNER/ADMIN/MEMBER/GUEST/NONE) plus the
 * `USER` alias of MEMBER. `normalizeGateRole` folds USER→MEMBER and uppercases at
 * runtime. The previous `(string & {})` escape — which let a gate name ANY
 * string and silently rank it 0 — is removed: a gate must name a real tier.
 */
export type RoleGateRole = Role | "USER";

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
	/**
	 * Optional short routing hint rendered in compact Stage-1 catalogs
	 * (DM and unaddressed group-triage tiers), where the full `description`
	 * is not rendered. One clause, ~80 chars max. Mirrors the
	 * `descriptionCompressed` convention actions and providers already use.
	 */
	descriptionCompressed?: string;
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
