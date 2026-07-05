/**
 * Human-speed streaming reporter and admin summary for the evidence matrix
 * runner (run-matrix.mjs). Where run-matrix owns lane execution, this module
 * owns the operator's view of it: it turns each lane's lifecycle
 * (pending -> running -> passed/failed/skipped) into readable terminal lines as
 * the matrix advances, then renders one end-of-run summary table an admin — or a
 * coding agent parsing stdout — reads to see what passed, what failed, what was
 * skipped and why, and where every artifact landed.
 *
 * All output goes through an injected `write` sink and an injected `now` clock
 * so the reporter's exact status transitions and summary text are asserted
 * against fixtures without spawning a real lane. Honesty is the invariant: a
 * lane that cannot run (no device, no live model) is reported `skipped` with a
 * reason and never rendered as passing.
 */

const STATUS_GLYPH = {
  pending: "[ ]",
  running: "[>]",
  passed: "[+]",
  failed: "[x]",
  skipped: "[-]",
};

const STATUS_LABEL = {
  pending: "PENDING",
  running: "RUNNING",
  passed: "PASS",
  failed: "FAIL",
  skipped: "SKIP",
};

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  return `${minutes}m${String(rest).padStart(2, "0")}s`;
}

/**
 * Streaming reporter that emits one line per lane state change so an operator
 * watching the terminal sees the matrix advance at human speed. Construct once
 * per run with the lanes to be executed; drive it with laneStart/laneEnd/
 * laneSkip as the runner processes each lane.
 */
export function createMatrixReporter({
  write,
  now = () => Date.now(),
  total,
} = {}) {
  if (typeof write !== "function") {
    throw new Error("createMatrixReporter requires a write(line) function");
  }
  if (!Number.isInteger(total) || total <= 0) {
    throw new Error("createMatrixReporter requires a positive integer total");
  }

  let index = 0;
  const startedAt = new Map();

  const emit = (status, id, label, suffix) => {
    const position = `[${index}/${total}]`;
    const glyph = STATUS_GLYPH[status];
    const badge = STATUS_LABEL[status];
    write(`${glyph} ${position} ${badge} ${id} — ${label}${suffix}`);
  };

  return {
    header() {
      write(
        `Running ${total} evidence lane${total === 1 ? "" : "s"} at human speed.`,
      );
    },
    laneStart(step) {
      index += 1;
      startedAt.set(step.id, now());
      emit("running", step.id, step.label, "");
    },
    laneEnd(step, status) {
      const started = startedAt.get(step.id);
      const elapsed = started == null ? null : now() - started;
      const timing = elapsed == null ? "" : `  (${formatDuration(elapsed)})`;
      emit(status, step.id, step.label, timing);
    },
    laneSkip(step, reason) {
      index += 1;
      emit("skipped", step.id, step.label, `  — ${reason}`);
    },
  };
}

function padEnd(value, width) {
  const text = String(value);
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

/**
 * Render the single end-of-run summary table. `steps` are the finished lane
 * records from the manifest (each with id/status/durationMs and optional
 * skipReason/artifactPath). Returns the full multi-line string so callers can
 * both print it and assert it. A `failed` lane appears explicitly as FAIL in the
 * table and drives the returned overall status — it is never swallowed into a
 * green summary.
 */
export function renderMatrixSummary(
  steps,
  { dashboardPath, manifestPath } = {},
) {
  const counts = { passed: 0, failed: 0, skipped: 0, planned: 0 };
  for (const step of steps) {
    counts[step.status] = (counts[step.status] ?? 0) + 1;
  }
  const overall =
    counts.failed > 0
      ? "FAILED"
      : counts.planned === steps.length && steps.length > 0
        ? "PLANNED"
        : "PASSED";

  const idWidth = Math.max(4, ...steps.map((s) => s.id.length));
  const lines = [];
  lines.push("");
  lines.push("Evidence matrix summary");
  lines.push("=".repeat(72));
  for (const step of steps) {
    const badge = STATUS_LABEL[step.status] ?? step.status.toUpperCase();
    const timing = padEnd(formatDuration(step.durationMs), 8);
    const note =
      step.status === "skipped" && step.skipReason
        ? `skip: ${step.skipReason}`
        : step.artifactPath
          ? `artifacts: ${step.artifactPath}`
          : "";
    lines.push(
      `${padEnd(badge, 5)}  ${padEnd(step.id, idWidth)}  ${timing}  ${note}`.trimEnd(),
    );
  }
  lines.push("-".repeat(72));
  const tally =
    overall === "PLANNED"
      ? `${counts.planned} planned`
      : `${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped`;
  lines.push(`${overall}: ${tally}`);
  if (manifestPath) lines.push(`Manifest: ${manifestPath}`);
  if (dashboardPath) lines.push(`Evidence dashboard: ${dashboardPath}`);
  lines.push("");

  return { text: lines.join("\n"), overall, counts };
}
