#!/usr/bin/env node
/**
 * Assembles the dossier the deep PR reviewer reads before it forms an opinion.
 *
 * A reviewing agent handed only a diff writes a plausible review of the diff.
 * That is the failure this module exists to prevent: the questions that decide
 * whether a change should merge here — is the evidence real, did CI actually
 * pass, does the fix address the cause or the symptom, was a test weakened to
 * make red go green — are answerable only from context that lives outside the
 * patch. So the dossier carries the pull request's evidence-row audit (through
 * the repository's own gate parser, never a second implementation of it), the
 * live check results for the head commit, the review conversation so far, and a
 * mechanical scan for the specific edits that make a symptom disappear without
 * curing it.
 *
 * `detectBandaidSignals()` and `summarizeTestCoverage()` are pure and tested.
 * They do not decide anything: they hand the agent leads it must confirm or
 * dismiss by reading the code, which is why every signal names a file and line.
 *
 * Consumed by .github/workflows/claude-code-review.yml.
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import {
  evaluatePrEvidence,
  REQUIRED_EVIDENCE_ROWS,
} from "../../scripts/check-pr-evidence.mjs";

/** Files whose changes are tests rather than shipped behavior. */
const TEST_PATH_RE =
  /(\.(test|spec|bench)\.[cm]?[jt]sx?$|(^|\/)(__tests__|__e2e__|e2e|tests?)\/)/i;

/** Files that ship no behavior, so they neither need nor provide test cover. */
const NON_BEHAVIORAL_RE =
  /(\.(md|mdx|txt|json|ya?ml|lock|snap|svg|png|jpe?g|gif|webp|ico)$|(^|\/)(docs|\.github)\/)/i;

const SOURCE_EXT_RE = /\.[cm]?[jt]sx?$|\.(rs|py|go|swift|kt|java)$/i;

/**
 * Edits that make a failure stop being visible without establishing that it
 * stopped happening. Each entry is a lead for the reviewer, not a verdict —
 * every one of these is legitimate somewhere, which is exactly why a human-
 * grade review has to look at them individually instead of trusting green CI.
 */
const BANDAID_PATTERNS = [
  {
    id: "disabled-test",
    severity: "high",
    test: /^\+.*\b(it|test|describe)\.(skip|todo)\b|^\+.*\bx(it|describe)\(|^\+\s*\/\/\s*@ts-nocheck/,
    explain: "a test was skipped or type-checking was switched off",
  },
  {
    id: "focused-test",
    severity: "high",
    test: /^\+.*\b(it|test|describe)\.only\b/,
    explain:
      "a focused test silently stops every other test in the file from running",
  },
  {
    id: "removed-assertion",
    severity: "high",
    test: /^-\s*(expect|assert|should)\b/,
    explain:
      "an assertion was deleted — confirm the behavior it guarded is still guarded",
  },
  {
    id: "swallowed-error",
    severity: "high",
    test: /^\+.*(catch\s*\([^)]*\)\s*\{\s*\}|\.catch\(\s*\(\s*\)\s*=>\s*\{?\s*\}?\s*\)|except\s*:\s*pass)/,
    explain:
      "an error is caught and discarded, which hides the failure instead of handling it",
  },
  {
    id: "fabricated-default",
    severity: "high",
    test: /^\+.*\?\?\s*(0|\[\]|""|''|\{\}|false)\s*[;,)\]]/,
    explain:
      "a literal default stands in for possibly-missing data, conflating 'not loaded' with 'empty'",
  },
  {
    id: "weakened-type",
    severity: "medium",
    test: /^\+.*(:\s*any\b|as\s+any\b|as\s+unknown\s+as\b|@ts-(ignore|expect-error))/,
    explain: "a type was weakened or an error suppressed rather than resolved",
  },
  {
    id: "loosened-timing",
    severity: "medium",
    test: /^\+.*\b(setTimeout|sleep|waitFor|retries|retry|timeout)\b.*\b\d{4,}\b/,
    explain:
      "a timeout or retry was enlarged, which usually postpones a race rather than removing it",
  },
  {
    id: "ci-failure-mask",
    severity: "high",
    test: /^\+.*(continue-on-error:\s*true|\|\|\s*true\b|--passWithNoTests|--no-verify)/,
    explain: "a CI step was made unable to fail",
  },
  {
    id: "snapshot-rewrite",
    severity: "medium",
    test: /^\+.*(-u\b|--update-snapshots?|toMatchSnapshot\(\))/,
    explain:
      "snapshots were regenerated — confirm the new snapshot is correct, not merely current",
  },
];

