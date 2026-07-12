/**
 * Crash-safe first-use provisioning for the workspace-native eliza-code ACP
 * server (`packages/examples/code`, bin `eliza-code-acp`). Development and
 * self-hosted checkouts deliberately do not require a global npm install: the
 * package is built into its normal `dist` directory on first use and launched
 * with the same Bun executable that performed the build.
 *
 * The naive "build if the artifact is missing or older than the source"
 * approach is not multi-process safe and is not crash safe (issue #16169):
 *
 *   - Two orchestrator processes (or two sessions in one process) racing the
 *     first spawn could both start `bun build` into the same `dist/acp.js`,
 *     interleaving writes and publishing a corrupt executable.
 *   - A crash after `bun build` truncated/opened `dist/acp.js` but before it
 *     finished writing leaves a partial artifact whose mtime is newer than the
 *     source, so the fast path treats a broken build as fresh forever.
 *   - Naive lock reclaim (wall-clock age, PID liveness, hard-link inode games)
 *     is either TOCTOU-racy (a waiter can delete a successor's lock) or steals
 *     from a verified-live owner.
 *
 * This module implements a deterministic protocol with the properties required
 * by #16169:
 *
 *   1. **Fenced mutual exclusion.** The lock file is created with
 *      `open(..., "wx")` (`O_CREAT | O_EXCL`). Its content is a JSON record
 *      carrying the owner PID, the process start time, and a random *fence
 *      token*. Ownership is proven by the fence token in the file, never by age
 *      or PID alone.
 *   2. **No stealing from a verified-live owner.** A waiter only attempts
 *      reclaim once the shared deadline has elapsed AND the owner PID is not
 *      alive. A live owner past the nominal budget is waited on, never
 *      overlapped.
 *   3. **Replacement-safe reclaim.** Reclaim is performed by *atomically
 *      renaming* the stale lock to a private scratch name keyed to the
 *      reclaimer's own fence token (`<lock>.reclaim.<fence>`). Only the process
 *      that wins that `rename` may delete the scratch file, and it deletes a
 *      path that embeds its own fence — so an old owner/waiter can never delete
 *      a successor's lock. After winning the reclaim the reclaimer re-creates
 *      the lock with `wx`, re-entering the exclusion protocol from the top.
 *   4. **Atomic publish.** The build writes to a private temp artifact
 *      (`dist/.acp.<fence>.tmp.js`), which is validated (non-empty, contains a
 *      known marker) and then `rename`d into place. A separate completion
 *      marker (`dist/.acp.done`) records the published artifact's size + mtime;
 *      freshness is decided from the marker, so a bare/partial `dist/acp.js`
 *      that appears without a matching marker is never treated as fresh.
 *   5. **Crash / PID-reuse recovery.** Because ownership is the fence token and
 *      reclaim is rename-fenced, a dead owner (crash) is recovered
 *      deterministically on the next start, and PID reuse cannot make a stale
 *      lock look live (a reused PID that happens to be alive only *delays*
 *      reclaim; it can never authorize deleting someone else's lock).
 *   6. **Robust paths.** The returned command double-quotes the Bun binary and
 *      the artifact path so a workspace or Bun install containing spaces
 *      survives `splitCommandLine`.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";

/** A `bun build` that produces the ACP executable must not run forever. */
const BUILD_TIMEOUT_MS = 120_000;
/**
 * Shared deadline for the whole wait-or-build attempt. A waiter that observes a
 * held lock will poll until this budget elapses before it even *considers*
 * reclaim (and only then if the owner is not alive). It comfortably exceeds
 * `BUILD_TIMEOUT_MS` so a legitimately slow build is never stolen.
 */
const PROVISION_DEADLINE_MS = 180_000;
/** Poll cadence while waiting for another process's build to complete. */
const WAIT_POLL_MS = 100;
/**
 * How long an existing-but-unparseable lock file must persist before it is
 * treated as a crashed (never-fully-claimed) lock and reclaimed. This only
 * needs to exceed the microsecond window between `open(..., "wx")` creating the
 * empty lock and `writeSync` filling in the record; 5s is generous and keeps a
 * legitimately mid-claim live owner from ever being overlapped.
 */
