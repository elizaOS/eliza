/**
 * Completion-evidence assembly for the auto goal-verifier.
 *
 * The auto goal-verifier ("grill until truly done") historically judged a
 * completed sub-agent task against its acceptance criteria using only the thin
 * `task_complete` event-summary string. That makes it trivially foolable: a
 * sub-agent that *claims* success but pasted no proof reads identically to one
 * that actually shipped.
 *
 * This module turns the rich signals the orchestrator ALREADY has into a single
 * clearly-SECTIONED evidence string the verifier can grill against:
 *
 *   - **CHANGESET** — the real git diffstat + changed files + a capped diff,
 *     captured from git at `task_complete` (same {@link WorkspaceChangeSet} the
 *     CODING_SESSION_CHANGES provider renders), so "I changed X" is checkable.
 *   - **DELIVERABLE** — the sub-agent's captured deliverable (printed/tool
 *     output the router extracted) and its final reply text.
 *   - **VERIFIED URLS** — URLs the router probed at completion, flagged
 *     loopback-vs-public so the verifier can reject localhost-only "deploys".
 *   - **TEST / BUILD / TYPECHECK OUTPUT** — lines mined from the session's
 *     recorded events/messages that look like build/test/typecheck output, so a
 *     real green run is distinguishable from a bare claim.
 *   - **ARTIFACTS** — references to screenshot/trajectory artifacts found on the
 *     task/session, so UI and agent-behavior criteria have something to cite.
 *
 * Pure (no IO): the caller gathers the inputs (durable store + live ACP session
 * metadata) and hands them in. The whole assembly is null-safe and size-capped
 * so it can be fed straight into the verifier without blowing the prompt
 * budget.
 *
 * @module services/completion-evidence
 */

import type { WorkspaceChangeSet } from "./workspace-diff.js";

/** One recorded signal (a durable event or sub-agent message) the assembler
 *  mines for test/build/typecheck output. Kept minimal so the service can map
 *  its store rows in without coupling this module to the full record types. */
export interface EvidenceSignal {
  /** Free-text body to scan (event summary, message content, …). */
  text: string;
  /** Optional label for the section header (e.g. the event type). */
  source?: string;
}

export interface CompletionEvidenceInput {
  /** The `task_complete` response summary — the original thin evidence; kept as
   *  the fallback and as the sub-agent's final reply when nothing richer. */
  fallbackSummary: string;
  /** Real git change set captured at completion, if any. */
  changeSet?: WorkspaceChangeSet;
  /** Captured deliverable (router-extracted printed/tool output), if any. */
  deliverable?: string;
  /** The sub-agent's final reply text, if distinct from the summary. */
  finalReply?: string;
  /** URLs the router probed/verified at completion. */
  verifiedUrls?: readonly string[];
  /** Recorded events/messages to mine for build/test/typecheck output. */
  signals?: readonly EvidenceSignal[];
  /** Artifact references (screenshots, trajectories) found on task/session. */
  artifacts?: readonly EvidenceArtifactRef[];
}

export interface EvidenceArtifactRef {
  artifactType: string;
  title: string;
  /** A path or uri — whichever locates the artifact for the verifier. */
  ref?: string;
}

/** Total cap for the assembled evidence string. Sits under the verifier's own
 *  {@link trimEvidence} budget so the section structure survives intact. */
const MAX_EVIDENCE_CHARS = 8_000;
const MAX_DIFF_CHARS = 3_000;
const MAX_DELIVERABLE_CHARS = 1_500;
const MAX_REPLY_CHARS = 1_500;
const MAX_SIGNAL_LINES = 40;
const MAX_SIGNAL_CHARS = 2_000;
const MAX_URLS = 12;
const MAX_ARTIFACTS = 20;

/**
 * Lines that look like the output of a build / test / typecheck / lint run.
 * Deliberately broad across the common toolchains (vitest/jest, tsc, biome,
 * eslint, cargo, go, pytest, generic "exit code") so a real run is surfaced
 * regardless of stack — the verifier then decides whether the line is a PASS or
 * a FAIL.
 */
const BUILD_TEST_LINE_RE =
  /\b(?:tests?|test\s+files?|suites?|specs?|passed|passing|failed|failing|✓|✗|✔|✖|pass|fail|error|errors?|warning|warnings?|tsc|typecheck|type-check|type\s+error|biome|eslint|lint|build\s+(?:succeeded|failed|complete)|compiled|compilation|exit\s+code|exited\s+with|coverage|\bpytest\b|\bcargo\b|\bvitest\b|\bjest\b)\b/i;

function isLoopbackUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

