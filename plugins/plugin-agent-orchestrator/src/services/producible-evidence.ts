/**
 * Defines the deterministic evidence contracts used by the goal verifier.
 * It resolves backend capabilities, filters invented artifact criteria, and
 * evaluates only claims that completion-time facts can prove without model
 * judgment. Ambiguous or behavioral claims remain undetermined.
 */
import { isBlockedHostname, isPrivateIpAddress } from "@elizaos/core";

/** What kinds of evidence a worker's sandbox/backend can actually produce. */
export interface EvidenceCapabilities {
  /** Child sandboxes are headless; screenshot demands are unproducible. */
  browser: boolean;
  /** Whether the backend brain emits the structural CompletionEnvelope. */
  completionEnvelope: boolean;
}

/** Provenance for a task promoted purely on deterministic evidence. */
export const DETERMINISTIC_LEDGER_VERIFIER_NAME =
  "deterministic-ledger-verifier";

/**
 * Backends whose brains are taught the CompletionEnvelope contract. The
 * `elizaos`/`eliza-code` brain does not emit one, so demanding it from those
 * sessions can never be satisfied. Deployments override the list via
 * `ELIZA_ENVELOPE_CAPABLE_BACKENDS` (comma-separated framework names).
 */
const DEFAULT_ENVELOPE_CAPABLE_BACKENDS = ["claude", "claude-code", "codex"];

function settingList(
  getSetting: ((key: string) => string | undefined | null) | undefined,
  key: string,
): string[] | undefined {
  const raw = getSetting?.(key) ?? process.env[key];
  if (typeof raw !== "string" || raw.trim().length === 0) return undefined;
  return raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

/**
 * Resolve the evidence capabilities of a session by its recorded backend
 * framework name. Unknown/absent frameworks resolve fail-closed: no envelope,
 * no browser — a correction must never demand what may not exist.
 */
export function capabilitiesForBackend(
  framework: string | undefined | null,
  getSetting?: (key: string) => string | undefined | null,
): EvidenceCapabilities {
  const envelopeCapable =
    settingList(getSetting, "ELIZA_ENVELOPE_CAPABLE_BACKENDS") ??
    DEFAULT_ENVELOPE_CAPABLE_BACKENDS;
  const name = (framework ?? "").trim().toLowerCase();
  const browserRaw =
    getSetting?.("ELIZA_SANDBOX_HAS_BROWSER") ??
    process.env.ELIZA_SANDBOX_HAS_BROWSER;
  return {
    browser: browserRaw === "1" || browserRaw === "true",
    completionEnvelope:
      name.length > 0 &&
      envelopeCapable.some(
        (capable) => name === capable || name.startsWith(`${capable}-`),
      ),
  };
}

/** Path-like tokens: a slashed relative path or an extensioned filename, as
 *  criteria generators produce them (optionally backtick-quoted). */
const PATH_TOKEN_RE = /`?((?:[\w.-]+\/)+[\w.-]+|[\w-]+\.[A-Za-z]{1,8})`?/g;

/** Extensions that read as prose ("e.g.", "v1.2") rather than artifacts. */
const NON_ARTIFACT_TOKEN_RE = /^(?:e\.g|i\.e|etc|v?\d+(?:\.\d+)+)$/i;

export interface InventedArtifactFilterResult {
  kept: string[];
  /** Criteria dropped because they pinned a path the request never named. */
  dropped: string[];
}

/**
 * Drop generated criteria that pin a concrete path/filename absent from the
 * request. The worker legitimately chooses its own layout when the request
 * names none — holding it to an invented path is unsatisfiable by design.
 * A criterion survives when every path-like token it names appears (case-
 * insensitively) in the goal text.
 */
export function stripInventedArtifactCriteria(
  criteria: readonly string[],
  goal: string,
): InventedArtifactFilterResult {
  const haystack = (goal ?? "").toLowerCase();
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const criterion of criteria) {
    const tokens = [...criterion.matchAll(PATH_TOKEN_RE)]
      .map((match) => match[1] ?? "")
      .filter(
        (token) =>
          token.length > 0 &&
          !NON_ARTIFACT_TOKEN_RE.test(token) &&
          // A bare extensioned word that is a common tool invocation
          // ("bun test", "tsconfig.json" appears in goals often) still counts
          // as an artifact claim only when it looks file-shaped.
          (token.includes("/") || token.includes(".")),
      );
    const invented = tokens.some(
      (token) => !haystack.includes(token.toLowerCase()),
    );
    (invented ? dropped : kept).push(criterion);
  }
  return { kept, dropped };
}

/** Criterion classifiers, shared vocabulary with the correction builder. */
const URL_CRITERION_RE =
  /\b(url|endpoint|deploy|live|reachable|http|served|serves|api)\b/i;
