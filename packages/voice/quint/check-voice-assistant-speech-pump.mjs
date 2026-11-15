/** Check the required transitions in the maintained controller suite. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SaxesParser } from "saxes";
import { parseJunitSummary } from "../../scripts/lib/junit-summary.ts";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = path.resolve(import.meta.dirname, "../../..");
assert.equal(process.argv.length, 3);
assert.equal(
  path.resolve(root, process.argv[2]),
  path.join(root, "packages/voice/quint/VoiceAssistantSpeechPump.qnt"),
);
const output = testOutputPath("quint-voice-speech-pump");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-"));
const junit = path.join(directory, "voice.xml");
const result = spawnSync(
  process.execPath,
  [
    "packages/scripts/run-with-deadline.ts",
    "120000",
    "--",
    "bun",
    "run",
    "--cwd",
    "packages/voice",
    "test",
    "src/voice-assistant-session.test.ts",
    "--reporter=junit",
    `--outputFile=${junit}`,
  ],
  { cwd: root, encoding: "utf8" },
);
const log = path.join(directory, "voice.log");
writeFileSync(log, `${result.stdout ?? ""}${result.stderr ?? ""}`);
if (result.error) throw result.error;
assert.equal(
  result.signal,
  null,
  `Voice controller terminated. Receipt ${log}`,
);
assert.equal(result.status, 0, `Voice controller failed. Receipt ${log}`);

const xml = readFileSync(junit, "utf8");
const summary = parseJunitSummary(xml);
assert.equal(summary.failures + summary.errors + summary.skipped, 0);
const required = [
  "hands the next sentence over once the current one is audible and counts heard in order",
  "a pipelined playback failure aborts a queued successor before it starts",
  "a queued completion after an earlier playback failure never credits the failed sentence",
  "speaks sentences planned while the first one plays, from the stream and from the confirmed reply",
];
const names = [];
const parser = new SaxesParser({ xmlns: false });
parser.on("opentag", (tag) => {
  if (tag.name !== "testcase") return;
  assert.equal(typeof tag.attributes.name, "string");
  names.push(tag.attributes.name.split(" > ").at(-1));
});
parser.write(xml).close();
for (const name of required)
  assert.equal(
    names.filter((item) => item === name).length,
    1,
    `Missing or repeated voice case: ${name}`,
  );
writeFileSync(
  path.join(directory, "evidence.json"),
  `${JSON.stringify({ required, summary, junit, log }, null, 2)}\n`,
);
console.log(
  `Voice speech pump passed all four required controller cases. Receipt ${junit}`,
);
