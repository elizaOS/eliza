/**
 * Process-owned directory lock for UI-smoke view builds and audit evidence.
 * A live owner is authoritative regardless of run length; age only reclaims a
 * lock whose owner metadata cannot be read. An atomic generation-scoped claim
 * serializes stale-owner replacement, and releases verify ownership so a
 * superseded process cannot remove a newer lock.
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function normalizeOwner(value) {
  if (!value || typeof value !== "object") return null;
  const pid = Number(value.pid);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return {
    pid,
    token: typeof value.token === "string" ? value.token : null,
    acquiredAt: typeof value.acquiredAt === "string" ? value.acquiredAt : null,
  };
}

export function readUiSmokeLockOwner(lockDir) {
  try {
    const raw = fs.readFileSync(path.join(lockDir, "owner"), "utf8");
    try {
      return normalizeOwner(JSON.parse(raw));
    } catch (error) {
      // error-policy:J3 Locks created by older runners used a line-based owner
      // file. Preserve their live-pid protection while treating any other
      // malformed metadata as explicitly unreadable.
      if (!(error instanceof SyntaxError)) throw error;
      const pid = Number.parseInt(raw.split(/\r?\n/, 1)[0] ?? "", 10);
      return Number.isInteger(pid) && pid > 0
        ? { pid, token: null, acquiredAt: null }
        : null;
    }
  } catch (error) {
    // error-policy:J3 A creator may be between mkdir and owner write, or a
    // crashed process may leave malformed state. Callers age-gate this
    // explicit unreadable result instead of assuming an active or stale owner.
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export function uiSmokeLockStatus(
  owner,
  { ageMs, staleAfterMs, isProcessAlive },
) {
  if (owner) {
    return isProcessAlive(owner.pid)
      ? { reclaim: false, reason: "pid-alive" }
      : { reclaim: true, reason: "pid-dead" };
  }
  return ageMs > staleAfterMs
    ? { reclaim: true, reason: "owner-unreadable-stale" }
    : { reclaim: false, reason: "owner-unreadable-fresh" };
}

function sameOwner(left, right) {
  if (left === null || right === null) return left === right;
  return (
    left.pid === right.pid &&
    left.token === right.token &&
    left.acquiredAt === right.acquiredAt
  );
}

function sameLockInstance(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.birthtimeMs === right.birthtimeMs
  );
}

function reclaimGeneration(owner, stat) {
  const generation = JSON.stringify({
    owner,
    dev: stat.dev,
    ino: stat.ino,
    birthtimeMs: stat.birthtimeMs,
  });
  return createHash("sha256").update(generation).digest("hex").slice(0, 24);
}

function reclaimClaimDir(lockDir, generation) {
  // Hash the full guarded path as well as its observed generation so recursive
  // recovery of a crashed claimant keeps a bounded path length and cannot
  // collide with another lock in the same parent directory.
  const claimId = createHash("sha256")
    .update(path.resolve(lockDir))
    .update("\0")
    .update(generation)
    .digest("hex")
    .slice(0, 32);
  return path.join(path.dirname(lockDir), `.ui-smoke-reclaim-${claimId}.lock`);
}

function writeOwnerAtomically(lockDir, owner) {
  const ownerPath = path.join(lockDir, "owner");
  const temporaryPath = path.join(
    path.dirname(lockDir),
    `.${path.basename(lockDir)}.owner-${owner.pid}-${randomUUID()}.tmp`,
  );
  fs.writeFileSync(temporaryPath, `${JSON.stringify(owner)}\n`, {
    flag: "wx",
  });
  try {
    fs.renameSync(temporaryPath, ownerPath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

function ownedRelease({ lockDir, removeLock, pid, token }) {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = readUiSmokeLockOwner(lockDir);
    if (current?.pid === pid && current.token === token) {
      removeLock(lockDir);
    }
  };
}

export function acquireUiSmokeViewLock({
  lockDir,
  removeLock,
  sleep,
  isProcessAlive,
  staleAfterMs = 30 * 60 * 1000,
  now = () => Date.now(),
  pid = process.pid,
  token = randomUUID(),
  onWait = () => {},
}) {
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  let announcedWait = false;

  for (;;) {
    try {
      fs.mkdirSync(lockDir);
    } catch (error) {
      // error-policy:J3 EEXIST is the atomic contention signal. Every other
      // filesystem failure is operational and must surface to the caller.
      if (error?.code !== "EEXIST") throw error;

      let stat;
      try {
        stat = fs.statSync(lockDir);
      } catch (statError) {
        // error-policy:J3 The holder may release between EEXIST and stat; retry
        // only that explicit race and surface every other filesystem failure.
        if (statError?.code === "ENOENT") continue;
        throw statError;
      }

      const observedOwner = readUiSmokeLockOwner(lockDir);
      const status = uiSmokeLockStatus(observedOwner, {
        ageMs: now() - stat.mtimeMs,
        staleAfterMs,
        isProcessAlive,
      });
      if (status.reclaim) {
        const generation = reclaimGeneration(observedOwner, stat);
        const claimDir = reclaimClaimDir(lockDir, generation);

        // `mkdir` inside this recursive acquisition is the atomic claim for the
        // observed generation. A crashed claimant is recovered by the same
        // owner/PID protocol one level down, so recovery never needs an unsafe
        // check-then-unlink of a shared marker.
        const releaseClaim = acquireUiSmokeViewLock({
          lockDir: claimDir,
          removeLock,
          sleep,
          isProcessAlive,
          staleAfterMs,
          now,
          pid,
          token,
          onWait,
        });

        let reclaimed = false;
        try {
          let currentStat;
          try {
            currentStat = fs.statSync(lockDir);
          } catch (currentStatError) {
            // error-policy:J3 A legitimate release can remove the outer lock
            // after the stale observation. Retry only that explicit race.
            if (currentStatError?.code === "ENOENT") continue;
            throw currentStatError;
          }
          const currentOwner = readUiSmokeLockOwner(lockDir);

          // The atomic claim serializes contenders, while this generation check
          // keeps a claimant from replacing an owner another process installed
          // after the original stale observation.
          if (
            !sameLockInstance(stat, currentStat) ||
            !sameOwner(observedOwner, currentOwner)
          ) {
            continue;
          }
          if (
            !uiSmokeLockStatus(currentOwner, {
              // Election files live beside the guarded directory so a crashed
              // contender cannot refresh the stale age that justified reclaim.
              ageMs: now() - stat.mtimeMs,
              staleAfterMs,
              isProcessAlive,
            }).reclaim
          ) {
            continue;
          }

          writeOwnerAtomically(lockDir, {
            pid,
            token,
            acquiredAt: new Date(now()).toISOString(),
          });
          reclaimed = true;
        } finally {
          releaseClaim();
        }

        if (reclaimed) {
          return ownedRelease({ lockDir, removeLock, pid, token });
        }
        continue;
      }

      if (!announcedWait) {
        onWait();
        announcedWait = true;
      }
      sleep(250);
      continue;
    }

    const owner = {
      pid,
      token,
      acquiredAt: new Date(now()).toISOString(),
    };
    let ownerWritten = false;
    try {
      writeOwnerAtomically(lockDir, owner);
      ownerWritten = true;
    } finally {
      if (!ownerWritten) removeLock(lockDir);
    }
    return ownedRelease({ lockDir, removeLock, pid, token });
  }
}
