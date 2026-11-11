/** Require native Android callback retirement and the existing call UI regressions. */
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
import { parseJunitSummary } from "../../../packages/scripts/lib/junit-summary.ts";
import { testOutputPath } from "../../../packages/scripts/lib/test-output.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const model = "plugins/plugin-native-phone/quint/NativeCallRegistry.qnt";
assert.equal(
  path.resolve(root, process.argv[2] ?? model),
  path.join(root, model),
);
const cases = model.replace(/\.qnt$/, ".cases.json");
const manifest = JSON.parse(readFileSync(path.join(root, cases), "utf8"));
const suites: { className: string; required: string[] }[] = JSON.parse(
  readFileSync(
    new URL("./native-call-conformance.json", import.meta.url),
    "utf8",
  ),
);
const output = testOutputPath("quint-native-call-registry");
mkdirSync(output, { recursive: true });
const receipt = mkdtempSync(path.join(output, "run-"));
const results = path.join(
  root,
  "plugins/plugin-native-phone/android/build/test-results/testDebugUnitTest",
);
// A successful no-source task cannot adopt XML from an older invocation.
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
    ":elizaos-plugin-native-phone:testDebugUnitTest",
  ],
  {
    cwd: root,
    env: {
      ...process.env,
      ...(process.env.JAVA_HOME_21_X64
        ? { JAVA_HOME: process.env.JAVA_HOME_21_X64 }
        : {}),
    },
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  },
);
const log = path.join(receipt, "gradle.log");
writeFileSync(log, `${child.stdout ?? ""}\n${child.stderr ?? ""}`);
if (child.error) throw child.error;
assert.equal(child.signal, null, `Native conformance terminated: ${log}`);
assert.equal(child.status, 0, `Native conformance failed: ${log}`);
const files = readdirSync(results).filter((file) => file.endsWith(".xml"));
assert.deepEqual(
  files.sort(),
  suites.map((suite) => `TEST-${suite.className}.xml`).sort(),
);
const observations = suites.map((suite) => {
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
  assert.equal(new Set(names).size, names.length, "Duplicate native test");
  assert.deepEqual(names.sort(), [...suite.required].sort());
  writeFileSync(path.join(receipt, `TEST-${suite.className}.xml`), xml);
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
  path.join(receipt, "evidence.json"),
  `${JSON.stringify({ model, status: "passed", sources, observations }, null, 2)}\n`,
);
console.log(
  `Native call registry: 23 Android JVM tests passed. Evidence ${receipt}`,
);