const FILE_CRITERION_RE =
  /\b(file|page|artifact|deliverable)\b.*\b(exists|created|written|present)\b|\b(create[sd]?|write[sn]?)\b.*\b(file|page)\b/i;
const DIFF_CRITERION_RE = /\bdiff\b|\bchange(?:set)?\b.*\bsummar/i;
const TEST_CRITERION_RE =
  /\b(test|spec|coverage|unit|e2e|integration|vitest|jest)s?\b/i;
const BUILD_CRITERION_RE = /\b(build|compile|typecheck|tsc)\b/i;
const LINT_CRITERION_RE = /\b(lint|biome|eslint|format)\b/i;
const SCREENSHOT_CRITERION_RE = /\b(screenshot|screen\s*capture)\b/i;
const EXPLICIT_HTTP_URL_RE = /https?:\/\/[^\s`"'<>]+/gi;
const URL_BEHAVIOR_CRITERION_RE =
  /\b(?:[1-5]\d{2}|status|response|body|json|xml|auth(?:entication|orization)?|unauthorized|forbidden|token|header|payload|method|redirect|error|returns?|responds?|contains?|matches?|accepts?|rejects?|requires?|allows?|denies?|get|post|put|patch|delete)\b/i;
const IMPLICIT_REACHABILITY_CRITERION_RE =
  /\b(?:live\s+url|public\s+url|(?:url|page|site|app|deployment)\s+(?:is\s+)?(?:live|reachable|available|served)|deployed\s+(?:app|page|site))\b/i;

function normalizeExplicitHttpUrl(value: string): string | undefined {
  const candidate = value.replace(/[),.;!?]+$/, "");
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.href
      : undefined;
  } catch {
    // error-policy:J3 A malformed criterion token is not a concrete URL claim.
    return undefined;
  }
}

function urlCriterionBasis(
  criterion: string,
  facts: DeterministicEvidenceFacts,
): string | undefined {
  const demandedUrls = [...criterion.matchAll(EXPLICIT_HTTP_URL_RE)]
    .map((match) => normalizeExplicitHttpUrl(match[0]))
    .filter((url): url is string => Boolean(url));
  const verified = facts.verifiedPublicUrls
    .map(normalizeExplicitHttpUrl)
    .filter((url): url is string => Boolean(url));
  if (URL_BEHAVIOR_CRITERION_RE.test(criterion)) return undefined;
  if (
    demandedUrls.length === 0 &&
    !IMPLICIT_REACHABILITY_CRITERION_RE.test(criterion)
  ) {
    return undefined;
  }
  const hit =
    demandedUrls.length > 0
      ? verified.find((url) => demandedUrls.includes(url))
      : verified[0];
  return hit ? `probed URL answered: ${hit}` : undefined;
}

/** Deterministic facts the orchestrator already holds at completion. */
export interface DeterministicEvidenceFacts {
  /** Router-probed URLs that answered, non-loopback only. */
  verifiedPublicUrls: readonly string[];
  /** Claimed files backed by a successful write in the session tool ledger. */
  ledgerVerifiedFiles: readonly string[];
  /** Whether a real git changeset was captured at completion. */
  hasChangeSet: boolean;
  /** Mined green output present per check class. */
  greenChecks: { test: boolean; build: boolean; lint: boolean };
}

export interface DeterministicCriterionResult {
  criterion: string;
  status: "met" | "undetermined";
  /** The concrete fact that satisfied a met criterion. */
  basis?: string;
}

export interface DeterministicLedgerVerdict {
  /** True only when EVERY criterion was deterministically satisfied. */
  allMet: boolean;
  results: DeterministicCriterionResult[];
  met: string[];
  undetermined: string[];
}

function fileCriterionBasis(
  criterion: string,
  facts: DeterministicEvidenceFacts,
): string | undefined {
  if (facts.ledgerVerifiedFiles.length === 0) return undefined;
  const tokens = [...criterion.matchAll(PATH_TOKEN_RE)].map((match) =>
    (match[1] ?? "").toLowerCase(),
  );
  if (tokens.length === 0) {
    // No specific path demanded: any ledger-verified write satisfies
    // "the file/deliverable exists".
    return `ledger-verified write: ${facts.ledgerVerifiedFiles[0]}`;
  }
  const hit = facts.ledgerVerifiedFiles.find((file) => {
    const lower = file.toLowerCase();
    return tokens.some(
      (token) =>
        lower === token || lower.endsWith(`/${token}`) || lower.includes(token),
    );
  });
  return hit ? `ledger-verified write: ${hit}` : undefined;
}

/**
 * Judge one criterion purely from deterministic facts. Conservative by
 * construction: anything not clearly satisfied is `undetermined`, never
 * "met" — this can promote a working deliverable but can never paper over a
 * missing one.
 */
export function deterministicCriterionCheck(
  criterion: string,
  facts: DeterministicEvidenceFacts,
): DeterministicCriterionResult {
  if (SCREENSHOT_CRITERION_RE.test(criterion)) {
    return { criterion, status: "undetermined" };
  }
  if (URL_CRITERION_RE.test(criterion)) {
    const basis = urlCriterionBasis(criterion, facts);
    return basis
      ? { criterion, status: "met", basis }
      : { criterion, status: "undetermined" };
  }
  if (TEST_CRITERION_RE.test(criterion)) {
    return facts.greenChecks.test
      ? { criterion, status: "met", basis: "green test output captured" }
      : { criterion, status: "undetermined" };
  }
  if (BUILD_CRITERION_RE.test(criterion)) {
    return facts.greenChecks.build
      ? {
          criterion,
          status: "met",
          basis: "green build/typecheck output captured",
        }
      : { criterion, status: "undetermined" };
  }
  if (LINT_CRITERION_RE.test(criterion)) {
    return facts.greenChecks.lint
      ? { criterion, status: "met", basis: "green lint output captured" }
      : { criterion, status: "undetermined" };
  }
  if (DIFF_CRITERION_RE.test(criterion)) {
    return facts.hasChangeSet
      ? {
          criterion,
          status: "met",
          basis: "git changeset captured at completion",
        }
      : { criterion, status: "undetermined" };
  }
  if (FILE_CRITERION_RE.test(criterion)) {
    const basis = fileCriterionBasis(criterion, facts);
    return basis
      ? { criterion, status: "met", basis }
      : { criterion, status: "undetermined" };
  }
  return { criterion, status: "undetermined" };
}

/**
 * The deterministic pre-pass the pipeline runs BEFORE any model judgment:
 * when every acceptance criterion is satisfied by the write ledger, probed
 * URLs, captured changeset, or mined green check output, the task passes with
 * {@link DETERMINISTIC_LEDGER_VERIFIER_NAME} provenance and no model spend.
 */
export function deterministicLedgerVerdict(
  criteria: readonly string[],
  facts: DeterministicEvidenceFacts,
): DeterministicLedgerVerdict {
  const results = criteria.map((criterion) =>
    deterministicCriterionCheck(criterion, facts),
  );
  const met = results
    .filter((result) => result.status === "met")
    .map((result) => result.criterion);
  const undetermined = results
    .filter((result) => result.status === "undetermined")
    .map((result) => result.criterion);
  return {
    allMet: criteria.length > 0 && undetermined.length === 0,
    results,
    met,
    undetermined,
  };
}

/** Only public HTTP(S) targets count as publicly-reachable deploy evidence. */
export function isPubliclyReachableUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    if (parsed.username || parsed.password || parsed.hostname.length === 0) {
      return false;
    }
    return (
      !isBlockedHostname(parsed.hostname) &&
      !isPrivateIpAddress(parsed.hostname)
    );
  } catch {
    // error-policy:J3 an unparseable URL is explicitly not reachable evidence
    return false;
  }
}

const GREEN_MARKER_RE = /\bpass(?:ed|ing)?\b|✓|✔|\bPASS\b|\bok\b|0 fail/i;
const RED_MARKER_RE = /\bnot\s+ok\b|\bfail(?:ed|ing|ure)?\b|✗|✖|\berrors?\b/i;

/**
 * Whether mined tool output constitutes GREEN evidence for a check class:
 * present, showing a pass marker, and free of failure markers. Conservative —
 * ambiguous output is not green (the model judge can still weigh it).
 */
export function isGreenCheckOutput(output: string | undefined | null): boolean {
  if (typeof output !== "string" || output.trim().length === 0) return false;
  const withoutZeroFailures = output.replace(/\b0\s+fail(?:ed|ures?)?\b/gi, "");
  return (
    GREEN_MARKER_RE.test(output) && !RED_MARKER_RE.test(withoutZeroFailures)
  );
}

/** Render the deterministic verdict as an evidence section for downstream
 *  judges (partial case) or as the pass evidence (allMet case). */
export function renderDeterministicVerdict(
  verdict: DeterministicLedgerVerdict,
): string {
  const lines = [
    "## DETERMINISTICALLY VERIFIED CRITERIA (write ledger / probed URLs / captured output — not model judgment)",
    ...verdict.results.map((result) =>
      result.status === "met"
        ? `- MET: ${result.criterion} [${result.basis}]`
        : `- undetermined (needs judgment): ${result.criterion}`,
    ),
  ];
  return lines.join("\n");
}
