import { PluginReference } from './schema';
import { Plugin } from '@elizaos/core';
import { getModuleLoader } from '@/src/utils/module-loader';

export interface ParsedPlugin {
  name: string;
  version?: string;
  config?: Record<string, any>;
  enabled: boolean;
  originalReference: PluginReference;
  loadedPlugin?: Plugin; // Store the actually loaded plugin
}

export interface PluginValidationResult {
  valid: boolean;
  plugins: ParsedPlugin[];
  errors: string[];
  warnings: string[];
}

/**
 * Parse plugin references from scenario configuration
 */
function parsePlugins(pluginReferences: PluginReference[] | undefined): ParsedPlugin[] {
    if (!pluginReferences || pluginReferences.length === 0) {
      return [];
    }

    return pluginReferences.map((ref) => {
      if (typeof ref === 'string') {
        return {
          name: ref,
          enabled: true,
          originalReference: ref,
        };
      } else {
        return {
          name: ref.name,
          version: ref.version,
          config: ref.config,
          enabled: ref.enabled ?? true,
          originalReference: ref,
        };
      }
    });
  }

/**
 * Validate parsed plugins dynamically
 */
async function validatePlugins(plugins: ParsedPlugin[]): Promise<PluginValidationResult> {
    const result: PluginValidationResult = {
      valid: true,
      plugins: [],
      errors: [],
      warnings: [],
    };

    const seenPlugins = new Set<string>();

    for (const plugin of plugins) {
      // Check if plugin is enabled
      if (!plugin.enabled) {
        result.warnings.push(`Plugin '${plugin.name}' is disabled`);
        continue;
      }

      // Check for duplicate plugins
      if (seenPlugins.has(plugin.name)) {
        result.errors.push(`Duplicate plugin '${plugin.name}' found`);
        result.valid = false;
        continue;
      }
      seenPlugins.add(plugin.name);

      // Validate plugin name format
      if (!isValidPluginName(plugin.name)) {
        result.errors.push(
          `Invalid plugin name '${plugin.name}'. Expected format: @elizaos/plugin-*`
        );
        result.valid = false;
        continue;
      }

      // Dynamically load and validate plugin
      try {
        const moduleLoader = getModuleLoader();
        const { PluginLoader } = await moduleLoader.load('@elizaos/server');
        const loader = new PluginLoader();
        const loadedPlugin = await loader.loadAndPreparePlugin(plugin.name);
        if (loadedPlugin) {
          plugin.loadedPlugin = loadedPlugin;
          result.plugins.push(plugin);
        } else {
          result.errors.push(`Failed to load plugin '${plugin.name}'`);
          result.valid = false;
          continue;
        }
      } catch (error) {
        result.errors.push(
          `Error loading plugin '${plugin.name}': ${error instanceof Error ? error.message : String(error)}`
        );
        result.valid = false;
        continue;
      }

      // Validate version if provided
      if (plugin.version && !isValidVersion(plugin.version)) {
        result.errors.push(`Invalid version '${plugin.version}' for plugin '${plugin.name}'`);
        result.valid = false;
        continue;
      }

      // Validate config if provided
      if (plugin.config && !isValidConfig(plugin.config)) {
        result.errors.push(`Invalid configuration for plugin '${plugin.name}'`);
        result.valid = false;
        continue;
      }
    }

    return result;
  }

/**
 * Parse and validate plugins from scenario configuration
 */
export async function parseAndValidate(
  pluginReferences: PluginReference[] | undefined
): Promise<PluginValidationResult> {
  const parsedPlugins = parsePlugins(pluginReferences);
  return await validatePlugins(parsedPlugins);
}

/**
 * Check if plugin name follows valid format
 */
function isValidPluginName(name: string): boolean {
    return /^@elizaos\/plugin-[a-zA-Z0-9-]+$/.test(name);
  }

/**
 * Validate version string
 */
function isValidVersion(version: string): boolean {
    return /^\d+\.\d+\.\d+$/.test(version);
  }

/**
 * Validate plugin configuration object
 */
function isValidConfig(config: Record<string, any>): boolean {
    // Basic validation - config should be an object
    return typeof config === 'object' && config !== null && !Array.isArray(config);
  }

/**
 * Generate plugin loading summary
 */
export function generateSummary(result: PluginValidationResult): string {
    const lines: string[] = [];

    lines.push(`Plugin Loading Summary:`);
    lines.push(`  Total plugins: ${result.plugins.length}`);
    lines.push(`  Valid: ${result.valid ? 'Yes' : 'No'}`);

    if (result.plugins.length > 0) {
      lines.push(`  Plugins to load:`);
      result.plugins.forEach((plugin) => {
        const configStr = plugin.config ? ` (with config)` : '';
        const versionStr = plugin.version ? ` v${plugin.version}` : '';
        lines.push(`    - ${plugin.name}${versionStr}${configStr}`);
      });
    }

    if (result.errors.length > 0) {
      lines.push(`  Errors:`);
      result.errors.forEach((error) => { lines.push(`    - ${error}`); });
    }

    if (result.warnings.length > 0) {
      lines.push(`  Warnings:`);
      result.warnings.forEach((warning) => { lines.push(`    - ${warning}`); });
    }

    return lines.join('\n');
  }
