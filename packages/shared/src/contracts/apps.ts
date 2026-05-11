/**
 * Shared app manager contracts.
 */

import {
  getRegisteredCuratedApps,
  type IAgentRuntime,
  registerCuratedApp as registerCoreCuratedApp,
} from "@elizaos/core";
import z from "zod";

export type AppSessionMode = "viewer" | "spectate-and-steer" | "external";

export type AppSessionFeature =
  | "commands"
  | "telemetry"
  | "pause"
  | "resume"
  | "suggestions";

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
  | { [key: string]: AppSessionJsonValue };

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

export interface AppSessionConfig {
  mode: AppSessionMode;
  features?: AppSessionFeature[];
}

export interface AppUiExtensionConfig {
  detailPanelId: string;
}

export interface RegistryAppSupports {
  v0: boolean;
  v1: boolean;
  v2: boolean;
}

export interface RegistryAppNpmInfo {
  package: string;
  v0Version: string | null;
  v1Version: string | null;
  v2Version: string | null;
}

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
  /**
   * If true, the app is a developer-tooling surface and is hidden from the
   * main UI unless Developer Mode is enabled in Settings.
   * TODO: server-side population pending
   */
  developerOnly?: boolean;
  /**
   * Controls whether the app appears in the user-facing app store/catalog.
   * Defaults to true. Set to false for apps that auto-install or are surfaced
   * only via direct deep-links.
   * TODO: server-side population pending
   */
  visibleInAppStore?: boolean;
  /**
   * If true, the app declares itself as the default landing tab. Exactly one
   * installed app should set this. Sourced from `package.json` →
   * `elizaos.app.mainTab`. Consumed by `getMainTabApp()` in `@elizaos/app-core`
   * to compute the shell's landing tab at boot.
   */
  mainTab?: boolean;
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
  stopScope: "plugin-uninstalled" | "viewer-session" | "no-op";
  message: string;
}

// ─── Zod response-tree schemas ───────────────────────────────────────────────
//
// Mirror the TS interfaces above so handlers in `packages/agent/src/api/` can
// validate / type their wire output. Schemas are co-located with the
// interfaces they mirror; bidirectional `extends` checks at the bottom of
// this section assert structural equivalence at compile time so drift in
// either direction breaks the build.
//
// Recursive `AppSessionJsonValueSchema` uses `z.lazy()`. Where the original
// interface declared `?: T` for an optional field, the schema uses
// `.optional()` (TypeScript treats `?: T` and `T | undefined` as equivalent
// for structural typing). Where the interface declared `T | null`, the
// schema uses `z.union([..., z.null()])` rather than `.nullable()` (zod 4
// inference quirk noted in the project memory).

const AppSessionModeEnum = z.enum(["viewer", "spectate-and-steer", "external"]);
const AppSessionControlActionEnum = z.enum(["pause", "resume"]);
const AppRunViewerAttachmentEnum = z.enum([
  "attached",
  "detached",
  "unavailable",
]);
const AppRunHealthStateEnum = z.union([
  z.literal("healthy"),
  z.literal("degraded"),
  z.literal("offline"),
]);
const AppRunCapabilityAvailabilityEnum = z.enum([
  "available",
  "unavailable",
  "unknown",
]);
const AppRunEventKindEnum = z.enum([
  "launch",
  "refresh",
  "attach",
  "detach",
  "stop",
  "status",
  "summary",
  "health",
]);
const AppRunEventSeverityEnum = z.enum(["info", "warning", "error"]);
const AppLaunchDiagnosticSeverityEnum = z.enum(["info", "warning", "error"]);
const AppSessionActivitySeverityEnum = z.enum(["info", "warning", "error"]);
const AppRunHealthFacetStateEnum = z.enum([
  "healthy",
  "degraded",
  "offline",
  "unknown",
]);

export const AppSessionJsonValueSchema: z.ZodType<AppSessionJsonValue> = z.lazy(
  () =>
    z.union([
      z.string(),
      z.number(),
      z.boolean(),
      z.null(),
      z.array(AppSessionJsonValueSchema),
      z.record(z.string(), AppSessionJsonValueSchema),
    ]),
);

export const AppViewerAuthMessageSchema = z.object({
  type: z.string(),
  authToken: z.string().optional(),
  characterId: z.string().optional(),
  sessionToken: z.string().optional(),
  agentId: z.string().optional(),
  followEntity: z.string().optional(),
});

