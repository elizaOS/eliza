import type { ParsedPullRequestLink } from "./pull-request-link.js";
import { extractPullRequestLink } from "./pull-request-link.js";

export type GroundTruthCheckState = "green" | "pending" | "red";

export interface RemoteCheck {
  name: string;
  status: string;
  conclusion?: string | null;
  required: boolean;
}

export interface RemotePullRequest {
  url: string;
  state: "open" | "closed" | "merged";
  headSha: string;
  changedFiles: string[];
  checks: RemoteCheck[];
}

export interface GroundTruthCheckVerdict extends RemoteCheck {
  state: GroundTruthCheckState;
}

export interface GroundTruthVerdict {
  status: "verified" | "mismatch" | "missing_pr" | "inconclusive";
  checkedAt: string;
  pr: {
    claimed: boolean;
    url?: string;
    repo?: string;
    number?: number;
    exists: boolean | null;
    state?: RemotePullRequest["state"];
    headSha?: string;
  };
  checks: {
    state: GroundTruthCheckState | "unavailable";
    items: GroundTruthCheckVerdict[];
  };
  files: {
    claimed: string[];
    actual: string[];
    changedButNotClaimed: string[];
    claimedButNotChanged: string[];
  };
  hardFail: boolean;
  hardFailReasons: string[];
  summary: string;
  error?: string;
}

export interface GroundTruthVerifierDeps {
  fetchPullRequest: (
    link: ParsedPullRequestLink,
  ) => Promise<RemotePullRequest | null>;
  now?: () => Date;
}

function uniqueSorted(files: readonly string[]): string[] {
  return [...new Set(files.map((file) => file.trim()).filter(Boolean))].sort();
}

export function compareClaimedFiles(
  claimedFiles: readonly string[],
  actualFiles: readonly string[],
): Pick<
  GroundTruthVerdict["files"],
  "claimed" | "actual" | "changedButNotClaimed" | "claimedButNotChanged"
> {
  const claimed = uniqueSorted(claimedFiles);
  const actual = uniqueSorted(actualFiles);
  const claimedSet = new Set(claimed);
  const actualSet = new Set(actual);
  return {
    claimed,
    actual,
    changedButNotClaimed: actual.filter((file) => !claimedSet.has(file)),
    claimedButNotChanged: claimed.filter((file) => !actualSet.has(file)),
  };
}

export function classifyCheck(check: RemoteCheck): GroundTruthCheckState {
  const status = check.status.toLowerCase();
  if (status !== "completed") return "pending";
  const conclusion = check.conclusion?.toLowerCase();
  if (
    conclusion === "success" ||
    conclusion === "neutral" ||
    conclusion === "skipped"
  ) {
    return "green";
  }
  if (
    conclusion === "failure" ||
    conclusion === "timed_out" ||
    conclusion === "cancelled" ||
    conclusion === "action_required" ||
    conclusion === "startup_failure" ||
    conclusion === "stale"
  ) {
    return "red";
  }
  return "pending";
}

export function classifyCheckRollup(checks: readonly RemoteCheck[]): {
  state: GroundTruthCheckState;
  items: GroundTruthCheckVerdict[];
} {
  const items = checks.map((check) => ({
    ...check,
    state: classifyCheck(check),
  }));
  const required = items.filter((check) => check.required);
  const relevant = required.length > 0 ? required : items;
  const state = relevant.some((check) => check.state === "red")
    ? "red"
    : relevant.some((check) => check.state === "pending")
      ? "pending"
      : "green";
  return { state, items };
}

function emptyFiles(
  claimedFiles: readonly string[],
): GroundTruthVerdict["files"] {
  return compareClaimedFiles(claimedFiles, []);
}

export function shouldIncludeGroundTruthEvidence(
  getSetting: (key: string) => unknown,
): boolean {
  const value = getSetting("ELIZA_ORCHESTRATOR_GROUND_TRUTH_EVIDENCE");
  return value !== "0" && value !== "false" && value !== false;
}

export function groundTruthHardFailEnabled(
  getSetting: (key: string) => unknown,
): boolean {
  const value = getSetting("ELIZA_ORCHESTRATOR_GROUND_TRUTH_HARD_FAIL");
  return value === "1" || value === "true" || value === true;
}

export function groundTruthRequiresPullRequest(
  getSetting: (key: string) => unknown,
  metadata: Record<string, unknown> | undefined,
): boolean {
  const policy = metadata?.groundTruthPolicy;
  const metadataRequires =
    metadata?.requirePullRequest === true ||
    (policy !== null &&
      typeof policy === "object" &&
      (policy as Record<string, unknown>).requirePullRequest === true);
  const value = getSetting("ELIZA_ORCHESTRATOR_GROUND_TRUTH_REQUIRE_PR");
  return (
    metadataRequires || value === "1" || value === "true" || value === true
  );
}

