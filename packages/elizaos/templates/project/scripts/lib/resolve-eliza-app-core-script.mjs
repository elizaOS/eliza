import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isLocalElizaDisabled } from "./eliza-source-mode.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(__dirname, "..", "..");
const requireFromHere = createRequire(import.meta.url);

function explicitAppCoreRoot() {
  const rawRoot = process.env.ELIZA_APP_CORE_ROOT;
  if (typeof rawRoot !== "string" || rawRoot.trim().length === 0) {
    return null;
  }
  return path.resolve(rawRoot);
}

function assertScriptName(scriptName) {
  if (
    typeof scriptName !== "string" ||
    scriptName.length === 0 ||
    path.isAbsolute(scriptName) ||
    scriptName.split(/[\\/]+/).includes("..")
  ) {
    throw new Error(`Invalid elizaOS app-core script name: ${scriptName}`);
  }
}

function resolvePublishedAppCoreRoot(repoRoot) {
  const packageJsonPath = requireFromHere.resolve(
    "@elizaos/app-core/package.json",
    {
      paths: [repoRoot, path.join(repoRoot, "apps", "app")],
    },
  );
  return path.dirname(packageJsonPath);
}

export function resolveElizaAppCoreRoot({
  repoRoot = defaultRepoRoot,
  preferLocal = !isLocalElizaDisabled({ repoRoot }),
} = {}) {
  const explicitRoot = explicitAppCoreRoot();
  if (explicitRoot) {
    if (!existsSync(path.join(explicitRoot, "package.json"))) {
      throw new Error(
        `ELIZA_APP_CORE_ROOT does not contain package.json: ${explicitRoot}`,
      );
    }
    return explicitRoot;
  }

  const localRoot = path.join(repoRoot, "eliza", "packages", "app-core");
  if (preferLocal) {
    if (existsSync(path.join(localRoot, "package.json"))) {
      return localRoot;
    }
    throw new Error(
      `ELIZA_SOURCE=local was selected, but ${path.relative(
        repoRoot,
        localRoot,
      )} is missing. Run bun run setup:upstreams first.`,
    );
  }

  try {
    return resolvePublishedAppCoreRoot(repoRoot);
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : "";
    throw new Error(
      `Could not resolve @elizaos/app-core.${detail} Run bun install, or run bun run setup:upstreams and select ELIZA_SOURCE=local.`,
    );
  }
}

export function resolveElizaAppCoreScript(
  scriptName,
  { repoRoot = defaultRepoRoot, preferLocal } = {},
) {
  assertScriptName(scriptName);
  const appCoreRoot = resolveElizaAppCoreRoot({ repoRoot, preferLocal });
  const scriptPath = path.join(appCoreRoot, "scripts", scriptName);
  if (!existsSync(scriptPath)) {
    throw new Error(
      `@elizaos/app-core script not found: ${path.relative(repoRoot, scriptPath)}`,
    );
  }
  return scriptPath;
}
