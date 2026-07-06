/**
 * Tests for the certification commit-drift check. Fixture repositories are
 * real `git init` repos built in a temp dir per test — no mocked git — so the
 * ancestor and diff semantics under test are exactly what CI runs.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import {
  evaluateCommitDrift,
  isAllowedDriftPath,
  readCertCommit,
} from "./check-commit-drift.mjs";

const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function git(repoDir, args) {
  return execFileSync("git", args, {
    cwd: repoDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function makeRepo() {
  const repoDir = mkdtempSync(join(tmpdir(), "cert-drift-test-"));
  roots.push(repoDir);
  git(repoDir, ["init", "-b", "main"]);
  git(repoDir, ["config", "user.email", "drift-test@example.invalid"]);
  git(repoDir, ["config", "user.name", "drift test"]);
  return repoDir;
}

function commitFiles(repoDir, message, files) {
  for (const [relPath, content] of Object.entries(files)) {
    const filePath = join(repoDir, ...relPath.split("/"));
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
  }
  git(repoDir, ["add", "-A"]);
  git(repoDir, ["commit", "-m", message]);
  return git(repoDir, ["rev-parse", "HEAD"]);
}

describe("isAllowedDriftPath", () => {
  const allowed = [
    "docs/promotion-notes.md",
    "docs/nested/deep/guide.txt",
    "packages/docs/src/pages/index.tsx",
    "README.md",
    "packages/core/CHANGELOG.md",
    ".github/pull_request_template.md",
    // The certification artifacts land after the signed commit by necessity;
    // signature + bundleSha protect their content, not the drift rule.
    "certification.json",
    "evidence/bundle/manifest.json",
    "evidence/bundle/lanes/e2e/result.json",
  ];
  const disallowed = [
    "packages/core/src/runtime.ts",
    "scripts/run-anything.mjs",
    ".github/certification/certification-public-key.pem",
    ".github/certification/README.md",
    ".github/workflows/certification-verify.yml",
    ".github/workflows/ci.yaml",
    ".github/actions/setup/action.yml",
    ".github/CODEOWNERS",
    ".github/ISSUE_TEMPLATE/config.yml",
    "scripts/certification/check-commit-drift.mjs",
    "package.json",
    "bun.lock",
    "docsish/trap.ts",
    "nested/certification.json",
    "evidence/other/file.json",
  ];
  for (const path of allowed) {
    it(`allows ${path}`, () => assert.equal(isAllowedDriftPath(path), true));
  }
  for (const path of disallowed) {
    it(`rejects ${path}`, () => assert.equal(isAllowedDriftPath(path), false));
  }
});

describe("readCertCommit", () => {
  it("extracts a full 40-hex commit", () => {
    const dir = mkdtempSync(join(tmpdir(), "cert-drift-cert-"));
    roots.push(dir);
    const sha = "a".repeat(40);
    const certPath = join(dir, "certification.json");
    writeFileSync(certPath, JSON.stringify({ schema: 1, commit: sha }));
    assert.deepEqual(readCertCommit(certPath), { commit: sha });
  });

  it("reports a missing file instead of throwing", () => {
    const read = readCertCommit(join(tmpdir(), "does-not-exist-cert.json"));
    assert.match(read.error, /certification unreadable/);
  });

  it("reports malformed JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "cert-drift-cert-"));
    roots.push(dir);
    const certPath = join(dir, "certification.json");
    writeFileSync(certPath, "{not json");
    assert.match(readCertCommit(certPath).error, /not valid JSON/);
  });

  it("rejects short or missing commit fields", () => {
    const dir = mkdtempSync(join(tmpdir(), "cert-drift-cert-"));
    roots.push(dir);
    const certPath = join(dir, "certification.json");
    writeFileSync(certPath, JSON.stringify({ commit: "abc123" }));
    assert.match(readCertCommit(certPath).error, /40-hex/);
    writeFileSync(certPath, JSON.stringify({ schema: 1 }));
    assert.match(readCertCommit(certPath).error, /40-hex/);
  });
});

describe("evaluateCommitDrift", () => {
  it("matches when the certification commit equals head", () => {
    const repoDir = makeRepo();
    const sha = commitFiles(repoDir, "base", {
      "packages/core/src/index.ts": "export {};\n",
    });
    const outcome = evaluateCommitDrift({
      certCommit: sha,
      headCommit: sha,
      repoDir,
    });
    assert.equal(outcome.result, "match");
    assert.deepEqual(outcome.driftPaths, []);
  });

  it("allows docs-only drift after the certified commit", () => {
    const repoDir = makeRepo();
    const certSha = commitFiles(repoDir, "certified tree", {
      "packages/core/src/index.ts": "export {};\n",
    });
    const headSha = commitFiles(repoDir, "docs drift", {
      "docs/promotion-notes.md": "# notes\n",
      "packages/docs/guide.mdx": "guide\n",
      "README.md": "# readme\n",
      ".github/pull_request_template.md": "# template\n",
    });
    const outcome = evaluateCommitDrift({
      certCommit: certSha,
      headCommit: headSha,
      repoDir,
    });
    assert.equal(outcome.result, "allowed-drift");
    assert.equal(outcome.driftPaths.length, 4);
    assert.deepEqual(outcome.disallowedPaths, []);
  });

  it("fails when drift touches source paths, listing the offenders", () => {
    const repoDir = makeRepo();
    const certSha = commitFiles(repoDir, "certified tree", {
      "packages/core/src/index.ts": "export {};\n",
    });
    const headSha = commitFiles(repoDir, "mixed drift", {
      "docs/ok.md": "fine\n",
      "packages/core/src/runtime.ts": "export const x = 1;\n",
    });
    const outcome = evaluateCommitDrift({
      certCommit: certSha,
      headCommit: headSha,
      repoDir,
    });
    assert.equal(outcome.result, "disallowed-drift");
    assert.deepEqual(outcome.disallowedPaths, ["packages/core/src/runtime.ts"]);
  });

  it("fails when drift touches GitHub workflow or policy paths", () => {
    const repoDir = makeRepo();
    const certSha = commitFiles(repoDir, "certified tree", {
      "packages/core/src/index.ts": "export {};\n",
    });
    const headSha = commitFiles(repoDir, "github policy drift", {
      ".github/workflows/ci.yaml": "name: ci\n",
      ".github/CODEOWNERS": "* @elizaOS/core\n",
    });
    const outcome = evaluateCommitDrift({
      certCommit: certSha,
      headCommit: headSha,
      repoDir,
    });
    assert.equal(outcome.result, "disallowed-drift");
    assert.deepEqual([...outcome.disallowedPaths].sort(), [
      ".github/CODEOWNERS",
      ".github/workflows/ci.yaml",
    ]);
  });

  it("fails when drift swaps the trusted public key (the attack the base-key rule exists for)", () => {
    const repoDir = makeRepo();
    const certSha = commitFiles(repoDir, "certified tree", {
      "packages/core/src/index.ts": "export {};\n",
    });
    const headSha = commitFiles(repoDir, "key swap", {
      ".github/certification/certification-public-key.pem": "FAKE KEY\n",
    });
    const outcome = evaluateCommitDrift({
      certCommit: certSha,
      headCommit: headSha,
      repoDir,
    });
    assert.equal(outcome.result, "disallowed-drift");
    assert.deepEqual(outcome.disallowedPaths, [
      ".github/certification/certification-public-key.pem",
    ]);
  });

  it("fails when the certified commit is not an ancestor of head", () => {
    const repoDir = makeRepo();
    commitFiles(repoDir, "trunk base", { "a.txt": "a\n" });
    git(repoDir, ["checkout", "-b", "side"]);
    const sideSha = commitFiles(repoDir, "side work", { "side.txt": "s\n" });
    git(repoDir, ["checkout", "main"]);
    const headSha = commitFiles(repoDir, "trunk head", { "b.txt": "b\n" });
    const outcome = evaluateCommitDrift({
      certCommit: sideSha,
      headCommit: headSha,
      repoDir,
    });
    assert.equal(outcome.result, "not-ancestor");
  });

  it("fails when the certified commit does not exist in the repository", () => {
    const repoDir = makeRepo();
    const headSha = commitFiles(repoDir, "only commit", { "a.txt": "a\n" });
    const outcome = evaluateCommitDrift({
      certCommit: "f".repeat(40),
      headCommit: headSha,
      repoDir,
    });
    assert.equal(outcome.result, "cert-commit-unknown");
  });
});
