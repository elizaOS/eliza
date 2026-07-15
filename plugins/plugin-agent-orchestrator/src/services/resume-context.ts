/**
 * Resume-context construction for rate-limit / capacity failover respawns.
 *
 * When a long-running coding sub-agent dies from a *pooled-account* failure
 * (a 429 rate-limit, a "quota exceeded" envelope, or an "overloaded"/capacity
 * signal) the router already fails over to a healthy sibling account and
 * respawns in the SAME worktree (see {@link sub-agent-router.respawnStateLost}).
 * Because the successor runs in the same `workdir`, the branch and any
 * uncommitted work are preserved on disk — but the successor is spawned with
 * the *bare* original task and no memory of what the predecessor already did,
 * so it starts cold and can redo (or clobber) prior progress.
 *
 * This module builds a compact, deterministic RESUME PREAMBLE the router
 * prepends to the successor's first instruction, plus the small persisted
 * marker (`ResumeContext`) stamped onto successor metadata and surfaced in task
 * events so the UI can distinguish "rate-limited, resumable" from "failed".
 *
 * It is deliberately PURE (no I/O, no runtime) so the classification, marker
 * round-trip, and preamble text are unit-testable in isolation. The caller
 * (the router's account-failover path) is responsible for gathering the inputs
 * (workdir, branch, changeset stat, the predecessor's last progress summary)
 * from data it already has.
 *
 * @module services/resume-context
 */

import type { CodingAccountFailureKind } from "./coding-account-selection.js";

/** Metadata key under which the resume marker is stamped on the SUCCESSOR
 * session's metadata bag. Read back by {@link readResumeContext} for the event
 * surface + any downstream inspection. Kept distinct from `retryOfSessionId`
 * (which records raw lineage) — this carries the *reason + progress* a resume
 * differs from a cold respawn by. */
export const RESUME_CONTEXT_METADATA_KEY = "resumeContext";

/** Why a session was resumed. Mirrors the pooled-account failure taxonomy
 * ({@link CodingAccountFailureKind}) plus an explicit `capacity` bucket for
 * provider "overloaded"/529 blips that are transient-server, not per-account
 * quota — the router treats both as resumable failover, but the UI benefits
 * from the distinction. */
export type ResumeReason = CodingAccountFailureKind | "capacity";

/** The persisted resume marker. Small, JSON-safe, and self-describing so a
 * successor session (and the task-event stream) can explain *why* it resumed
 * and *what* it is resuming from without re-deriving anything. */
export interface ResumeContext {
  /** Discriminator so an untyped metadata read can be validated. */
  kind: "rate-limit-failover";
  /** Why the predecessor died (drives the "rate-limited, resumable" UI copy). */
  reason: ResumeReason;
  /** Canonical auth trigger when the failover was caused by access-token expiry. */
  authReason?: "token_expired";
  /** The predecessor session id this run is resuming from (lineage). */
  fromSessionId: string;
  /** Worktree the successor reuses — same branch + uncommitted work on disk. */
  workdir: string;
  /** Branch name, when resolvable, so the preamble/UI can name it. */
  branch?: string;
  /** `git diff --shortstat`-style line (e.g. "3 files changed, 40 insertions"),
   * when the predecessor's changeset was captured. */
  diffStat?: string;
  /** Predecessor's changed-file paths (capped) so the successor knows what was
   * already touched and doesn't blindly re-create it. */
  changedFiles?: string[];
  /** The predecessor's last progress/completion summary, if any. */
  lastProgress?: string;
  /** When the resume marker was built (epoch ms). */
  capturedAt: number;
}

/** Cap on how many changed-file paths ride in the marker / preamble — bounds
 * the persisted size and the prompt budget. */
export const MAX_RESUME_CHANGED_FILES = 40;

/** Cap on the predecessor progress summary length in the preamble (chars). */
export const MAX_RESUME_PROGRESS_CHARS = 1200;

/** Human phrasing per reason for the preamble/UI. */
const REASON_PHRASE: Record<ResumeReason, string> = {
  "rate-limited": "a provider rate limit",
  "needs-reauth": "a credential expiry",
  capacity: "a provider capacity/overload condition",
};

export interface BuildResumeContextInput {
  reason: ResumeReason;
  fromSessionId: string;
  workdir: string;
  branch?: string | null;
  diffStat?: string | null;
  changedFiles?: readonly string[] | null;
  lastProgress?: string | null;
  authReason?: "token_expired" | null;
  now?: number;
}

