/** Loads optional bundled plugins while honoring explicit workspace-source development. */
import { pathToFileURL } from "node:url";
import { ElizaError, logger } from "@elizaos/core";
import { isModuleNotFoundError } from "../utils/module-resolution-error.ts";
import { OPTIONAL_PLUGIN_IMPORTERS } from "./optional-plugin-imports.ts";
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
  } catch (cause) {
    const specifier = optionalPluginImportSpecifier(packageName);
    if (
      !isModuleNotFoundError(cause, specifier) &&
      !isModuleNotFoundError(cause, packageName)
    ) {
      throw new ElizaError("Optional plugin could not be loaded", {
        code: "OPTIONAL_PLUGIN_LOAD_FAILED",
        context: { packageName },
        cause,
      });
    }
    if (isWorkspacePluginSourceFallbackAllowed()) {
      const sourceEntry = resolveSourceEntry();
      if (sourceEntry) {
        logger.debug(
          `[eliza] Loading ${packageName} from workspace source at ${sourceEntry}`,
        );
        return await import(pathToFileURL(sourceEntry).href);
      }
    }
    return null;
  }
}
