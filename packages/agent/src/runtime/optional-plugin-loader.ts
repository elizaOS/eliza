/** Loads optional bundled plugins while honoring explicit workspace-source development. */
import { pathToFileURL } from "node:url";
import { logger } from "@elizaos/core";
import { OPTIONAL_PLUGIN_IMPORTERS } from "./optional-plugin-imports.generated.ts";
import {
  hasElizaSourceRuntimeCondition,
  OPTIONAL_STATIC_PLUGIN_OVERRIDES,
  optionalPluginImportSpecifier,
} from "./optional-plugins.ts";
import {
  isWorkspacePluginSourceFallbackAllowed,
  resolveWorkspacePluginSourceEntry,
} from "./workspace-plugin-source.ts";

export async function loadOptionalPlugin(
  packageName: string,
  sourceStartDirectory: string,
): Promise<unknown> {
  const resolveSourceEntry = () =>
    resolveWorkspacePluginSourceEntry(
      packageName,
      sourceStartDirectory,
      OPTIONAL_STATIC_PLUGIN_OVERRIDES[packageName]?.importSubpath,
      hasElizaSourceRuntimeCondition(),
    );
  // Bun can select the generated importer's dist condition despite an explicit
  // source condition. Resolve the workspace entry before consulting that map.
  if (
    hasElizaSourceRuntimeCondition() &&
    isWorkspacePluginSourceFallbackAllowed()
  ) {
    const sourceEntry = resolveSourceEntry();
    if (sourceEntry) {
      logger.debug(
        `[eliza] Loading ${packageName} from explicitly requested workspace source at ${sourceEntry}`,
      );
      return await import(pathToFileURL(sourceEntry).href);
    }
  }

  try {
    const importer = OPTIONAL_PLUGIN_IMPORTERS[packageName];
    if (importer) return await importer();
    return await import(optionalPluginImportSpecifier(packageName));
  } catch {
    // error-policy:J4 Optional imports unavailable in a partial install may
    // use the existing dev source fallback, otherwise remain unavailable.
    if (isWorkspacePluginSourceFallbackAllowed()) {
      const sourceEntry = resolveSourceEntry();
      if (sourceEntry) {
        try {
          logger.debug(
            `[eliza] Loading ${packageName} from workspace source at ${sourceEntry}`,
          );
          return await import(pathToFileURL(sourceEntry).href);
        } catch {
          // error-policy:J4 An unbuildable optional plugin remains unavailable.
        }
      }
    }
    return null;
  }
}