export async function verifyGroundTruth(
  input: {
    completion: string;
    claimedFiles: readonly string[];
    requirePullRequest: boolean;
    hardFailEnabled: boolean;
  },
  deps: GroundTruthVerifierDeps,
): Promise<GroundTruthVerdict> {
  const checkedAt = (deps.now?.() ?? new Date()).toISOString();
  const link = extractPullRequestLink(input.completion);
  if (!link) {
    const hardFail = input.hardFailEnabled && input.requirePullRequest;
    return {
      status: "missing_pr",
      checkedAt,
      pr: { claimed: false, exists: false },
      checks: { state: "unavailable", items: [] },
      files: emptyFiles(input.claimedFiles),
      hardFail,
      hardFailReasons: hardFail
        ? ["A pull request is required but none was claimed."]
        : [],
      summary: input.requirePullRequest
        ? "No pull request was claimed, but task policy requires one."
        : "No pull request was claimed; remote verification was skipped.",
    };
  }

  let remote: RemotePullRequest | null;
  try {
    remote = await deps.fetchPullRequest(link);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "inconclusive",
      checkedAt,
      pr: {
        claimed: true,
        url: link.url,
        repo: link.repo,
        number: link.number,
        exists: null,
      },
      checks: { state: "unavailable", items: [] },
      files: emptyFiles(input.claimedFiles),
      hardFail: false,
      hardFailReasons: [],
      summary:
        "GitHub verification was inconclusive because the API request failed.",
      error: message,
    };
  }

  if (!remote) {
    const hardFail = input.hardFailEnabled;
    return {
      status: "missing_pr",
      checkedAt,
      pr: {
        claimed: true,
        url: link.url,
        repo: link.repo,
        number: link.number,
        exists: false,
      },
      checks: { state: "unavailable", items: [] },
      files: emptyFiles(input.claimedFiles),
      hardFail,
      hardFailReasons: hardFail
        ? ["The claimed pull request does not exist."]
        : [],
      summary: "The claimed pull request does not exist or is not accessible.",
    };
  }

  const checks = classifyCheckRollup(remote.checks);
  const files = compareClaimedFiles(input.claimedFiles, remote.changedFiles);
  const mismatch =
    files.changedButNotClaimed.length > 0 ||
    files.claimedButNotChanged.length > 0;
  const redRequired = checks.items.filter(
    (check) => check.required && check.state === "red",
  );
  const hardFail = input.hardFailEnabled && redRequired.length > 0;
  const hardFailReasons = hardFail
    ? [
        `Required checks are red: ${redRequired.map((check) => check.name).join(", ")}.`,
      ]
    : [];
  const status =
    checks.state === "pending"
      ? "inconclusive"
      : mismatch || checks.state === "red"
        ? "mismatch"
        : "verified";
  return {
    status,
    checkedAt,
    pr: {
      claimed: true,
      url: remote.url,
      repo: link.repo,
      number: link.number,
      exists: true,
      state: remote.state,
      headSha: remote.headSha,
    },
    checks,
    files,
    hardFail,
    hardFailReasons,
    summary: hardFail
      ? hardFailReasons[0]
      : checks.state === "pending"
        ? "Pull request checks are still pending; remote verification is not yet conclusive."
        : mismatch
          ? "Remote pull-request files do not exactly match the captured workspace change set."
          : `Pull request exists (${remote.state}); CI is ${checks.state}; changed files match the captured claim.`,
  };
}

export function renderGroundTruthEvidence(verdict: GroundTruthVerdict): string {
  const lines = [
    "## GROUND TRUTH (GitHub API verification)",
    `status: ${verdict.status}`,
    `summary: ${verdict.summary}`,
    `pullRequest: ${verdict.pr.url ?? "not claimed"}`,
    `exists: ${verdict.pr.exists === null ? "inconclusive" : String(verdict.pr.exists)}`,
  ];
  if (verdict.pr.state) lines.push(`state: ${verdict.pr.state}`);
  if (verdict.pr.headSha) lines.push(`headSha: ${verdict.pr.headSha}`);
  lines.push(`checkRollup: ${verdict.checks.state}`);
  for (const check of verdict.checks.items) {
    lines.push(
      `- check ${check.name}: ${check.state}${check.required ? " (required)" : ""}`,
    );
  }
  lines.push(
    `changedButNotClaimed: ${verdict.files.changedButNotClaimed.join(", ") || "(none)"}`,
    `claimedButNotChanged: ${verdict.files.claimedButNotChanged.join(", ") || "(none)"}`,
    `hardFail: ${String(verdict.hardFail)}`,
  );
  if (verdict.error) lines.push(`apiError: ${verdict.error}`);
  return lines.join("\n");
}
