import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const workflow = parse(
  readFileSync(
    join(root, ".github/workflows/update-os-release-manifest.yml"),
    "utf8",
  ),
);
const steps = workflow.jobs["repair-manifest"].steps;
const identity = steps.find((step) => step.id === "identity").run;
const publication = steps.find(
  (step) => step.name === "Open the draft checksum recovery pull request",
).run;
const manifest = "packages/os/release/v1.2.3/manifest.json";
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "os-manifest-recovery-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: directory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  git("init");
  mkdirSync(join(directory, "packages/os/release/v1.2.3"), { recursive: true });
  writeFileSync(join(directory, manifest), "{}\n");
  writeFileSync(join(directory, "other.txt"), "original\n");
  git("add", ".");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "fixture",
  );
  return { directory, git, base: git("rev-parse", "HEAD").trim() };
}

test("recovery accepts only tracked monorepo manifest paths before remote reads", (t) => {
  const { directory, base } = fixture(t);
  const prefix = identity.slice(0, identity.indexOf("checkout_sha="));
  for (const path of [
    manifest,
    "release/v1.2.3/manifest.json",
    "packages/os/release/../manifest.json",
    "packages/os/release/bad\nname/manifest.json",
    "packages/os/release/untracked/manifest.json",
  ]) {
    if (path.includes("untracked")) {
      mkdirSync(join(directory, "packages/os/release/untracked"));
      writeFileSync(join(directory, path), "{}");
    }
    const result = spawnSync("bash", ["-c", prefix], {
      cwd: directory,
      env: {
        ...process.env,
        EXPECTED_BASE_SHA: base,
        EXPECTED_TAG_SHA: base,
        RELEASE_TAG: "v1.2.3",
        MANIFEST_PATH: path,
      },
      encoding: "utf8",
    });
    assert.equal(result.status === 0, path === manifest, result.stderr);
  }
});

test("recovery rejects unrelated staged bytes even when their working files match HEAD", (t) => {
  const { directory, git, base } = fixture(t);
  const bin = join(directory, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "git"),
    '#!/bin/sh\nif [ "$1" = ls-remote ]; then printf "%s\\trefs/heads/develop\\n" "$BASE_SHA"; else exec /usr/bin/git "$@"; fi\n',
    { mode: 0o755 },
  );
  writeFileSync(join(directory, manifest), '{"changed":true}\n');
  const prefix = publication.slice(0, publication.indexOf("run_url="));
  const run = () =>
    spawnSync("bash", ["-c", prefix], {
      cwd: directory,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        BASE_SHA: base,
        MANIFEST_PATH: manifest,
      },
      encoding: "utf8",
    });
  assert.equal(run().status, 0);
  writeFileSync(join(directory, "other.txt"), "staged change\n");
  git("add", "other.txt");
  writeFileSync(join(directory, "other.txt"), "original\n");
  assert.equal(git("diff", "--name-only", "HEAD", "--", "other.txt"), "");
  const result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /changed unexpected files: other.txt/);
});

test("recovery preserves exact inventory and draft PR gates at valid root tool paths", () => {
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.equal(workflow.jobs["repair-manifest"].environment, "release");
  assert.equal(
    steps.find((step) => step.uses?.startsWith("actions/setup-node@")).with[
      "node-version"
    ],
    "24.15.0",
  );
  const commands = steps.map((step) => step.run ?? "").join("\n");
  for (const match of commands.matchAll(/node ([\w/.-]+\.(?:mjs|ts))/g))
    assert.ok(existsSync(resolve(root, match[1])), match[1]);
  assert.match(commands, /testOutputPath\("os-manifest-recovery"/);
  assert.match(commands, /release-asset-inventory\.ts compare/);
  assert.match(publication, /--draft/);
  assert.match(publication, /--base develop/);
  assert.match(publication, /--body-file "\$pr_body"/);
  assert.ok(
    commands.indexOf("release-asset-inventory.ts compare") <
      commands.indexOf("git push origin"),
  );
});
