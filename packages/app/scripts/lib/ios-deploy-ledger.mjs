/**
 * Deploy ledger for physical-iPhone sideloads: records which renderer buildId +
 * git commit was last installed on which device, so `devices:status` can answer
 * "is this phone running develop HEAD?" without reading the app's sandboxed
 * container (a physical iOS device does not expose it).
 *
 * `ios-device-deploy.mjs` stages `App.app` locally before install, so the ledger
 * is written deploy-side: it reads the staged renderer stamp
 * (`public/eliza-renderer-build.json`, produced by the vite
 * `renderer-build-manifest` plugin) and appends one JSONL record per successful
 * install. `devices:status` (issue #14338) is the sole reader; when a device has
 * no ledger row it reports "unknown — no ledger entry" honestly rather than
 * guessing (a phone flashed by other means was never recorded here). The
 * boot-trace pull remains the ground-truth cross-check.
 *
 * Everything here is pure or takes the filesystem edge as the JSONL path, so the
 * append/read/latest-per-device logic is unit-tested against fixtures without a
 * device. The renderer stamp itself — path resolution and typed read — lives in
 * `lib/ios-renderer-stamp.mjs` (the single source of truth the simulator lanes
 * also use); this module owns only the deploy-side, non-throwing freshness
 * *verdict* ({@link evaluateStagedRendererFreshness}) the device deploy renders
 * before install to refuse a staged bundle whose buildId does not match the
 * freshly built dist (a stale UI would otherwise ship silently — issue #9309's
 * failure mode, on the device lane).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Resolve the per-user state dir for the ledger, honoring the documented
 * branded-first precedence (`MILADY_STATE_DIR` > `ELIZA_STATE_DIR` >
 * `$XDG_STATE_HOME/<namespace>` > `~/.local/state/<namespace>`). Mirrors
 * `packages/core/src/utils/state-dir.ts` — that module is TypeScript and cannot
 * be imported from a plain build script, so the precedence is reproduced here.
 * Kept in lockstep: any change to the canonical resolver must land here too.
 *
 * @param {{ env?: Record<string, string | undefined>, homedir?: () => string }} [options]
 * @returns {string}
 */
export function resolveLedgerStateDir({
  env = process.env,
  homedir = os.homedir,
} = {}) {
  const explicit = (env.MILADY_STATE_DIR ?? env.ELIZA_STATE_DIR)?.trim();
  if (explicit) return path.resolve(explicit);
  const namespace = env.ELIZA_NAMESPACE?.trim() || "eliza";
  const xdg = env.XDG_STATE_HOME?.trim();
  if (xdg) {
    return path.isAbsolute(xdg)
      ? path.join(xdg, namespace)
      : path.join(homedir(), xdg, namespace);
  }
  return path.join(homedir(), ".local", "state", namespace);
}

/**
 * Absolute path to the deploy-ledger JSONL. One file for all devices; each line
 * is a self-contained deploy record (see {@link appendDeployRecord}).
 *
 * @param {{ env?: Record<string, string | undefined>, homedir?: () => string }} [options]
 * @returns {string}
 */
export function resolveDeployLedgerPath(options = {}) {
  return path.join(
    resolveLedgerStateDir(options),
    "device-deploy-ledger.jsonl",
  );
}

export const DEPLOY_LEDGER_SCHEMA = "elizaos.device.deploy-ledger/v1";

/**
 * Build a validated deploy record. `udid` + `buildId` are required — a record
 * that cannot identify the device or the renderer it received is useless to the
 * status reader, so this throws rather than writing a hole. `deployedAt`
 * defaults to now (ISO 8601). `commit` is nullable only because the renderer
 * stamp itself carries a nullable commit (a build outside a git checkout).
 *
 * @param {{
 *   udid: string,
 *   buildId: string,
 *   name?: string | null,
 *   identifier?: string | null,
 *   commit?: string | null,
 *   variant?: string | null,
 *   runtimeMode?: string | null,
 *   skippedAppexes?: boolean,
 *   deployedAt?: string,
 * }} input
 * @returns {{
 *   schema: string, udid: string, buildId: string, name: string | null,
 *   identifier: string | null, commit: string | null, variant: string | null,
 *   runtimeMode: string | null, skippedAppexes: boolean, deployedAt: string,
 * }}
 */
export function buildDeployRecord(input) {
  const udid = input?.udid?.trim();
  const buildId = input?.buildId?.trim();
  if (!udid) throw new Error("buildDeployRecord: udid is required");
  if (!buildId) throw new Error("buildDeployRecord: buildId is required");
  return {
    schema: DEPLOY_LEDGER_SCHEMA,
    udid,
    buildId,
    name: input.name?.trim() || null,
    identifier: input.identifier?.trim() || null,
    commit: input.commit?.trim() || null,
    variant: input.variant?.trim() || null,
    runtimeMode: input.runtimeMode?.trim() || null,
    skippedAppexes: input.skippedAppexes === true,
    deployedAt: input.deployedAt?.trim() || new Date().toISOString(),
  };
}

/**
 * Parse a ledger JSONL string into records, skipping only blank lines. A line
 * that fails to parse throws with its line number — a corrupt ledger is a real
 * problem the operator must see, not silently dropped (that would let a status
 * check read a truncated history as authoritative).
 *
 * @param {string} text
 * @returns {Array<ReturnType<typeof buildDeployRecord>>}
 */
