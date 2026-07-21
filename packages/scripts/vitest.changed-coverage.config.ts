/**
 * Composes each package-owned Vitest config with source aliases for the
 * pre-build changed-file coverage lane. Package aliases stay first so test
 * stubs and platform shims win; the comprehensive workspace aliases then keep
 * every transitive @elizaos package resolvable without a pre-existing dist.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Alias } from "vite";
import {
  type ConfigEnv,
  defineConfig,
  type ViteUserConfig,
  type ViteUserConfigExport,
} from "vitest/config";
import { buildHarnessSourceAliases } from "../test/harness/source-aliases";

function normalizeAliasEntries(alias: unknown): Alias[] {
  if (alias === undefined) return [];
  if (Array.isArray(alias)) return alias as Alias[];
  if (!alias || typeof alias !== "object") {
    throw new TypeError("Vitest resolve.alias must be an object or array");
  }

  return Object.entries(alias).map(([find, replacement]) => {
    if (typeof replacement !== "string") {
      throw new TypeError(`Vitest alias ${find} must resolve to a string`);
    }
    return { find, replacement };
  });
}

async function resolveUserConfig(
  configExport: ViteUserConfigExport,
  configEnv: ConfigEnv,
): Promise<ViteUserConfig> {
  const awaited = await configExport;
  const resolved =
    typeof awaited === "function" ? await awaited(configEnv) : awaited;
  if (!resolved || typeof resolved !== "object" || Array.isArray(resolved)) {
    throw new TypeError("Package Vitest config must resolve to an object");
  }
  return resolved;
}

export function composeChangedCoverageConfig(
  packageConfig: ViteUserConfig,
  repoRoot: string,
): ViteUserConfig {
  const packageConditions = packageConfig.resolve?.conditions ?? [];
  return {
    ...packageConfig,
    resolve: {
      ...packageConfig.resolve,
      conditions: [...new Set([...packageConditions, "eliza-source"])],
      alias: [
        ...normalizeAliasEntries(packageConfig.resolve?.alias),
        ...buildHarnessSourceAliases(repoRoot),
      ],
    },
  };
}

export async function loadChangedCoverageConfig(
  configEnv: ConfigEnv,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ViteUserConfig> {
  const configPath = env.ELIZA_CHANGED_VITEST_CONFIG;
  const repoRoot = env.ELIZA_CHANGED_VITEST_REPO_ROOT;
  if (!configPath || !repoRoot) {
    throw new Error(
      "Changed coverage requires ELIZA_CHANGED_VITEST_CONFIG and ELIZA_CHANGED_VITEST_REPO_ROOT",
    );
  }

  const absoluteRoot = path.resolve(repoRoot);
  const absoluteConfig = path.resolve(configPath);
  const relativeConfig = path.relative(absoluteRoot, absoluteConfig);
  if (
    relativeConfig === ".." ||
    relativeConfig.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeConfig)
  ) {
    throw new Error(
      `Package Vitest config escapes the repository: ${configPath}`,
    );
  }

  const module = (await import(pathToFileURL(absoluteConfig).href)) as {
    default?: ViteUserConfigExport;
  };
  if (module.default === undefined) {
    throw new Error(
      `Package Vitest config has no default export: ${configPath}`,
    );
  }
  const packageConfig = await resolveUserConfig(module.default, configEnv);
  return composeChangedCoverageConfig(packageConfig, absoluteRoot);
}

export default defineConfig((configEnv) =>
  loadChangedCoverageConfig(configEnv),
);
