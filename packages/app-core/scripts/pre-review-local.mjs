import { execFileSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ANY_TYPE_PATTERN = /:\s*any\b|<\s*any\s*>|\bas\s+any\b/;

// TypeScript / JavaScript source file extensions. TS-specific patterns like
// ANY_TYPE_PATTERN and @ts-expect-error should only be scanned against these — not
// against Markdown, YAML, JSON, shell scripts, or other non-source files where
// the literal strings may legitimately appear in prose or configuration.
const SOURCE_CODE_EXTENSIONS = /\.(?:m|c)?[jt]sx?$/i;
const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;

export function isSourceCode(file) {
  return SOURCE_CODE_EXTENSIONS.test(file);
}

// Files whose changes do not require accompanying regression tests. Broader
// than "docs-only" — also covers agent definitions (.claude/), CI workflow
// YAML (.github/), editor rules (.cursor/), dev-tooling shell scripts, build
// orchestration under scripts/, lockfiles, build/tooling configs, and the
// submodule pointer. None of these produce runtime behavior that a Vitest
// suite could meaningfully assert against.
export function isTestExempt(file) {
  if (file.startsWith("docs/")) return true;
  if (file.startsWith("packages/docs/")) return true;
  if (file.startsWith("eliza/docs/")) return true;
  if (/\.(mdx?|txt)$/i.test(file)) return true;
  if (file.startsWith(".claude/")) return true;
  if (file.startsWith(".github/")) return true;
  if (file.startsWith(".cursor/")) return true;
  if (file.startsWith("scripts/")) return true;
  if (/\.sh$/i.test(file)) return true;
  // Static assets (images, fonts, audio, video) have no runtime behavior a
  // Vitest suite can assert against.
  if (
    /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp|tiff?|heic|woff2?|ttf|otf|eot|mp3|mp4|wav|ogg|webm|mov)$/i.test(
      file,
    )
  )
    return true;
  if (/(^|\/)(bun\.lock|package-lock\.json|yarn\.lock)$/.test(file))
    return true;
  if (/(^|\/)package\.json$/.test(file)) return true;
  if (/(^|\/)tsconfig(\.[\w-]+)?\.json$/.test(file)) return true;
  if (
    /(^|\/)(vite|vitest|tsdown|rollup|tsup|webpack|esbuild)\.config\.[cm]?[jt]s$/.test(
      file,
    )
  )
    return true;
  if (
    file.startsWith("test/helpers/") ||
    file.startsWith("eliza/test/helpers/") ||
    /(^|\/)test\/helpers\//.test(file)
  )
    return true;
  // Submodule pointer changes appear as a single path with no extension.
  if (file === "eliza" || file === "eliza/cloud" || file === "eliza/steward-fi")
    return true;
  return false;
}