/** Parses a unified diff hunk header into the new-file starting line. */
function hunkStartLine(header) {
  const match = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(header);
  return match ? Number(match[1]) : null;
}

/**
 * Scans patches for surface-fix tells, reporting the file and new-file line of
 * every hit so the reviewer can go read it.
 */
export function detectBandaidSignals(files) {
  const signals = [];
  for (const file of files) {
    if (!file.patch) continue;
    let lineNumber = 0;
    for (const line of file.patch.split("\n")) {
      if (line.startsWith("@@")) {
        const start = hunkStartLine(line);
        if (start !== null) lineNumber = start - 1;
        continue;
      }
      if (!line.startsWith("-")) lineNumber += 1;
      for (const pattern of BANDAID_PATTERNS) {
        if (!pattern.test.test(line)) continue;
        signals.push({
          id: pattern.id,
          severity: pattern.severity,
          explain: pattern.explain,
          file: file.filename,
          line: line.startsWith("-") ? null : lineNumber,
          text: line.slice(0, 200),
        });
      }
    }
  }
  return signals;
}

/**
 * Which changed source files gained no test coverage in the same pull request.
 * Matching is by basename because this repository colocates
 * `foo.ts` with `__tests__/foo.test.ts` and `foo.test.ts` alike.
 */
export function summarizeTestCoverage(files) {
  const testedStems = new Set();
  const changedSources = [];
  for (const file of files) {
    const name = file.filename;
    if (TEST_PATH_RE.test(name)) {
      testedStems.add(basenameStem(name).replace(/\.(test|spec|bench)$/i, ""));
      continue;
    }
    if (NON_BEHAVIORAL_RE.test(name) || !SOURCE_EXT_RE.test(name)) continue;
    changedSources.push(name);
  }
  const uncovered = changedSources.filter(
    (name) => !testedStems.has(basenameStem(name)),
  );
  return {
    changedSourceCount: changedSources.length,
    testFileCount: files.filter((file) => TEST_PATH_RE.test(file.filename))
      .length,
    uncovered,
  };
}

function basenameStem(path) {
  const base = path.split("/").pop() ?? path;
  return base
    .replace(/\.[cm]?[jt]sx?$/i, "")
    .replace(/\.(rs|py|go|swift|kt|java)$/i, "");
}

