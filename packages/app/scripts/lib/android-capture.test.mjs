/**
 * Runs Android capture helpers through a process-real fake adb transport. The
 * recorder writes its moov box only after the simulated device-side SIGINT, so
 * killing the host adb child early reproduces the corrupt-video regression.
 */
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  assertPlayableMp4,
  captureAndroidLogcat,
  captureAndroidScreenshot,
  inspectMp4,
  startAndroidScreenRecord,
  startChunkedAndroidScreenRecord,
} from "./android-capture.mjs";

const root = mkdtempSync(path.join(tmpdir(), "eliza-android-capture-"));
const stateDir = path.join(root, "state");
const artifactDir = path.join(root, "artifacts");
const fakeAdb = path.join(root, "fake-adb.mjs");

const fakeAdbSource = String.raw`#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const state = path.join(path.dirname(fileURLToPath(import.meta.url)), "state");
fs.mkdirSync(state, { recursive: true });
let args = process.argv.slice(2);
if (args[0] === "-s") args = args.slice(2);
const activePath = path.join(state, "active.json");
const stopPath = path.join(state, "stop");
const signalLog = path.join(state, "signals.log");
const remoteFile = (remote) => path.join(state, Buffer.from(remote).toString("base64url"));
const box = (type, payload = Buffer.alloc(4)) => {
  const out = Buffer.alloc(8 + payload.length);
  out.writeUInt32BE(out.length, 0);
  out.write(type, 4, 4, "ascii");
  payload.copy(out, 8);
  return out;
};
const partialMp4 = () => Buffer.concat([
  box("ftyp", Buffer.from("isom")),
  box("mdat", Buffer.from([1, 2, 3, 4])),
]);
const completeMp4 = () => Buffer.concat([
  box("ftyp", Buffer.from("isom")),
  box("mdat", Buffer.from([1, 2, 3, 4])),
  box("moov", Buffer.from([0, 0, 0, 0])),
]);

if (args[0] === "shell" && args[1] === "screenrecord") {
  const remote = args.at(-1);
  fs.rmSync(stopPath, { force: true });
  fs.writeFileSync(remoteFile(remote), partialMp4());
  fs.writeFileSync(activePath, JSON.stringify({ remote }));
  let finished = false;
  const finish = (reason) => {
    if (finished) return;
    finished = true;
    fs.writeFileSync(remoteFile(remote), completeMp4());
    fs.rmSync(activePath, { force: true });
    fs.appendFileSync(signalLog, reason + "\n");
    process.exit(0);
  };
  process.on("SIGINT", () => finish("host-SIGINT"));
  process.on("SIGTERM", () => finish("host-SIGTERM"));
  setInterval(() => {
    if (fs.existsSync(stopPath)) finish("device-SIGINT");
  }, 20);
} else if (args[0] === "shell" && args[1] === "pkill") {
  fs.writeFileSync(stopPath, "stop");
} else if (args[0] === "shell" && args[1] === "pidof") {
  if (fs.existsSync(activePath)) process.stdout.write("4242\n");
  else process.exitCode = 1;
} else if (args[0] === "shell" && args[1] === "stat") {
  const remote = args.at(-1);
  try {
    process.stdout.write(String(fs.statSync(remoteFile(remote)).size) + "\n");
  } catch {
    process.exitCode = 1;
  }
} else if (args[0] === "shell" && args[1] === "rm") {
  fs.rmSync(remoteFile(args.at(-1)), { force: true });
} else if (args[0] === "pull") {
  fs.copyFileSync(remoteFile(args[1]), args[2]);
  process.stdout.write("pulled\n");
} else if (args[0] === "exec-out" && args[1] === "screencap") {
  process.stdout.write(Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]));
} else if (args[0] === "logcat") {
  process.stdout.write("I/ElizaTest: capture logcat receipt\n");
} else {
  process.stderr.write("unsupported fake adb args: " + JSON.stringify(args) + "\n");
  process.exitCode = 2;
}
`;

