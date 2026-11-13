/** Require the maintained controller's capture ownership cases. */
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
  path.join(root, "packages/voice/quint/VoiceAssistantCaptureOwnership.qnt"),
);
const output = testOutputPath("quint-voice-capture-ownership");
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
  "closes input at submission and keeps it closed through thinking, every sentence and drain; reopens once after the last playback",
  "a healthy idle Mute stays quiet until Unmute, which reopens; the next turn is sent and held",
  "a Mute close that fails for a capture still reopening after the reply ends the conversation once; the reopen settles nothing more",
  "Stop while an idle Mute close is pending resolves once the close settles; a close that fails after Stop reports nothing",
  "Stop waits for the cancel receipt of a capture returned after its reopen was retired",
  "ends the conversation when the reopen is refused (a call or pause on the bridge), after one attempt",
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
  `Voice capture ownership passed all six required controller cases. Receipt ${junit}`,
);