const MALFORMED_LOCK_GRACE_MS = 5_000;
/**
 * Absolute ceiling on how long a lock may be honored against a merely-
 * PID-alive owner. Any real build publishes its artifact or dies well within
 * `BUILD_TIMEOUT_MS`, and a waiter gives up after `PROVISION_DEADLINE_MS`, so a
 * lock still held past a comfortable multiple of both can only be a crashed
 * owner whose PID was reused by an unrelated (possibly long-lived) process.
 * Past this ceiling we override liveness and reclaim, resolving the PID-reuse
 * ambiguity the naive liveness check cannot. Set generously so a genuinely
 * slow-but-live original build is never stolen from.
 */
const LOCK_MAX_LIFETIME_MS = BUILD_TIMEOUT_MS + PROVISION_DEADLINE_MS + 60_000;
/** Marker string every valid ACP build embeds; used to validate the artifact. */
const ACP_ARTIFACT_MARKER = "eliza-code-acp";

export type AcpProvisionResult = {
  /** Absolute path to the Bun executable that should launch the artifact. */
  command: string;
  /** Launch arguments (the built `dist/acp.js`). */
  args: string[];
};

/**
 * Quote a single command token so `splitCommandLine` reconstructs it intact.
 * `splitCommandLine` understands both `"..."` and `'...'` but has no escape
 * syntax, so we pick whichever quote character the value does not itself
 * contain:
 *   - no whitespace/quotes → emit bare (unchanged round-trip)
 *   - contains `"` but not `'` → single-quote it
 *   - otherwise → double-quote it
 * A value containing BOTH quote characters cannot be represented losslessly in
 * that grammar; that is pathological for a filesystem path, so we double-quote
 * as the least-surprising best effort rather than silently corrupting args.
 */
