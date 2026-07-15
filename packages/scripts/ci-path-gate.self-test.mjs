#!/usr/bin/env node
// Exercises ci path gate.self test automation behavior with deterministic script fixtures.
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./ci-path-gate.mjs", import.meta.url));

function runGate({ config, files = [], labels = "" }) {
  const dir = mkdtempSync(join(tmpdir(), "ci-path-gate-"));
  const changedFiles = join(dir, "changed-files.txt");
  const output = join(dir, "github-output.txt");
  const summary = join(dir, "summary.md");
  writeFileSync(changedFiles, `${files.join("\n")}\n`);

  const result = spawnSync(
    process.execPath,
    [
      script,
      "--config",
      config,
      "--event",
      "pull_request",
      "--changed-files",
      changedFiles,
      "--labels",
      labels,
      "--output",
      output,
      "--summary",
      summary,
    ],
    { encoding: "utf8" },
  );

  if (result.status !== 0) {
    throw new Error(
      result.stderr || result.stdout || `ci-path-gate exited ${result.status}`,
    );
  }

  const values = Object.fromEntries(
    readOutput(output).map((line) => {
      const [key, value] = line.split("=");
      return [key, value];
    }),
  );
  rmSync(dir, { recursive: true, force: true });
  return values;
}

function readOutput(path) {
  return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

function assertGate(name, actual, expected) {
  for (const [key, value] of Object.entries(expected)) {
    assertEqual(actual[key], value, `${name} ${key}`);
  }
}

assertGate(
  "app changes",
  runGate({ config: "test", files: ["packages/app/src/App.tsx"] }),
  {
    server: "false",
    client: "true",
    plugins: "false",
    desktop: "false",
    zero_key: "true",
    cloud: "false",
  },
);

assertGate("full label", runGate({ config: "test", labels: "ci:full" }), {
  server: "true",
  client: "true",
  plugins: "true",
  desktop: "true",
  zero_key: "true",
  cloud: "true",
});

assertGate(
  "android label",
  runGate({ config: "mobile", labels: "ci:android" }),
  {
    ios: "false",
    android: "true",
  },
);

assertGate(
  "docker runtime",
  runGate({ config: "docker", files: ["plugins/plugin-openai/src/index.ts"] }),
  {
    docker: "true",
  },
);

// The elizaos CLI suite runs under `test:server`; a CLI-only PR must trigger the
// server lane (it previously matched no rule and skipped every test lane).
assertGate(
  "elizaos CLI changes",
  runGate({ config: "test", files: ["packages/elizaos/src/scaffold.ts"] }),
  {
    server: "true",
    client: "false",
    plugins: "false",
    desktop: "false",
    zero_key: "false",
    cloud: "false",
  },
);

// Runtime skills also run under `test:server`.
assertGate(
  "runtime skills changes",
  runGate({ config: "test", files: ["packages/skills/src/index.ts"] }),
  {
    server: "true",
    client: "false",
  },
);

// Fail-safe: a novel/unmapped code package must never skip every lane. It routes
// to the server lane rather than passing green with zero tests.
assertGate(
  "unmapped code path fail-safe",
  runGate({ config: "test", files: ["packages/inference/src/router.ts"] }),
  {
    server: "true",
    client: "false",
    plugins: "false",
    desktop: "false",
    zero_key: "false",
    cloud: "false",
  },
);

// A second unmapped package proves the fail-safe branch, not a one-off pattern.
assertGate(
  "unmapped registry package fail-safe",
  runGate({ config: "test", files: ["packages/registry/src/index.ts"] }),
  {
    server: "true",
  },
);

// Pure docs/marketing surfaces are exempt and still skip cleanly (no fail-safe).
assertGate(
  "docs-only changes skip cleanly",
  runGate({ config: "test", files: ["packages/docs/pages/intro.mdx"] }),
  {
    server: "false",
    client: "false",
    plugins: "false",
    desktop: "false",
    zero_key: "false",
    cloud: "false",
  },
);

// Non-code changes (top-level files) are outside the code roots - no fail-safe.
assertGate(
  "top-level non-code changes skip cleanly",
  runGate({ config: "test", files: ["README.md"] }),
  {
    server: "false",
    client: "false",
    plugins: "false",
    desktop: "false",
    zero_key: "false",
    cloud: "false",
  },
);

// An ignored docs path alongside a real orphan code path still trips the
// fail-safe - the orphan is what matters.
assertGate(
  "mixed docs + orphan code trips fail-safe",
  runGate({
    config: "test",
    files: ["packages/docs/pages/x.mdx", "packages/inference/src/y.ts"],
  }),
  {
    server: "true",
  },
);

// --- git-diff path (--base/--head, no --changed-files) ---------------------
// The base SHA the workflows pass is the base branch TIP, which advances as
// other PRs merge. The gate must diff from the MERGE-BASE so a PR trailing its
// base branch is not charged with develop-side files it never touched, which
// over-triggered unrelated heavy lanes (#16125). Exercised against a real
// throwaway git history: base branch advances with an app (client-lane) file
// after the PR branches; the PR itself only touches a docs file.

function gitIn(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function writeIn(cwd, relPath, contents) {
  const full = join(cwd, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents);
}

function runGateGit({ config, cwd, base, head }) {
  const dir = mkdtempSync(join(tmpdir(), "ci-path-gate-git-"));
  const output = join(dir, "github-output.txt");
  const summary = join(dir, "summary.md");
  const result = spawnSync(
    process.execPath,
    [
      script,
      "--config",
      config,
      "--event",
      "pull_request",
      "--base",
      base,
      "--head",
      head,
      "--labels",
      "",
      "--output",
      output,
      "--summary",
      summary,
    ],
    { cwd, encoding: "utf8" },
  );
  if (result.status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    return { status: result.status, stderr: result.stderr };
  }
  const values = Object.fromEntries(
    readOutput(output).map((line) => {
      const [key, value] = line.split("=");
      return [key, value];
    }),
  );
  rmSync(dir, { recursive: true, force: true });
  return { status: 0, values };
}

const repo = mkdtempSync(join(tmpdir(), "ci-path-gate-repo-"));
try {
  gitIn(repo, "init", "-q");
  gitIn(repo, "config", "user.email", "test@example.com");
  gitIn(repo, "config", "user.name", "test");
  gitIn(repo, "checkout", "-q", "-b", "develop");

  // Merge-base commit: the point the PR branch forks from.
  writeIn(repo, "README.md", "base\n");
  gitIn(repo, "add", ".");
  gitIn(repo, "commit", "-q", "-m", "base");

  // PR branch changes only a docs page (matches no test lane).
  gitIn(repo, "checkout", "-q", "-b", "pr");
  writeIn(repo, "packages/docs/pages/only.mdx", "# docs\n");
  gitIn(repo, "add", ".");
  gitIn(repo, "commit", "-q", "-m", "docs-only PR change");
  const headSha = gitIn(repo, "rev-parse", "HEAD");

  // develop advances past the branch point with an app file (client lane).
  gitIn(repo, "checkout", "-q", "develop");
  writeIn(repo, "packages/app/src/App.tsx", "export default 1;\n");
  gitIn(repo, "add", ".");
  gitIn(repo, "commit", "-q", "-m", "develop advances with app change");
  const baseTipSha = gitIn(repo, "rev-parse", "HEAD");

  const stale = runGateGit({
    config: "test",
    cwd: repo,
    base: baseTipSha,
    head: headSha,
  });
  assertEqual(stale.status, 0, "stale-base git diff run exit status");
  assertGate(
    "stale base is not charged with develop-side files",
    stale.values,
    {
      server: "false",
      client: "false",
      plugins: "false",
      desktop: "false",
      zero_key: "false",
      cloud: "false",
    },
  );

  // No merge-base (unrelated histories / bad fetch depth) must fail loud, not
  // silently diff the entire tree.
  gitIn(repo, "checkout", "-q", "--orphan", "unrelated");
  gitIn(repo, "rm", "-rfq", "--cached", ".");
  writeIn(repo, "orphan.txt", "no shared history\n");
  gitIn(repo, "add", "orphan.txt");
  gitIn(repo, "commit", "-q", "-m", "orphan root");
  const orphanSha = gitIn(repo, "rev-parse", "HEAD");

  const noMergeBase = runGateGit({
    config: "test",
    cwd: repo,
    base: orphanSha,
    head: headSha,
  });
  if (noMergeBase.status === 0) {
    throw new Error("expected the gate to fail when no merge-base exists");
  }
  if (!/no merge-base/.test(noMergeBase.stderr)) {
    throw new Error(
      `expected a 'no merge-base' error, got: ${noMergeBase.stderr}`,
    );
  }
} finally {
  rmSync(repo, { recursive: true, force: true });
}

console.log("ci-path-gate self-test passed");
