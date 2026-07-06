/**
 * Point-of-failure forensics for the device-e2e runners (#14338).
 *
 * The runners (`android-e2e.mjs`, `ios-e2e.mjs`) drive a sequence of shell
 * steps at the child-process boundary; when a step fails the device state that
 * caused it — what was on screen, what the app logged — is gone by the time a
 * human or agent reads the log. This wraps each runner step so that, the moment
 * it throws, a screenshot + a device-log snapshot are captured INTO the triage
 * bundle at `<bundle>/failure/<step-slug>/` before the error is rethrown, and
 * the runner's exit block names the failing step and lists those artifact paths.
 *
 * Consumed by the two runners (one `runStep` wrapper per phase) and by the
 * bundle's `summary.json` writer (a failed step contributes `status:"failed"`
 * plus `artifacts` pointing at its failure dir). The capture itself is injected
 * as `captureScreenshot`/`captureDeviceLog` callbacks — the runners pass the
 * real `adb screencap` / `simctl io screenshot` / `logcat -d` primitives; tests
 * pass fakes — so this module has no device dependency and is fully headless.
 *
 * Forensics capture is best-effort (crash-only J6/J7): a capture that itself
 * fails (device disconnected mid-run) is recorded as a warning on the step and
 * NEVER replaces or masks the original step error, which always propagates.
 */
import { mkdirSync, statSync } from "node:fs";
import path from "node:path";

/** Filesystem-safe slug for a step name, used as its failure sub-directory. */
export function slugifyStep(name) {
  const slug = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  // A step named only with punctuation must still get a stable directory.
  return slug || "step";
}

/**
 * Run one named runner step. On success returns the callback's value and
 * records a `passed` step. On failure, captures forensics into
 * `<bundleDir>/failure/<slug>/` (best-effort), records a `failed` step with the
 * captured artifact paths, then rethrows the ORIGINAL error unchanged.
 *
 * `captureScreenshot(outPath)` / `captureDeviceLog(outPath)` return the written
 * path on success or `null`/throw on failure; either outcome is tolerated and
 * surfaced as a warning without affecting the propagated error.
 */
export async function runStep(
  {
    name,
    fn,
    bundleDir,
    captureScreenshot = null,
    captureDeviceLog = null,
    now = () => Date.now(),
  },
  ledger,
) {
  const startedAt = now();
  try {
    const value = await fn();
    ledger.push({
      name,
      status: "passed",
      durationMs: now() - startedAt,
      artifacts: [],
    });
    return value;
  } catch (error) {
    const failureDir = path.join(bundleDir, "failure", slugifyStep(name));
    const { artifacts, warnings } = await captureForensics({
      failureDir,
      captureScreenshot,
      captureDeviceLog,
    });
    ledger.push({
      name,
      status: "failed",
      durationMs: now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      artifacts,
      ...(warnings.length ? { forensicsWarnings: warnings } : {}),
    });
    throw error;
  }
}

/**
 * Best-effort screenshot + device-log capture into `failureDir`. Returns the
 * artifacts that were actually written and a warning per capture that failed.
 * Never throws: the caller is on an error path and the original error must win.
 */
export async function captureForensics({
  failureDir,
  captureScreenshot,
  captureDeviceLog,
}) {
  const artifacts = [];
  const warnings = [];
  try {
    mkdirSync(failureDir, { recursive: true });
  } catch (error) {
    // error-policy:J6 best-effort forensics — if we cannot even make the dir,
    // there is nothing to capture into; warn and let the step error propagate.
    return {
      artifacts: [],
      warnings: [`failure dir unwritable: ${errMessage(error)}`],
    };
  }
  await captureInto({
    kind: "screenshot",
    capture: captureScreenshot,
    outPath: path.join(failureDir, "screenshot.png"),
    artifacts,
    warnings,
  });
  await captureInto({
    kind: "device-log",
    capture: captureDeviceLog,
    outPath: path.join(failureDir, "device-log.txt"),
    artifacts,
    warnings,
  });
  return { artifacts, warnings };
}

/**
 * A single forensic capture. `capture` may be absent (platform declined to wire
 * this signal), return `null` (device produced nothing), or throw (device gone)
 * — all three degrade to a warning, never an artifact and never a rethrow.
 */
async function captureInto({ kind, capture, outPath, artifacts, warnings }) {
  if (typeof capture !== "function") return;
  try {
    const written = await capture(outPath);
    if (written && fileExists(written)) {
      artifacts.push({ kind, path: written });
    } else if (written) {
      warnings.push(`${kind} capture returned missing file: ${written}`);
    } else {
      warnings.push(`${kind} capture produced no file`);
    }
  } catch (error) {
    // error-policy:J6 best-effort forensics — a device disconnected mid-capture
    // must not overwrite the step failure that triggered this path.
    warnings.push(`${kind} capture failed: ${errMessage(error)}`);
  }
}

function fileExists(p) {
  try {
    return statSync(p).isFile();
  } catch {
    // error-policy:J6 best-effort forensics — missing/unreadable capture output
    // becomes a warning so the triggering step failure remains the main error.
    return false;
  }
}

function errMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The runner's terminal exit block for a failed run: the failing step, its
 * one-line cause, and the absolute paths of its forensic artifacts — so a
 * triager sees the point of failure without scrolling the transcript.
 * Returns `null` when no step failed (nothing to print).
 */
export function formatFailureBlock(ledger, { bundleDir = null } = {}) {
  const failed = ledger.find((step) => step.status === "failed");
  if (!failed) return null;
  const lines = [
    "──────── device-e2e failure ────────",
    `step:  ${failed.name}`,
    `cause: ${failed.error ?? "(no message)"}`,
  ];
  if (failed.artifacts?.length) {
    lines.push("artifacts:");
    for (const artifact of failed.artifacts) {
      const abs = path.isAbsolute(artifact.path)
        ? artifact.path
        : path.resolve(bundleDir ?? ".", artifact.path);
      lines.push(`  - ${artifact.kind}: ${abs}`);
    }
  } else {
    lines.push("artifacts: (none captured)");
  }
  if (failed.forensicsWarnings?.length) {
    for (const warning of failed.forensicsWarnings) {
      lines.push(`  ! ${warning}`);
    }
  }
  lines.push("────────────────────────────────────");
  return lines.join("\n");
}
