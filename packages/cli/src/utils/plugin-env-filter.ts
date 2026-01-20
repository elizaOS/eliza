import { logger } from '@elizaos/core';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { EnvVarConfig } from '../commands/plugins/types';

export interface PluginEnvVarInfo {
  name: string;
  config: EnvVarConfig;
  plugin: string;
}

export interface PluginEnvScanResult {
  allowedVars: Set<string>;
  varInfo: Map<string, PluginEnvVarInfo>;
  pluginsWithDeclarations: string[];
  pluginsWithoutDeclarations: string[];
}

const CORE_ALLOWED_VARS = new Set([
  'POSTGRES_URL',
  'PGLITE_DATA_DIR',
  'SERVER_PORT',
  'SERVER_HOST',
  'LOG_LEVEL',
  'LOG_FORMAT',
  'NODE_ENV',
  'BUN_ENV',
  'ELIZAOS_DATA_DIR',
  'ELIZAOS_CONFIG_DIR',
]);

// Cached regex for parsing .env file variable names - compiled once at module load
const ENV_VAR_NAME_REGEX = /^([^=]+)=/;

interface ParsedPackageJson {
  isPlugin: boolean;
  declarations: Record<string, EnvVarConfig> | null;
}

/**
 * Reads and parses package.json once, returning both plugin detection and env declarations.
 * This eliminates duplicate file reads that occurred when isElizaOSPlugin and
 * readPluginEnvDeclarations were called separately.
 */
function parsePackageJson(packageJsonPath: string): ParsedPackageJson | null {
  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    const isPlugin = Boolean(
      pkg.agentConfig?.pluginType ||
      pkg.eliza?.type === 'plugin' ||
      pkg.name?.startsWith('@elizaos/plugin-') ||
      pkg.keywords?.includes('elizaos-plugin')
    );
    const declarations = pkg.agentConfig?.pluginParameters ?? null;
    return { isPlugin, declarations };
  } catch (error) {
    logger.debug(
      {
        src: 'cli',
        util: 'plugin-env-filter',
        path: packageJsonPath,
        error: error instanceof Error ? error.message : String(error),
      },
      'Failed to read plugin package.json'
    );
    return null;
  }
}

function processPluginDeclarations(
  pkgName: string,
  declarations: Record<string, EnvVarConfig> | null,
  result: PluginEnvScanResult
): void {
  if (declarations && Object.keys(declarations).length > 0) {
    result.pluginsWithDeclarations.push(pkgName);
    for (const [varName, config] of Object.entries(declarations)) {
      result.allowedVars.add(varName);
      result.varInfo.set(varName, {
        name: varName,
        config: config as EnvVarConfig,
        plugin: pkgName,
      });
    }
  } else {
    result.pluginsWithoutDeclarations.push(pkgName);
  }
}

function scanNodeModules(
  nodeModulesPath: string,
  result: PluginEnvScanResult,
  scannedPackages: Set<string>
): void {
  let entries: string[];
  try {
    entries = readdirSync(nodeModulesPath);
  } catch {
    // Directory doesn't exist or can't be read - early exit
    return;
  }

  for (const entry of entries) {
    if (entry.startsWith('@')) {
      const scopePath = path.join(nodeModulesPath, entry);
      let scopedEntries: string[];
      try {
        scopedEntries = readdirSync(scopePath);
      } catch {
        // Skip if can't read scope directory
        continue;
      }

      for (const scopedPkg of scopedEntries) {
        const fullPkgName = `${entry}/${scopedPkg}`;
        if (scannedPackages.has(fullPkgName)) continue;
        scannedPackages.add(fullPkgName);

        const packageJsonPath = path.join(scopePath, scopedPkg, 'package.json');
        // Single file read: parse package.json and check if plugin in one operation
        const parsed = parsePackageJson(packageJsonPath);
        if (parsed?.isPlugin) {
          processPluginDeclarations(fullPkgName, parsed.declarations, result);
        }
      }
    } else {
      if (scannedPackages.has(entry)) continue;
      scannedPackages.add(entry);

      const pkgPath = path.join(nodeModulesPath, entry);
      try {
        if (!statSync(pkgPath).isDirectory()) continue;
      } catch {
        continue;
      }

      const packageJsonPath = path.join(pkgPath, 'package.json');
      // Single file read: parse package.json and check if plugin in one operation
      const parsed = parsePackageJson(packageJsonPath);
      if (parsed?.isPlugin) {
        processPluginDeclarations(entry, parsed.declarations, result);
      }
    }
  }
}

export function scanPluginsForEnvDeclarations(
  cwd: string,
  options: { includeCoreVars?: boolean; maxDepth?: number } = {}
): PluginEnvScanResult {
  const { includeCoreVars = true, maxDepth = 5 } = options;

  const result: PluginEnvScanResult = {
    allowedVars: new Set(includeCoreVars ? CORE_ALLOWED_VARS : []),
    varInfo: new Map(),
    pluginsWithDeclarations: [],
    pluginsWithoutDeclarations: [],
  };

  const scannedPackages = new Set<string>();

  let currentDir = cwd;
  for (let depth = 0; depth < maxDepth; depth++) {
    scanNodeModules(path.join(currentDir, 'node_modules'), result, scannedPackages);

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }

  logger.debug(
    {
      src: 'cli',
      util: 'plugin-env-filter',
      allowedVarsCount: result.allowedVars.size,
      pluginsWithDeclarations: result.pluginsWithDeclarations.length,
      pluginsWithoutDeclarations: result.pluginsWithoutDeclarations.length,
    },
    'Plugin env scan complete'
  );

  return result;
}

export function filterEnvVarsByPluginDeclarations(
  envVars: Record<string, string | undefined>,
  allowedVars: Set<string>
): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(envVars)) {
    if (value !== undefined && allowedVars.has(key)) filtered[key] = value;
  }
  return filtered;
}

export function detectShellOnlyVars(
  envFilePath: string,
  processEnv: Record<string, string | undefined>
): Set<string> {
  const isSystemVar = (key: string) => key.startsWith('_') || key.startsWith('npm_');

  // Try to read file directly - avoids separate existsSync check
  let content: string;
  try {
    content = readFileSync(envFilePath, 'utf-8');
  } catch {
    // File doesn't exist or can't be read - all non-system vars are shell-only
    return new Set(Object.keys(processEnv).filter((key) => !isSystemVar(key)));
  }

  const envFileVars = new Set<string>();

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const match = trimmed.match(ENV_VAR_NAME_REGEX);
      if (match) envFileVars.add(match[1].trim());
    }
  }

  return new Set(
    Object.keys(processEnv).filter((key) => !envFileVars.has(key) && !isSystemVar(key))
  );
}

export function warnAboutMissingDeclarations(
  pluginsWithoutDeclarations: string[],
  options: { logLevel?: 'warn' | 'debug' } = {}
): boolean {
  const officialPluginsMissing = pluginsWithoutDeclarations.filter((p) =>
    p.startsWith('@elizaos/plugin-')
  );
  if (officialPluginsMissing.length === 0) return false;

  const message = `${officialPluginsMissing.length} ElizaOS plugins missing env var declarations: ${officialPluginsMissing.join(', ')}`;
  const logFn = options.logLevel === 'debug' ? logger.debug : logger.warn;
  logFn({ src: 'cli', util: 'plugin-env-filter', plugins: officialPluginsMissing }, message);

  return true;
}