/** Issue references in the pull request body, so the reviewer can check intent. */
export function extractLinkedIssues(body) {
  const found = new Set();
  for (const match of String(body ?? "").matchAll(/(?:^|\s)#(\d{3,6})\b/g)) {
    found.add(Number(match[1]));
  }
  for (const match of String(body ?? "").matchAll(
    /github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/(\d+)/g,
  )) {
    found.add(Number(match[1]));
  }
  return [...found].sort((a, b) => a - b);
}

/** Renders the dossier. */
export function renderDossier({
  pr,
  files,
  evidence,
  checks,
  coverage,
  signals,
  linkedIssues,
  priorComments,
}) {
  const out = [
    `# Review dossier: #${pr.number} — ${pr.title}`,
    "",
    `- Author: ${pr.user?.login} · Base: \`${pr.base?.ref}\` · Head: \`${pr.head?.sha}\``,
    `- Churn: +${pr.additions}/-${pr.deletions} across ${pr.changed_files} files, ${pr.commits} commits`,
    `- Draft: ${pr.draft ? "yes" : "no"} · Mergeable state: ${pr.mergeable_state ?? "unknown"}`,
    `- Linked issues: ${linkedIssues.length ? linkedIssues.map((n) => `#${n}`).join(", ") : "none referenced"}`,
    "",
    "## Stated intent (the claim this change must be measured against)",
    "",
    "```markdown",
    (pr.body ?? "").slice(0, 12_000) || "(empty pull request description)",
    "```",
    "",
    "## Evidence gate audit",
    "",
  ];

  const failing = evidence.findings.filter(
    (finding) => finding.status !== "ok",
  );
  out.push(
    evidence.ok
      ? "Every required evidence row is satisfied by the repository's own gate parser."
      : `${failing.length} evidence row(s) are NOT satisfied:`,
  );
  for (const finding of failing) {
    out.push(`- **${finding.label}** (\`${finding.id}\`): ${finding.status}`);
  }
  out.push(
    "",
    "Row status meanings: `missing` = the marker was removed from the body; `blank` = no",
    "artifact link and no `N/A - <reason>`; `artifact-required` = a rendered-UI file changed,",
    "so real media is mandatory and N/A is refused; `ocr-required` = a UI diff without an OCR",
    "text review. A satisfied row means a link is PRESENT — not that anyone opened it. Judging",
    "whether the linked artifact actually shows the claimed behavior is your job, not the gate's.",
    "",
    "## CI state for the head commit",
    "",
  );

  if (checks.length === 0) {
    out.push("No check runs reported for this commit yet.");
  } else {
    const grouped = new Map();
    for (const check of checks) {
      const key =
        check.status === "completed"
          ? (check.conclusion ?? "unknown")
          : check.status;
      grouped.set(key, [...(grouped.get(key) ?? []), check.name]);
    }
    for (const [state, names] of [...grouped].sort()) {
      out.push(
        `- **${state}** (${names.length}): ${names.slice(0, 25).join(", ")}`,
      );
    }
    const failed = checks.filter(
      (check) =>
        check.status === "completed" &&
        !["success", "skipped", "neutral"].includes(check.conclusion),
    );
    if (failed.length) {
      out.push(
        "",
        "Failing checks — a passing review over red CI is not a review:",
      );
      for (const check of failed)
        out.push(`- ${check.name}: ${check.conclusion} — ${check.html_url}`);
    }
  }

  out.push("", "## Test coverage of changed behavior", "");
  out.push(
    `- Changed source files: ${coverage.changedSourceCount}`,
    `- Changed test files: ${coverage.testFileCount}`,
  );
  if (coverage.uncovered.length) {
    out.push(
      `- Source files with no same-name test touched in this pull request (${coverage.uncovered.length}):`,
      ...coverage.uncovered.slice(0, 40).map((name) => `  - ${name}`),
      "",
      "Name matching is a heuristic. Confirm against the real suite before claiming a gap:",
      "coverage may live in an integration or e2e test with an unrelated filename.",
    );
  } else {
    out.push(
      "- Every changed source file has a same-named test touched in this pull request.",
    );
  }

  out.push("", "## Mechanical surface-fix signals", "");
  if (signals.length === 0) {
    out.push(
      "No surface-fix patterns matched. Depth of the fix still has to be judged by reading it.",
    );
  } else {
    out.push(
      `${signals.length} pattern hit(s). Each is a LEAD to verify, never a finding on its own —`,
      "confirm by reading the code, and say so explicitly if it is legitimate here.",
      "",
    );
    for (const signal of signals.slice(0, 60)) {
      const where = signal.line === null ? "(removed line)" : `:${signal.line}`;
      out.push(
        `- [${signal.severity}] \`${signal.id}\` ${signal.file}${where} — ${signal.explain}`,
      );
      out.push(`  \`${signal.text.replace(/`/g, "'")}\``);
    }
  }

  out.push("", "## Changed files", "");
  for (const file of files.slice(0, 200)) {
    out.push(
      `- ${file.status} \`${file.filename}\` (+${file.additions}/-${file.deletions})`,
    );
  }
  if (files.length > 200) out.push(`- …and ${files.length - 200} more`);

  out.push("", "## Review conversation so far", "");
  if (priorComments.length === 0) {
    out.push("No prior review comments.");
  } else {
    out.push(
      "Do not repeat a point already made here; say whether it was addressed.",
      "",
    );
    for (const comment of priorComments.slice(-40)) {
      out.push(
        `- **${comment.author}** on ${comment.path ?? "the pull request"}: ${comment.body.slice(0, 600).replace(/\n+/g, " ")}`,
      );
    }
  }

  return out.join("\n");
}

