/** Bind capture ownership scenarios to the maintained browser and native owners. */
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
const suites = [
  {
    name: "native",
    package: "packages/voice",
    command: "test",
    files: [
      "src/voice-assistant-session.test.ts",
      "src/native-live-voice.test.ts",
      "src/live-voice-session.test.ts",
    ],
    required: [
      "closes input at submission and keeps it closed through thinking, every sentence and drain; reopens once after the last playback",
      "a healthy idle Mute stays quiet until Unmute, which reopens; the next turn is sent and held",
      "a Mute close that fails for a capture still reopening after the reply ends the conversation once; the reopen settles nothing more",
      "Stop while an idle Mute close is pending resolves once the close settles; a close that fails after Stop reports nothing",
      "Stop waits for the cancel receipt of a capture returned after its reopen was retired",
      "ends the conversation when the reopen is refused (a call or pause on the bridge), after one attempt",
      "Stop rejects while the capture refuses, and the repeat asks that capture again",
      "a close that fails after Stop's cancel confirmed proves nothing against it",
      "a capture that opens after Stop is released, and its refusal rejects Stop",
      "keeps the session's Stop rejected until the bridge answers, over the real capture",
      "keeps a refused cancel: the repeat asks the same capture, and only its answer frees Transcribe",
    ],
  },
  {
    name: "browser",
    package: "packages/ui",
    command: "test:e2e",
    files: [
      "src/voice/__e2e__/voice-session-mic-capture.test.ts",
      "src/voice/voice-session-cloud-budget-rotation.test.ts",
      "src/hooks/useRealtimeVoiceSession.refusal.test.tsx",
    ],
    required: [
      "a track that refuses leaves its siblings stopped, rejects, and confirms only on its own retry",
      "a track that refuses keeps Stop rejected until that capture's own retry confirms",
      "no capture opens over a release that is still refused",
      "the real hook retains failed Stop across retry and starts only after release",
      "Stop cancels a restart that is still releasing a retained capture",
      "unmount retries a retained release without starting a new capture",
      "disable retries a retained release without starting a new capture",
      "changeConversation retries a retained release without starting a new capture",
    ],
  },
];
const receipts = [];
for (const suite of suites) {
  const junit = path.join(directory, `${suite.name}.xml`);
  const result = spawnSync(
    process.execPath,
    [
      "packages/scripts/run-with-deadline.ts",
      "120000",
      "--",
      "bun",
      "run",
      "--cwd",
      suite.package,
      suite.command,
      ...suite.files,
      "--reporter=junit",
      `--outputFile=${junit}`,
    ],
    { cwd: root, encoding: "utf8" },
  );
  const log = path.join(directory, `${suite.name}.log`);
  writeFileSync(log, `${result.stdout ?? ""}${result.stderr ?? ""}`);
  if (result.error) throw result.error;
  assert.equal(result.signal, null, `Capture suite terminated. Receipt ${log}`);
  assert.equal(result.status, 0, `Capture suite failed. Receipt ${log}`);
  const xml = readFileSync(junit, "utf8");
  const summary = parseJunitSummary(xml);
  assert.equal(summary.failures + summary.errors + summary.skipped, 0);
  const names = [];
  const parser = new SaxesParser({ xmlns: false });
  parser.on("opentag", (tag) => {
    if (tag.name !== "testcase") return;
    assert.equal(typeof tag.attributes.name, "string");
    names.push(tag.attributes.name.split(" > ").at(-1));
  });
  parser.write(xml).close();
  for (const name of suite.required)
    assert.equal(
      names.filter((item) => item === name).length,
      1,
      `Missing or repeated capture case: ${name}`,
    );
  receipts.push({ ...suite, summary, junit, log });
}
writeFileSync(
  path.join(directory, "evidence.json"),
  `${JSON.stringify({ receipts }, null, 2)}\n`,
);
console.log(
  `Capture ownership scenario conformance passed. Receipt ${directory}`,
);
