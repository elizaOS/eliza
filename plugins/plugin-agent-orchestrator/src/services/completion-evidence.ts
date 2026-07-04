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

/**
 * Captured stdout from the sub-agent's tool runs, split by tool class. Each
 * field is the raw (already-bounded) output of a `vitest`/`tsc`/`biome`-style
 * run mined from the recorded ACP tool events, so the verifier can read the
 * actual run result rather than the agent's narration of it. `raw` is a
 * catch-all for tool output that matched a build/test marker but couldn't be
 * confidently classed as test/build/lint.
 */
export interface ToolOutputEvidence {
  test?: string;
  build?: string;
  lint?: string;
  raw?: string;
}

/**
 * The TYPED completion-evidence bundle (issue #8894). This is the formalized,
 * collect-once shape the orchestrator assembles BEFORE verification: every
 * evidence source resolves to a named field instead of being threaded through
 * the prompt as loose strings. {@link buildCompletionEvidenceString} serializes
 * it into the same clearly-sectioned string the verifier already grills
 * against, emitting exactly one section per POPULATED field and omitting empty
 * ones.
 *
 * `verifiedUrls` and `screenshots` are required (default to `[]`); everything
 * else is optional and contributes a section only when present.
 */
export interface CompletionEvidenceBundle {
  /** The sub-agent's reported result — the fallback/final-reply text. */
  summary: string;
  /** Human-readable git diff summary (diffstat + changed files + capped diff)
   *  captured at completion, if any. */
  diffSummary?: string;
  /** Captured tool stdout split by class (test/build/lint) plus a raw bucket. */
  toolOutput?: ToolOutputEvidence;
  /** URLs the router probed/verified at completion (loopback-flagged on render). */
  verifiedUrls: string[];
  /** URLs the sub-agent merely MENTIONED in prose (never probed). Rendered in a
   *  distinct, explicitly-unverified section so the judge can not mistake a
   *  claimed link for a reachable deploy. */
  mentionedUrls?: string[];
  /** Screenshot artifact paths found on the task/session. */
  screenshots: string[];
  /** Path to the persisted trajectory JSONL artifact for this completion. */
  trajectoryPath?: string;
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
/** Per-tool-output-field cap (test/build/lint/raw each). */
const MAX_TOOL_OUTPUT_CHARS = 2_000;

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
    // error-policy:J3 unparseable URL string is an explicit not-loopback result
    return false;
  }
}

function clamp(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}\n… [truncated]`;
}

/** Markers that class a signal as TEST output (vitest/jest run, suite result). */
const TEST_MARKER_RE =
  /\b(?:vitest|jest|pytest|test\s+files?|tests?\s+(?:passed|failed|run)|✓|✗|✔|✖|specs?|suites?|coverage|PASS|FAIL)\b/;
/** Markers that class a signal as BUILD/TYPECHECK output (tsc/tsgo/compile). */
const BUILD_MARKER_RE =
  /\b(?:tsc|tsgo|typecheck|type-check|type\s+error|compiled|compilation|build\s+(?:succeeded|failed|complete)|cargo\s+build|go\s+build)\b/;
/** Markers that class a signal as LINT output (biome/eslint). */
const LINT_MARKER_RE = /\b(?:biome|eslint|\blint\b)\b/;

/** Extract just the build/test-looking lines from one signal body, deduped and
 *  bounded, so a noisy tool transcript collapses to its run-result lines. */
function extractToolLines(text: string, seen: Set<string>): string[] {
  const out: string[] = [];
  for (const rawLine of text.replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.length > 400) continue;
    if (!BUILD_TEST_LINE_RE.test(line)) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
    if (out.length >= MAX_SIGNAL_LINES) break;
  }
  return out;
}

/**
 * Classify the build/test/typecheck/lint output mined from recorded tool
 * signals into a {@link ToolOutputEvidence} bucket per tool class, so the
 * verifier can read the actual test/build stdout under named headers. A signal
 * is routed by the markers in its body (and source label): test markers →
 * `test`, build/typecheck → `build`, lint → `lint`; build-test-looking lines
 * that match none fall into `raw`. Returns undefined when nothing matched.
 */
export function classifyToolOutput(
  signals: readonly EvidenceSignal[],
): ToolOutputEvidence | undefined {
  const buckets: Record<keyof ToolOutputEvidence, string[]> = {
    test: [],
    build: [],
    lint: [],
    raw: [],
  };
  const seen = new Set<string>();
  for (const signal of signals) {
    const lines = extractToolLines(signal.text, seen);
    if (lines.length === 0) continue;
    const haystack = `${signal.source ?? ""}\n${signal.text}`;
    let bucket: keyof ToolOutputEvidence;
    if (TEST_MARKER_RE.test(haystack)) bucket = "test";
    else if (BUILD_MARKER_RE.test(haystack)) bucket = "build";
    else if (LINT_MARKER_RE.test(haystack)) bucket = "lint";
    else bucket = "raw";
    buckets[bucket].push(...lines);
  }
  const out: ToolOutputEvidence = {};
  if (buckets.test.length > 0) out.test = buckets.test.join("\n");
  if (buckets.build.length > 0) out.build = buckets.build.join("\n");
  if (buckets.lint.length > 0) out.lint = buckets.lint.join("\n");
  if (buckets.raw.length > 0) out.raw = buckets.raw.join("\n");
  return hasToolOutput(out) ? out : undefined;
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

/**
 * Render the human-readable body of a {@link WorkspaceChangeSet} (diffstat +
 * changed files + a capped diff) WITHOUT the section header. Used as the
 * `diffSummary` field of a {@link CompletionEvidenceBundle}, so the bundle and
 * the legacy assembler produce byte-identical changeset text.
 */
export function renderChangeSetBody(changeSet: WorkspaceChangeSet): string {
  const files =
    changeSet.changedFiles.length > 0
      ? changeSet.changedFiles.join(", ")
      : "(none)";
  const lines = [
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

function renderChangeSetSection(changeSet: WorkspaceChangeSet): string {
  return [
    "## CHANGESET (real git diff captured at completion)",
    renderChangeSetBody(changeSet),
  ].join("\n");
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

/** Render URLs the sub-agent only claimed, under a header that makes their
 *  UN-verified status explicit — so the judge treats a pasted link as a claim,
 *  not as proof of a reachable deploy. */
function renderMentionedUrlsSection(urls: readonly string[]): string {
  const unique = [...new Set(urls.map((u) => u.trim()).filter(Boolean))].slice(
    0,
    MAX_URLS,
  );
  const lines = [
    "## CLAIMED URLS (mentioned by the sub-agent — NOT probe-verified; treat as an unproven claim)",
  ];
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

function renderToolOutputSection(toolOutput: ToolOutputEvidence): string {
  const lines = ["## TEST / BUILD / TYPECHECK OUTPUT (captured tool stdout)"];
  const labelled: [string, string | undefined][] = [
    ["test", toolOutput.test],
    ["build", toolOutput.build],
    ["lint", toolOutput.lint],
    ["raw", toolOutput.raw],
  ];
  for (const [label, value] of labelled) {
    const text = value?.trim();
    if (!text) continue;
    lines.push(`### ${label}`);
    lines.push(clamp(text, MAX_TOOL_OUTPUT_CHARS));
  }
  return lines.join("\n");
}

