/**
 * Resolves the generated macOS EventKit/effects bridge used by source-checkout
 * dev servers. The plan stays pure so bootstrap can distinguish an existing
 * explicit override from a missing or stale local artifact before spawning the
 * API process that consumes it.
 */
import path from "node:path";

function sourceCheckoutRoot(cwd, exists) {
  const roots = [cwd, path.join(cwd, "eliza")];
  return (
    roots.find((root) =>
      exists(
        path.join(
          root,
          "packages",
          "app-core",
          "platforms",
          "electrobun",
          "native",
          "macos",
          "window-effects.mm",
        ),
      ),
    ) ?? null
  );
}

export function resolveMacNativeEffectsDevPlan({
  cwd,
  env,
  platform,
  exists,
  modifiedAt,
}) {
  if (platform !== "darwin" || env.ELIZA_DEV_NATIVE_EFFECTS === "0") {
    return { kind: "skip" };
  }

  const configuredPath = env.ELIZA_NATIVE_PERMISSIONS_DYLIB?.trim();
  if (configuredPath && exists(configuredPath)) {
    return { kind: "use", dylibPath: configuredPath };
  }

  const root = sourceCheckoutRoot(cwd, exists);
  if (!root) return { kind: "skip" };

  const packageDir = path.join(
    root,
    "packages",
    "app-core",
    "platforms",
    "electrobun",
  );
  const sourcePath = path.join(
    packageDir,
    "native",
    "macos",
    "window-effects.mm",
  );
  const dylibPath = path.join(packageDir, "src", "libMacWindowEffects.dylib");

  if (exists(dylibPath) && modifiedAt(dylibPath) >= modifiedAt(sourcePath)) {
    return { kind: "use", dylibPath };
  }

  return { kind: "build", packageDir, dylibPath };
}
