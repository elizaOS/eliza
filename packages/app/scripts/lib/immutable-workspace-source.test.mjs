import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyCommittedWorkspace } from "./immutable-workspace-source.mjs";

const verifySource = (directory, commit) =>
  verifyCommittedWorkspace(directory, commit, {
    generatedFiles: [".consumer-source.json"],
  });

function fixture(t) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "consumer-source-integrity-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, bytes) => {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  };
  const git = (...args) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-q");
  git("config", "user.name", "Source integrity fixture");
  git("config", "user.email", "fixture@example.invalid");
  write("package.json", JSON.stringify({ workspaces: ["packages/*"] }));
  write(
    "turbo.json",
    JSON.stringify({ tasks: { build: { outputs: ["dist/**"] } } }),
  );
  write(
    "packages/example/package.json",
    JSON.stringify({ name: "@example/runtime" }),
  );
  write("packages/example/src/index.ts", "export const value = 1;\n");
  write(".gitignore", "ignored/\nnode_modules/\n**/dist/\n");
  git("add", ".");
  git("commit", "-qm", "Fixture");
  return { root, write, git, commit: git("rev-parse", "HEAD") };
}

test("immutable source admits declared build outputs but rejects hidden source additions", (t) => {
  const f = fixture(t);
  verifySource(f.root, f.commit);
  f.write("packages/example/dist/index.js", "generated");
  f.write("node_modules/dependency/index.js", "dependency");
  f.write(".consumer-source.json", "{}");
  verifySource(f.root, f.commit);
  f.write("ignored/injected.ts", "export const injected = true;");
  assert.throws(
    () => verifySource(f.root, f.commit),
    /Unexpected untracked runtime source: ignored\/injected.ts/,
  );
});

test("immutable source rejects changed bytes even when Git skips worktree stat checks", (t) => {
  const f = fixture(t),
    file = "packages/example/src/index.ts";
  f.git("update-index", "--assume-unchanged", file);
  f.write(file, "export const value = 2;\n");
  assert.throws(
    () => verifySource(f.root, f.commit),
    /Unexpected runtime source change/,
  );
});

test("immutable source rejects replaced files, mode changes, wrong commits and retired overrides", (t) => {
  const f = fixture(t),
    file = path.join(f.root, "packages/example/src/index.ts");
  fs.chmodSync(file, 0o755);
  assert.throws(
    () => verifySource(f.root, f.commit),
    /Unexpected runtime source change/,
  );
  fs.chmodSync(file, 0o644);
  fs.unlinkSync(file);
  fs.symlinkSync("../../../package.json", file);
  assert.throws(
    () => verifySource(f.root, f.commit),
    /Unexpected runtime source change/,
  );
  assert.throws(
    () => verifySource(f.root, "0".repeat(40)),
    /base commit changed/,
  );
  assert.throws(
    () => verifySource(f.root, { baseCommit: f.commit, candidateFiles: {} }),
    /Exact admitted runtime commit required/,
  );
});

test("host output allowances reject traversal and do not relax tracked-file authentication", (t) => {
  const f = fixture(t);
  for (const value of ["../outside", "/absolute", ".", "build/**"])
    assert.throws(
      () =>
        verifyCommittedWorkspace(f.root, f.commit, {
          generatedDirectories: [value],
        }),
      /workspace-relative paths/,
    );
  f.write("mobile-output/bundle.js", "generated");
  verifyCommittedWorkspace(f.root, f.commit, {
    generatedDirectories: ["mobile-output"],
  });
  assert.throws(
    () => verifyCommittedWorkspace(f.root, f.commit),
    /Unexpected untracked runtime source/,
  );
  f.write("packages/example/src/index.ts", "changed");
  assert.throws(
    () =>
      verifyCommittedWorkspace(f.root, f.commit, {
        generatedFiles: ["packages/example/src/index.ts"],
        generatedDirectories: ["mobile-output"],
      }),
    /Unexpected runtime source change/,
  );
});

test("a repository subdirectory cannot masquerade as the admitted source root", (t) => {
  const f = fixture(t);
  assert.throws(
    () =>
      verifyCommittedWorkspace(path.join(f.root, "packages/example"), f.commit),
    /Git checkout root/,
  );
});
