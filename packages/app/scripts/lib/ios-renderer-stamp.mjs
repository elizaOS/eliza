/**
 * Renderer build-stamp helpers for the iOS lanes: resolve the
 * `eliza-renderer-build.json` stamp inside a staged/installed `App.app` and in
 * the freshly built dist, read it as a typed manifest, and assert the two
 * buildIds match. This is the single source of truth for the stale-UI guard
 * (#9309): a Capacitor app bakes the web bundle into the `.app` at build time,
 * so an install of a cached dist over a fresh one silently ships yesterday's UI
 * unless the buildIds are compared before install.
 *
 * Consumed by the simulator smoke lanes (`ios-e2e`, `ios-onboarding-smoke`,
 * `mobile-local-chat-smoke`) via the throwing `assertIosAppRendererFresh`, and
 * by the physical-device deploy/e2e lane (`ios-device-deploy`, `ios-device-e2e`,
 * `lib/ios-deploy-ledger`) which reuses the path/read helpers here and layers its
 * own non-throwing freshness verdict on top.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const RENDERER_MANIFEST = "eliza-renderer-build.json";

function execText(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      cwd: options.cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    if (options.optional) return null;
    throw error;
  }
}

export function rendererManifestPathFromAppPath(appPath) {
  return path.join(appPath, "public", RENDERER_MANIFEST);
}

export function freshRendererManifestPath({ repoRoot, rendererDist }) {
  return path.join(
    rendererDist
      ? path.resolve(rendererDist)
      : path.join(repoRoot, "packages", "app", "dist"),
    RENDERER_MANIFEST,
  );
}

/**
 * Read + parse a renderer stamp, requiring a non-empty buildId (an unstamped
 * build is not a usable manifest — throwing here keeps a consumer from treating
 * it as fresh). Returns a normalized shape so callers get typed access to the
 * fields the stamp carries (`commit`/`variant`/`runtimeMode` drive the
 * deploy-ledger row; `builtAt` is echoed in freshness logs) rather than reaching
 * into a raw JSON blob.
 *
 * @param {string} manifestPath
 * @param {string} label
 * @returns {{ buildId: string, commit: string | null, variant: string | null,
 *            runtimeMode: string | null, builtAt: string | null }}
 */
export function readRendererManifest(manifestPath, label) {
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`${label} renderer manifest is missing: ${manifestPath}`);
  }
  const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (typeof parsed.buildId !== "string" || parsed.buildId.length === 0) {
    throw new Error(
      `${label} renderer manifest has no buildId: ${manifestPath}`,
    );
  }
  return {
    buildId: parsed.buildId,
    commit: typeof parsed.commit === "string" ? parsed.commit : null,
    variant: typeof parsed.variant === "string" ? parsed.variant : null,
    runtimeMode:
      typeof parsed.runtimeMode === "string" ? parsed.runtimeMode : null,
    builtAt: typeof parsed.builtAt === "string" ? parsed.builtAt : null,
  };
}

export function compareRendererBuildIds({
  fresh,
  installed,
  label = "iOS app",
}) {
  if (installed.buildId !== fresh.buildId) {
    throw new Error(
      `${label} renderer buildId ${installed.buildId} != freshly built ${fresh.buildId} - stale UI install.`,
    );
  }
  return {
    buildId: fresh.buildId,
    builtAt: fresh.builtAt ?? null,
  };
}

export function readIosBundleIdFromAppPath(appPath) {
  const plist = path.join(appPath, "Info.plist");
  if (!fs.existsSync(plist)) {
    throw new Error(`iOS app bundle is missing Info.plist: ${plist}`);
  }
  const bundleId = execText(
    "plutil",
    ["-extract", "CFBundleIdentifier", "raw", plist],
    {
      optional: true,
    },
  );
  if (!bundleId) {
    throw new Error(`Could not read CFBundleIdentifier from ${plist}`);
  }
  return bundleId;
}

export function assertIosAppPathMatchesBundleId({ appPath, bundleId }) {
  const actual = readIosBundleIdFromAppPath(appPath);
  if (actual !== bundleId) {
    throw new Error(
      `iOS app bundle id ${actual} did not match expected ${bundleId}: ${appPath}`,
    );
  }
  return actual;
}

export function assertIosAppRendererFresh({
  appPath,
  repoRoot,
  rendererDist = process.env.ELIZA_SMOKE_RENDERER_DIST,
  label = "iOS app",
  log = () => {},
}) {
  const freshManifest = freshRendererManifestPath({ repoRoot, rendererDist });
  const installedManifest = rendererManifestPathFromAppPath(appPath);
  const fresh = readRendererManifest(freshManifest, "freshly built");
  const installed = readRendererManifest(installedManifest, label);
  const result = compareRendererBuildIds({ fresh, installed, label });
  log(
    `renderer build stamp OK for ${label}: ${String(result.buildId).slice(0, 12)}${result.builtAt ? ` built ${result.builtAt}` : ""}`,
  );
  return result;
}

export function assertCandidateIosAppRendererFresh({
  appPath,
  bundleId,
  repoRoot,
  log,
}) {
  assertIosAppPathMatchesBundleId({ appPath, bundleId });
  return assertIosAppRendererFresh({
    appPath,
    repoRoot,
    label: `candidate ${bundleId}`,
    log,
  });
}

export function assertInstalledIosAppRendererFresh({
  udid,
  bundleId,
  repoRoot,
  log,
}) {
  const appPath = execText(
    "xcrun",
    ["simctl", "get_app_container", udid, bundleId, "app"],
    { optional: true },
  );
  if (!appPath) {
    throw new Error(
      `Cannot verify renderer stamp: ${bundleId} is not installed in simulator ${udid}.`,
    );
  }
  return assertIosAppRendererFresh({
    appPath,
    repoRoot,
    label: `installed ${bundleId}`,
    log,
  });
}
