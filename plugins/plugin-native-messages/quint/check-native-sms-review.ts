/** Compile and execute the actual native review/journal boundary; never a radio proof. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { SaxesParser } from "saxes";
import { parseJunitSummary } from "../../../packages/scripts/lib/junit-summary.ts";
import { testOutputPath } from "../../../packages/scripts/lib/test-output.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const model =
  "plugins/plugin-native-messages/quint/NativeSmsReviewOwnership.qnt";
assert.equal(
  path.resolve(root, process.argv[2] ?? model),
  path.join(root, model),
);
const cases = model.replace(/\.qnt$/, ".cases.json");
const manifest = JSON.parse(readFileSync(path.join(root, cases), "utf8"));
const suites: Array<{ className: string; required: string[] }> = JSON.parse(
  readFileSync(
    new URL("./native-sms-review-conformance.json", import.meta.url),
    "utf8",
  ),
);
const output = testOutputPath("quint-native-sms-review");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-"));
const log = path.join(directory, "gradle.log");
for (const suite of suites) {
  rmSync(
    path.join(
      root,
      "plugins/plugin-native-messages/android/build/test-results/testDebugUnitTest",
      `TEST-${suite.className}.xml`,
    ),
    { force: true },
  );
}
const child = spawnSync(
  process.execPath,
  [
    path.join(root, "packages/scripts/run-with-deadline.ts"),
    "300000",
    "--",
    "packages/app/platforms/android/gradlew",
    "-p",
    "packages/app/scripts/android-native-plugins-gradle",
    "--no-daemon",
    "--max-workers=4",
    "--rerun-tasks",
    ":elizaos-plugin-native-messages:testDebugUnitTest",
    ...suites.flatMap((suite) => ["--tests", suite.className]),
  ],
  { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
);
writeFileSync(log, `${child.stdout ?? ""}\n${child.stderr ?? ""}`);
if (child.error) throw child.error;
assert.equal(child.signal, null, `Native conformance terminated: ${log}`);
assert.equal(child.status, 0, `Native conformance failed: ${log}`);
const results = suites.map((suite) => {
  const file = path.join(
    root,
    "plugins/plugin-native-messages/android/build/test-results/testDebugUnitTest",
    `TEST-${suite.className}.xml`,
  );
  const xml = readFileSync(file, "utf8").replace(/^<\?xml[^>]*>\s*/, "");
  const summary = parseJunitSummary(
    `<testsuites tests="${suite.required.length}" failures="0" errors="0" skipped="0">${xml}</testsuites>`,
  );
  assert.equal(summary.tests, suite.required.length);
  assert.equal(summary.failures + summary.errors + summary.skipped, 0);
  const names: string[] = [];
  const parser = new SaxesParser({ xmlns: false });
  parser.on("opentag", (tag) => {
    if (tag.name === "testcase") {
      assert.equal(tag.attributes.classname, suite.className);
      assert.equal(typeof tag.attributes.name, "string");
      names.push(tag.attributes.name as string);
    }
  });
  parser.write(xml).close();
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(names.sort(), [...suite.required].sort());
  writeFileSync(path.join(directory, path.basename(file)), xml);
  return { className: suite.className, names, summary };
});
const sources = Object.fromEntries(
  [...new Set<string>([model, cases, ...manifest.sources])]
    .sort()
    .map((file) => [
      file,
      createHash("sha256")
        .update(readFileSync(path.join(root, file)))
        .digest("hex"),
    ]),
);
writeFileSync(
  path.join(directory, "evidence.json"),
  `${JSON.stringify({ model, sources, results, boundary: "Actual Android classes on Robolectric29; controlled scheduling/journal, no radio/carrier/device acceptance." }, null, 2)}\n`,
);
console.log(
  `Native review conformance passed ${results.reduce((count, result) => count + result.names.length, 0)} exact cases. Evidence ${directory}`,
);
