/**
 * Tree-shakeable client/public surface of `@elizaos/core` (#18056).
 *
 * The app Vite config aliases bare `@elizaos/core` to the prebuilt browser
 * blob (one ~2.4 MB file). Login-critical UI must import from this subpath
 * (or other pure subpaths) so Rolldown only ships the symbols it needs.
 *
 * Do not re-export modules that pull Node or the full runtime graph.
 */

export {
	ElizaError,
	isElizaError,
	type ElizaErrorOptions,
	type ElizaErrorSeverity,
	type ReportedError,
} from "./errors.ts";

export { isTruthyEnvValue } from "./env-utils.ts";

export { formatError } from "./utils/format-error.ts";

export {
	CANONICAL_ROLE_RANK,
	ROLE_RANK,
	hasAtLeastRole,
	isAdminRank,
	normalizeGateRole,
	roleRank,
	satisfiesRoleGate,
	type RoleGateRole,
	type RoleName,
	type SimpleRoleGate,
} from "./roles-rank.ts";

export {
	MESSAGE_SOURCE_AGENT_GREETING,
	MESSAGE_SOURCE_CLIENT_CHAT,
	MESSAGE_SOURCE_CODING_AGENT,
	MESSAGE_SOURCE_SUB_AGENT,
	MESSAGE_SOURCE_TRIGGER_PROMPT,
	MESSAGE_SOURCES,
	type MessageSourceSentinel,
} from "./types/message-source.ts";

export {
	LINKED_ACCOUNT_ACCOUNT_SOURCES,
	LINKED_ACCOUNT_HEALTH_STATES,
	LINKED_ACCOUNT_PROVIDER_IDS,
	LINKED_ACCOUNT_SOURCES,
	LINKED_ACCOUNT_STATUSES,
	SERVICE_ROUTE_ACCOUNT_STRATEGIES,
	type LinkedAccountAccountSource,
	type LinkedAccountHealth,
	type LinkedAccountProviderId,
	type LinkedAccountSource,
	type LinkedAccountStatus,
	type ServiceRouteAccountStrategy,
} from "./contracts/service-routing-types.ts";

export {
	isViewVisible,
	isViewKindEnabled,
	resolveViewKind,
	VIEW_KINDS,
	type EnabledViewKinds,
	type ViewKind,
	type ViewKindBearer,
} from "./types/view-kind.ts";

export {
	IMMERSIVE_WALLPAPER_SURFACE,
	SURFACE_CAPABILITIES,
	SURFACE_ISOLATION_LEVELS,
	resolveSurfaceBackgroundPolicy,
	resolveSurfaceManifest,
	surfaceGrants,
	type ResolvedSurfaceManifest,
	type SurfaceCapability,
	type SurfaceIsolationLevel,
	type SurfaceLifecyclePolicy,
	type SurfaceManifest,
	type SurfaceManifestBearer,
} from "./types/surface-manifest.ts";

export type {
	AppShellBackgroundPolicy,
	ViewHeaderPolicy,
	ViewModality,
	ViewType,
} from "./types/plugin.ts";

export { dedupeModalities } from "./types/plugin.ts";

export {
	DEFAULT_NOTIFICATION_CATEGORY,
	DEFAULT_NOTIFICATION_PRIORITY,
	DEFAULT_NOTIFICATION_SOURCE,
	tierForPriority,
	type AgentNotification,
	type NotificationCategory,
	type NotificationPriority,
	type NotificationTier,
} from "./types/notification.ts";

export {
	SHORTCUT_AMBIGUITY_EPSILON,
	SHORTCUT_CONFIDENCE_FLOOR,
	matchShortcut,
	normalizeForMatch,
} from "./runtime/shortcut-registry.ts";

export type {
	ShortcutDefinition,
	ShortcutKind,
	ShortcutMatch,
	ShortcutMatchContext,
	ShortcutPattern,
	ShortcutTarget,
} from "./types/shortcut.ts";

export {
	activityEventToPlaintext,
	type ActivityPlaintextOptions,
	type ActivityPlaintextSummary,
} from "./activity-plaintext.ts";

export {
	toSwarmActivity,
	type SwarmActivityEnvelope,
	type SwarmActivityPlanEntry,
	type SwarmActivityStatus,
	type SwarmActivityTool,
	type SwarmEvent,
} from "./types/swarm-coordinator.ts";
