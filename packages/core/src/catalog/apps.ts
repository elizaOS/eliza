/**
 * Shared app manager contracts.
 */

import type * as zod from "zod";
import type { IAgentRuntime } from "../types/runtime.js";
import type { ViewKind } from "../views/declarations.js";
import curatedAppDefinitions from "./curated-app-definitions.json" with {
	type: "json",
};
import type {
	appNpmSchema,
	appSessionSchema,
	appSupportsSchema,
} from "./schema.js";

const APP_ROUTE_SLUG_RE = /^[a-z0-9](?:[a-z0-9._-]{0,127})$/;
/** Accepts canonical app slugs used to select installed route modules. */
export function isValidAppRouteSlug(value: unknown): value is string {
	return (
		typeof value === "string" &&
		APP_ROUTE_SLUG_RE.test(value) &&
		value !== "." &&
		value !== ".."
	);
}

// Runtime-registered curated apps — keyed on a global Symbol so the same
// store is shared across @elizaos/core, @elizaos/app, and any plugin
// that wires in additional curated entries.

const ELIZA_CURATED_APP_REGISTRY_KEY = Symbol.for(
	"elizaos.curated-app-registry",
);
interface CuratedAppRegistryStore {
	entries: ElizaCuratedAppDefinition[];
}
function getCuratedAppRegistryStore(): CuratedAppRegistryStore {
	const globalObject = globalThis as Record<PropertyKey, unknown>;
	const existing = globalObject[ELIZA_CURATED_APP_REGISTRY_KEY] as
		| CuratedAppRegistryStore
		| null
		| undefined;
	if (existing) return existing;
	const created: CuratedAppRegistryStore = { entries: [] };
	globalObject[ELIZA_CURATED_APP_REGISTRY_KEY] = created;
	return created;
}
function registerCoreCuratedApp(def: ElizaCuratedAppDefinition): void {
	const store = getCuratedAppRegistryStore();
	const existing = store.entries.findIndex((d) => d.slug === def.slug);
	if (existing >= 0) {
		store.entries[existing] = def;
	} else {
		store.entries.push(def);
	}
}
export function getRegisteredCuratedApps(): ElizaCuratedAppDefinition[] {
	return [...getCuratedAppRegistryStore().entries];
}
export type AppSessionConfig = zod.infer<typeof appSessionSchema>;
export type AppSessionMode = AppSessionConfig["mode"];
export type AppSessionFeature = NonNullable<
	AppSessionConfig["features"]
>[number];
export type AppSessionControlAction = "pause" | "resume";
export type AppRunViewerAttachment = "attached" | "detached" | "unavailable";
export type AppRunHealthState = "healthy" | "degraded" | "offline";
export type AppRunCapabilityAvailability =
	| "available"
	| "unavailable"
	| "unknown";
export type AppRunEventKind =
	| "launch"
	| "refresh"
	| "attach"
	| "detach"
	| "stop"
	| "status"
	| "summary"
	| "health";
export type AppRunEventSeverity = "info" | "warning" | "error";
export type AppSessionJsonValue =
	| string
	| number
	| boolean
	| null
	| AppSessionJsonValue[]
	| {
			[key: string]: AppSessionJsonValue;
	  };
export interface AppViewerAuthMessage {
	type: string;
	authToken?: string;
	characterId?: string;
	sessionToken?: string;
	agentId?: string;
	followEntity?: string;
}
export interface AppSessionRecommendation {
	id: string;
	label: string;
	type?: string;
	reason?: string | null;
	priority?: number | null;
	command?: string | null;
}
export interface AppSessionActivityItem {
	id: string;
	type: string;
	message: string;
	timestamp?: number | null;
	severity?: "info" | "warning" | "error";
}
export interface AppViewerConfig {
	url: string;
	embedParams?: Record<string, string>;
	postMessageAuth?: boolean;
	sandbox?: string;
	authMessage?: AppViewerAuthMessage;
}
export interface AppUiExtensionConfig {
	detailPanelId: string;
}
export type RegistryAppSupports = zod.infer<typeof appSupportsSchema>;
export type RegistryAppNpmInfo = zod.infer<typeof appNpmSchema>;
export interface RegistryAppInfo {
	name: string;
	displayName: string;
	description: string;
	category: string;
	launchType: string;
	launchUrl: string | null;
	icon: string | null;
	/**
	 * Absolute or app-scoped URL to a large hero image (ideally a 1024×1024
	 * square webp) used as the card background on the apps page. Apps declare
	 * this in their `package.json` under `elizaos.app.heroImage` as a path
	 * relative to the package root; the runtime rewrites app hero requests
	 * through `/api/apps/hero/<slug>` and will synthesize generated artwork
	 * there when the app does not ship a dedicated hero asset.
	 */
	heroImage: string | null;
	capabilities: string[];
	stars: number;
	repository: string;
	latestVersion: string | null;
	supports: RegistryAppSupports;
	npm: RegistryAppNpmInfo;
	directory?: string | null;
	registryKind?: string;
	origin?: "builtin" | "third-party" | string;
	source?: string;
	support?: "first-party" | "community" | string;
	builtIn?: boolean;
	firstParty?: boolean;
	thirdParty?: boolean;
	status?: string;
	uiExtension?: AppUiExtensionConfig;
	viewer?: Omit<AppViewerConfig, "authMessage">;
	session?: AppSessionConfig;

