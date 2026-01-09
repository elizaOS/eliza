// src/utils/registry/schema.ts
import { z } from 'zod';

export const registrySchema = z.record(z.string(), z.string());

/**
 * Defines the possible types of plugins:
 * - "adapter" - Database adapters that provide data persistence (e.g., SQL, PostgreSQL)
 * - "client" - Platform integration clients (e.g., Discord, Twitter, Telegram)
 * - "plugin" - General purpose plugins providing additional functionality
 */
export type PluginType = 'adapter' | 'client' | 'plugin';

/**
 * Configuration for plugin type detection patterns
 * Each key maps to an array of patterns (strings or RegExp) that identify that plugin type
 */
const PLUGIN_TYPE_PATTERNS: Record<Exclude<PluginType, 'plugin'>, Array<string | RegExp>> = {
  adapter: [
    // Database adapters
    'sql',
    'postgres',
    'postgresql',
    'mysql',
    'sqlite',
    'mongodb',
    'database',
    'db-adapter',
    'pglite',
    // Match patterns like plugin-sql, adapter-postgres, etc.
    /adapter-/i,
    /db-/i,
  ],
  client: [
    // Social platforms and messaging
    'discord',
    'twitter',
    'telegram',
    'slack',
    'whatsapp',
    'matrix',
    'mastodon',
    'bluesky',
    'farcaster',
    'lens',
    'xmtp',
    // Communication and chat
    'irc',
    'teams',
    'messenger',
    // Web clients
    'web-client',
    'direct-client',
    // Match patterns like client-discord, plugin-telegram-client, etc.
    /client-/i,
    /-client$/i,
  ],
};

/**
 * Normalizes a plugin name for comparison by:
 * - Converting to lowercase
 * - Removing common prefixes like @elizaos/, plugin-, etc.
 *
 * @param name - The plugin name to normalize
 * @returns Normalized plugin name
 */
function normalizePluginName(name: string): string {
  return name
    .toLowerCase()
    .replace(/^@elizaos(-plugins)?\//, '') // Remove @elizaos/ or @elizaos-plugins/
    .replace(/^plugin-/, '') // Remove plugin- prefix
    .replace(/^elizaos-/, '') // Remove elizaos- prefix
    .trim();
}

/**
 * Checks if a normalized name matches any pattern in an array
 *
 * @param normalizedName - The normalized plugin name
 * @param patterns - Array of string or RegExp patterns to match
 * @returns true if any pattern matches
 */
function matchesPatterns(normalizedName: string, patterns: Array<string | RegExp>): boolean {
  return patterns.some((pattern) => {
    if (typeof pattern === 'string') {
      // For string patterns, check if the name includes the pattern
      return normalizedName.includes(pattern);
    }
    // For RegExp patterns, test against the original name
    return pattern.test(normalizedName);
  });
}

/**
 * Determines the type of plugin based on its name.
 *
 * The function uses pattern matching to identify plugin types:
 * - Database-related plugins (sql, postgres, etc.) are classified as 'adapter'
 * - Platform client plugins (discord, twitter, etc.) are classified as 'client'
 * - All other plugins are classified as 'plugin'
 *
 * @param name - The name of the plugin (can be scoped like @elizaos/plugin-sql)
 * @returns The plugin type ('adapter', 'client', or 'plugin')
 *
 * @example
 * getPluginType('@elizaos/plugin-sql')        // 'adapter'
 * getPluginType('plugin-discord')             // 'client'
 * getPluginType('@elizaos/plugin-bootstrap')  // 'plugin'
 * getPluginType('postgres-adapter')           // 'adapter'
 */
export function getPluginType(name: string): PluginType {
  const normalizedName = normalizePluginName(name);

  // Check adapter patterns first (they're more specific)
  if (matchesPatterns(normalizedName, PLUGIN_TYPE_PATTERNS.adapter)) {
    return 'adapter';
  }

  // Check client patterns
  if (matchesPatterns(normalizedName, PLUGIN_TYPE_PATTERNS.client)) {
    return 'client';
  }

  // Default to general plugin
  return 'plugin';
}

/**
 * Checks if a plugin is a database adapter
 *
 * @param name - The plugin name
 * @returns true if the plugin is a database adapter
 */
export function isAdapterPlugin(name: string): boolean {
  return getPluginType(name) === 'adapter';
}

/**
 * Checks if a plugin is a platform client
 *
 * @param name - The plugin name
 * @returns true if the plugin is a platform client
 */
export function isClientPlugin(name: string): boolean {
  return getPluginType(name) === 'client';
}

/**
 * Type definition for the Registry type which is inferred from the registrySchema
 */
export type Registry = z.infer<typeof registrySchema>;