export const AppViewerConfigSchema = z.object({
  url: z.string(),
  embedParams: z.record(z.string(), z.string()).optional(),
  postMessageAuth: z.boolean().optional(),
  sandbox: z.string().optional(),
  authMessage: AppViewerAuthMessageSchema.optional(),
});

export const AppSessionRecommendationSchema = z.object({
  id: z.string(),
  label: z.string(),
  type: z.string().optional(),
  reason: z.union([z.string(), z.null()]).optional(),
  priority: z.union([z.number(), z.null()]).optional(),
  command: z.union([z.string(), z.null()]).optional(),
});

export const AppSessionActivityItemSchema = z.object({
  id: z.string(),
  type: z.string(),
  message: z.string(),
  timestamp: z.union([z.number(), z.null()]).optional(),
  severity: AppSessionActivitySeverityEnum.optional(),
});

export const AppSessionStateSchema = z.object({
  sessionId: z.string(),
  appName: z.string(),
  mode: AppSessionModeEnum,
  status: z.string(),
  displayName: z.string().optional(),
  agentId: z.string().optional(),
  characterId: z.string().optional(),
  followEntity: z.string().optional(),
  canSendCommands: z.boolean().optional(),
  controls: z.array(AppSessionControlActionEnum).optional(),
  summary: z.union([z.string(), z.null()]).optional(),
  goalLabel: z.union([z.string(), z.null()]).optional(),
  suggestedPrompts: z.array(z.string()).optional(),
  recommendations: z.array(AppSessionRecommendationSchema).optional(),
  activity: z.array(AppSessionActivityItemSchema).optional(),
  telemetry: z
    .union([z.record(z.string(), AppSessionJsonValueSchema), z.null()])
    .optional(),
});

export const AppRunHealthSchema = z.object({
  state: AppRunHealthStateEnum,
  message: z.union([z.string(), z.null()]),
});

export const AppRunHealthFacetSchema = z.object({
  state: AppRunHealthFacetStateEnum,
  message: z.union([z.string(), z.null()]),
});

export const AppRunHealthDetailsSchema = z.object({
  checkedAt: z.union([z.string(), z.null()]),
  auth: AppRunHealthFacetSchema,
  runtime: AppRunHealthFacetSchema,
  viewer: AppRunHealthFacetSchema,
  chat: AppRunHealthFacetSchema,
  control: AppRunHealthFacetSchema,
  message: z.union([z.string(), z.null()]),
});

export const AppRunEventSchema = z.object({
  eventId: z.string(),
  kind: AppRunEventKindEnum,
  severity: AppRunEventSeverityEnum,
  message: z.string(),
  createdAt: z.string(),
  status: z.union([z.string(), z.null()]).optional(),
  details: z
    .union([z.record(z.string(), AppSessionJsonValueSchema), z.null()])
    .optional(),
});

export const AppRunAwaySummarySchema = z.object({
  generatedAt: z.string(),
  message: z.string(),
  eventCount: z.number(),
  since: z.union([z.string(), z.null()]),
  until: z.union([z.string(), z.null()]),
});

export const AppRunSummarySchema = z.object({
  runId: z.string(),
  appName: z.string(),
  displayName: z.string(),
  pluginName: z.string(),
  launchType: z.string(),
  launchUrl: z.union([z.string(), z.null()]),
  viewer: z.union([AppViewerConfigSchema, z.null()]),
  session: z.union([AppSessionStateSchema, z.null()]),
  characterId: z.union([z.string(), z.null()]),
  agentId: z.union([z.string(), z.null()]),
  status: z.string(),
  summary: z.union([z.string(), z.null()]),
  startedAt: z.string(),
  updatedAt: z.string(),
  lastHeartbeatAt: z.union([z.string(), z.null()]),
  supportsBackground: z.boolean(),
  supportsViewerDetach: z.boolean(),
  chatAvailability: AppRunCapabilityAvailabilityEnum,
  controlAvailability: AppRunCapabilityAvailabilityEnum,
  viewerAttachment: AppRunViewerAttachmentEnum,
  recentEvents: z.array(AppRunEventSchema),
  awaySummary: z.union([AppRunAwaySummarySchema, z.null()]),
  health: AppRunHealthSchema,
  healthDetails: AppRunHealthDetailsSchema,
});