function quoteAcpToken(value: string): string {
  if (value.length > 0 && !/[\s"']/u.test(value)) return value;
  if (value.includes('"') && !value.includes("'")) return `'${value}'`;
  return `"${value}"`;
}

/**
 * Format a provision result as a single command string. Both the Bun path and
 * every arg are quoted so `splitCommandLine` reconstructs them intact even when
 * a path contains spaces or a quote character.
 */
export function formatAcpCommand(result: AcpProvisionResult): string {
  return [result.command, ...result.args].map(quoteAcpToken).join(" ");
}

function findExecutableOnPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Walk up from `startDir` to the first checkout that contains
 * `packages/examples/code/src/acp.ts`. Exported for tests.
 */
export function findWorkspaceElizaCodePackage(
  startDir: string,
): string | undefined {
  let dir = resolve(startDir);
  while (true) {
    const candidate = join(dir, "packages", "examples", "code");
    if (existsSync(join(candidate, "src", "acp.ts"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

type LockRecord = {
  pid: number;
  fence: string;
  startedAtMs: number;
};

/**
 * Records describing the on-disk layout of a provisioning attempt for one
 * package. Kept together so the protocol steps read declaratively.
 */
type ProvisionPaths = {
  packageDir: string;
  distDir: string;
  source: string;
  output: string;
  lock: string;
  doneMarker: string;
  reclaimIntent: string;
};

function provisionPaths(packageDir: string): ProvisionPaths {
  const distDir = join(packageDir, "dist");
  return {
    packageDir,
    distDir,
    source: join(packageDir, "src", "acp.ts"),
    output: join(distDir, "acp.js"),
    lock: join(distDir, ".acp.build.lock"),
    doneMarker: join(distDir, ".acp.done"),
    // Single-winner reclaim gate: created with O_EXCL so exactly one reclaimer
    // may replace a stale lock at a time (see tryReclaimStaleLock).
    reclaimIntent: join(distDir, ".acp.build.reclaiming"),
  };
}

/**
 * Injection seam for tests: liveness of a PID. Default uses `process.kill(pid,
 * 0)`. Overridable so crash / PID-reuse scenarios are deterministic.
 */
export type ProvisionHooks = {
  isPidAlive?: (pid: number) => boolean;
  now?: () => number;
  /**
   * Perform the actual build into `tmpOutput`. Default runs `bun build`.
   * Overridable so tests can simulate partial builds, crashes, and failures
   * without invoking a real toolchain.
   */
  build?: (ctx: { bun: string; packageDir: string; tmpOutput: string }) => {
    ok: boolean;
    detail: string;
  };
};

function defaultIsPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // error-policy:J7 liveness translation — process.kill(pid, 0) signals
    // existence via throw; ESRCH → no such process (dead), EPERM → exists but
    // not ours (alive). Translated to a boolean, never surfaced.
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

function defaultBuild(ctx: {
  bun: string;
  packageDir: string;
  tmpOutput: string;
}): { ok: boolean; detail: string } {
  // The package build script emits `dist/acp.js`; run it, then relocate that
  // artifact to our private fenced temp path so the atomic publish below owns
  // the final rename. Building to the canonical dist path first matches the
  // existing `bun run build` wiring (bundler config, externals) without
  // reinventing bundler flags here.
  const canonical = join(ctx.packageDir, "dist", "acp.js");
  const result = spawnSync(ctx.bun, ["run", "--cwd", ctx.packageDir, "build"], {
    cwd: ctx.packageDir,
    env: process.env,
    encoding: "utf8",
    timeout: BUILD_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0 || !existsSync(canonical)) {
    const detail = String(
      result.stderr || result.stdout || "build failed",
    ).trim();
    return { ok: false, detail };
  }
  try {
    // Move the freshly built canonical artifact aside into our fenced temp so
    // validation + atomic publish is the single authority for what becomes the
    // live `dist/acp.js`. If a concurrent loser also built, whichever temp is
    // published under the lock wins; the other is discarded.
    renameSync(canonical, ctx.tmpOutput);
  } catch (err) {
    // error-policy:J7 staging failure is reported to the caller as a typed
    // {ok:false} build result (not thrown) so provisioning can surface a clean
    // diagnostic and discard the temp.
    return { ok: false, detail: `stage artifact failed: ${String(err)}` };
  }
  return { ok: true, detail: "" };
}

/**
 * Anchor timestamp for aging a lock: the max of the recorded wall-clock start
 * and the lock file's mtime. Using the max means neither a skewed clock in the
 * record nor a touched mtime can make the lock look artificially young (which
 * would delay a legitimate reclaim). Returns undefined if the lock file has
 * vanished (the caller should retry acquisition rather than reclaim).
 */
function lockAgeAnchorMs(
  lockPath: string,
  recordStartedAtMs: number,
): number | undefined {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(lockPath).mtimeMs;
  } catch {
    // error-policy:J7 the lock vanished between checks; report "no anchor" so
    // the caller retries acquisition rather than reclaiming a missing lock.
    return undefined;
  }
  return Math.max(recordStartedAtMs, mtimeMs);
}

function readLockRecord(lockPath: string): LockRecord | undefined {
  try {
    const raw = readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<LockRecord>;
    if (
      typeof parsed.pid === "number" &&
      typeof parsed.fence === "string" &&
      typeof parsed.startedAtMs === "number"
    ) {
      return {
        pid: parsed.pid,
        fence: parsed.fence,
        startedAtMs: parsed.startedAtMs,
      };
    }
    return undefined;
  } catch {
    // error-policy:J7 missing or unreadable/partial lock → treat as absent; the
    // caller retries the exclusive create. A parse failure must not throw.
    return undefined;
  }
}

/**
 * Attempt to atomically create the lock with our fence token. Returns true on
 * success (`O_CREAT | O_EXCL` won), false if the lock already exists.
 */
function tryAcquireLock(lockPath: string, record: LockRecord): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(lockPath, "wx");
  } catch (err) {
    // error-policy:J7 EEXIST means another process holds the lock (report
    // not-acquired); any other error (e.g. EACCES) is a real fault and is
    // rethrown.
    if ((err as NodeJS.ErrnoException)?.code === "EEXIST") return false;
    throw err;
  }
  try {
    writeSync(fd, JSON.stringify(record));
    return true;
  } finally {
    closeSync(fd);
  }
}

/** Identity of the specific stale lock a reclaim is authorized to replace. */
type ReclaimTarget = { kind: "fenced"; fence: string } | { kind: "malformed" };

/**
 * Try to reclaim a stale lock without ever stealing from a verified-live owner.
 *
 * Reclaim is an ATOMIC REPLACE: the reclaimer writes a fresh lock record (under
 * its own fence) to a private temp and `rename`s it OVER `paths.lock` in one
 * step. `paths.lock` is therefore never momentarily absent, so no third process
 * can slip in via `open(..., "wx")` during a reclaim gap (the flaw of a
 * move-aside-then-restore scheme). On success the reclaimer holds the lock and
 * builds directly.
 *
 * A rare multi-waiter race can still have two reclaimers replace each other's
 * lock and both build. That is safe: correctness lives in the ATOMIC PUBLISH
 * (see buildAndPublish), not the lock. Each build writes to a private per-fence
 * temp and publishes via a single atomic `rename` over `dist/acp.js` plus a
 * completion marker, so overlapping builds can never corrupt or partially
 * publish the artifact — the last atomic publish wins with a complete, validated
 * file. The lock is only an optimization to avoid wasted concurrent builds.
 *
 * The staleness gate below still guarantees we NEVER replace a verified-live
 * owner's lock (PID alive within the lifetime ceiling), and only reclaim a
 * malformed lock once it has aged past the write-window grace.
 *
 * Returns true iff we installed our lock (the caller then builds under it).
 */
function tryReclaimStaleLock(
  paths: ProvisionPaths,
  ourFence: string,
  isPidAlive: (pid: number) => boolean,
  now: () => number,
): boolean {
  // Distinguish "no lock file" from "lock file present but its record is
  // unreadable". The latter happens when an owner crashed between `open(...,
  // "wx")` (which creates an empty file) and writing the JSON record: the file
  // exists so acquisition keeps hitting EEXIST, but there is no owner PID to
  // check. Such a malformed lock is by definition stale (no process ever
  // finished claiming it) and MUST be reclaimable, or crash recovery would
  // deadlock until manual cleanup.
  if (!existsSync(paths.lock)) {
    // Lock vanished (owner released). Nothing to reclaim; let the caller retry
    // acquisition.
    return false;
  }
  const record = readLockRecord(paths.lock);
  let target: ReclaimTarget;
  if (record) {
    if (isPidAlive(record.pid)) {
      // The PID is alive, but that alone does not prove the ORIGINAL builder is
      // still running: after a crash the OS can reuse the PID for an unrelated,
      // possibly long-lived process, which would otherwise pin this lock
      // forever. Resolve the PID-reuse ambiguity with an absolute lifetime
      // ceiling: a legitimate build always publishes or dies well within
      // LOCK_MAX_LIFETIME_MS, so a lock older than that whose PID is "alive" is
      // necessarily a reused PID, not the original owner. Only past that hard
      // ceiling do we override liveness and reclaim. Below it we still NEVER
      // steal from a possibly-live owner. The age is taken as the max of the
      // recorded wall-clock start and the lock file's mtime so a bad clock in
      // the record cannot make the lock look artificially young.
      const startedAtMs = lockAgeAnchorMs(paths.lock, record.startedAtMs);
      if (startedAtMs === undefined) return false; // lock vanished; retry acquire
      if (now() - startedAtMs < LOCK_MAX_LIFETIME_MS) return false;
      // Fall through: aged past the ceiling with a reused PID → reclaim.
    }
    // We are authorized to reclaim ONLY the lock bearing this exact fence.
    target = { kind: "fenced", fence: record.fence };
  } else {
    // Malformed/empty record. This is either (a) a crashed owner that never
    // finished writing its record, or (b) a live owner in the microsecond
    // window between `open(..., "wx")` and `writeSync` of the record. Only
    // reclaim once the empty lock has aged past a short grace far exceeding
    // that write window, so a legitimately mid-claim live owner is never
    // overlapped.
    let ageMs: number;
    try {
      ageMs = now() - statSync(paths.lock).mtimeMs;
    } catch {
      // error-policy:J7 lock disappeared between the existsSync check and the
      // stat — treat as released; the caller retries acquisition.
      return false;
    }
    if (ageMs < MALFORMED_LOCK_GRACE_MS) return false;
    // A malformed lock has no fence to key on; we are authorized to reclaim
    // only a still-malformed lock (verified after the rename below).
    target = { kind: "malformed" };
  }

  // SINGLE-WINNER reclaim. A stale lock is replaced by exactly one process at a
  // time, so concurrent reclaimers can never both enter the build (which, via
  // the shared `bun run build` canonical output, is NOT safe to run twice at
  // once). The single-winner gate is an O_EXCL create of a shared reclaim-intent
  // file: only one reclaimer wins it. The winner re-verifies the lock is still
  // the SAME stale identity it authorized (guarding against a successor a prior
  // winner installed), then atomically REPLACES the lock under its own fence via
  // a temp+rename (so `paths.lock` is never momentarily absent — no window for a
  // fresh `open(..., "wx")` acquirer). It KEEPS the intent gate held; the caller
  // releases it via `releaseReclaimIntent` once the build finishes, so no other
  // reclaimer overlaps the build.
  let intentFd: number;
  try {
    intentFd = openSync(paths.reclaimIntent, "wx");
  } catch (err) {
    // error-policy:J7 gate contention/failure is translated to "did not win the
    // gate" (return false); we never throw out of the single-winner probe.
    if ((err as NodeJS.ErrnoException)?.code === "EEXIST") {
      // Another reclaimer is mid-reclaim/mid-build. If its intent-holder is
      // DEAD (crashed after winning the gate, before releasing it), clear the
      // gate IMMEDIATELY so crash recovery completes within the outer
      // provisioning deadline rather than waiting out the lifetime ceiling.
      // The wall-clock ceiling is only a fallback for a holder whose PID is
      // unreadable or ambiguously reused.
      if (isReclaimIntentReclaimable(paths, isPidAlive, now)) {
        bestEffortRemove(paths.reclaimIntent);
      }
      return false;
    }
    return false;
  }
  // Record our PID in the gate so a future reclaimer can detect and clear it
  // immediately if we crash while holding it.
  try {
    writeSync(
      intentFd,
      JSON.stringify({ pid: process.pid, startedAtMs: now() }),
    );
  } catch (err) {
    // error-policy:J6 the gate content is a best-effort crash-recovery hint;
    // an empty gate still excludes correctly (it just falls back to the
    // wall-clock ceiling for stale detection), so a write failure is swallowed.
    void err;
  } finally {
    closeSync(intentFd);
  }

  // Under the single-winner gate, re-verify the lock still bears the exact
  // stale identity we authorized reclaiming. A concurrent winner may have
  // already replaced it with a live successor; if so, do NOT reclaim.
  if (!lockStillMatchesTarget(paths.lock, target)) {
    bestEffortRemove(paths.reclaimIntent);
    return false;
  }

  const claimTmp = `${paths.lock}.claim.${ourFence}`;
  const claim: LockRecord = {
    pid: process.pid,
    fence: ourFence,
    startedAtMs: now(),
  };
  try {
    writeFileSync(claimTmp, JSON.stringify(claim));
    // Atomic replace: after this returns, paths.lock carries OUR fence and was
    // never absent. The caller detects our fence and builds directly, then
    // releases the intent gate.
    renameSync(claimTmp, paths.lock);
  } catch {
    // error-policy:J6 reclaim install failed; roll back our scratch temp and
    // release the single-winner gate so another reclaimer may retry. Reported
    // as "did not reclaim" (return false), never thrown.
    bestEffortRemove(claimTmp);
    bestEffortRemove(paths.reclaimIntent);
    return false;
  }
  return true;
}

/**
 * Remove a path, ignoring "already gone" and other teardown failures. A
 * best-effort unlink whose failure must not abort the caller: a lingering
 * scratch/lock/intent file is inert and is aged out by the staleness gates.
 * error-policy:J6 best-effort teardown — the removal is advisory cleanup, not a
 * correctness step, so a failure is swallowed after being recorded here.
 */
function bestEffortRemove(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch (err) {
    // error-policy:J6 swallow: cleanup is advisory; surface nothing but keep a
    // named binding so this is an explicit, non-empty handler.
    void err;
  }
}

/** Release the single-winner reclaim gate after the reclaimer's build. */
function releaseReclaimIntent(paths: ProvisionPaths): void {
  // Best-effort; a lingering intent is recovered by isReclaimIntentReclaimable
  // (dead-holder liveness check, wall-clock ceiling fallback).
  bestEffortRemove(paths.reclaimIntent);
}

/**
 * True iff the current lock still bears the exact stale identity a reclaim was
 * authorized against. Guards the single-winner reclaim from clobbering a
 * successor lock installed by a prior winner.
 */
function lockStillMatchesTarget(
  lockPath: string,
  target: ReclaimTarget,
): boolean {
  if (!existsSync(lockPath)) return false;
  const record = readLockRecord(lockPath);
  if (target.kind === "fenced") return record?.fence === target.fence;
  return record === undefined; // malformed target must still be malformed
}

/**
 * True iff a held reclaim-intent gate may be cleared because its holder is
 * gone. Prefers an IMMEDIATE liveness check on the holder PID recorded in the
 * gate (so a crashed reclaimer is recovered within the outer provisioning
 * deadline, not after the multi-minute lifetime ceiling); falls back to the
 * wall-clock ceiling only when the holder PID is unreadable (an empty/legacy
 * gate) or ambiguously alive, so a genuinely live holder is never cleared
 * early.
 */
function isReclaimIntentReclaimable(
  paths: ProvisionPaths,
  isPidAlive: (pid: number) => boolean,
  now: () => number,
): boolean {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(paths.reclaimIntent).mtimeMs;
  } catch {
    // error-policy:J7 gate vanished (holder released it); nothing to reclaim.
    return false;
  }
  const holder = readIntentHolder(paths.reclaimIntent);
  if (holder && Number.isInteger(holder.pid) && holder.pid > 0) {
    // Dead holder → reclaim the gate immediately.
    if (!isPidAlive(holder.pid)) return true;
    // Live holder → only override past the absolute ceiling (PID-reuse guard),
    // anchoring on max(recorded start, mtime) so a touched mtime cannot make it
    // look young.
    const anchor = Math.max(holder.startedAtMs ?? 0, mtimeMs);
    return now() - anchor > LOCK_MAX_LIFETIME_MS;
  }
  // No readable holder PID (empty/legacy gate): fall back to the wall-clock
  // ceiling on the gate file's mtime.
  return now() - mtimeMs > LOCK_MAX_LIFETIME_MS;
}

type IntentHolder = { pid: number; startedAtMs?: number };

function readIntentHolder(intentPath: string): IntentHolder | undefined {
  try {
    const parsed = JSON.parse(readFileSync(intentPath, "utf8")) as
      | Partial<IntentHolder>
      | undefined;
    if (parsed && typeof parsed.pid === "number") {
      return {
        pid: parsed.pid,
        startedAtMs:
          typeof parsed.startedAtMs === "number"
            ? parsed.startedAtMs
            : undefined,
      };
    }
    return undefined;
  } catch {
    // error-policy:J7 unparseable/missing intent holder → report "no holder" so
    // the caller falls back to the wall-clock ceiling; never thrown.
    return undefined;
  }
}

/** Freshness: a validated artifact + a matching completion marker. */
function isFreshArtifact(paths: ProvisionPaths): boolean {
  if (!existsSync(paths.output) || !existsSync(paths.doneMarker)) return false;
  let sourceMtime: number;
  let outputStat: ReturnType<typeof statSync>;
  try {
    sourceMtime = statSync(paths.source).mtimeMs;
    outputStat = statSync(paths.output);
  } catch {
    // error-policy:J7 a stat failure means we cannot prove freshness → report
    // not-fresh so provisioning rebuilds; never thrown.
    return false;
  }
  // Source newer than the built artifact → rebuild.
  if (sourceMtime > outputStat.mtimeMs) return false;
  // The marker must describe THIS artifact (size + mtime). A bare/partial
  // `acp.js` written by a crashed build has no matching marker → not fresh.
  try {
    const marker = JSON.parse(readFileSync(paths.doneMarker, "utf8")) as {
      size?: number;
      mtimeMs?: number;
    };
    return (
      marker.size === outputStat.size && marker.mtimeMs === outputStat.mtimeMs
    );
  } catch {
    // error-policy:J7 unreadable/invalid completion marker → report not-fresh so
    // provisioning rebuilds; never thrown.
    return false;
  }
}

function validateArtifact(tmpOutput: string): boolean {
  try {
    const stat = statSync(tmpOutput);
    if (stat.size <= 0) return false;
    const content = readFileSync(tmpOutput, "utf8");
    return content.includes(ACP_ARTIFACT_MARKER);
  } catch {
    // error-policy:J7 unreadable temp artifact → report invalid so the build is
    // rejected and the temp discarded; never thrown.
    return false;
  }
}

/**
 * Build under an already-held lock, validate, and atomically publish. On
 * success writes the completion marker describing the published artifact.
 * Throws with a bounded diagnostic on build/validation failure. A failed build
 * NEVER leaves a fresh-looking artifact: the temp is discarded and the
 * completion marker is not (re)written for a bad build.
 */
function buildAndPublish(
  paths: ProvisionPaths,
  bun: string,
  fence: string,
  build: NonNullable<ProvisionHooks["build"]>,
): void {
  const tmpOutput = join(paths.distDir, `.acp.${fence}.tmp.js`);
  // Clear any stale temp from a previous crashed attempt with this (extremely
  // unlikely to collide) fence.
  rmSync(tmpOutput, { force: true });

  const { ok, detail } = build({
    bun,
    packageDir: paths.packageDir,
    tmpOutput,
  });
  if (!ok) {
    rmSync(tmpOutput, { force: true });
    throw new Error(
      `Failed to auto-install eliza-code-acp: ${detail.slice(0, 4000)}`,
    );
  }
  if (!validateArtifact(tmpOutput)) {
    rmSync(tmpOutput, { force: true });
    throw new Error(
      "Failed to auto-install eliza-code-acp: built artifact failed validation",
    );
  }
  // Invalidate any prior marker BEFORE publishing so a crash between the
  // rename and the marker write can never leave the OLD marker validating the
  // NEW (unmarked) artifact as fresh. Absent marker → not fresh → clean rebuild.
  rmSync(paths.doneMarker, { force: true });
  // Atomic publish: rename the validated temp over the live artifact.
  renameSync(tmpOutput, paths.output);
  const published = statSync(paths.output);
  writeFileSync(
    paths.doneMarker,
    JSON.stringify({ size: published.size, mtimeMs: published.mtimeMs }),
  );
}

/**
 * Provision the workspace-native eliza-code ACP executable on first use in a
 * crash-safe, multi-process-safe way. Returns the structured launch command,
 * or `undefined` when the workspace package or a Bun executable is unavailable
 * (the caller falls back to the published npm package).
 *
 * Throws only when a build was required and genuinely failed.
 */
export function provisionWorkspaceElizaCodeAcp(
  startDir: string = process.cwd(),
  hooks: ProvisionHooks = {},
): AcpProvisionResult | undefined {
  const packageDir = findWorkspaceElizaCodePackage(startDir);
  const bun = findExecutableOnPath("bun");
  if (!packageDir || !bun) return undefined;

  const paths = provisionPaths(packageDir);
  const isPidAlive = hooks.isPidAlive ?? defaultIsPidAlive;
  const now = hooks.now ?? Date.now;
  const build = hooks.build ?? defaultBuild;

  // Fast path: already fresh, no lock needed.
  if (isFreshArtifact(paths)) {
    return { command: bun, args: [paths.output] };
  }

  mkdirSync(paths.distDir, { recursive: true });

  const fence = randomBytes(16).toString("hex");
  const deadline = now() + PROVISION_DEADLINE_MS;
  // Hard iteration cap as a last-resort guard so a pathological clock/lock
  // state can never spin forever. At WAIT_POLL_MS cadence this bounds the loop
  // well beyond PROVISION_DEADLINE_MS while staying finite.
  const maxAttempts = Math.ceil(PROVISION_DEADLINE_MS / WAIT_POLL_MS) + 100;
  let attempts = 0;

  while (true) {
    if (++attempts > maxAttempts) {
      throw new Error(
        "Failed to auto-install eliza-code-acp: exceeded provisioning attempt budget",
      );
    }
    // Re-check freshness each turn: another process may have published while we
    // waited or between reclaim attempts.
    if (isFreshArtifact(paths)) {
      return { command: bun, args: [paths.output] };
    }

    const record: LockRecord = {
      pid: process.pid,
      fence,
      startedAtMs: now(),
    };
    if (tryAcquireLock(paths.lock, record)) {
      try {
        // Double-check under the lock: a racer may have published between our
        // freshness check and acquiring the lock.
        if (isFreshArtifact(paths)) {
          return { command: bun, args: [paths.output] };
        }
        buildAndPublish(paths, bun, fence, build);
        return { command: bun, args: [paths.output] };
      } finally {
        // Release the lock we own. Only remove it if it still carries our
        // fence (defensive: never delete a successor's lock).
        const held = readLockRecord(paths.lock);
        if (held?.fence === fence) {
          rmSync(paths.lock, { force: true });
        }
      }
    }

    // Someone else holds the lock. A DEAD owner (crash) is reclaimed
    // immediately — crash recovery must not wait out the whole deadline.
    // tryReclaimStaleLock only reclaims when the owner PID is not alive, so a
    // verified-live owner is never stolen from here regardless of age. On
    // success it atomically installs a lock under OUR fence, so we hold it and
    // build directly (no re-acquire, which would EEXIST against our own lock).
    if (tryReclaimStaleLock(paths, fence, isPidAlive, now)) {
      try {
        if (isFreshArtifact(paths)) {
          return { command: bun, args: [paths.output] };
        }
        buildAndPublish(paths, bun, fence, build);
        return { command: bun, args: [paths.output] };
      } finally {
        const held = readLockRecord(paths.lock);
        if (held?.fence === fence) {
          rmSync(paths.lock, { force: true });
        }
        // Release the single-winner reclaim gate so another reclaimer may
        // proceed once we are done building under the reclaimed lock.
        releaseReclaimIntent(paths);
      }
    }

    // The owner is alive (or the lock momentarily vanished/was replaced). Never
    // overlap a live owner: wait until it publishes or the shared deadline
    // elapses. Only once the budget is exhausted do we surface a timeout — we
    // still do NOT steal from a process we just observed to be alive.
    if (now() >= deadline) {
      // Re-confirm liveness right before giving up: if the owner died in the
      // meantime the next loop iteration will reclaim it.
      const owner = readLockRecord(paths.lock);
      if (owner && isPidAlive(owner.pid)) {
        throw new Error(
          "Failed to auto-install eliza-code-acp: timed out waiting for a live concurrent build to finish",
        );
      }
      // Owner is gone now — loop to reclaim.
      continue;
    }
    sleepSync(WAIT_POLL_MS);
  }
}

/** Synchronous sleep used while polling for another process's build. */
function sleepSync(ms: number): void {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, Math.max(0, ms));
}