function clamp(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}\n… [truncated]`;
}

/** Pull the lines from a signal body that read like build/test/typecheck
 *  output, so the verifier sees the actual run output rather than narration. */
function extractBuildTestLines(signals: readonly EvidenceSignal[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const signal of signals) {
    for (const rawLine of signal.text.replace(/\r\n/g, "\n").split("\n")) {
      const line = rawLine.trim();
      if (line.length === 0 || line.length > 400) continue;
      if (!BUILD_TEST_LINE_RE.test(line)) continue;
      const key = signal.source ? `${signal.source}: ${line}` : line;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(key);
      if (out.length >= MAX_SIGNAL_LINES) return out;
    }
  }
  return out;
}

function renderChangeSetSection(changeSet: WorkspaceChangeSet): string {
  const files =
    changeSet.changedFiles.length > 0
      ? changeSet.changedFiles.join(", ")
      : "(none)";
  const lines = [
    "## CHANGESET (real git diff captured at completion)",
    `diffstat: ${changeSet.diffStat || "(none)"}`,
    `changedFiles (${changeSet.changedFiles.length}): ${files}`,
  ];
  if (changeSet.diff && changeSet.diff.trim().length > 0) {
    lines.push("diff:");
    lines.push(clamp(changeSet.diff, MAX_DIFF_CHARS));
  }
  if (changeSet.truncated) lines.push("(changeset truncated)");
  return lines.join("\n");
}

function renderUrlsSection(urls: readonly string[]): string {
  const unique = [...new Set(urls.map((u) => u.trim()).filter(Boolean))].slice(
    0,
    MAX_URLS,
  );
  const lines = ["## VERIFIED URLS (probed at completion)"];
  for (const url of unique) {
    lines.push(
      `- ${url}${isLoopbackUrl(url) ? " (LOOPBACK — not publicly reachable)" : ""}`,
    );
  }
  return lines.join("\n");
}

function renderArtifactsSection(
  artifacts: readonly EvidenceArtifactRef[],
): string {
  const shown = artifacts.slice(0, MAX_ARTIFACTS);
  const lines = ["## ARTIFACTS (screenshots / trajectories / other refs)"];
  for (const artifact of shown) {
    const ref = artifact.ref ? ` — ${artifact.ref}` : "";
    lines.push(`- [${artifact.artifactType}] ${artifact.title}${ref}`);
  }
  return lines.join("\n");
}

/**
 * Assemble the sectioned completion-evidence string from the signals the
 * orchestrator already has. Always returns a non-empty string: when nothing
 * richer than the fallback summary is available it still returns the summary,
 * so the verifier behaves exactly as before for thin completions.
 */
export function buildCompletionEvidenceString(
  input: CompletionEvidenceInput,
): string {
  const sections: string[] = [];
  // Track whether any section carries MORE than the bare fallback summary. The
  // FINAL REPLY section always renders (the fallback is the worst-case reply),
  // so it alone does not count as "richer": when it is the only section and it
  // just echoes the fallback, we return the bare summary to preserve the prior
  // thin-completion behavior exactly.
  let hasRicherSection = false;

  if (input.changeSet && input.changeSet.changedFiles.length > 0) {
    sections.push(renderChangeSetSection(input.changeSet));
    hasRicherSection = true;
  }

  const deliverable = input.deliverable?.trim();
  if (deliverable) {
    sections.push(
      [
        "## DELIVERABLE (captured sub-agent output)",
        clamp(deliverable, MAX_DELIVERABLE_CHARS),
      ].join("\n"),
    );
    hasRicherSection = true;
  }

  const reply = input.finalReply?.trim() || input.fallbackSummary.trim();
  if (reply) {
    sections.push(
      [
        "## FINAL REPLY (sub-agent's reported result)",
        clamp(reply, MAX_REPLY_CHARS),
      ].join("\n"),
    );
    // A reply that says more than the bare fallback is itself richer signal.
    if (reply !== input.fallbackSummary.trim()) hasRicherSection = true;
  }

  if (input.verifiedUrls && input.verifiedUrls.length > 0) {
    sections.push(renderUrlsSection(input.verifiedUrls));
    hasRicherSection = true;
  }

  const buildTestLines = extractBuildTestLines(input.signals ?? []);
  if (buildTestLines.length > 0) {
    sections.push(
      [
        "## TEST / BUILD / TYPECHECK OUTPUT (mined from recorded session output)",
        clamp(buildTestLines.join("\n"), MAX_SIGNAL_CHARS),
      ].join("\n"),
    );
    hasRicherSection = true;
  }

  if (input.artifacts && input.artifacts.length > 0) {
    sections.push(renderArtifactsSection(input.artifacts));
    hasRicherSection = true;
  }

  // Nothing richer than the bare summary — preserve prior behavior exactly.
  if (!hasRicherSection) {
    return input.fallbackSummary.trim();
  }

  const assembled = sections.join("\n\n");
  return assembled.length > MAX_EVIDENCE_CHARS
    ? `${assembled.slice(0, MAX_EVIDENCE_CHARS)}\n… [evidence truncated]`
    : assembled;
}