const SECRET_LIKE_TOKEN_PATTERNS = [
  /sk-[a-z0-9]{20,}/i,
  /pk_[a-z0-9]{24,}/i,
  /xox[baprs]-[0-9a-z-]{10,}/i,
  /gh[pousr]_[A-Za-z0-9_]{36,}/i,
  /(?:^|[^A-Za-z0-9_])(password|secret|api[_-]?key|access[_-]?token|client[_-]?secret|private[_-]?key)\s*[:=]\s*["'][^"']{8,}/i,
];

function extractAddedDiffLines(diffChunks) {
  return diffChunks
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
}

function extractRemovedDiffLines(diffChunks) {
  return diffChunks
    .split("\n")
    .filter((line) => line.startsWith("-") && !line.startsWith("---"))
    .map((line) => line.slice(1))
    .join("\n");
}

function countPatternMatches(text, pattern) {
  const flags = pattern.flags.includes("g")
    ? pattern.flags
    : `${pattern.flags}g`;
  const globalPattern = new RegExp(pattern.source, flags);
  return [...text.matchAll(globalPattern)].length;
}

function normalizeExecError(error) {
  return {
    ok: false,
    stdout: error.stdout ? String(error.stdout) : "",
    stderr: error.stderr ? String(error.stderr) : String(error.message),
    status: Number(error.status ?? 1),
  };
}

function runCommand(command, options = {}) {
  try {
    return {
      ok: true,
      stdout: execSync(command, {
        encoding: "utf8",
        maxBuffer: DEFAULT_MAX_BUFFER,
        stdio: ["pipe", "pipe", "pipe"],
        ...options,
      }),
      stderr: "",
      status: 0,
    };
  } catch (error) {
    return normalizeExecError(error);
  }
}

function runCommandArgs(command, args, options = {}) {
  try {
    return {
      ok: true,
      stdout: execFileSync(command, args, {
        encoding: "utf8",
        maxBuffer: DEFAULT_MAX_BUFFER,
        stdio: ["pipe", "pipe", "pipe"],
        ...options,
      }),
      stderr: "",
      status: 0,
    };
  } catch (error) {
    return normalizeExecError(error);
  }
}

export function getBaseRef() {
  const explicitBase =
    process.env.ELIZA_PRE_REVIEW_BASE ?? process.env.PRE_REVIEW_BASE_REF;
  if (explicitBase) {
    const explicitResult = runCommandArgs("git", [
      "rev-parse",
      "--verify",
      explicitBase,
    ]);
    if (explicitResult.ok) return explicitBase;
  }

  const candidates = [
    "refs/remotes/upstream/develop",
    "upstream/develop",
    "refs/remotes/upstream/main",
    "upstream/main",
    "refs/heads/origin/develop",
    "origin/develop",
    "develop",
    "refs/remotes/origin/main",
    "origin/main",
    "main",
  ];

  for (const ref of candidates) {
    const result = runCommandArgs("git", ["rev-parse", "--verify", ref]);
    if (result.ok) return ref;
  }

  return "HEAD~1";
}

function firstFailureTitle(message) {
  return `Failed: ${message}`;
}

export function classificationFromInputs({ branch, message }) {
  const content = `${branch} ${message}`.toLowerCase();

  // Conventional Commit prefixes on the commit subject win over keyword
  // matching: `fix:`, `chore(ci):`, `ci(release):`, `build(...):`, etc. are
  // unambiguous signals and should not fall through to the generic
  // keyword-based classifier (which can be fooled by merge-commit subjects).
  const ccMatch = /^([a-z]+)(?:\([^)]+\))?!?:/.exec(message ?? "");
  if (ccMatch) {
    const type = ccMatch[1];
    if (type === "fix" || type === "revert") return "bugfix";
    if (type === "feat") return "feature";
    if (type === "docs") return "docs";
    if (type === "style") return "aesthetic";
    if (
      type === "chore" ||
      type === "ci" ||
      type === "build" ||
      type === "perf" ||
      type === "refactor" ||
      type === "test"
    ) {
      return "chore";
    }
  }

  if (
    /\b(redesign|restyle|theme|font|layout|css|visual|icon|logo|animation|aesthetic)\b|\bdark mode\b/.test(
      content,
    )
  ) {
    return "aesthetic";
  }

  if (/(security|vuln|secret|auth|leak)/.test(content)) {
    return "security";
  }

  if (/(fix|bug|crash|regression|error|broken)/.test(content)) {
    return "bugfix";
  }

  if (/\bdocs?\b|\.mdx?\b|\.md\b|readme/i.test(content)) {
    return "docs";
  }

  return "feature";
}

export function scopeVerdictFor(classification) {
  if (classification === "aesthetic") return "out of scope";
  if (classification === "docs") return "in scope";
  if (classification === "chore") return "in scope";
  if (classification === "feature") return "needs deep review";
  return "in scope";
}

export function decisionFromFindings({
  classification: _classification,
  issues,
}) {
  return issues.length > 0 ? "REQUEST CHANGES" : "APPROVE";
}

export function scanDiffTextForBlockedPatterns(diffChunks) {
  const issues = [];
  const addedLines = extractAddedDiffLines(diffChunks);
  const removedLines = extractRemovedDiffLines(diffChunks);

  if (
    countPatternMatches(addedLines, ANY_TYPE_PATTERN) >
    countPatternMatches(removedLines, ANY_TYPE_PATTERN)
  ) {
    issues.push(
      "Potential `any` usage introduced or modified. Verify strict typing is necessary.",
    );
  }

  if (/@ts-ignore/.test(addedLines)) {
    issues.push(
      "`@ts-ignore` usage detected. Prefer explicit narrowing or guards.",
    );
  }

  for (const pattern of SECRET_LIKE_TOKEN_PATTERNS) {
    if (pattern.test(addedLines)) {
      issues.push(
        "Potential secret-like string in diff; verify no credentials or secrets were added.",
      );
      break;
    }
  }

  return issues;
}

function readDiffForFiles(base, sourceFiles) {
  return sourceFiles
    .map((file) => {
      const result = runCommandArgs("git", [
        "diff",
        `${base}...HEAD`,
        "--",
        file,
      ]);
      return result.ok ? result.stdout : "";
    })
    .join("\n");
}

