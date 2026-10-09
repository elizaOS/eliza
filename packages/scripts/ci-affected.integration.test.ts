/** Exercise the actual selector against committed fixture workspaces and Git history. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const source = import.meta.dirname;
test("CI selection preserves complete Git changes and dynamic plugin scenarios", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ci-affected-integration-"));
  const env = { ...process.env, GITHUB_SHA: "HEAD", GITHUB_OUTPUT: "" };
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", env });
  const write = (file: string, value: unknown) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(
      path.join(root, file),
      typeof value === "string" ? value : JSON.stringify(value),
    );
  };
  const commit = () => {
    git("add", ".");
    git(
      "-c",
      "user.name=CI fixture",
      "-c",
      "user.email=ci@example.invalid",
      "commit",
      "-qm",
      "fixture",
    );
    return git("rev-parse", "HEAD").trim();
  };
  const select = (base: string) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        ["packages/scripts/ci-affected.ts", base],
        { cwd: root, encoding: "utf8", env },
      ),
    ).outputs;
  try {
    git("init", "-q");
    for (const file of [
      "ci-affected.ts",
      "lib/workspaces.ts",
      "lib/repository-file-integrity.ts",
    ]) {
      const target = path.join(root, "packages/scripts", file);
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(path.join(source, file), target);
    }
    write("package.json", {
      type: "module",
      workspaces: ["packages/*", "plugins/*"],
    });
    write("plugins/plugin-form/package.json", { name: "@fixture/form" });
    write("packages/core/package.json", { name: "@fixture/core" });
    write("packages/app/package.json", {
      name: "@fixture/app",
      dependencies: { "@fixture/core": "workspace:*" },
    });
    const base = commit();
    write("README.md", "Fixture docs\n");
    commit();
    assert.equal(select(base).source, "false");
    write("plugins/plugin-form/index.ts", "export const form = true;\n");
    const pluginHead = commit();
    assert.equal(
      select(base).scenarios,
      "true",
      "catalog-loaded plugins need scenario coverage",
    );
    write("packages/core/index.ts", "export const core = true;\n");
    commit();
    assert.equal(
      select(pluginHead).app,
      "true",
      "reverse dependencies must run",
    );
    write("README.md", "Another docs commit after unvalidated source\n");
    commit();
    assert.equal(
      select(base).app,
      "true",
      "all changes since the validated ancestor must count",
    );
    assert.equal(select("0".repeat(40)).full, "true");
    assert.equal(select("a".repeat(40)).full, "true");
    const current = git("rev-parse", "HEAD").trim();
    write("unowned/source.ts", "export {};\n");
    commit();
    assert.equal(
      select(current).full,
      "true",
      "unknown source must select everything",
    );
    const beforeRename = git("rev-parse", "HEAD").trim();
    git("mv", "plugins/plugin-form", "retired-form");
    commit();
    assert.equal(
      select(beforeRename).full,
      "true",
      "renamed workspaces must not disappear",
    );
    assert.equal(select(git("rev-parse", "HEAD").trim()).source, "false");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("promotion baselines require successful ancestor evidence from the promotion chain", () => {
  const root = mkdtempSync(path.join(tmpdir(), "promotion-baseline-"));
  const repo = path.join(root, "repo");
  const runner = path.join(root, "runner");
  const bin = path.join(root, "bin");
  for (const directory of [repo, runner, bin]) mkdirSync(directory);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  const commit = (name: string, file = name) => {
    if (file) writeFileSync(path.join(repo, file), name);
    git("add", ".");
    git(
      "-c",
      "user.name=CI fixture",
      "-c",
      "user.email=ci@example.invalid",
      "commit",
      "-qm",
      name,
    );
    return git("rev-parse", "HEAD");
  };
  try {
    git("init", "-q");
    const trusted = commit("trusted");
    const unvalidated = commit("unvalidated");
    git("rm", "-q", "unvalidated");
    const head = commit("promotion", "");
    git("checkout", "-qb", "unrelated-tip", trusted);
    const diverged = commit("diverged");
    git("checkout", "-q", "--detach", head);
    const workflow = readFileSync(
      path.join(source, "../../.github/workflows/develop-full.yml"),
      "utf8",
    );
    const step = workflow.slice(
      workflow.indexOf(
        "      - name: Resolve last successfully validated ancestor",
      ),
    );
    const block = step.match(/ {8}run: \|\n([\s\S]*?)(?=\n {6}- name:)/)?.[1];
    assert.ok(block, "execute the checked-in workflow shell");
    const script = block.replace(/^ {10}/gm, "");
    writeFileSync(
      path.join(bin, "gh"),
      `#!/usr/bin/env bash
set -euo pipefail
branch=
success=
for argument in "$@"; do
  case "$argument" in
    branch=*) branch="\${argument#branch=}" ;;
    status=success) success=1 ;;
  esac
done
[ "$success" = 1 ]
printf '%s\\n' "$branch" >> "$RUNNER_TEMP/requests"
[ ! -f "$RUNNER_TEMP/fail-$branch" ]
cat "$RUNNER_TEMP/candidates-$branch"
`,
      { mode: 0o755 },
    );
    const select = (
      branch: string,
      candidates: Record<string, string[]>,
      event = "push",
      fail?: string,
    ) => {
      for (const name of ["develop", "staging", "main"]) {
        writeFileSync(
          path.join(runner, `candidates-${name}`),
          `${(candidates[name] ?? []).join("\n")}\n`,
        );
        rmSync(path.join(runner, `fail-${name}`), { force: true });
      }
      if (fail) writeFileSync(path.join(runner, `fail-${fail}`), "");
      const output = path.join(runner, "output");
      writeFileSync(output, "");
      writeFileSync(path.join(runner, "requests"), "");
      execFileSync("bash", ["-c", script], {
        cwd: repo,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          RUNNER_TEMP: runner,
          GITHUB_OUTPUT: output,
          GITHUB_REPOSITORY: "fixture/repo",
          GITHUB_REF_NAME: branch,
          GITHUB_SHA: head,
          EVENT_NAME: event,
        },
      });
      return {
        base: readFileSync(output, "utf8").trim().split("=")[1],
        requests: readFileSync(path.join(runner, "requests"), "utf8")
          .trim()
          .split("\n")
          .filter(Boolean),
      };
    };
    const zero = "0".repeat(40);
    const promoted = select("main", {
      staging: ["malformed", diverged, trusted],
    });
    assert.equal(promoted.base, trusted);
    assert.deepEqual(promoted.requests, ["main", "staging"]);
    assert.deepEqual(
      new Set(git("rev-list", `${promoted.base}..${head}`).split("\n")),
      new Set([unvalidated, head]),
      "all unvalidated commits remain in the scan range",
    );
    assert.equal(
      select("main", { main: [trusted], staging: [unvalidated] }).base,
      trusted,
      "retain the destination's existing validated baseline",
    );
    assert.equal(select("staging", { develop: [trusted] }).base, trusted);
    assert.equal(
      select("main", { staging: [unvalidated] }).base,
      zero,
      "upstream validation cannot qualify changed source",
    );
    assert.deepEqual(select("develop", { staging: [trusted] }), {
      base: zero,
      requests: ["develop"],
    });
    assert.equal(
      select("main", { staging: [diverged] }).base,
      zero,
      "a successful non-ancestor cannot reduce coverage",
    );
    assert.deepEqual(
      select("main", { staging: [trusted] }, "push", "main"),
      { base: zero, requests: ["main"] },
      "API failure keeps full validation",
    );
    assert.deepEqual(
      select(
        "main",
        { main: [trusted], staging: [trusted] },
        "workflow_dispatch",
      ),
      { base: zero, requests: [] },
      "explicit dispatch retains full-history validation",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
