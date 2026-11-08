/** A failed implementation check must never produce a passing model receipt. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { testOutputPath } from "../../../scripts/lib/test-output.ts";

test("an implementation conformance failure fails the formal run", () => {
  const output = testOutputPath("cloud-formal");
  mkdirSync(output, { recursive: true });
  const root = mkdtempSync(path.join(output, "runner-fixture-"));
  const put = (file: string, text: string) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  };
  try {
    put(
      "packages/cloud/scripts/formal/check.ts",
      readFileSync(new URL("./check.ts", import.meta.url), "utf8"),
    );
    put(
      "packages/scripts/lib/test-output.ts",
      readFileSync(
        new URL("../../../scripts/lib/test-output.ts", import.meta.url),
        "utf8",
      ),
    );
    put(
      "packages/cloud/formal/inventory/fixture.json",
      JSON.stringify({ flows: [] }),
    );
    put(
      "packages/cloud/formal/models/fixture.qnt",
      "module fixture { var x: bool action init = x' = true action step = x' = x val safety = x run identityTest = init.then(step).expect(safety) }",
    );
    put(
      "packages/cloud/formal/conformance/fixture.mjs",
      "process.exitCode = 17;\n",
    );
    put(
      "packages/cloud/formal/contracts.json",
      JSON.stringify({
        models: [
          {
            id: "fixture",
            file: "fixture.qnt",
            sources: ["packages/cloud/formal/conformance/fixture.mjs"],
            invariants: ["safety"],
            assumptions: ["Test fixture"],
            maxSteps: 1,
            conformance: "packages/cloud/formal/conformance/fixture.mjs",
          },
        ],
      }),
    );
    const require = createRequire(import.meta.url);
    const quint = path.dirname(
      require.resolve("@informalsystems/quint/package.json"),
    );
    mkdirSync(path.join(root, "node_modules/@informalsystems"), {
      recursive: true,
    });
    symlinkSync(
      quint,
      path.join(root, "node_modules/@informalsystems/quint"),
      "dir",
    );
    const result = spawnSync(
      process.execPath,
      [
        path.join(root, "packages/cloud/scripts/formal/check.ts"),
        "--model=fixture",
      ],
      { cwd: root, encoding: "utf8", timeout: 60_000 },
    );
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const receipt = JSON.parse(
      readFileSync(
        path.join(root, "test-results/cloud-formal/test/fixture/results.json"),
        "utf8",
      ),
    );
    assert.equal(receipt.passed, false);
    assert.equal(receipt.results.at(-1).command[0], "conformance");
    assert.equal(receipt.results.at(-1).exitCode, 17);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