writeFileSync(fakeAdb, fakeAdbSource);
chmodSync(fakeAdb, 0o755);
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

function mp4Box(type, payload = Buffer.alloc(4)) {
  const out = Buffer.alloc(8 + payload.length);
  out.writeUInt32BE(out.length, 0);
  out.write(type, 4, 4, "ascii");
  payload.copy(out, 8);
  return out;
}

test("inspectMp4 distinguishes complete, truncated, and missing-box files", () => {
  const valid = Buffer.concat([mp4Box("ftyp"), mp4Box("mdat"), mp4Box("moov")]);
  assert.deepEqual(inspectMp4(valid), {
    valid: true,
    boxes: ["ftyp", "mdat", "moov"],
    reason: null,
  });
  assert.match(inspectMp4(valid.subarray(0, 7)).reason, /truncated/);
  assert.match(
    inspectMp4(Buffer.concat([mp4Box("ftyp"), mp4Box("mdat")])).reason,
    /missing moov/,
  );

  const badSize = Buffer.alloc(8);
  badSize.writeUInt32BE(99, 0);
  badSize.write("moov", 4, 4, "ascii");
  assert.match(inspectMp4(badSize).reason, /invalid moov box size/);
});

test("single recording waits for the device finalizer and returns a playable MP4", async () => {
  const logs = [];
  const recording = await startAndroidScreenRecord({
    adb: fakeAdb,
    serial: "emulator-test",
    artifactDir,
    filename: "single.mp4",
    remotePath: "/sdcard/single.mp4",
    log: (line) => logs.push(line),
  });
  const result = await recording.stop();

  assert.equal(result, path.join(artifactDir, "single.mp4"));
  assert.equal(recording.localPath, result);
  assert.equal(await recording.stop(), result, "stop is idempotent");
  assert.equal(assertPlayableMp4(result).valid, true);
  assert.match(
    readFileSync(path.join(stateDir, "signals.log"), "utf8"),
    /device-SIGINT/,
  );
  assert.doesNotMatch(
    readFileSync(path.join(stateDir, "signals.log"), "utf8"),
    /host-SIGINT/,
  );
  assert.ok(logs.some((line) => line.includes("wrote Android screenrecord")));
});

test("chunked recording finalizes its active segment before packaging", async () => {
  const recording = await startChunkedAndroidScreenRecord({
    adb: fakeAdb,
    serial: "emulator-test",
    artifactDir,
    filename: "chunked.mp4",
    segmentSeconds: 1,
  });
  const result = await recording.stop();
  assert.equal(result, path.join(artifactDir, "chunked.mp4"));
  assert.equal(assertPlayableMp4(result).valid, true);
});

test("screenshot and logcat helpers retain real command bytes", () => {
  const screenshot = captureAndroidScreenshot({
    adb: fakeAdb,
    serial: "emulator-test",
    artifactDir,
    filename: "screen.png",
  });
  assert.deepEqual(
    [...readFileSync(screenshot)],
    [0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10],
  );

  const logcat = captureAndroidLogcat({
    adb: fakeAdb,
    serial: "emulator-test",
    artifactDir,
    filename: "logcat.txt",
    lines: 42,
  });
  assert.match(readFileSync(logcat, "utf8"), /capture logcat receipt/);
});

test("capture helpers reject missing required device inputs", async () => {
  await assert.rejects(
    startAndroidScreenRecord({ adb: fakeAdb, artifactDir }),
    /serial is required/,
  );
  await assert.rejects(
    startChunkedAndroidScreenRecord({ adb: fakeAdb, serial: "device" }),
    /artifactDir is required/,
  );
  assert.throws(
    () => captureAndroidScreenshot({ adb: fakeAdb, artifactDir }),
    /serial is required/,
  );
  assert.throws(
    () => captureAndroidLogcat({ adb: fakeAdb, serial: "device" }),
    /artifactDir is required/,
  );
});
