/** Bind bounded Files state to the actual adapter, archive and schema suites. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SaxesParser } from "saxes";
import { testOutputPath } from "../../../packages/scripts/lib/test-output.ts";
import { requireVitestConformance } from "../../../packages/scripts/lib/vitest-conformance.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const model = "plugins/plugin-files/quint/FilesViewOwnership.qnt";
assert.equal(path.resolve(root, process.argv[2] ?? ""), path.join(root, model));
const cases = JSON.parse(
  readFileSync(path.join(root, model.replace(".qnt", ".cases.json")), "utf8"),
);
const manifest = JSON.parse(
  readFileSync(
    new URL("./files-view-conformance.json", import.meta.url),
    "utf8",
  ),
);
const output = testOutputPath("quint-files-view-ownership");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-"));
function run(label, command, cwd = root) {
  const child = spawnSync(
    process.execPath,
    [
      path.join(root, "packages/scripts/run-with-deadline.ts"),
      "120000",
      "--",
      ...command,
    ],
    { cwd, env: process.env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  writeFileSync(
    path.join(directory, `${label}.log`),
    `${child.stdout ?? ""}\n${child.stderr ?? ""}`,
  );
  if (child.error) throw child.error;
  assert.equal(child.signal, null, `${label} interrupted`);
  assert.equal(child.status, 0, `${label} failed; see ${directory}`);
  return child.stdout;
}
const xml = run("node", [
  process.execPath,
  "--test",
  "--experimental-transform-types",
  "--test-reporter=junit",
  ...new Set(manifest.node.map(({ file }) => path.join(root, file))),
]);
writeFileSync(path.join(directory, "node.xml"), xml);
const observed = [];
const parser = new SaxesParser({ xmlns: false });
parser.on("opentag", (tag) => {
  assert(
    !["failure", "error", "skipped"].includes(tag.name),
    `Non-passing Node result: ${tag.name}`,
  );
  if (tag.name === "testcase") {
    assert.equal(typeof tag.attributes.file, "string");
    observed.push({
      file: path.relative(root, tag.attributes.file),
      classname: tag.attributes.classname ?? "",
      name: tag.attributes.name,
    });
  }
});
parser.write(xml).close();
const keys = (entries) => entries.map((entry) => JSON.stringify(entry)).sort();
assert.equal(new Set(keys(observed)).size, manifest.node.length);
assert.deepEqual(keys(observed), keys(manifest.node));

const report = path.join(directory, "assistant.json");
run(
  "assistant",
  [
    process.execPath,
    "--conditions=eliza-source",
    path.join(root, "node_modules/vitest/vitest.mjs"),
    "run",
    "src/services/device-actions/files-browser-contract.test.ts",
    "--cache=false",
    "--reporter=json",
    `--outputFile=${report}`,
  ],
  path.join(root, "plugins/plugin-assistant"),
);
const assistant = requireVitestConformance(
  JSON.parse(readFileSync(report, "utf8")),
  path.join(root, manifest.assistant.file),
  manifest.assistant.required,
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
  `${JSON.stringify({ model, node: observed, assistant, sources, bounds: cases.bounds }, null, 2)}\n`,
);
console.log(
  `Files conformance passed ${observed.length} exact Node cases and ${assistant.length} assistant cases without skips. Evidence ${directory}`,
);