export function scanForBlockedDiffPatterns(base, changedFiles) {
  const sourceFiles = changedFiles.filter(
    (file) =>
      file !== "scripts/pre-review-local.mjs" &&
      !/\.(?:e2e\.)?test\.(tsx?|jsx?)$/i.test(file) &&
      isSourceCode(file),
  );
  if (sourceFiles.length === 0) return [];

  const diffChunks = readDiffForFiles(base, sourceFiles);
  return scanDiffTextForBlockedPatterns(diffChunks);
}

export function resolveRunnableTestFiles(testFiles, cwd = process.cwd()) {
  return testFiles.filter((file) => existsSync(path.resolve(cwd, file)));
}

export function buildRepoTestCommand(repoTests) {
  return `bunx vitest run --config eliza/test/vitest/unit.config.ts ${repoTests.join(" ")}`;
}

export function shouldRunTargetedRegressionTests({
  branch,
  env = process.env,
} = {}) {
  return !(env.GITHUB_ACTIONS === "true" && branch === "HEAD (detached)");
}

export function splitRunnableTestFiles(testFiles) {
  const repoTests = [];
  const homepageTests = [];
  const repoE2eTests = [];

  for (const file of testFiles) {
    if (file.startsWith("packages/homepage/")) {
      homepageTests.push(path.relative("packages/homepage", file));
    } else if (/\.e2e\.test\.[jt]sx?$/.test(file)) {
      if (file.startsWith("test/") || file.startsWith("eliza/test/")) {
        repoE2eTests.push(file);
      }
    } else {
      repoTests.push(file);
    }
  }

  return { repoTests, repoE2eTests, homepageTests };
}

export function collectChangedFiles(base) {
  const result = runCommandArgs("git", [
    "diff",
    "--name-only",
    `${base}...HEAD`,
  ]);
  if (!result.ok) {
    return {
      files: [],
      lines: "",
      errors: [
        firstFailureTitle("unable to read changed files"),
        result.stderr,
      ],
    };
  }

  const files = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return { files, lines: result.stdout, errors: [] };
}

export function collectCommitMessage(base) {
  const result = runCommandArgs("git", [
    "log",
    "-1",
    "--pretty=%s",
    "--no-merges",
    `${base}..HEAD`,
  ]);
  if (result.ok && result.stdout.trim()) return result.stdout.trim();

  const fallback = runCommandArgs("git", [
    "log",
    "-1",
    "--pretty=%s",
    "--no-merges",
    "HEAD",
  ]);
  if (fallback.ok && fallback.stdout.trim()) return fallback.stdout.trim();

  const anyCommit = runCommandArgs("git", ["log", "-1", "--pretty=%s", "HEAD"]);
  if (anyCommit.ok) return anyCommit.stdout.trim();

  return "";
}