function requireEnv(env, name) {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function createClient(token) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  return async function request(path) {
    const response = await fetch(`https://api.github.com${path}`, { headers });
    if (!response.ok) {
      throw new Error(
        `GitHub API ${response.status} for ${path}: ${await response.text()}`,
      );
    }
    return response.json();
  };
}

async function paginate(request, path, limit = 5) {
  const all = [];
  for (let page = 1; page <= limit; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const chunk = await request(`${path}${separator}per_page=100&page=${page}`);
    all.push(...chunk);
    if (chunk.length < 100) break;
  }
  return all;
}

export async function main(env = process.env) {
  const repo = requireEnv(env, "GITHUB_REPOSITORY");
  const token = requireEnv(env, "GITHUB_TOKEN");
  const prNumber = Number(requireEnv(env, "PR_NUMBER"));
  const outDir = env.REVIEW_OUT_DIR ?? ".review";
  const request = createClient(token);

  const pr = await request(`/repos/${repo}/pulls/${prNumber}`);
  const files = await paginate(
    request,
    `/repos/${repo}/pulls/${prNumber}/files`,
  );
  const changedFiles = files.map((file) => file.filename).join("\n");
  const addedFiles = files
    .filter((file) => file.status === "added")
    .map((file) => file.filename)
    .join("\n");

  const evidence = evaluatePrEvidence(pr.body ?? "", REQUIRED_EVIDENCE_ROWS, {
    labels: (pr.labels ?? []).map((label) => label.name).join(","),
    changedFiles,
    addedFiles,
  });

  const checkPayload = await request(
    `/repos/${repo}/commits/${pr.head.sha}/check-runs?per_page=100`,
  );
  const [issueComments, reviewComments] = await Promise.all([
    paginate(request, `/repos/${repo}/issues/${prNumber}/comments`, 3),
    paginate(request, `/repos/${repo}/pulls/${prNumber}/comments`, 3),
  ]);
  const priorComments = [...issueComments, ...reviewComments]
    .filter((comment) => comment.body)
    .map((comment) => ({
      author: comment.user?.login ?? "unknown",
      body: comment.body,
      path: comment.path,
    }));

  const dossier = renderDossier({
    pr,
    files,
    evidence,
    checks: checkPayload.check_runs ?? [],
    coverage: summarizeTestCoverage(files),
    signals: detectBandaidSignals(files),
    linkedIssues: extractLinkedIssues(pr.body),
    priorComments,
  });

  mkdirSync(outDir, { recursive: true });
  const dossierPath = `${outDir}/dossier.md`;
  writeFileSync(dossierPath, dossier);
  if (env.GITHUB_OUTPUT) {
    appendFileSync(
      env.GITHUB_OUTPUT,
      `dossier_path=${dossierPath}\nhead_sha=${pr.head.sha}\nchanged_files=${files.length}\n`,
    );
  }
  console.log(
    `review dossier written to ${dossierPath} (${files.length} files)`,
  );
  return { dossierPath, dossier };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
