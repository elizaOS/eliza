import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

function isPackagedAppDirectory(directory) {
  return (
    existsSync(path.join(directory, "bin", "launcher")) &&
    existsSync(path.join(directory, "bin", "libNativeWrapper.so"))
  );
}

/**
 * Resolve Electrobun's Linux platform directory to the nested packaged app.
 * Current Electrobun emits build/dev-linux-x64/Eliza-dev, while older outputs
 * may place bin/ directly in the platform directory.
 */
export function resolveElectrobunLinuxAppDirectory(directory) {
  if (isPackagedAppDirectory(directory)) return directory;

  const nested = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(directory, entry.name))
    .filter(isPackagedAppDirectory)
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);

  if (nested.length === 1) return nested[0];
  if (nested.length > 1) {
    throw new Error(
      `Ambiguous Electrobun Linux build under ${directory}: ${nested.join(", ")}`,
    );
  }
  throw new Error(
    `No packaged Electrobun app with bin/launcher and bin/libNativeWrapper.so found under ${directory}`,
  );
}

export function resolveLatestElectrobunLinuxBuild({
  buildRoot,
  explicitBuildDir,
  repoRoot,
}) {
  if (explicitBuildDir) {
    return resolveElectrobunLinuxAppDirectory(
      path.resolve(repoRoot, explicitBuildDir),
    );
  }

  const platformDirectories = readdirSync(buildRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /linux/i.test(entry.name))
    .map((entry) => path.join(buildRoot, entry.name))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);

  if (platformDirectories.length === 0) {
    throw new Error(`No Linux Electrobun build found under ${buildRoot}`);
  }

  const failures = [];
  for (const directory of platformDirectories) {
    try {
      return resolveElectrobunLinuxAppDirectory(directory);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(failures.join("\n"));
}
