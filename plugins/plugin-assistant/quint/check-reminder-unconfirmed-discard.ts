/** Requires the maintained journal's complete implementation suite. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../../packages/scripts/lib/test-output.ts";
import { requireVitestConformance } from "../../../packages/scripts/lib/vitest-conformance.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const model = "plugins/plugin-assistant/quint/ReminderUnconfirmedDiscard.qnt";
assert.equal(path.resolve(root, process.argv[2]), path.join(root, model));
const cases = JSON.parse(
  readFileSync(path.join(root, model.replace(".qnt", ".cases.json")), "utf8"),
);
const manifest = JSON.parse(
  readFileSync(
    new URL("./reminder-discard-conformance.json", import.meta.url),
    "utf8",
  ),
);
const output = testOutputPath("quint-reminder-unconfirmed-discard");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-")),
  report = path.join(directory, "vitest.json");
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
      path.join(root, "plugins/plugin-assistant"),
      path.join(root, manifest.file),
    ),
    "--maxWorkers=1",
    "--reporter=json",
    "--outputFile=" + report,
  ],
  {
    cwd: path.join(root, "plugins/plugin-assistant"),
    env: {
      ...process.env,
      NODE_OPTIONS:
        (process.env.NODE_OPTIONS ?? "") + " --conditions=eliza-source",
    },
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  },
);
writeFileSync(
  path.join(directory, "vitest.log"),
  (result.stdout ?? "") + "\n" + (result.stderr ?? ""),
);
if (result.error) throw result.error;
assert.equal(result.signal, null);
assert.equal(result.status, 0);
const tests = requireVitestConformance(
  JSON.parse(readFileSync(report, "utf8")),
  path.join(root, manifest.file),
  manifest.required,
);
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
  "Reminder discard conformance passed " +
    tests.length +
    " required cases. " +
    directory,
);