function hasToolOutput(toolOutput: ToolOutputEvidence | undefined): boolean {
  if (!toolOutput) return false;
  return Boolean(
    toolOutput.test?.trim() ||
      toolOutput.build?.trim() ||
      toolOutput.lint?.trim() ||
      toolOutput.raw?.trim(),
  );
}

/**
 * Serialize the TYPED {@link CompletionEvidenceBundle} into the clearly-
 * sectioned evidence string the verifier grills against — one section per
 * POPULATED field, empty fields omitted. When nothing richer than the bare
 * summary is present, returns the bare summary (prior thin-completion
 * behavior). This is the issue #8894 entry point; the legacy signal-mining
 * assembler lives in {@link buildEvidenceStringFromInput} and remains exported.
 */
export function buildCompletionEvidenceString(
  bundle: CompletionEvidenceBundle,
): string {
  const sections: string[] = [];
  let hasRicherSection = false;

  const diff = bundle.diffSummary?.trim();
  if (diff) {
    sections.push(
      ["## CHANGESET (real git diff captured at completion)", diff].join("\n"),
    );
    hasRicherSection = true;
  }

  const reply = bundle.summary.trim();
  if (reply) {
    sections.push(
      [
        "## FINAL REPLY (sub-agent's reported result)",
        clamp(reply, MAX_REPLY_CHARS),
      ].join("\n"),
    );
  }

  if (bundle.verifiedUrls.length > 0) {
    sections.push(renderUrlsSection(bundle.verifiedUrls));
    hasRicherSection = true;
  }

  // Claimed-but-unverified URLs are informational only — surfaced so the judge
  // sees them, but explicitly NOT counted as "richer" evidence (a pasted link
  // is not proof), unlike a probe-verified URL above.
  const mentioned = (bundle.mentionedUrls ?? []).filter(
    (url) => !bundle.verifiedUrls.includes(url),
  );
  if (mentioned.length > 0) {
    sections.push(renderMentionedUrlsSection(mentioned));
  }

  if (bundle.toolOutput && hasToolOutput(bundle.toolOutput)) {
    sections.push(renderToolOutputSection(bundle.toolOutput));
    hasRicherSection = true;
  }

  const artifacts: EvidenceArtifactRef[] = bundle.screenshots
    .map((ref) => ref.trim())
    .filter(Boolean)
    .map((ref) => ({ artifactType: "screenshot", title: "screenshot", ref }));
  const trajectory = bundle.trajectoryPath?.trim();
  if (trajectory) {
    artifacts.push({
      artifactType: "trajectory",
      title: "completion trajectory",
      ref: trajectory,
    });
  }
  if (artifacts.length > 0) {
    sections.push(renderArtifactsSection(artifacts));
    hasRicherSection = true;
  }

  if (!hasRicherSection) {
    return reply;
  }

  const assembled = sections.join("\n\n");
  return assembled.length > MAX_EVIDENCE_CHARS
    ? `${assembled.slice(0, MAX_EVIDENCE_CHARS)}\n… [evidence truncated]`
    : assembled;
}

/**
 * Assemble the sectioned completion-evidence string from the loose signals the
 * orchestrator already has. Always returns a non-empty string: when nothing
 * richer than the fallback summary is available it still returns the summary,
 * so the verifier behaves exactly as before for thin completions.
 *
 * Retained for backward compatibility and as the signal-mining helper the
 * bundle collector reuses to extract build/test lines; new callers should
 * assemble a {@link CompletionEvidenceBundle} and use
 * {@link buildCompletionEvidenceString}.
 */
export function buildEvidenceStringFromInput(
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
