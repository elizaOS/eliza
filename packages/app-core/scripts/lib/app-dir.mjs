import fs from "node:fs";
import path from "node:path";

function hasPackageJson(dir) {
  return fs.existsSync(path.join(dir, "package.json"));
}

function firstExistingPackage(candidates) {
  return candidates.find(hasPackageJson) ?? candidates[0];
}

export function resolveMainAppDir(repoRoot, appName = "app") {
  const cwd = path.resolve(process.cwd());
  const elizaRoot = path.join(repoRoot, "eliza");
  const cwdIsInsideNestedEliza =
    hasPackageJson(elizaRoot) &&
    (cwd === path.resolve(elizaRoot) ||
      cwd.startsWith(`${path.resolve(elizaRoot)}${path.sep}`));

  const isOuterMonorepo = hasPackageJson(path.join(repoRoot, "eliza"));
  if (appName === "app") {
    const localCandidates = [
      path.join(repoRoot, "packages", "app"),
      path.join(repoRoot, "apps", "app"),
    ];
    const outerCandidates = [
      path.join(repoRoot, "eliza", "packages", "app"),
      path.join(repoRoot, "eliza", "apps", "app"),
      path.join(repoRoot, "apps", "app"),
    ];
    return firstExistingPackage(
      isOuterMonorepo && !cwdIsInsideNestedEliza
        ? [
            path.join(repoRoot, "apps", "app"),
            path.join(repoRoot, "packages", "app"),
            path.join(repoRoot, "eliza", "packages", "app"),
            path.join(repoRoot, "eliza", "apps", "app"),
          ]
        : isOuterMonorepo
          ? outerCandidates
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

export function resolveElectrobunDir(repoRoot) {
  const candidates = [
    path.join(repoRoot, "packages", "app-core", "platforms", "electrobun"),
    path.join(
      repoRoot,
      "eliza",
      "packages",
      "app-core",
      "platforms",
      "electrobun",
    ),
  ];
  const match = candidates.find((candidate) =>
    fs.existsSync(path.join(candidate, "electrobun.config.ts")),
  );
  return match ?? candidates[0];
}