	/** Four-tier visibility category; absent values default to release. */
	viewKind?: ViewKind;
	/**
	 * Controls whether the app appears in the user-facing app store/catalog.
	 * Defaults to true. Set to false for apps that auto-install or are surfaced
	 * only via direct deep-links.
	 */
	visibleInAppStore?: boolean;
	/**
	 * If true, the app declares itself as the default landing tab. Exactly one
	 * installed app should set this. Sourced from `package.json` →
	 * `elizaos.app.mainTab`. Consumed by `getMainTabApp()` in `@elizaos/ui`
	 * to compute the shell's landing tab at boot.
	 */
	mainTab?: boolean;
	/**
	 * Declared home section for the app catalog, sourced from `package.json` →
	 * `elizaos.app.catalogSection`. One of the concrete catalog sections
	 * (`games` | `developerUtilities` | `finance` | `other`). When absent, the
	 * section is derived from `category` and keyword heuristics. The dynamic
	 * `featured` / `favorites` sections are never declared here (they are
	 * computed from `featured` and the user's starred apps).
	 */
	catalogSection?: string;
	/**
	 * If true, the app is promoted into the Featured catalog section. Sourced
	 * from `elizaos.app.featured`. Featured is presentational only — it does not
	 * make an otherwise-hidden app appear.
	 */
	featured?: boolean;
	/**
	 * If true, the app is hidden from the catalog by default and only surfaces
	 * when explicitly configured as a default app, or — for `scope: "wallet"`
	 * apps — when the wallet is enabled. Sourced from `elizaos.app.defaultHidden`.
	 */
	defaultHidden?: boolean;
	/**
	 * Capability scope that gates default visibility. `"wallet"` apps are
	 * revealed when the wallet is enabled. Sourced from `elizaos.app.scope`.
	 */
	scope?: string;
}
export interface AppSessionState {
	sessionId: string;
	appName: string;
	mode: AppSessionMode;
	status: string;
	displayName?: string;
	agentId?: string;
	characterId?: string;
	followEntity?: string;
	canSendCommands?: boolean;
	controls?: AppSessionControlAction[];
	summary?: string | null;
	goalLabel?: string | null;
	suggestedPrompts?: string[];
	recommendations?: AppSessionRecommendation[];
	activity?: AppSessionActivityItem[];
	telemetry?: Record<string, AppSessionJsonValue> | null;
}
export interface AppSessionActionResult {
	success: boolean;
	message: string;
	session?: AppSessionState | null;
}
export interface AppRunHealth {
	state: AppRunHealthState;
	message: string | null;
}
export interface AppRunHealthFacet {
	state: AppRunHealthState | "unknown";
	message: string | null;
}
export interface AppRunHealthDetails {
	checkedAt: string | null;
	auth: AppRunHealthFacet;
	runtime: AppRunHealthFacet;
	viewer: AppRunHealthFacet;
	chat: AppRunHealthFacet;
	control: AppRunHealthFacet;
	message: string | null;
}
export interface AppRunEvent {
	eventId: string;
	kind: AppRunEventKind;
	severity: AppRunEventSeverity;
	message: string;
	createdAt: string;
	status?: string | null;
	details?: Record<string, AppSessionJsonValue> | null;
}
export interface AppRunAwaySummary {
	generatedAt: string;
	message: string;
	eventCount: number;
	since: string | null;
	until: string | null;
}
export interface AppRunSummary {
	runId: string;
	appName: string;
	displayName: string;
	pluginName: string;
	launchType: string;
	launchUrl: string | null;
	viewer: AppViewerConfig | null;
	session: AppSessionState | null;
	characterId: string | null;
	agentId: string | null;
	status: string;
	summary: string | null;
	startedAt: string;
	updatedAt: string;
	lastHeartbeatAt: string | null;
	supportsBackground: boolean;
	supportsViewerDetach: boolean;
	chatAvailability: AppRunCapabilityAvailability;
	controlAvailability: AppRunCapabilityAvailability;
	viewerAttachment: AppRunViewerAttachment;
	recentEvents: AppRunEvent[];
	awaySummary: AppRunAwaySummary | null;
	health: AppRunHealth;
	healthDetails: AppRunHealthDetails;
}
export interface AppRunActionResult {
	success: boolean;
	message: string;
	run?: AppRunSummary | null;
}
/**
 * Runtime service type for an optional host-provided app-run reader. Consumers (e.g. the agent's hosted-app session gate) query
 * `runtime.getService(APP_SESSION_SERVICE_TYPE)` instead of statically importing
 * the plugin, keeping the host→plugin dependency direction correct.
 */
