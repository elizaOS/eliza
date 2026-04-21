// Adapter: RegistryEntry -> the legacy `ManifestPluginEntry` shape that
// plugins-compat-routes.ts expects today.
//
// Drop-in replacement for `JSON.parse(fs.readFileSync(plugins.json))`.
// Lets the route swap data sources without rewriting the transformation
// pipeline. Once the route is ported to read RegistryEntry directly, this
// adapter and the legacy types should be deleted.

import type { ConfigField, RegistryEntry } from "./schema";

export interface LegacyManifestParameter {
  type: string;
  description: string;
  required: boolean;
  sensitive: boolean;
  default?: string;
  options?: string[];
}

export interface LegacyManifestEntry {
  id: string;
  dirName?: string;
  name: string;
  npmName?: string;
  description?: string;
  tags?: string[];
  category: string;
  envKey?: string | null;
  configKeys: string[];
  version?: string;
  pluginParameters: Record<string, LegacyManifestParameter>;
  icon?: string | null;
  homepage?: string;
  repository?: string;
  setupGuideUrl?: string;
}

export interface LegacyManifest {
  plugins: LegacyManifestEntry[];
}

const FIELD_TYPE_TO_LEGACY: Record<ConfigField["type"], string> = {
  string: "string",
  secret: "string",
  url: "string",
  "file-path": "string",
  textarea: "string",
  json: "string",
  select: "string",
  multiselect: "string",
  boolean: "boolean",
  number: "number",
};

const KIND_TO_LEGACY_CATEGORY = {
  app: "app",
  connector: "connector",
  plugin: "feature",
} as const;

function pluginSubtypeToCategory(entry: RegistryEntry): string {
  if (entry.kind !== "plugin") return KIND_TO_LEGACY_CATEGORY[entry.kind];
  if (entry.subtype === "ai-provider") return "ai-provider";
  if (entry.subtype === "database") return "database";
  return "feature";
}

function connectorSubtypeToCategory(entry: RegistryEntry): string {
  if (entry.kind !== "connector") return "connector";
  if (entry.subtype === "streaming") return "streaming";
  return "connector";
}

function categoryFor(entry: RegistryEntry): string {
  if (entry.kind === "plugin") return pluginSubtypeToCategory(entry);
  if (entry.kind === "connector") return connectorSubtypeToCategory(entry);
  return KIND_TO_LEGACY_CATEGORY[entry.kind];
}

function envKeyFor(entry: RegistryEntry): string | null {
  if (entry.kind === "connector" && entry.auth) {
    const [first] = entry.auth.credentialKeys;
    if (first) return first;
  }
  for (const [key, field] of Object.entries(entry.config)) {
    if (field.required && (field.type === "secret" || field.sensitive)) {
      return key;
    }
  }
  return null;
}

function fieldToLegacyParameter(
  field: ConfigField,
): LegacyManifestParameter {
  const param: LegacyManifestParameter = {
    type: FIELD_TYPE_TO_LEGACY[field.type],
    description: field.help ?? field.label ?? "",
    required: field.required,
    sensitive: field.sensitive ?? field.type === "secret",
  };
  if (field.default !== undefined && field.default !== null) {
    param.default = String(field.default);
  }
  if (field.options) {
    param.options = field.options.map((option) => option.value);
  }
  return param;
}

export function entryToLegacyManifestEntry(
  entry: RegistryEntry,
): LegacyManifestEntry {
  const pluginParameters: Record<string, LegacyManifestParameter> = {};
  for (const [key, field] of Object.entries(entry.config)) {
    pluginParameters[key] = fieldToLegacyParameter(field);
  }

  return {
    id: entry.id,
    dirName: entry.npmName?.replace(/^@[^/]+\//, ""),
    name: entry.name,
    npmName: entry.npmName,
    description: entry.description,
    tags: entry.tags,
    category: categoryFor(entry),
    envKey: envKeyFor(entry),
    configKeys: Object.keys(entry.config),
    version: entry.version,
    pluginParameters,
    icon: entry.render.icon ?? null,
    homepage: entry.resources.homepage,
    repository: entry.resources.repository,
    setupGuideUrl: entry.resources.setupGuideUrl,
  };
}

export function entriesToLegacyManifest(
  entries: RegistryEntry[],
): LegacyManifest {
  return { plugins: entries.map(entryToLegacyManifestEntry) };
}