function cleanStr(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Build the persisted {@link ResumeContext} marker from the failover inputs.
 * Pure — all fields are normalized/clamped here so both the metadata stamp and
 * the preamble render from one validated shape. `changedFiles` is deduped and
 * capped; `lastProgress` is trimmed and length-clamped.
 */
export function buildResumeContext(
  input: BuildResumeContextInput,
): ResumeContext {
  const changed = input.changedFiles
    ? [
        ...new Set(input.changedFiles.map((f) => f.trim()).filter(Boolean)),
      ].slice(0, MAX_RESUME_CHANGED_FILES)
    : undefined;
  const progress = cleanStr(input.lastProgress);
  return {
    kind: "rate-limit-failover",
    reason: input.reason,
    authReason:
      input.authReason === "token_expired" ? "token_expired" : undefined,
    fromSessionId: input.fromSessionId,
    workdir: input.workdir,
    branch: cleanStr(input.branch),
    diffStat: cleanStr(input.diffStat),
    changedFiles: changed && changed.length > 0 ? changed : undefined,
    lastProgress:
      progress && progress.length > MAX_RESUME_PROGRESS_CHARS
        ? `${progress.slice(0, MAX_RESUME_PROGRESS_CHARS)}…`
        : progress,
    capturedAt:
      typeof input.now === "number" && Number.isFinite(input.now)
        ? input.now
        : Date.now(),
  };
}

/**
 * Coerce a free-form metadata value back into a typed {@link ResumeContext},
 * or `undefined` when it is absent/malformed. The successor's metadata bag is
 * untyped by construction (ACP `SessionInfo.metadata`), so every field is
 * validated defensively — a partial/garbage marker reads as "no resume
 * context" rather than throwing into the event path.
 */
export function readResumeContext(value: unknown): ResumeContext | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.kind !== "rate-limit-failover") return undefined;
  const reason = raw.reason;
  if (
    reason !== "rate-limited" &&
    reason !== "needs-reauth" &&
    reason !== "capacity"
  ) {
    return undefined;
  }
  const fromSessionId = cleanStr(raw.fromSessionId as string | undefined);
  const workdir = cleanStr(raw.workdir as string | undefined);
  if (!fromSessionId || !workdir) return undefined;
  if (raw.authReason !== undefined && raw.authReason !== "token_expired") {
    return undefined;
  }
  if (
    raw.branch !== undefined &&
    cleanStr(raw.branch as string | undefined) === undefined
  ) {
    return undefined;
  }
  if (
    raw.diffStat !== undefined &&
    cleanStr(raw.diffStat as string | undefined) === undefined
  ) {
    return undefined;
  }
  if (
    raw.lastProgress !== undefined &&
    cleanStr(raw.lastProgress as string | undefined) === undefined
  ) {
    return undefined;
  }
  if (typeof raw.capturedAt !== "number" || !Number.isFinite(raw.capturedAt)) {
    return undefined;
  }
  const capturedAt = raw.capturedAt;
  let changedFiles: string[] | undefined;
  if (raw.changedFiles !== undefined) {
    if (!Array.isArray(raw.changedFiles)) return undefined;
    const parsed = raw.changedFiles.map((file) =>
      cleanStr(file as string | undefined),
    );
    if (parsed.some((file) => file === undefined)) return undefined;
    changedFiles = parsed.slice(0, MAX_RESUME_CHANGED_FILES) as string[];
  }
  return {
    kind: "rate-limit-failover",
    reason,
    authReason:
      raw.authReason === "token_expired" ? "token_expired" : undefined,
    fromSessionId,
    workdir,
    branch: cleanStr(raw.branch as string | undefined),
    diffStat: cleanStr(raw.diffStat as string | undefined),
    changedFiles:
      changedFiles && changedFiles.length > 0 ? changedFiles : undefined,
    lastProgress: cleanStr(raw.lastProgress as string | undefined),
    capturedAt,
  };
}

/**
 * Render the resume preamble prepended to the successor's first instruction.
 * Tells the resumed agent: the prior run died of a rate limit (not a mistake),
 * it is in the SAME worktree with prior work on disk, and to continue rather
 * than restart. Deterministic text (no timestamps in the body) so it is
 * snapshot-testable.
 */
export function buildResumePreamble(ctx: ResumeContext): string {
  const lines: string[] = [];
  lines.push(
    `[RESUMING AFTER FAILOVER] Your predecessor run stopped because of ${REASON_PHRASE[ctx.reason]}, not a task failure or a mistake in the work.`,
  );
  lines.push(
    "You are continuing the SAME task in the SAME working directory. Any files the previous run created or edited are already on disk (uncommitted work is preserved). Do NOT start over — inspect the current state first, then continue from where the previous run left off.",
  );
  if (ctx.branch) {
    lines.push(`Working branch: ${ctx.branch} (already checked out).`);
  }
  if (ctx.diffStat) {
    lines.push(`Work already in progress: ${ctx.diffStat}.`);
  }
  if (ctx.changedFiles && ctx.changedFiles.length > 0) {
    const shown = ctx.changedFiles.slice(0, MAX_RESUME_CHANGED_FILES);
    lines.push(
      `Files already touched by the previous run:\n${shown.map((f) => `  - ${f}`).join("\n")}`,
    );
  }
  if (ctx.lastProgress) {
    lines.push(`Previous run's last progress summary:\n${ctx.lastProgress}`);
  }
  lines.push(
    "Start by running `git status` / reading the changed files above to see what is done before doing anything else.",
  );
  return lines.join("\n\n");
}

/**
 * Prepend the resume preamble to the original task instruction. Kept separate
 * from {@link buildResumePreamble} so a caller can persist the raw preamble
 * and the composed instruction independently. A blank/whitespace task returns
 * just the preamble.
 */
export function applyResumePreamble(
  originalTask: string,
  ctx: ResumeContext,
): string {
  const preamble = buildResumePreamble(ctx);
  const task = originalTask.trim();
  if (task.length === 0) return preamble;
  return `${preamble}\n\n---\n\nOriginal task:\n\n${task}`;
}

/**
 * The event-surface fields the router stamps on the account-failover `error`
 * event so the UI shows "rate-limited, resumable" vs "failed". Pure derivation
 * from a {@link ResumeContext} so the router and any other emitter agree on the
 * shape.
 */
export function resumeEventFields(ctx: ResumeContext): {
  resumable: true;
  resumeReason: ResumeReason;
  authReason?: "token_expired";
  resumeFromSessionId: string;
} {
  return {
    resumable: true,
    resumeReason: ctx.reason,
    authReason: ctx.authReason,
    resumeFromSessionId: ctx.fromSessionId,
  };
}
