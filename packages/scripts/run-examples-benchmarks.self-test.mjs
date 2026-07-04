#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "run-examples-benchmarks.mjs",
);

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(`${filePath}`, `${JSON.stringify(value, null, 2)}\n`);
}

const tempRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "run-examples-benchmarks-"),
);

try {
  writeJson(path.join(tempRoot, "package.json"), {
    name: "fixture-root",
    private: true,
    workspaces: [
      "packages/examples/*",
      "packages/benchmarks/*",
      "packages/other/*",
      "!packages/examples/excluded",
    ],
  });
  writeJson(path.join(tempRoot, "packages/examples/with-lint/package.json"), {
    name: "with-lint",
    scripts: { lint: "echo lint" },
  });
  writeJson(path.join(tempRoot, "packages/examples/no-lint/package.json"), {
    name: "no-lint",
    scripts: { typecheck: "echo typecheck" },
  });
  writeJson(path.join(tempRoot, "packages/examples/excluded/package.json"), {
    name: "excluded",
    scripts: { lint: "echo lint" },
  });
  writeJson(path.join(tempRoot, "packages/benchmarks/bench/package.json"), {
    name: "bench",
    scripts: { lint: "echo lint" },
  });
  writeJson(path.join(tempRoot, "packages/other/not-in-scope/package.json"), {
    name: "not-in-scope",
    scripts: { lint: "echo lint" },
  });

  const result = spawnSync(
    process.execPath,
    [scriptPath, "lint", "--list=json"],
    {
      cwd: tempRoot,
      encoding: "utf8",
    },
  );

  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }

  const listed = JSON.parse(result.stdout);
  const dirs = listed.packages.map((pkg) => pkg.dir).sort();
  const expected = [
    "packages/benchmarks/bench",
    "packages/examples/with-lint",
  ];
  if (JSON.stringify(dirs) !== JSON.stringify(expected)) {
    console.error(
      `unexpected package list:\nexpected ${JSON.stringify(
        expected,
      )}\nactual   ${JSON.stringify(dirs)}`,
    );
    process.exit(1);
  }

  const textResult = spawnSync(process.execPath, [scriptPath, "lint", "--list"], {
    cwd: tempRoot,
    encoding: "utf8",
  });
  if (textResult.status !== 0) {
    process.stderr.write(textResult.stderr);
    process.exit(textResult.status ?? 1);
  }
  if (!textResult.stdout.includes("with-lint\tpackages/examples/with-lint")) {
    console.error("text list output did not include the expected package");
    process.exit(1);
  }

  console.log("run-examples-benchmarks self-test passed");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
