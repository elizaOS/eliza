// src/utils/registry/schema.ts
import { z } from 'zod';

export const registrySchema = z.record(z.string(), z.string());

/**
 * Defines the possible types of plugins:
 * - "adapter"
 * - "client"
 * - "plugin"
 */
export type PluginType = 'adapter' | 'client' | 'plugin';

// TODO: we should handle this better later
/**
 * Function that determines the type of plugin based on the name provided.
 * @param {string} name - The name of the plugin.
 * @returns {PluginType} The type of plugin ('adapter', 'client', or 'plugin').
 */
export function getPluginType(name: string): PluginType {
  if (/sql/.test(name)) return 'adapter';
  if (/discord|twitter|telegram/.test(name)) return 'client';
  return 'plugin';
}

/**
 * Type definition for the Registry type which is inferred from the registrySchema
 */
export type Registry = z.infer<typeof registrySchema>;
