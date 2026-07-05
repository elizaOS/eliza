/**
 * Renderer build-stamp status helpers for device evidence lanes.
 *
 * Android e2e, iOS deploy, and fleet status all need the same answer: which
 * renderer build is installed, and does it match the fresh app bundle or
 * develop HEAD? Keeping the comparison pure makes stale-install behavior
 * unit-testable while the platform scripts own adb, simctl, and devicectl.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const RENDERER_MANIFEST_FILENAME = "eliza-renderer-build.json";
export const IOS_DEPLOY_LEDGER_FILENAME = "ios-device-deploy-ledger.jsonl";

export function shortSha(value, length = 12) {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text.slice(0, length) : null;
}

export function normalizeCommit(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function commitsMatch(actual, expected) {
  const a = normalizeCommit(actual);
  const e = normalizeCommit(expected);
  if (!a || !e) return false;
  return a === e || a.startsWith(e) || e.startsWith(a);
}

export function readRendererManifestFile(manifestPath, label = "renderer") {
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`${label} manifest is missing: ${manifestPath}`);
  }
  const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (typeof parsed.buildId !== "string" || parsed.buildId.length === 0) {
    throw new Error(`${label} manifest has no buildId: ${manifestPath}`);
  }
  return parsed;
}

export function freshRendererManifestPath({ appDir, rendererDist = null }) {
  return path.join(
    rendererDist ? path.resolve(rendererDist) : path.join(appDir, "dist"),
    RENDERER_MANIFEST_FILENAME,
  );
}

export function evaluateRendererFreshness({
  installed,
  fresh = null,
  developHead = null,
} = {}) {
  if (!installed) {
    return {
      verdict: "UNKNOWN",
      reason: "app is not installed or no installed stamp is available",
    };
  }
  if (fresh && installed.buildId !== fresh.buildId) {
    return {
      verdict: "STALE",
      reason: `installed buildId ${installed.buildId} != fresh buildId ${fresh.buildId}`,
    };
  }
  const expectedCommit = normalizeCommit(developHead);
  if (expectedCommit) {
    const installedCommit = normalizeCommit(installed.commit);
    if (!installedCommit) {
      return {
        verdict: "UNKNOWN",
        reason: "installed stamp has no commit to compare with develop HEAD",
      };
    }
    if (!commitsMatch(installedCommit, expectedCommit)) {
      return {
        verdict: "STALE",
        reason: `installed commit ${shortSha(installedCommit)} != develop HEAD ${shortSha(expectedCommit)}`,
      };
    }
  }
  if (!fresh && !expectedCommit) {
    return {
      verdict: "UNKNOWN",
      reason: "no fresh dist stamp or develop HEAD was provided",
    };
  }
  return {
    verdict: "FRESH",
    reason: fresh
      ? `installed buildId matches fresh buildId ${fresh.buildId}`
      : `installed commit matches develop HEAD ${shortSha(expectedCommit)}`,
  };
}

export function decideAndroidInstall({ installed, fresh, skipBuild = false }) {
  const status = evaluateRendererFreshness({ installed, fresh });
  if (status.verdict === "FRESH") {
    return { install: false, status };
  }
  if (skipBuild) {
    return {
      install: false,
      status,
      error: `--skip-build requires installed renderer == fresh dist; ${status.reason}`,
    };
  }
  return { install: true, status };
}

export function resolveDeviceStatusStateDir(
  env = process.env,
  homedir = os.homedir(),
) {
  const explicit = env.ELIZA_DEVICE_STATUS_STATE_DIR?.trim();
  if (explicit) return path.resolve(explicit.replace(/^~(?=$|\/)/, homedir));
  const stateDir = env.ELIZA_STATE_DIR?.trim();
  if (stateDir) return path.resolve(stateDir.replace(/^~(?=$|\/)/, homedir));
  const namespace = env.ELIZA_NAMESPACE?.trim() || "eliza";
  const xdg = env.XDG_STATE_HOME?.trim();
  return path.join(xdg || path.join(homedir, ".local", "state"), namespace);
}

export function iosDeployLedgerPath(stateDir) {
  return path.join(stateDir, "device-status", IOS_DEPLOY_LEDGER_FILENAME);
}

export function appendIosDeployLedgerEntry({
  stateDir = resolveDeviceStatusStateDir(),
  device,
  bundleId,
  stamp,
  source = "ios-device-deploy",
  deployedAt = new Date().toISOString(),
}) {
  if (!device?.udid) {
    throw new Error("cannot write iOS deploy ledger entry without device.udid");
  }
  if (!stamp?.buildId) {
    throw new Error(
      "cannot write iOS deploy ledger entry without stamp.buildId",
    );
  }
  const entry = {
    source,
    deployedAt,
    bundleId,
    device: {
      identifier: device.identifier ?? null,
      udid: device.udid,
      name: device.name ?? null,
    },
    buildId: stamp.buildId,
    commit: normalizeCommit(stamp.commit),
    builtAt: stamp.builtAt ?? null,
    variant: stamp.variant ?? null,
    capacitorTarget: stamp.capacitorTarget ?? null,
    runtimeMode: stamp.runtimeMode ?? null,
  };
  const ledgerPath = iosDeployLedgerPath(stateDir);
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.appendFileSync(ledgerPath, `${JSON.stringify(entry)}\n`);
  return { entry, ledgerPath };
}

export function readIosDeployLedgerEntries({
  stateDir = resolveDeviceStatusStateDir(),
} = {}) {
  const ledgerPath = iosDeployLedgerPath(stateDir);
  if (!fs.existsSync(ledgerPath)) return [];
  return fs
    .readFileSync(ledgerPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function latestIosDeployLedgerEntry({ entries, udid, bundleId } = {}) {
  const wantedUdid = String(udid ?? "").toLowerCase();
  const wantedBundle = String(bundleId ?? "");
  return [...(entries ?? [])]
    .reverse()
    .find(
      (entry) =>
        String(entry?.device?.udid ?? "").toLowerCase() === wantedUdid &&
        String(entry?.bundleId ?? "") === wantedBundle,
    );
}
