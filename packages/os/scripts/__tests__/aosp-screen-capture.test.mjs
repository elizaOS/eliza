import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { crc32, deflateSync } from "node:zlib";
import { captureScreens } from "../distro-android/capture-screens.mjs";
import { parseSubArgs } from "../distro-android/e2e-validate.mjs";

function png() {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "capture-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const adb = join(dir, "adb");
  const log = join(dir, "calls.jsonl");
  const payload = join(dir, "payload.png");
  await writeFile(payload, png());
  await writeFile(
    adb,
    `#!${process.execPath}
const fs=require('node:fs');const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');
if(args.includes('get-serialno')) console.log('emulator-5554');
else if(args.includes('exec-out')) {
  if(fs.existsSync(${JSON.stringify(join(dir, "fail"))})) process.exit(17);
  process.stdout.write(fs.readFileSync(${JSON.stringify(payload)}));
}
else if(args.join(' ').includes('sys.boot_completed')) console.log('1');
else console.log('wrong-product');
`,
  );
  await chmod(adb, 0o755);
  return { dir, adb, log, payload, outDir: join(dir, "screens") };
}

test("capture resolves one serial and uses it for every step and framebuffer", async (t) => {
  const f = await fixture(t);
  const seen = [];
  const step = {
    label: "home",
    settleMs: 0,
    drive: (_adb, serial) => seen.push(serial),
  };
  const images = await captureScreens({
    ...f,
    steps: ["home", "home"],
    stepMap: { home: step },
  });
  assert.equal(images.length, 2);
  assert.deepEqual(seen, ["emulator-5554", "emulator-5554"]);
  const calls = (await readFile(f.log, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(calls[0], ["get-serialno"]);
  for (const call of calls.slice(1))
    assert.deepEqual(call.slice(0, 2), ["-s", "emulator-5554"]);
});

test("a failed launch cannot produce a mislabeled screenshot", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    captureScreens({
      ...f,
      serial: "emulator-5554",
      steps: ["dialer"],
      stepMap: {
        dialer: {
          label: "dialer",
          drive() {
            throw new Error("launch failed");
          },
          settleMs: 0,
        },
      },
    }),
    /could not be launched/,
  );
  assert.deepEqual(await readdir(f.outDir), []);
  await assert.rejects(readFile(f.log), { code: "ENOENT" });
});

test("invalid labels and empty steps fail before accessing a device", async (t) => {
  const f = await fixture(t);
  for (const label of ["../../escape", "back\\slash", "line\nbreak"]) {
    await assert.rejects(
      captureScreens({ ...f, label, steps: ["home"], stepMap: { home: {} } }),
      /filename component/,
    );
  }
  await assert.rejects(
    captureScreens({ ...f, steps: [], stepMap: {} }),
    /nonempty steps/,
  );
  await assert.rejects(readFile(f.log), { code: "ENOENT" });
  for (const value of ["10ms", "1.5", "Infinity"]) {
    assert.throws(
      () => parseSubArgs(["--out", f.outDir, "--timeout-ms", value]),
      /positive integer/,
    );
  }
});

test("end-to-end validation does not launch screenshot actions after a boot refusal", async (t) => {
  const f = await fixture(t);
  await mkdir(f.outDir);
  const script = new URL("../distro-android/e2e-validate.mjs", import.meta.url);
  const result = spawnSync(
    process.execPath,
    [
      script.pathname,
      "--out",
      f.outDir,
      "--adb",
      f.adb,
      "--serial",
      "emulator-5554",
      "--timeout-ms",
      "1000",
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(
    await readFile(join(f.outDir, "report.json"), "utf8"),
  );
  assert.equal(report.errors[0].phase, "boot-validate");
  assert.deepEqual(report.screenshots, []);
  assert.doesNotMatch(
    await readFile(f.log, "utf8"),
    /exec-out|keyevent|am start|monkey/,
  );
});

test("empty, non-PNG, truncated and corrupt framebuffer output is never recorded", async (t) => {
  const f = await fixture(t);
  const damaged = Buffer.from(png());
  damaged[20] ^= 1;
  for (const data of [
    Buffer.alloc(0),
    Buffer.from("adb diagnostic"),
    png().subarray(0, -2),
    damaged,
  ]) {
    await writeFile(f.payload, data);
    await assert.rejects(
      captureScreens({ ...f, serial: "emulator-5554", noLaunch: true }),
      /complete checksummed PNG/,
    );
    assert.deepEqual(await readdir(f.outDir), []);
  }
});

test("failed exec-out is reported without writing a file on the device", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.dir, "fail"), "1");
  await assert.rejects(
    captureScreens({ ...f, serial: "emulator-5554", noLaunch: true }),
    /capture failed \(17\)/,
  );
  const calls = (await readFile(f.log, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(calls, [
    ["-s", "emulator-5554", "exec-out", "screencap", "-p"],
  ]);
  assert.deepEqual(await readdir(f.outDir), []);
});
