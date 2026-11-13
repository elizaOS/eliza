/**
 * Resolves the main app directory across repo layouts
 * (flat elizaOS monorepo vs a consumer repo that nests it as eliza/) so build
 * scripts target the right app package regardless of the host fork.
 */
import fs from "node:fs";
import path from "node:path";

function hasPackageJson(dir) {
  return fs.existsSync(path.join(dir, "package.json"));
}

function firstExistingPackage(candidates) {
  const found = candidates.find(hasPackageJson);
  if (!found)
    throw new Error(`App package not found. Checked: ${candidates.join(", ")}`);
  return found;
}

export function resolveMainAppDir(repoRoot, appName = "app") {
  if (
    !appName ||
    appName === "." ||
    appName === ".." ||
    /[\\/]/.test(appName)
  ) {
    throw new Error(`Invalid app package name: ${appName}`);
  }
  const isOuterMonorepo = hasPackageJson(path.join(repoRoot, "eliza"));
  if (appName === "app") {
    const localCandidates = [
      path.join(repoRoot, "packages", "app"),
      path.join(repoRoot, "apps", "app"),
    ];
    return firstExistingPackage(
      isOuterMonorepo
        ? [
            path.join(repoRoot, "apps", "app"),
            path.join(repoRoot, "packages", "app"),
            path.join(repoRoot, "eliza", "packages", "app"),
            path.join(repoRoot, "eliza", "apps", "app"),
          ]
        : localCandidates,
    );
  }

  const candidates = [
    path.join(repoRoot, "apps", appName),
    path.join(repoRoot, "packages", appName),
    path.join(repoRoot, "eliza", "apps", appName),
    path.join(repoRoot, "eliza", "packages", appName),
  ];
  return firstExistingPackage(candidates);
}

export function relativeAppDir(repoRoot, appDir) {
  return path.relative(repoRoot, appDir).replaceAll(path.sep, "/");
}
