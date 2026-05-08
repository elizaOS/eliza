// Registry SoT for apps, plugins, and connectors.
//
// Replaces the fragmented surface of:
//   - plugins.json (97 entries, 5 categories)
//   - PluginInfo (api/client-types-config.ts)
//   - ConfigUiHint (types/index.ts)
//   - RegistryAppInfo (shared/contracts/apps.ts)
//   - VISIBLE_CONNECTOR_IDS / DEFAULT_ICONS / FEATURE_SUBGROUP / SUBGROUP_DISPLAY_ORDER
//     (components/pages/plugin-list-utils.ts)
//   - paramsToSchema() heuristics (PORT/TIMEOUT/MODEL guessing)
//
// Static registry only. Runtime overlay (enabled, configured, isActive,
// validationErrors) lives in RegistryRuntimeOverlay and is merged at API read
// time — never in the registry files themselves.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Config field schema — replaces PluginParamDef + ConfigUiHint.
// One field, one place. UI hints are co-located with type info.
// ---------------------------------------------------------------------------

const configFieldType = z.enum([
  "string",
  "secret",
  "boolean",
  "number",
  "select",
  "multiselect",
  "json",
  "textarea",
  "url",
  "file-path",
]);

const configFieldOption = z.object({
  value: z.string(),
  label: z.string(),
  description: z.string().optional(),
  icon: z.string().optional(),
  disabled: z.boolean().optional(),
});

const visibilityCondition: z.ZodType<{
  key: string;
  equals?: unknown;
  in?: unknown[];
  notEquals?: unknown;
}> = z.object({
  key: z.string(),
  equals: z.unknown().optional(),
  in: z.array(z.unknown()).optional(),
  notEquals: z.unknown().optional(),
});

export const configFieldSchema = z.object({
  type: configFieldType,
  required: z.boolean(),
  sensitive: z.boolean().optional(),
  default: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),

  label: z.string().optional(),
  help: z.string().optional(),
  placeholder: z.string().optional(),
  group: z.string().optional(),
  order: z.number().int().optional(),
  width: z.enum(["full", "half", "third"]).optional(),
  advanced: z.boolean().optional(),
  hidden: z.boolean().optional(),
  readonly: z.boolean().optional(),
  icon: z.string().optional(),

  options: z.array(configFieldOption).optional(),
  pattern: z.string().optional(),
  patternError: z.string().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  unit: z.string().optional(),

  visible: visibilityCondition.optional(),
});

export type ConfigField = z.infer<typeof configFieldSchema>;

// ---------------------------------------------------------------------------
// Render hints — replaces VISIBLE_CONNECTOR_IDS / DEFAULT_ICONS /
// FEATURE_SUBGROUP / SUBGROUP_DISPLAY_ORDER.
//
// Surface mapping is implicit:
//   kind: "connector" → ConnectorsView (primary)
//   kind: "app"       → AppsView       (primary)
//   kind: "plugin"    → PluginsView    (primary)
// Every entry shows in its primary surface unless `visible: false`.
//
// Use `pinTo` to ALSO surface an item somewhere it wouldn't appear by default
// (e.g. promoting an app into the chat quick-launcher). Opt-in only — keeps
// the common case zero-config.
// ---------------------------------------------------------------------------

const renderActionSchema = z.enum([
  "enable",
  "configure",
  "launch",
  "attach",
  "detach",
  "stop",
  "uninstall",
  "install",
  "setup-guide",
]);

const secondarySurfaceSchema = z.enum([
  "chat-apps-section",
  "companion-shell",
  "settings-integrations",
]);

export const renderSchema = z.object({
  visible: z.boolean().default(true),
  pinTo: z.array(secondarySurfaceSchema).default([]),

  style: z.enum(["card", "setup-panel", "hero-card"]).default("card"),
  icon: z.string().optional(),
  heroImage: z.string().optional(),

  group: z.string(),
  groupOrder: z.number().int().optional(),

  actions: z.array(renderActionSchema).default([]),
});

export type RenderHints = z.infer<typeof renderSchema>;
export type SecondarySurface = z.infer<typeof secondarySurfaceSchema>;

// ---------------------------------------------------------------------------
// External resources (already in plugins.json today).
// ---------------------------------------------------------------------------

export const resourcesSchema = z.object({
  homepage: z.string().url().optional(),
  repository: z.string().url().optional(),
  setupGuideUrl: z.string().url().optional(),
});

export type Resources = z.infer<typeof resourcesSchema>;

// ---------------------------------------------------------------------------
// App-only: launch + viewer + session (mirrors RegistryAppInfo).
// ---------------------------------------------------------------------------

const appViewerSchema = z.object({
  url: z.string(),
  embedParams: z.record(z.string(), z.string()).optional(),
  postMessageAuth: z.boolean().optional(),
  sandbox: z.string().optional(),
});

const appSessionSchema = z.object({
  mode: z.enum(["viewer", "spectate-and-steer", "external"]),
  features: z
    .array(z.enum(["commands", "telemetry", "pause", "resume", "suggestions"]))
    .optional(),
});

