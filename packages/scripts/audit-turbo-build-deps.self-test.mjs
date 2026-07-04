#!/usr/bin/env node
// Exercises audit turbo build deps.self test automation behavior with deterministic script fixtures.

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

  console.log("audit-turbo-build-deps self-test passed");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
