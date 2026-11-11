/** Fresh, exact Android JVM identities for source-linked native state models. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { SaxesParser } from "saxes";
import { parseJunitSummary } from "../lib/junit-summary.ts";
import { testOutputPath } from "../lib/test-output.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const model = process.argv[2];
assert(model?.endsWith(".qnt"));
const relative = path.relative(root, path.resolve(root, model));
assert(!relative.startsWith("..") && !path.isAbsolute(relative));
const cases = relative.replace(/\.qnt$/, ".cases.json");
const manifest = JSON.parse(readFileSync(path.join(root, cases), "utf8"));
const native: {
  project: string;
  directory: string;
  suites: { className: string; required: string[] }[];
} = manifest.nativeAndroid;
assert(native && /^[a-z0-9-]+$/.test(native.project));
assert(/^plugins\/plugin-native-[a-z-]+\/android$/.test(native.directory));
assert(native.suites.length > 0);
for (const suite of native.suites) {
  assert(/^[A-Za-z0-9_.]+$/.test(suite.className));
  assert(suite.required.length > 0);
  assert.equal(new Set(suite.required).size, suite.required.length);
}
const inputs = [
  ...new Set<string>([relative, cases, ...manifest.sources]),
].sort();
const fingerprints = () =>
  Object.fromEntries(
    inputs.map((file) => [
      file,
      createHash("sha256")
        .update(readFileSync(path.join(root, file)))
        .digest("hex"),
    ]),
  );
const sources = fingerprints();
const output = testOutputPath("quint-native-android");
mkdirSync(output, { recursive: true });
const receipt = mkdtempSync(path.join(output, `${native.project}-`));
const results = path.join(
  root,
  native.directory,
  "build/test-results/testDebugUnitTest",
);
rmSync(results, { recursive: true, force: true });
const child = spawnSync(
  process.execPath,
  [
    path.join(root, "packages/scripts/run-with-deadline.ts"),
    "360000",
    "--",
    path.join(root, "packages/app/platforms/android/gradlew"),
    "-p",
    path.join(root, "packages/app/scripts/android-native-plugins-gradle"),
    "--no-daemon",
    "--max-workers=2",
    "--rerun-tasks",
    `:${native.project}:testDebugUnitTest`,
    ...native.suites.flatMap((suite) => ["--tests", suite.className]),
  ],
  {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    env: {
      ...process.env,
      ...(process.env.JAVA_HOME_21_X64
        ? { JAVA_HOME: process.env.JAVA_HOME_21_X64 }
        : {}),
    },
  },
);
const log = path.join(receipt, "gradle.log");
writeFileSync(log, `${child.stdout ?? ""}\n${child.stderr ?? ""}`);
if (child.error) throw child.error;
assert.equal(child.signal, null, `Native conformance terminated: ${log}`);
assert.equal(child.status, 0, `Native conformance failed: ${log}`);
assert.deepEqual(
  readdirSync(results)
    .filter((file) => file.endsWith(".xml"))
    .sort(),
  native.suites.map((suite) => `TEST-${suite.className}.xml`).sort(),
);
const observations = native.suites.map((suite) => {
  const xml = readFileSync(
    path.join(results, `TEST-${suite.className}.xml`),
    "utf8",
  );
  const summary = parseJunitSummary(
    `<testsuites tests="${suite.required.length}" failures="0" errors="0" skipped="0">${xml.replace(/^<\?xml[^?]*\?>\s*/, "")}</testsuites>`,
  );
  assert.equal(summary.tests, suite.required.length);
  assert.equal(summary.failures + summary.errors + summary.skipped, 0);
  const names: string[] = [];
  const parser = new SaxesParser({ xmlns: false });
  parser.on("opentag", (tag) => {
    if (tag.name !== "testcase") return;
    assert.equal(tag.attributes.classname, suite.className);
    assert.equal(typeof tag.attributes.name, "string");
    names.push(tag.attributes.name as string);
  });
  parser.write(xml).close();
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(names.sort(), [...suite.required].sort());
  writeFileSync(path.join(receipt, `TEST-${suite.className}.xml`), xml);
  return { className: suite.className, names, summary };
});
assert.deepEqual(
  fingerprints(),
  sources,
  "Native sources changed during conformance",
);
writeFileSync(
  path.join(receipt, "evidence.json"),
  `${JSON.stringify({ model: relative, status: "passed", sources, observations }, null, 2)}\n`,
);
console.log(
  `Native Android conformance: ${observations.reduce((sum, observation) => sum + observation.names.length, 0)} exact tests passed. Evidence ${receipt}`,
);