export const AppLaunchDiagnosticSchema = z.object({
  code: z.string(),
  severity: AppLaunchDiagnosticSeverityEnum,
  message: z.string(),
});

export const AppLaunchResultSchema = z.object({
  pluginInstalled: z.boolean(),
  needsRestart: z.boolean(),
  displayName: z.string(),
  launchType: z.string(),
  launchUrl: z.union([z.string(), z.null()]),
  viewer: z.union([AppViewerConfigSchema, z.null()]),
  session: z.union([AppSessionStateSchema, z.null()]),
  run: z.union([AppRunSummarySchema, z.null()]),
  diagnostics: z.array(AppLaunchDiagnosticSchema).optional(),
});

export const AppStopResultSchema = z.object({
  success: z.boolean(),
  appName: z.string(),
  runId: z.union([z.string(), z.null()]),
  stoppedAt: z.string(),
  pluginUninstalled: z.boolean(),
  needsRestart: z.boolean(),
  stopScope: z.union([
    z.literal("plugin-uninstalled"),
    z.literal("viewer-session"),
    z.literal("no-op"),
  ]),
  message: z.string(),
});

/**
 * /relaunch returns `{ launch, verify }` — `launch` is an AppLaunchResult,
 * `verify` is the verdict from `AppVerificationService.verifyApp` (or null
 * if the caller did not request post-launch verification).
 */
export const AppVerifyResultSchema = z.object({
  verdict: z.string(),
  retryablePromptForChild: z.string().optional(),
});

export const PostRelaunchAppResponseSchema = z.object({
  launch: AppLaunchResultSchema,
  verify: z.union([AppVerifyResultSchema, z.null()]),
});

// ─── Compile-time alignment checks ───────────────────────────────────────────
//
// These constants typecheck iff every valid value of the hand-written
// interface is also a valid value of the zod schema. They never run; they
// exist purely to fail the build if the interface is widened (e.g. an
// interface field added that the schema doesn't model).
//
// They intentionally do NOT enforce the reverse direction (schema ⊆
// interface). zod's inferred types are sometimes structurally wider than
// the equivalent hand-written interface (e.g. union ordering, literal-vs-
// string narrowing in `z.enum`). For response validation that's fine —
// the schema is the wire contract; any handler returning a valid interface
// value will satisfy it.

type _AssertInterfaceFitsSchema<Interface, Inferred> = [Interface] extends [
  Inferred,
]
  ? true
  : false;

const _alignAppViewerAuthMessage: _AssertInterfaceFitsSchema<
  AppViewerAuthMessage,
  z.infer<typeof AppViewerAuthMessageSchema>
> = true;
const _alignAppViewerConfig: _AssertInterfaceFitsSchema<
  AppViewerConfig,
  z.infer<typeof AppViewerConfigSchema>
> = true;
const _alignAppSessionRecommendation: _AssertInterfaceFitsSchema<
  AppSessionRecommendation,
  z.infer<typeof AppSessionRecommendationSchema>
> = true;
const _alignAppSessionActivityItem: _AssertInterfaceFitsSchema<
  AppSessionActivityItem,
  z.infer<typeof AppSessionActivityItemSchema>
> = true;
const _alignAppSessionState: _AssertInterfaceFitsSchema<
  AppSessionState,
  z.infer<typeof AppSessionStateSchema>
> = true;
const _alignAppRunHealth: _AssertInterfaceFitsSchema<
  AppRunHealth,
  z.infer<typeof AppRunHealthSchema>
> = true;
const _alignAppRunHealthFacet: _AssertInterfaceFitsSchema<
  AppRunHealthFacet,
  z.infer<typeof AppRunHealthFacetSchema>
> = true;
const _alignAppRunHealthDetails: _AssertInterfaceFitsSchema<
  AppRunHealthDetails,
  z.infer<typeof AppRunHealthDetailsSchema>
> = true;
const _alignAppRunEvent: _AssertInterfaceFitsSchema<
  AppRunEvent,
  z.infer<typeof AppRunEventSchema>
> = true;
const _alignAppRunAwaySummary: _AssertInterfaceFitsSchema<
  AppRunAwaySummary,
  z.infer<typeof AppRunAwaySummarySchema>
> = true;
const _alignAppRunSummary: _AssertInterfaceFitsSchema<
  AppRunSummary,
  z.infer<typeof AppRunSummarySchema>