const appSupportsSchema = z.object({
  v0: z.boolean(),
  v1: z.boolean(),
  v2: z.boolean(),
});

const appNpmSchema = z.object({
  package: z.string(),
  v0Version: z.string().nullable(),
  v1Version: z.string().nullable(),
  v2Version: z.string().nullable(),
});

const packageRoutePluginSpecifierSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.startsWith(".") &&
      !value.startsWith("/") &&
      !/(^|\/)(apps|plugins)\//.test(value),
    "routePlugin.specifier must be a package specifier, not a filesystem path",
  );

const appRoutePluginSchema = z.object({
  specifier: packageRoutePluginSpecifierSchema,
  exportName: z.string().min(1).optional(),
});

export const appLaunchSchema = z.object({
  type: z.enum(["internal-tab", "overlay", "server-launch"]),
  target: z.string().optional(),
  url: z.string().nullable().optional(),
  viewer: appViewerSchema.optional(),
  session: appSessionSchema.optional(),
  supports: appSupportsSchema.optional(),
  npm: appNpmSchema.optional(),
  capabilities: z.array(z.string()).default([]),
  uiExtension: z.object({ detailPanelId: z.string() }).optional(),
  curatedSlug: z.string().optional(),
  routePlugin: appRoutePluginSchema.optional(),
  /**
   * If true, the app declares itself as the default landing tab.
   * Mirrors `package.json#elizaos.app.mainTab`. Consumed by
   * `getMainTabApp()` in this package to compute the shell's landing
   * tab. Exactly one installed app should set this; multiple declarers
   * are resolved deterministically by alphabetic id.
   */
  mainTab: z.boolean().optional(),
});

export type AppLaunch = z.infer<typeof appLaunchSchema>;

// ---------------------------------------------------------------------------
// Common fields shared by every entry.
// ---------------------------------------------------------------------------

const commonFields = {
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "id must be kebab-case ascii"),
  name: z.string().min(1),
  description: z.string().optional(),
  npmName: z.string().optional(),
  version: z.string().optional(),
  releaseStream: z.enum(["latest", "beta"]).optional(),
  source: z.enum(["bundled", "store"]).default("bundled"),
  tags: z.array(z.string()).default([]),
  config: z.record(z.string(), configFieldSchema).default({}),
  render: renderSchema,
  resources: resourcesSchema.default({}),
  dependsOn: z.array(z.string()).default([]),
} as const;

// ---------------------------------------------------------------------------
// Discriminated union — three kinds, each with their own constraints.
// ---------------------------------------------------------------------------

const pluginSubtype = z.enum([
  "ai-provider",
  "feature",
  "database",
  "voice",
  "knowledge",
  "blockchain",
  "media",
  "agents",
  "automation",
  "storage",
  "gaming",
  "devtools",
  "other",
]);

const connectorSubtype = z.enum([
  "messaging",
  "social",
  "streaming",
  "email",
  "calendar",
  "other",
]);

export const pluginEntrySchema = z.object({
  ...commonFields,
  kind: z.literal("plugin"),
  subtype: pluginSubtype,
});

export const connectorEntrySchema = z.object({
  ...commonFields,
  kind: z.literal("connector"),
  subtype: connectorSubtype,
  auth: z
    .object({
      kind: z.enum(["token", "oauth", "credentials", "none"]),
      credentialKeys: z.array(z.string()).default([]),
    })
    .optional(),
});

export const appEntrySchema = z.object({
  ...commonFields,
  kind: z.literal("app"),
  subtype: z.enum(["game", "tool", "shell", "marketplace", "trading", "other"]),
  launch: appLaunchSchema,
});

export const registryEntrySchema = z.discriminatedUnion("kind", [
  pluginEntrySchema,
  connectorEntrySchema,
  appEntrySchema,
]);

export type PluginEntry = z.infer<typeof pluginEntrySchema>;
export type ConnectorEntry = z.infer<typeof connectorEntrySchema>;
export type AppEntry = z.infer<typeof appEntrySchema>;
export type RegistryEntry = z.infer<typeof registryEntrySchema>;
export type RegistryKind = RegistryEntry["kind"];

// ---------------------------------------------------------------------------
// Runtime overlay — never in registry files. Merged at API read time.
// ---------------------------------------------------------------------------

export const registryRuntimeOverlaySchema = z.object({
  id: z.string(),
  enabled: z.boolean(),
  configured: z.boolean(),
  isActive: z.boolean(),
  loadError: z.string().optional(),
  validationErrors: z
    .array(z.object({ field: z.string(), message: z.string() }))
    .default([]),
  validationWarnings: z
    .array(z.object({ field: z.string(), message: z.string() }))
    .default([]),
  installedVersion: z.string().optional(),
  latestVersion: z.string().nullable().optional(),
});

export type RegistryRuntimeOverlay = z.infer<
  typeof registryRuntimeOverlaySchema
>;

// ---------------------------------------------------------------------------
// Combined view — what the API hands to the UI.
// ---------------------------------------------------------------------------

export type RegistryView = RegistryEntry & RegistryRuntimeOverlay;
