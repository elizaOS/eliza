/** Runs both complete owning suites for the bounded voice-state projections. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../../packages/scripts/lib/test-output.ts";
import { requireVitestConformance } from "../../../packages/scripts/lib/vitest-conformance.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const model = "packages/voice/quint/VoiceDeferredState.qnt";
assert.equal(path.resolve(root, process.argv[2]), path.join(root, model));
const cases = JSON.parse(
  readFileSync(path.join(root, model.replace(".qnt", ".cases.json")), "utf8"),
);
const manifest = JSON.parse(
  readFileSync(
    new URL("./deferred-state-conformance.json", import.meta.url),
    "utf8",
  ),
);
const output = testOutputPath("quint-voice-deferred-state");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-"));
const tests = [];
for (const fixture of manifest.files) {
  const report = path.join(directory, `${path.basename(fixture.file)}.json`);
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, "packages/scripts/run-with-deadline.ts"),
      "120000",
      "--",
      process.execPath,
      path.join(root, "node_modules/vitest/vitest.mjs"),
      "run",
      "--config",
      "vitest.config.ts",
      path.relative(
        path.join(root, "packages/voice"),
        path.join(root, fixture.file),
      ),
      "--maxWorkers=1",
      "--reporter=json",
      `--outputFile=${report}`,
    ],
    {
      cwd: path.join(root, "packages/voice"),
      env: {
        ...process.env,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --conditions=eliza-source`,
      },
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  writeFileSync(
    path.join(directory, `${path.basename(fixture.file)}.log`),
    `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  );
  if (result.error) throw result.error;
  assert.equal(result.signal, null);
  assert.equal(result.status, 0);
  tests.push(
    ...requireVitestConformance(
      JSON.parse(readFileSync(report, "utf8")),
      path.join(root, fixture.file),
      fixture.required,
    ),
  );
}
const sources = Object.fromEntries(
  [
    ...new Set([model, model.replace(".qnt", ".cases.json"), ...cases.sources]),
  ].map((file) => [
    file,
    createHash("sha256")
      .update(readFileSync(path.join(root, file)))
      .digest("hex"),
  ]),
);
writeFileSync(
  path.join(directory, "evidence.json"),
  JSON.stringify({ model, tests, sources, bounds: cases.bounds }, null, 2) +
    "\n",
);
console.log(
  "Voice deferred-state conformance passed " +
    tests.length +
    " required cases. " +
    directory,
);