> = true;
const _alignAppLaunchDiagnostic: _AssertInterfaceFitsSchema<
  AppLaunchDiagnostic,
  z.infer<typeof AppLaunchDiagnosticSchema>
> = true;
const _alignAppLaunchResult: _AssertInterfaceFitsSchema<
  AppLaunchResult,
  z.infer<typeof AppLaunchResultSchema>
> = true;
const _alignAppStopResult: _AssertInterfaceFitsSchema<
  AppStopResult,
  z.infer<typeof AppStopResultSchema>
> = true;

export type PostRelaunchAppResponse = z.infer<
  typeof PostRelaunchAppResponseSchema
>;
export type AppVerifyResult = z.infer<typeof AppVerifyResultSchema>;

function packageNameToBasename(packageName: string): string {
  return packageName
    .trim()
    .replace(/^@[^/]+\//, "")
    .trim();
}

export const ELIZA_CURATED_APP_DEFINITIONS: readonly ElizaCuratedAppDefinition[] =
  [
    {
      slug: "companion",
      canonicalName: "@elizaos/app-companion",
      aliases: [],
    },
    {
      slug: "contacts",
      canonicalName: "@elizaos/app-contacts",
      aliases: [],
    },
    {
      slug: "phone",
      canonicalName: "@elizaos/app-phone",
      aliases: [],
    },
    {
      slug: "wifi",
      canonicalName: "@elizaos/app-wifi",
      aliases: [],
    },
    {
      slug: "hyperscape",
      canonicalName: "@hyperscape/plugin-hyperscape",
      aliases: ["@elizaos/app-hyperscape"],
    },
    {
      slug: "babylon",
      canonicalName: "@elizaos/app-babylon",
      aliases: [],
    },
    {
      slug: "2004scape",
      canonicalName: "@elizaos/app-2004scape",
      aliases: [],
    },
    {
      slug: "scape",
      canonicalName: "@elizaos/app-scape",
      aliases: [],
    },
    {
      slug: "defense-of-the-agents",
      canonicalName: "@elizaos/app-defense-of-the-agents",
      aliases: [],
    },
    {
      slug: "vincent",
      canonicalName: "@elizaos/app-vincent",
      aliases: [],
    },
    {
      slug: "hyperliquid",
      canonicalName: "@elizaos/app-hyperliquid",
      aliases: [],
    },
    {
      slug: "polymarket",
      canonicalName: "@elizaos/app-polymarket",
      aliases: [],
    },
    {
      slug: "shopify",
      canonicalName: "@elizaos/app-shopify",
      aliases: ["@elizaos/plugin-shopify"],
    },
    {
      slug: "screenshare",
      canonicalName: "@elizaos/app-screenshare",
      aliases: [],
    },
    {
      slug: "clawville",
      canonicalName: "@elizaos/app-clawville",
      aliases: [],
    },
    {
      slug: "trajectory-logger",
      canonicalName: "@elizaos/app-trajectory-logger",
      aliases: [],
    },
  ] as const;

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
    packageNameToBasename(packageName) ??
    packageName.trim();

  return slug
    .split(/[^a-zA-Z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function hasAppInterface(
  value: { kind?: string | null; appMeta?: unknown } | null | undefined,
): boolean {
  return Boolean(value && (value.kind === "app" || value.appMeta));
}

export function getElizaCuratedAppDefinition(
  value: string,
): ElizaCuratedAppDefinition | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

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

// ---------------------------------------------------------------------------
// Curated app registry — allows plugins to register additional curated app
// definitions at runtime without modifying the hardcoded list.
// ---------------------------------------------------------------------------

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

function _rebuildCuratedAppLookup(): void {
  // Add registered apps to the mutable lookup map
  for (const def of getRegisteredCuratedApps()) {
    for (const key of getElizaCuratedAppMatchKeys(def)) {
      ELIZA_CURATED_APP_DEFINITION_BY_KEY.set(key, def);
    }
  }
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

export function getElizaCuratedAppLookupNames(value: string): string[] {
  const definition = getElizaCuratedAppDefinition(value);
  if (!definition) {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }

  return Array.from(
    new Set([
      definition.canonicalName,
      ...definition.aliases,
      definition.slug,
      ...definition.aliases
        .map((alias) => packageNameToAppRouteSlug(alias))
        .filter((alias): alias is string => Boolean(alias)),
      packageNameToAppRouteSlug(definition.canonicalName) ?? definition.slug,
    ]),
  );
}