export function runChecks() {
  const base = getBaseRef();
  const detectedBranch = runCommandArgs("git", [
    "branch",
    "--show-current",
  ]).stdout.trim();
  // GitHub Actions checks out a detached merge ref for PRs; fall back to the
  // source-branch env vars so classification can still see names like
  // `fix/...` or `feat/...`.
  const branch =
    detectedBranch ||
    process.env.GITHUB_HEAD_REF ||
    process.env.GITHUB_REF_NAME ||
    "HEAD (detached)";
  const commitMessage = collectCommitMessage(base);
  const classification = classificationFromInputs({
    branch,
    message: commitMessage,
  });
  const shouldRunTargetedTests = shouldRunTargetedRegressionTests({ branch });
  const scope = scopeVerdictFor(classification);

  const changed = collectChangedFiles(base);
  if (changed.errors.length) {
    return {
      classification,
      scopeVerdict: "needs deep review",
      codeQuality: `issues found: ${changed.errors.join("; ")}`,
      security: "concerns: change detection failed",
      tests: "not run: unable to read diff",
      decision: "REQUEST CHANGES",
      checklist: ["Pre-review failed to resolve git diff for changed files."],
      details: [],
      exitCode: 1,
    };
  }

  if (changed.files.length === 0) {
    return {
      classification: "other",
      scopeVerdict: "in scope",
      codeQuality: "pass",
      security: "clear",
      tests: "not applicable: no files changed compared to base branch.",
      decision: "APPROVE",
      checklist: [],
      details: [],
      changedFiles: [],
      exitCode: 0,
    };
  }

  const issues = scanForBlockedDiffPatterns(base, changed.files);

  const checks = [
    { name: "bun run verify:lint", command: "bun run verify:lint" },
    { name: "bun run verify:typecheck", command: "bun run verify:typecheck" },
  ];

  const missingTests = [];
  const checklist = [];

  for (const check of checks) {
    const result = runCommand(check.command);
    if (!result.ok) {
      issues.push(`${check.name} failed.`);
      checklist.push(`${check.name} must pass before approval.`);
      const tail = (text) => {
        const lines = String(text || "").split("\n");
        return lines.slice(-80).join("\n");
      };
      console.error(`\n=== ${check.name} stdout (last 80 lines) ===`);
      console.error(tail(result.stdout));
      console.error(`\n=== ${check.name} stderr (last 80 lines) ===`);
      console.error(tail(result.stderr));
    }
  }

  // Changes that produce no runtime behavior (docs, agent tooling, CI
  // workflow YAML, editor rules, dev shell scripts) do not need accompanying
  // regression tests — there is no runtime path to assert against.
  const allFilesAreTestExempt = changed.files.every(isTestExempt);

  if (
    !allFilesAreTestExempt &&
    (classification === "bugfix" ||
      classification === "feature" ||
      classification === "security")
  ) {
    const testFiles = changed.files.filter((file) =>
      /\.(?:e2e\.)?test\.(ts|tsx|js|jsx)$/.test(file),
    );
    if (testFiles.length === 0) {
      issues.push("No changed test files found for a behavioral change.");
      missingTests.push(
        "Add or update regression tests for changed runtime behavior.",
      );
      checklist.push(
        "Run tests that validate the exact behavior change and check them in.",
      );
    } else {
      const runnableTestFiles = resolveRunnableTestFiles(testFiles);
      if (runnableTestFiles.length === 0) {
        issues.push(
          "No runnable changed test files found for a behavioral change.",
        );
        missingTests.push(
          "Add or update regression tests for changed runtime behavior.",
        );
        checklist.push(
          "Run tests that validate the exact behavior change and check them in.",
        );
      } else if (shouldRunTargetedTests) {
        const { repoTests, repoE2eTests, homepageTests } =
          splitRunnableTestFiles(runnableTestFiles);
        const testCommands = [];

        if (repoTests.length > 0) {
          testCommands.push(buildRepoTestCommand(repoTests));
        }

        if (repoE2eTests.length > 0) {
          testCommands.push(
            `bunx vitest run --config eliza/test/vitest/e2e.config.ts ${repoE2eTests.join(" ")}`,
          );
        }

        if (homepageTests.length > 0) {
          testCommands.push(
            `cd packages/homepage && bunx vitest run ${homepageTests.join(" ")}`,
          );
        }

        for (const command of testCommands) {
          const testRun = runCommand(command);
          if (!testRun.ok) {
            issues.push("Regression/new-behavior tests did not pass.");
            missingTests.push(
              "Fix failing tests or add missing assertions for changed paths.",
            );
            checklist.push(
              "Re-run targeted regression tests after behavioral fixes.",
            );
            break;
          }
        }
      } else {
        checklist.push(
          "Changed tests detected; dedicated CI test lanes will validate them for merge refs.",
        );
      }
    }
  }

  const decision = decisionFromFindings({ classification, issues });

  if (classification === "aesthetic") {
    checklist.push(
      "Aesthetic-only scope is blocked unless user-specified and agent capability-focused.",
    );
  }

  if (classification === "feature") {
    checklist.push(
      "Feature changes should include focused unit or integration tests.",
    );
  }

  return {
    classification,
    scopeVerdict: scope,
    codeQuality: issues.length ? `issues found: ${issues.join(" ")}` : "pass",
    security: issues.length ? "concerns: review issues above" : "clear",
    tests:
      missingTests.length > 0
        ? `missing: ${missingTests.join(" ")}`
        : "adequate",
    decision,
    checklist: issues.length ? checklist : [],
    details: issues,
    changedFiles: changed.files,
    exitCode: decision === "APPROVE" ? 0 : 1,
  };
}

function printResult(result) {
  console.log("## Pre-Review Results");
  console.log(`1. **Classification:** ${result.classification}`);
  console.log(`2. **Scope verdict:** ${result.scopeVerdict}`);
  console.log(`3. **Code quality:** ${result.codeQuality}`);
  console.log(`4. **Security:** ${result.security}`);
  console.log(`5. **Tests:** ${result.tests}`);
  console.log(`6. **Decision:** ${result.decision}`);

  if (result.checklist.length > 0 || result.details.length > 0) {
    console.log("");
    console.log("### Required changes (if any):");
    const lines = [...new Set([...result.checklist, ...result.details])];
    for (const item of lines) {
      console.log(`- [ ] ${item}`);
    }
  }
}

function isMainModule() {
  if (!process.argv[1]) return false;
  return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const result = runChecks();
  printResult(result);
  process.exit(result.exitCode);
}