export function parseDeployLedger(text) {
  const records = [];
  const lines = String(text ?? "").split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      records.push(JSON.parse(line));
    } catch (error) {
      // error-policy:J3 untrusted-input — a corrupt ledger line is an explicit
      // failure (not a fabricated-empty history); name the line for the operator.
      throw new Error(
        `parseDeployLedger: malformed JSONL at line ${i + 1}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return records;
}

/**
 * Read the ledger from disk. A missing file is an empty history (no deploys
 * recorded yet) — that is a legitimate empty result, not a masked failure, so
 * it returns `[]`. Any other read error propagates.
 *
 * @param {string} ledgerPath
 * @returns {Array<ReturnType<typeof buildDeployRecord>>}
 */
export function readDeployLedger(ledgerPath) {
  if (!fs.existsSync(ledgerPath)) return [];
  return parseDeployLedger(fs.readFileSync(ledgerPath, "utf8"));
}

/**
 * Append one record to the ledger, creating the state dir + file if absent.
 * JSONL is append-only by construction — concurrent deploys from separate
 * sessions each add their own line without a read-modify-write race.
 *
 * @param {string} ledgerPath
 * @param {ReturnType<typeof buildDeployRecord>} record
 * @returns {ReturnType<typeof buildDeployRecord>}
 */
export function appendDeployRecord(ledgerPath, record) {
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.appendFileSync(ledgerPath, `${JSON.stringify(record)}\n`);
  return record;
}

/**
 * Latest record per device UDID from a record list. JSONL is append-ordered, so
 * the last row for a UDID is its current install; this collapses the history to
 * one row per phone (what `devices:status` renders). Records missing a `udid`
 * are dropped — they cannot be attributed to a device.
 *
 * @param {Array<ReturnType<typeof buildDeployRecord>>} records
 * @returns {Map<string, ReturnType<typeof buildDeployRecord>>}
 */
export function latestDeployByUdid(records) {
  const latest = new Map();
  for (const record of records ?? []) {
    const udid = record?.udid;
    if (typeof udid !== "string" || !udid) continue;
    latest.set(udid, record);
  }
  return latest;
}

/**
 * The honest status of one device against the deploy ledger. `known: false` is
 * the "unknown — no ledger entry" path the design doc (Q7) requires: a device
 * we never recorded a deploy for is reported as unknown, never guessed.
 *
 * @param {Array<ReturnType<typeof buildDeployRecord>>} records
 * @param {string} udid
 * @returns {{ known: false, udid: string, reason: string }
 *          | { known: true, udid: string, record: ReturnType<typeof buildDeployRecord> }}
 */
export function deployStatusForDevice(records, udid) {
  const wanted = udid?.trim();
  if (!wanted) throw new Error("deployStatusForDevice: udid is required");
  const record = latestDeployByUdid(records).get(wanted);
  if (!record) {
    return {
      known: false,
      udid: wanted,
      reason:
        "unknown — no ledger entry (device was flashed by other means; " +
        "cross-check with `ios:device:logs --pull-boot-trace`)",
    };
  }
  return { known: true, udid: wanted, record };
}

/**
 * Renderer-freshness verdict for a deploy: does the buildId the staged bundle
 * carries match the freshly built dist? A device install of a stale renderer is
 * the #9309 footgun (a cached dist copied over a fresh one); the deploy asserts
 * on this before install so the phone never boots yesterday's UI.
 *
 * Both manifests are required — a missing/parse-less stamp is a broken pipeline,
 * not a pass, so the caller throws when it cannot read one. This function is the
 * pure comparison over the two already-read manifests.
 *
 * @param {{ buildId?: string | null, commit?: string | null } | null} staged
 * @param {{ buildId?: string | null, commit?: string | null } | null} fresh
 * @returns {{ fresh: boolean, stagedBuildId: string | null,
 *            freshBuildId: string | null, reason: string }}
 */
export function evaluateStagedRendererFreshness(staged, fresh) {
  const stagedBuildId = staged?.buildId?.trim() || null;
  const freshBuildId = fresh?.buildId?.trim() || null;
  if (!stagedBuildId) {
    return {
      fresh: false,
      stagedBuildId,
      freshBuildId,
      reason:
        "staged App.app has no renderer buildId (public/eliza-renderer-build.json " +
        "missing or unstamped) — rebuild the device lane before deploying",
    };
  }
  if (!freshBuildId) {
    return {
      fresh: false,
      stagedBuildId,
      freshBuildId,
      reason:
        "freshly built dist has no renderer buildId (packages/app/dist/" +
        "eliza-renderer-build.json missing) — run the ios-local build before deploying",
    };
  }
  if (stagedBuildId !== freshBuildId) {
    return {
      fresh: false,
      stagedBuildId,
      freshBuildId,
      reason:
        `staged renderer buildId ${stagedBuildId.slice(0, 12)} != freshly built ` +
        `${freshBuildId.slice(0, 12)} — the device would boot a STALE UI (issue #9309). ` +
        "Rebuild without --skip-build, or re-stage from a matching dist.",
    };
  }
  return {
    fresh: true,
    stagedBuildId,
    freshBuildId,
    reason: `renderer buildId ${stagedBuildId.slice(0, 12)} matches freshly built dist`,
  };
}
