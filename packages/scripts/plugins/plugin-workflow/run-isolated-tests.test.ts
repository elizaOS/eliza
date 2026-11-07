import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  discoverWorkflowTestFiles,
  mergeWorkflowJunit,
  runWorkflowTestFiles,
} from "./run-isolated-tests.ts";

const hosted = [
  "__tests__/integration/hosted-digests-http.test.ts",
  "__tests__/integration/hosted-live-google-http.test.ts",
  "__tests__/integration/hosted-native-source-http.test.ts",
];
function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "workflow-runner-test-"));
  const log = path.join(dir, "calls.jsonl");
  const binary = path.join(dir, "runner");
  writeFileSync(
    binary,
    `#!${process.execPath}\n${String.raw`
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(LOG, JSON.stringify(args) + "\n");
if (args.includes("fail.test.ts")) process.exit(9);
const output = args.find(x => x.startsWith("--outputFile=") || x.startsWith("--reporter-outfile="));
if (output) {
  const vitest = args.includes("--config");
  fs.writeFileSync(output.slice(output.indexOf("=") + 1), '<testsuites tests="1" failures="0" ' + (vitest ? 'errors="0"' : 'assertions="3" skipped="0"') + '><testsuite name="fixture"><testcase name="ran"/></testsuite></testsuites>');
}
`.replace("LOG", JSON.stringify(log))}`,
  );
  chmodSync(binary, 0o755);
  return {
    dir,
    binary,
    log,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("all discovered suites remain scheduled and mixed runners emit merged JUnit", async () => {
  const discovered = discoverWorkflowTestFiles();
  for (const file of hosted) assert.ok(discovered.includes(file));
  const f = fixture();
  try {
    const output = path.join(f.dir, "result.xml");
    assert.equal(
      await runWorkflowTestFiles({
        files: ["ordinary.test.ts", ...hosted],
        bunBinary: f.binary,
        nodeBinary: f.binary,
        reporterOutfile: output,
      }),
      0,
    );
    const calls = readFileSync(f.log, "utf8")
      .trim()
      .split("\n")
      .map((x) => JSON.parse(x));
    assert.equal(calls.length, 4);
    assert.deepEqual(calls[0].slice(0, 2), ["test", "--isolate"]);
    assert.ok(calls[0].some((x) => x.startsWith("--reporter-outfile=")));
    for (let i = 1; i < 4; i++) {
      assert.ok(calls[i][0].endsWith("/packages/scripts/run-vitest.ts"));
      assert.deepEqual(calls[i].slice(1, 4), [
        "run",
        "--config",
        i === 2
          ? "vitest.hosted-live-google.config.ts"
          : "vitest.hosted-digests.config.ts",
      ]);
      assert.ok(calls[i].includes(hosted[i - 1]));
      assert.ok(calls[i].some((x) => x.startsWith("--outputFile=")));
    }
    const xml = readFileSync(output, "utf8");
    assert.match(
      xml,
      /<testsuites tests="4" errors="0" failures="0" skipped="0">/,
    );
    assert.equal((xml.match(/<testcase /g) || []).length, 4);
    assert.doesNotMatch(xml, /NaN|assertions=/);
  } finally {
    f.cleanup();
  }
});

test("child failure stays nonzero and stops later suites", async () => {
  const f = fixture();
  try {
    assert.equal(
      await runWorkflowTestFiles({
        files: ["fail.test.ts", ...hosted],
        bunBinary: f.binary,
        nodeBinary: f.binary,
      }),
      9,
    );
    assert.equal(readFileSync(f.log, "utf8").trim().split("\n").length, 1);
  } finally {
    f.cleanup();
  }
});

test("JUnit preserves available Bun assertion counts and Vitest error counts", () => {
  const f = fixture();
  try {
    const input = path.join(f.dir, "fragment.xml"),
      output = path.join(f.dir, "merged.xml");
    writeFileSync(
      input,
      '<testsuites tests="2" assertions="7" failures="1" skipped="0" errors="2"><testsuite/></testsuites>',
    );
    mergeWorkflowJunit([{ file: "fixture", path: input }], output);
    assert.match(
      readFileSync(output, "utf8"),
      /tests="2" assertions="7" errors="2" failures="1"/,
    );
    writeFileSync(
      input,
      '<testsuites tests="2" failures="0" errors="0"><testsuite skipped="1"><testcase><skipped/></testcase><testcase/></testsuite></testsuites>',
    );
    mergeWorkflowJunit([{ file: "vitest-fixture", path: input }], output);
    assert.match(
      readFileSync(output, "utf8"),
      /tests="2" errors="0" failures="0" skipped="1"/,
    );
    writeFileSync(
      input,
      '<testsuites tests="2" skipped="0"><testsuite/></testsuites>',
    );
    assert.throws(
      () => mergeWorkflowJunit([{ file: "fixture", path: input }], output),
      /no failures count/,
    );
  } finally {
    f.cleanup();
  }
});