export const APP_SESSION_SERVICE_TYPE = "app-session";
/**
 * Contract for the app-session runtime service. Exposes the current AppManager
 * run snapshot so gate logic can decide whether a hosted app is active without
 * reaching into the plugin's on-disk store directly.
 */
export interface AppSessionServiceLike {
	/** Current AppManager run snapshot (unfiltered; callers apply status logic). */
	getRuns(): AppRunSummary[];
}
export type AppLaunchDiagnosticSeverity = "info" | "warning" | "error";
export interface AppLaunchDiagnostic {
	code: string;
	severity: AppLaunchDiagnosticSeverity;
	message: string;
}
export interface AppLaunchPreparation {
	diagnostics?: AppLaunchDiagnostic[];
	launchUrl?: string | null;
	viewer?: Omit<AppViewerConfig, "authMessage"> | null;
	skipRuntimePluginRegistration?: boolean;
}
export interface AppLaunchResult {
	pluginInstalled: boolean;
	needsRestart: boolean;
	displayName: string;
	launchType: string;
	launchUrl: string | null;
	viewer: AppViewerConfig | null;
	session: AppSessionState | null;
	run: AppRunSummary | null;
	diagnostics?: AppLaunchDiagnostic[];
}
// ── App Session Contexts ──────────────────────────────────────────────────
/** Context available during app launch (before a run is started). */
export interface AppLaunchSessionContext {
	appName: string;
	launchUrl: string | null;
	runtime: IAgentRuntime | null;
	viewer: AppLaunchResult["viewer"] | null;
}
/** Context available during an active app run. */
export interface AppRunSessionContext extends AppLaunchSessionContext {
	runId?: string;
	session: AppSessionState | null;
}
export interface InstalledAppInfo {
	name: string;
	displayName: string;
	pluginName: string;
	version: string;
	installedAt: string;
}
export interface ElizaCuratedAppDefinition {
	slug: string;
	canonicalName: string;
	aliases: string[];
}
export interface AppStopResult {
	success: boolean;
	appName: string;
	runId: string | null;
	stoppedAt: string;
	pluginUninstalled: boolean;
	needsRestart: boolean;
	stopScope: "plugin-uninstalled" | "viewer-session" | "nothing-stopped";
	message: string;
}
function packageNameToBasename(packageName: string): string {
	return packageName
		.trim()
		.replace(/^@[^/]+\//, "")
		.trim();
}
// Materialized from the first-party registry. The curated-app set is derived at
// registry build time from each plugin's `registry-entry.json` `curatedApp`
// marker (slug + order + aliases) and emitted as a small, browser-safe JSON. To
// add/change a curated app, edit the owning plugin's registry-entry.json and run
// `bun run --cwd packages/core generate:first-party` — do NOT hand-edit this
// list. Registration is plugin-side; see packages/core/src/catalog/.
export const ELIZA_CURATED_APP_DEFINITIONS: readonly ElizaCuratedAppDefinition[] =
	curatedAppDefinitions;
function getElizaCuratedAppMatchKeys(
	definition: ElizaCuratedAppDefinition,
): string[] {
	const keys = new Set<string>([
		definition.slug.trim().toLowerCase(),
		definition.canonicalName.trim().toLowerCase(),
	]);
	for (const alias of definition.aliases) {
		const trimmed = alias.trim().toLowerCase();
		if (!trimmed) continue;
		keys.add(trimmed);
		const routeSlug = packageNameToAppRouteSlug(alias)?.trim().toLowerCase();
		if (routeSlug) {
			keys.add(routeSlug);
		}
	}
	const canonicalRouteSlug = packageNameToAppRouteSlug(definition.canonicalName)
		?.trim()
		.toLowerCase();
	if (canonicalRouteSlug) {
		keys.add(canonicalRouteSlug);
	}
	return Array.from(keys);
}
const ELIZA_CURATED_APP_DEFINITION_BY_KEY = new Map<
	string,
	ElizaCuratedAppDefinition
>(
	ELIZA_CURATED_APP_DEFINITIONS.flatMap((definition) =>
		getElizaCuratedAppMatchKeys(definition).map((key) => [key, definition]),
	),
);
export function packageNameToAppRouteSlug(packageName: string): string | null {
	const basename = packageNameToBasename(packageName);
	if (!basename) return null;
	const withoutPrefix = basename.replace(/^(app|plugin)-/, "").trim();
	return withoutPrefix || basename;
}
export function packageNameToAppDisplayName(packageName: string): string {
	const slug =
		packageNameToAppRouteSlug(packageName) ??
		packageNameToBasename(packageName);
	return slug
		.split(/[^a-zA-Z0-9]+/)
		.filter((part) => part.length > 0)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}
export function hasAppInterface(
	value:
		| {
				kind?: string | null;
				appMeta?: unknown;
		  }
		| null
		| undefined,
): boolean {
	return Boolean(value && (value.kind === "app" || value.appMeta));
}
export function getElizaCuratedAppDefinition(
	value: string,
): ElizaCuratedAppDefinition | null {
	const trimmed = value.trim();
	if (!trimmed) return null;
	// The registered-apps store is a Symbol.for global shared across every
	// loaded copy of this module, but the lookup map below is module-local and
	// only rebuilt by the copy that registerCuratedApp ran in. Fold the global
	// store in before every lookup so an app registered through one module
	// instance (e.g. a plugin's dist bundle) resolves from another (e.g. the
	// launcher's source instance) — otherwise launch fails with
	// "not found in the registry" for an app that IS registered.
	_rebuildCuratedAppLookup();
	const directMatch = ELIZA_CURATED_APP_DEFINITION_BY_KEY.get(
		trimmed.toLowerCase(),
	);
	if (directMatch) {
		return directMatch;
	}
	const routeSlug = packageNameToAppRouteSlug(trimmed)?.trim().toLowerCase();
	if (!routeSlug) {
		return null;
	}
	return ELIZA_CURATED_APP_DEFINITION_BY_KEY.get(routeSlug) ?? null;
}
export function normalizeElizaCuratedAppName(value: string): string | null {
	return getElizaCuratedAppDefinition(value)?.canonicalName ?? null;
}
export function isElizaCuratedAppName(value: string): boolean {
	return normalizeElizaCuratedAppName(value) !== null;
}

// Curated app registry — allows plugins to register additional curated app
// definitions at runtime without modifying the hardcoded list.

/**
 * Register an additional curated app definition at runtime.
 * Plugins should call this during initialization to add their app to the
 * curated catalog.
 */
export function registerCuratedApp(def: ElizaCuratedAppDefinition): void {
	registerCoreCuratedApp(def);
	// Rebuild the lookup map so runtime-registered apps are discoverable
	_rebuildCuratedAppLookup();
}
/**
 * Get all curated app definitions: hardcoded list merged with
 * runtime-registered apps. Runtime registrations with the same slug
 * override hardcoded entries.
 */
export function getCuratedAppDefinitions(): ElizaCuratedAppDefinition[] {
	const merged = new Map<string, ElizaCuratedAppDefinition>();
	for (const def of ELIZA_CURATED_APP_DEFINITIONS) {
		merged.set(def.slug, def);
	}
	for (const def of getRegisteredCuratedApps()) {
		merged.set(def.slug, def);
	}
	return Array.from(merged.values());
}
// The shared store entries this module copy last folded into its lookup map.
// Folding is skipped while the store holds the same definitions in the same
// order; any change (from this or another module copy) refolds every entry in
// store order, so the last registration of a key still wins.
let foldedCuratedApps: readonly ElizaCuratedAppDefinition[] = [];
function _rebuildCuratedAppLookup(): void {
	const entries = getCuratedAppRegistryStore().entries;
	if (
		entries.length === foldedCuratedApps.length &&
		entries.every((def, index) => def === foldedCuratedApps[index])
	) {
		return;
	}
	for (const def of entries) {
		for (const key of getElizaCuratedAppMatchKeys(def)) {
			ELIZA_CURATED_APP_DEFINITION_BY_KEY.set(key, def);
		}
	}
	foldedCuratedApps = [...entries];
}
export function getElizaCuratedAppCatalogOrder(value: string): number {
	const canonicalName = normalizeElizaCuratedAppName(value);
	if (!canonicalName) {
		return Number.MAX_SAFE_INTEGER;
	}
	const index = ELIZA_CURATED_APP_DEFINITIONS.findIndex(
		(definition) => definition.canonicalName === canonicalName,
	);
	return index >= 0 ? index : Number.MAX_SAFE_INTEGER;
}
