#!/usr/bin/env node
/**
 * Exercises task validation and workspace cycles through the real audit CLI
 * against deterministic temporary monorepos.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "audit-turbo-build-deps.mjs",
);

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "turbo-audit-"));

try {
  writeJson(path.join(tempRoot, "package.json"), {
    name: "fixture-root",
    private: true,
    workspaces: ["packages/*"],
  });
  writeJson(path.join(tempRoot, "packages/foo/package.json"), {
    name: "@fixture/foo",
    scripts: { build: "echo build" },
    dependencies: { "@fixture/bar": "workspace:*" },
  });
  writeJson(path.join(tempRoot, "packages/bar/package.json"), {
    name: "@fixture/bar",
    scripts: { build: "echo build" },
    dependencies: { "@fixture/foo": "workspace:*" },
  });
  writeJson(path.join(tempRoot, "turbo.json"), {
    tasks: {
      "@fixture/foo#build": {},
      "@fixture/foo#typecheck": {},
      "@fixture/missing#build": {},
    },
  });

  const failResult = spawnSync(process.execPath, [scriptPath], {
    cwd: tempRoot,
    env: { ...process.env, AUDIT_TURBO_REPO_ROOT: tempRoot },
    encoding: "utf8",
  });
  const failOutput = `${failResult.stdout}\n${failResult.stderr}`;
  if (failResult.status === 0) {
    console.error("expected direct workspace cycle audit to fail");
    process.exit(1);
  }
  if (!failOutput.includes("@fixture/bar <-> @fixture/foo")) {
    console.error(
      "missing expected audit output: @fixture/bar <-> @fixture/foo",
    );
    console.error(failOutput);
    process.exit(1);
  }

  // Transitive 3-node cycle foo -> bar -> baz -> foo. A pairwise A<->B scan
  // misses this shape; the SCC finder must catch it.
  writeJson(path.join(tempRoot, "packages/bar/package.json"), {
    name: "@fixture/bar",
    scripts: { build: "echo build" },
    dependencies: { "@fixture/baz": "workspace:*" },
  });
  writeJson(path.join(tempRoot, "packages/baz/package.json"), {
    name: "@fixture/baz",
    scripts: { build: "echo build" },
    dependencies: { "@fixture/foo": "workspace:*" },
  });
  const transitiveResult = spawnSync(process.execPath, [scriptPath], {
    cwd: tempRoot,
    env: { ...process.env, AUDIT_TURBO_REPO_ROOT: tempRoot },
    encoding: "utf8",
  });
  const transitiveOutput = `${transitiveResult.stdout}\n${transitiveResult.stderr}`;
  if (transitiveResult.status === 0) {
    console.error("expected transitive workspace cycle audit to fail");
    process.exit(1);
  }
  for (const member of ["@fixture/foo", "@fixture/bar", "@fixture/baz"]) {
    if (!transitiveOutput.includes(member)) {
      console.error(`transitive cycle output missing member: ${member}`);
      console.error(transitiveOutput);
      process.exit(1);
    }
  }
  if (!transitiveOutput.includes(" -> ")) {
    console.error("transitive cycle should render as a path");
    console.error(transitiveOutput);
    process.exit(1);
  }
  fs.rmSync(path.join(tempRoot, "packages/baz"), {
    recursive: true,
    force: true,
  });

  writeJson(path.join(tempRoot, "packages/bar/package.json"), {
    name: "@fixture/bar",
    scripts: { build: "echo build" },
  });

  const phantomResult = spawnSync(process.execPath, [scriptPath], {
    cwd: tempRoot,
    env: { ...process.env, AUDIT_TURBO_REPO_ROOT: tempRoot },
    encoding: "utf8",
  });
  const phantomOutput = `${phantomResult.stdout}\n${phantomResult.stderr}`;
  if (phantomResult.status === 0) {
    console.error("expected phantom override audit to fail");
    process.exit(1);
  }
  for (const expected of [
    '@fixture/foo#typecheck — owner package does not define script "typecheck"',
    "@fixture/missing#build — owner package is not a workspace member",
  ]) {
    if (!phantomOutput.includes(expected)) {
      console.error(`missing expected audit output: ${expected}`);
      console.error(phantomOutput);
      process.exit(1);
    }
  }

  writeJson(path.join(tempRoot, "packages/foo/package.json"), {
    name: "@fixture/foo",
    scripts: { build: "echo build", typecheck: "echo typecheck" },
    dependencies: { "@fixture/bar": "workspace:*" },
  });
  writeJson(path.join(tempRoot, "packages/bar/package.json"), {
    name: "@fixture/bar",
    scripts: { build: "echo build" },
  });
  writeJson(path.join(tempRoot, "packages/missing/package.json"), {
    name: "@fixture/missing",
    scripts: { build: "echo build" },
  });

  const passResult = spawnSync(process.execPath, [scriptPath], {
    cwd: tempRoot,
    env: { ...process.env, AUDIT_TURBO_REPO_ROOT: tempRoot },
    encoding: "utf8",
  });
  if (passResult.status !== 0) {
    process.stderr.write(passResult.stderr);
    process.exit(passResult.status ?? 1);
  }

  writeJson(path.join(tempRoot, "packages/bar/package.json"), {
    name: "@fixture/bar",
    scripts: { build: "echo build" },
    peerDependencies: { "@fixture/baz": "workspace:*" },
  });
  writeJson(path.join(tempRoot, "packages/baz/package.json"), {
    name: "@fixture/baz",
    scripts: { build: "echo build" },
  });
  for (const [task, dependency, valid] of [
    ["typecheck", "baz", true],
    ["typecheck", "missing", false],
    ["build", "baz", false],
  ]) {
    writeJson(path.join(tempRoot, "turbo.json"), {
      tasks: {
        [`@fixture/foo#${task}`]: {
          dependsOn: [`@fixture/${dependency}#build`],
        },
      },
    });
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: tempRoot,
      env: { ...process.env, AUDIT_TURBO_REPO_ROOT: tempRoot },
      encoding: "utf8",
    });
    assert.equal(
      result.status === 0,
      valid,
      `${result.stdout}\n${result.stderr}`,
    );
    if (!valid) assert.match(result.stderr, /phantom #build edge/);
  }

  console.log("audit-turbo-build-deps self-test passed");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
