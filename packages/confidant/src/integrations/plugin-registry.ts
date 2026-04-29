import { defineSecretSchema } from "../secret-schema.js";
import type { SecretId, SecretSchemaEntry } from "../types.js";

/**
 * Plugin-author entry point. Lets any elizaOS plugin — including the
 * many under `elizaos-plugins/*` outside this repository — register its
 * own credential schemas in Confidant by handing in the same plugin
 * registry JSON it already publishes.
 *
 * Confidant doesn't need a hardcoded list of every plugin in the
 * universe. Each plugin is the source of truth for its own credentials.
 * This module makes self-registration a one-liner.
 *
 * Typical usage in a plugin's index.ts:
 *
 *     import registryEntry from "./registry.json";
 *     import { defineSchemaFromRegistry } from "@elizaos/confidant";
 *
 *     defineSchemaFromRegistry(registryEntry, {
 *       domain: "connector",
 *       subject: "discord",
 *     });
 *
 * After this call, every `type: "secret"` field in the registry entry
 * is registered under `<domain>.<subject>.<camelCasedField>` with
 * ownership attributed to the plugin's own id.
 */

/**
 * Subset of an elizaOS plugin registry entry that Confidant needs.
 * Plugins typically ship a JSON file like this (see
 * `eliza/packages/app-core/src/registry/entries/plugins/<name>.json`).
 */
export interface PluginRegistryEntryLike {
  /** The plugin id (`@elizaos/plugin-discord`, etc.). Required. */
  readonly id?: string;
  /** Optional npm name; falls back to `id`. */
  readonly npmName?: string;
  /** The same `config` block already used by the Settings UI renderer. */
  readonly config?: Readonly<Record<string, ConfigField>>;
}

export interface ConfigField {
  readonly type: string;
  readonly sensitive?: boolean;
  readonly required?: boolean;
  readonly label?: string;
  readonly help?: string;
  readonly placeholder?: string;
}

/**
 * Canonical domain namespaces. Plugin authors pick the one that
 * matches their plugin's role:
 */
export type CanonicalDomain =
  | "llm"
  | "subscription"
  | "tts"
  | "tool"
  | "connector"
  | "wallet"
  | "rpc"
  | "trading"
  | "music"
  | "storage"
  | "service";

export interface DefineSchemaFromRegistryOptions {
  /** Domain segment of the resulting SecretId(s). Required. */
  readonly domain: CanonicalDomain | string;
  /** Subject segment — usually the plugin's short name (e.g., "discord"). */
  readonly subject: string;
  /**
   * Optional override of the per-env-var → camelCased-field mapping.
   * Default: strips the `{domain}_{subject}_` and `{subject}_` prefixes
   * from the env-var name (case-insensitive), then converts the
   * remainder to camelCase. `DISCORD_BOT_TOKEN` → `botToken`.
   */
  readonly fieldNameForEnvVar?: (envVar: string) => string;
  /**
   * Optional override of the plugin id used for schema ownership.
   * Default: `entry.id` (or `entry.npmName`).
   */
  readonly pluginId?: string;
  /**
   * Optional whitelist — only register schemas for these env-var names.
   * Useful for plugins whose registry includes both secret and non-secret
   * fields where only some belong to Confidant.
   */
  readonly only?: readonly string[];
}

export interface DefineSchemaResult {
  readonly registered: ReadonlyArray<{
    readonly envVar: string;
    readonly secretId: SecretId;
  }>;
  readonly skipped: ReadonlyArray<{
    readonly envVar: string;
    readonly reason: "not-secret-type" | "not-in-allowlist";
  }>;
}

/**
 * Read a plugin registry JSON entry, find every `type: "secret"` field,
 * and register each as a Confidant SecretId scoped to the plugin.
 *
 * Returns a structured report so callers can log adoption.
 */
export function defineSchemaFromRegistry(
  entry: PluginRegistryEntryLike,
  options: DefineSchemaFromRegistryOptions,
): DefineSchemaResult {
  if (!entry.config) return { registered: [], skipped: [] };
  const pluginId = options.pluginId ?? entry.id ?? entry.npmName;
  if (!pluginId) {
    throw new TypeError(
      "defineSchemaFromRegistry: registry entry has no id or npmName, and no pluginId override was supplied.",
    );
  }
  const fieldFor =
    options.fieldNameForEnvVar ??
    ((envVar) => defaultFieldNameForEnvVar(envVar, options.subject, options.domain));
  const allowlist =
    options.only && options.only.length > 0
      ? new Set(options.only)
      : null;

  const entries: Record<string, Omit<SecretSchemaEntry, "id">> = {};
  const registered: Array<{ envVar: string; secretId: SecretId }> = [];
  const skipped: Array<{
    envVar: string;
    reason: "not-secret-type" | "not-in-allowlist";
  }> = [];

  for (const [envVar, field] of Object.entries(entry.config)) {
    if (allowlist && !allowlist.has(envVar)) {
      skipped.push({ envVar, reason: "not-in-allowlist" });
      continue;
    }
    if (field.type !== "secret") {
      skipped.push({ envVar, reason: "not-secret-type" });
      continue;
    }
    const fieldName = fieldFor(envVar);
    const secretId: SecretId = `${options.domain}.${options.subject}.${fieldName}`;
    const label = field.label ?? humanizeEnvVar(envVar);
    const formatHint = field.placeholder;
    entries[secretId] = {
      label,
      ...(formatHint ? { formatHint } : {}),
      sensitive: true,
      pluginId,
    };
    registered.push({ envVar, secretId });
  }

  if (Object.keys(entries).length > 0) {
    defineSecretSchema(entries);
  }
  return { registered, skipped };
}

/**
 * Default env-var → camelCased-field name. Strips known prefixes
 * derived from the domain + subject so the resulting field name is
 * concise.
 *
 *   DISCORD_BOT_TOKEN, subject="discord", domain="connector" → botToken
 *   GITHUB_API_TOKEN,  subject="github",  domain="connector" → apiToken
 *   OPENROUTER_API_KEY, subject="openrouter", domain="llm" → apiKey
 */
export function defaultFieldNameForEnvVar(
  envVar: string,
  subject: string,
  domain: string,
): string {
  let remainder = envVar;
  const prefixes: string[] = [];
  if (subject) {
    prefixes.push(`${subject.toUpperCase().replace(/-/g, "_")}_`);
    prefixes.push(`${subject.replace(/-/g, "").toUpperCase()}_`);
  }
  if (domain && subject) {
    prefixes.push(
      `${domain.toUpperCase()}_${subject.toUpperCase().replace(/-/g, "_")}_`,
    );
  }
  // Longest prefix first so multi-word prefixes win over their initial
  // single-word components.
  prefixes.sort((a, b) => b.length - a.length);
  for (const prefix of prefixes) {
    if (remainder.toUpperCase().startsWith(prefix) && remainder.length > prefix.length) {
      remainder = remainder.slice(prefix.length);
      break;
    }
  }
  return toCamelCase(remainder);
}

function toCamelCase(snakeOrUpper: string): string {
  const parts = snakeOrUpper
    .split("_")
    .filter(Boolean)
    .map((p) => p.toLowerCase());
  if (parts.length === 0) return "value";
  const first = parts[0]!;
  const rest = parts
    .slice(1)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1));
  return [first, ...rest].join("");
}

function humanizeEnvVar(envVar: string): string {
  return envVar
    .toLowerCase()
    .split("_")
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}
