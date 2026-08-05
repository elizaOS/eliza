import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { analyzeBuildTypecheck } from "./audit-build-typecheck.mjs";

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function analyzeFixture(root) {
  return analyzeBuildTypecheck({
    repoRoot: root,
    turbo: { tasks: {} },
    buildFiles: [],
  });
}

test("nested workspace enforcement requires a justified package exception", () => {
  const root = mkdtempSync(path.join(tmpdir(), "audit-build-nested-"));
  try {
    writeJson(path.join(root, "package.json"), {
      workspaces: ["packages/*/*"],
      devDependencies: {
        "@typescript/native": "npm:typescript@^7.0.2",
        "@typescript/typescript6": "6.0.0",
      },
    });
    const pkgDir = path.join(root, "packages", "group", "nested");
    mkdirSync(pkgDir, { recursive: true });
    const nestedPackage = {
      name: "@demo/nested",
      scripts: { typecheck: "tsc6 --noEmit" },
    };
    writeJson(path.join(pkgDir, "package.json"), nestedPackage);

    const unallowlisted = analyzeFixture(root);
    assert.deepEqual(unallowlisted.counts, {
      declared: 1,
      scanned: 1,
      typechecked: 1,
      excepted: 0,
    });
    assert.match(
      unallowlisted.violations.join("\n"),
      /typecheck uses compatibility tsc6 --noEmit/,
    );

    writeJson(path.join(pkgDir, "package.json"), {
      ...nestedPackage,
      elizaos: {
        scripts: {
          buildModel: {
            tscTypecheck: {
              reason:
                "nested compatibility fixture intentionally exercises tsc6",
            },
          },
        },
      },
    });
    const justified = analyzeFixture(root);
    assert.deepEqual(justified.violations, []);
    assert.equal(justified.counts.excepted, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed and stale package exceptions fail the audit", () => {
  const root = mkdtempSync(path.join(tmpdir(), "audit-build-stale-"));
  try {
    writeJson(path.join(root, "package.json"), {
      workspaces: ["packages/*/*"],
      devDependencies: {
        "@typescript/native": "npm:typescript@^7.0.2",
        "@typescript/typescript6": "6.0.0",
      },
    });
    const pkgDir = path.join(root, "packages", "group", "nested");
    mkdirSync(pkgDir, { recursive: true });

    writeJson(path.join(pkgDir, "package.json"), {
      name: "@demo/nested",
      scripts: { typecheck: "tsc --noEmit" },
      devDependencies: {
        "@typescript/native": "npm:typescript@^7.0.2",
      },
      elizaos: {
        scripts: {
          buildModel: {
            tscTypecheck: { reason: "this reason is now stale" },
          },
        },
      },
    });
    assert.match(
      analyzeFixture(root).violations.join("\n"),
      /stale buildModel\.tscTypecheck exception/,
    );

    writeJson(path.join(pkgDir, "package.json"), {
      name: "@demo/nested",
      scripts: { typecheck: "tsc6 --noEmit" },
      elizaos: {
        scripts: {
          buildModel: { tscTypecheck: true },
        },
      },
    });
    assert.match(
      analyzeFixture(root).violations.join("\n"),
      /must be an object with a non-empty reason/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
