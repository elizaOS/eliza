import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  defaultRequirementsPath,
  FASTBOOT_GETVARS,
  parseArgs,
  READ_ONLY_COMMANDS,
} from "../android/device-qualify.ts";
import {
  checkNames,
  deriveFacts,
  evaluate,
  normalizeVendorApiLevel,
  parseCameras,
  parseFastbootVars,
  parseKernelVersion,
  parseLsMode,
  parseMediaCodecs,
  parseMicrophoneCount,
  parseVintfTargetLevel,
  parseWifiBands,
  validateRequirements,
} from "../android/device-qualify-lib.ts";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const requirements = validateRequirements(
  JSON.parse(fs.readFileSync(defaultRequirementsPath, "utf8")),
);
const fixtureDir = path.join(
  packageRoot,
  "scripts/__tests__/fixtures/device-qualify/android15-emulator",
);
const loadFixture = () =>
  Object.fromEntries(
    fs
      .readdirSync(fixtureDir)
      .map((file) => [
        path.basename(file, ".txt"),
        fs.readFileSync(path.join(fixtureDir, file), "utf8"),
      ]),
  );

// A product-style file: thresholds like these live downstream, not upstream.
const productRequirements = validateRequirements({
  schemaVersion: 1,
  requirements: [
    ...requirements.requirements,
    { id: "ram-min", level: "required", check: "ramGiB", min: 5.5 },
    { id: "storage", level: "required", check: "dataGiB", min: 50 },
    { id: "rear-camera", level: "required", check: "camera", facing: "back" },
    {
      id: "rear-autofocus",
      level: "required",
      check: "cameraAutofocus",
      facing: "back",
    },
    { id: "front-camera", level: "required", check: "camera", facing: "front" },
    { id: "wifi-5ghz", level: "required", check: "wifi5GHz" },
    { id: "charge-control", level: "preferred", check: "chargeControl" },
    {
      id: "wifi-country-surface-locked",
      level: "preferred",
      check: "wifiCountryProcNotWorldWritable",
    },
  ],
  fastbootRequirements: requirements.fastbootRequirements,
});

test("Android 15 emulator capture yields the observed facts", () => {
  const facts = deriveFacts(loadFixture());
  assert.equal(facts.emulator, true);
  assert.equal(facts.androidRelease, 15);
  assert.equal(facts.vendorApiLevel, 35);
  assert.equal(facts.treble, true);
  assert.equal(facts.abi, "arm64-v8a");
  assert.equal(facts.kernel?.gkiBranch, "android15-6.6");
  assert.deepEqual(facts.display, {
    width: 2560,
    height: 1600,
    longEdge: 2560,
    shortEdge: 1600,
  });
  assert.equal(facts.cameras.length, 1);
  assert.equal(facts.cameras[0].facing, "back");
  assert.equal(facts.cameras[0].autofocus, true);
  assert.equal(facts.microphoneCount, 1);
  assert.equal(facts.wifi5GHz, false);
  assert.ok(facts.codecs.decoders.includes("video/hevc"));
  assert.equal(facts.selinux, "Enforcing");
});

test("emulator capture is labelled emulator evidence even when the Treble gates pass", () => {
  const evaluation = evaluate(deriveFacts(loadFixture()), requirements);
  assert.equal(evaluation.evidenceLevel, "emulator-observation");
  assert.equal(evaluation.verdict, "pass");
  assert.deepEqual(evaluation.warnings, ["ab-updates"]);
  assert.match(evaluation.disclaimer, /Not a GSI or image boot/);
});

test("product thresholds fail the emulator on real hardware gaps", () => {
  const evaluation = evaluate(deriveFacts(loadFixture()), productRequirements);
  const byId = Object.fromEntries(
    evaluation.results.map((r) => [r.id, r.result]),
  );
  assert.equal(evaluation.evidenceLevel, "emulator-observation");
  assert.equal(evaluation.verdict, "fail");
  assert.equal(byId["front-camera"], "fail");
  assert.equal(byId["rear-autofocus"], "pass");
  assert.equal(byId["wifi-5ghz"], "fail");
  assert.equal(byId["ram-min"], "fail");
});

test("shipped requirements are generic, valid and fully implemented", () => {
  const all = [
    ...requirements.requirements,
    ...requirements.fastbootRequirements,
  ];
  assert.ok(all.every((r) => checkNames.includes(r.check)));
  for (const id of [
    "treble",
    "vendor-api-level",
    "kernel-floor",
    "dynamic-partitions",
    "abi",
    "selinux-enforcing",
  ])
    assert.ok(
      requirements.requirements.some((r) => r.id === id),
      id,
    );
  assert.doesNotMatch(
    fs.readFileSync(defaultRequirementsPath, "utf8"),
    /senior|elizaresearch/i,
  );
  const productChecks = ["ramGiB", "dataGiB", "camera", "wifi5GHz", "codec"];
  assert.ok(all.every((r) => !productChecks.includes(r.check)));
  assert.doesNotThrow(() => evaluate(deriveFacts({}), requirements));
  assert.doesNotThrow(() =>
    evaluate({ fastboot: {} }, requirements, { fastboot: true }),
  );
  assert.throws(
    () =>
      validateRequirements({
        schemaVersion: 1,
        requirements: [{ id: "x", level: "required", check: "toString" }],
      }),
    /unknown check/,
  );
  assert.throws(
    () =>
      validateRequirements({
        schemaVersion: 1,
        requirements: [
          { id: "x", level: "required", check: "treble" },
          { id: "x", level: "required", check: "treble" },
        ],
      }),
    /duplicate/,
  );
});

test("a qualifying device passes product gates and flags a world-writable country node", () => {
  const facts = {
    emulator: false,
    androidRelease: 16,
    vendorApiLevel: 36,
    treble: true,
    abi: "arm64-v8a",
    kernel: parseKernelVersion("6.1.118-android14-11-g0000"),
    ramGiB: 7.6,
    dataGiB: 110,
    cameras: [
      { id: "0", facing: "back", autofocus: true },
      { id: "1", facing: "front", autofocus: false },
    ],
    wifi5GHz: true,
    dynamicPartitions: true,
    abUpdates: true,
    selinux: "Enforcing",
    chargeControlNodes: [],
    wlanCountryProcMode: "-rw-rw-rw-",
  };
  const evaluation = evaluate(facts, productRequirements);
  assert.equal(evaluation.verdict, "pass");
  assert.equal(evaluation.evidenceLevel, "device-observation");
  assert.deepEqual(evaluation.warnings.sort(), [
    "charge-control",
    "wifi-country-surface-locked",
  ]);
  facts.wlanCountryProcMode = "-rw-rw-r--";
  assert.equal(
    evaluate(facts, productRequirements).results.find(
      (r) => r.id === "wifi-country-surface-locked",
    ).result,
    "pass",
  );
});

test("missing observations make required checks incomplete, never pass", () => {
  const partial = evaluate(
    { ...deriveFacts(loadFixture()), ramGiB: null, cameras: [] },
    productRequirements,
  );
  assert.equal(
    partial.results.find((r) => r.id === "ram-min").result,
    "unknown",
  );
  assert.equal(
    partial.results.find((r) => r.id === "rear-camera").result,
    "unknown",
  );
  const generic = evaluate(
    { ...deriveFacts(loadFixture()), selinux: null, kernel: null },
    requirements,
  );
  assert.equal(generic.verdict, "incomplete");
});

test("parsers handle vendor formats", () => {
  assert.equal(normalizeVendorApiLevel(202404), 35);
  assert.equal(normalizeVendorApiLevel(202504), 36);
  assert.equal(normalizeVendorApiLevel(34), 34);
  assert.deepEqual(parseWifiBands("wifi_native_supported_sta_bands=15"), {
    mask: 15,
    ghz2_4: true,
    ghz5: true,
    ghz6: true,
  });
  assert.equal(
    parseKernelVersion("5.10.209-android12-9-00001-g1")?.gkiBranch,
    "android12-5.10",
  );
  assert.equal(
    parseLsMode(
      "-rw-rw-r-- 1 system system 0 2026-10-02 05:00 /proc/net/wlan/country",
    ),
    "-rw-rw-r--",
  );
  assert.equal(
    parseLsMode("ls: /proc/net/wlan/country: No such file or directory"),
    null,
  );
  assert.equal(
    parseVintfTargetLevel(
      '<manifest version="8.0" type="device" target-level="202404">',
    ),
    "202404",
  );
  assert.equal(
    parseMicrophoneCount(
      "{AUDIO_DEVICE_IN_BUILTIN_MIC, @:bottom}\n{AUDIO_DEVICE_IN_BACK_MIC, @:back}\n{AUDIO_DEVICE_IN_BUILTIN_MIC, @:bottom}",
    ),
    2,
  );
  assert.deepEqual(
    parseMediaCodecs(
      '<Decoders><MediaCodec name="c2.vendor.hevc.decoder" type="video/hevc"/></Decoders><Encoders><MediaCodec name="c2.android.aac.encoder" type="audio/mp4a-latm"/></Encoders>',
    ),
    { decoders: ["video/hevc"], encoders: ["audio/mp4a-latm"] },
  );
  const cameras = parseCameras(
    [
      "== Camera HAL device device@1.1/internal/0 (v1.3) static information: ==",
      "      android.control.afAvailableModes (10017): byte[1]",
      "        [0 ]",
      "      android.lens.facing (80005): byte[1]",
      "        [FRONT ]",
      "      android.lens.info.minimumFocusDistance (90005): float[1]",
      "        [0.00000000 ]",
    ].join("\n"),
  );
  assert.deepEqual(
    cameras.map((c) => [c.facing, c.autofocus]),
    [["front", false]],
  );
});

test("fastboot getvar parsing and relock checks", () => {
  const vars = parseFastbootVars(
    [
      "(bootloader) unlocked:yes",
      "(bootloader) current-slot:a",
      "(bootloader) partition-type:avb_custom_key:raw",
      "all: Done!!",
    ].join("\n"),
  );
  assert.equal(vars.unlocked, "yes");
  assert.equal(vars["partition-type:avb_custom_key"], "raw");
  const ok = evaluate({ fastboot: vars }, requirements, { fastboot: true });
  assert.equal(ok.evidenceLevel, "bootloader-observation");
  assert.deepEqual(
    ok.results.map((r) => r.result),
    ["pass", "pass"],
  );
  const missing = evaluate(
    {
      fastboot: {
        unlocked: "no",
        "partition-type:avb_custom_key":
          "FAILED (remote: 'Variable not implemented')",
      },
    },
    requirements,
    { fastboot: true },
  );
  assert.equal(
    missing.results.find((r) => r.id === "avb-custom-key").result,
    "fail",
  );
});

test("collection is a fixed read-only command set", () => {
  const forbidden =
    /\b(setprop|settings put|pm (install|uninstall|clear|grant|revoke)|am (start|broadcast|force-stop)|svc |reboot|rm |dd |echo |>|tee |chmod|chown|mount|setenforce|cmd wifi (set|force|start|stop|connect)|fastboot (flash|erase|oem|flashing))/;
  for (const [key, command] of Object.entries(READ_ONLY_COMMANDS))
    assert.doesNotMatch(
      command.replaceAll("2>/dev/null", "").replaceAll("2>&1", ""),
      forbidden,
      key,
    );
  assert.deepEqual(FASTBOOT_GETVARS, ["all", "partition-type:avb_custom_key"]);
  assert.throws(() => parseArgs([]), /--serial/);
  assert.throws(() => parseArgs(["--serial", "a;rm"]), /--serial/);
  assert.equal(
    parseArgs(["--serial", "emulator-5554"]).requirements,
    defaultRequirementsPath,
  );
});

test("CLI drives only the allowlisted adb commands and labels emulator records", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "os-device-qualify-"));
  try {
    // Fake adb answers from the emulator fixture and logs every invocation.
    const log = path.join(tmp, "adb.log");
    const adb = path.join(tmp, "adb");
    const commandToFixture = Object.fromEntries(
      Object.entries(READ_ONLY_COMMANDS).map(([key, command]) => [
        command,
        path.join(fixtureDir, `${key}.txt`),
      ]),
    );
    fs.writeFileSync(
      path.join(tmp, "map.json"),
      JSON.stringify(commandToFixture),
    );
    fs.writeFileSync(
      adb,
      `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
if (args[2] === "get-state") { process.stdout.write("device\\n"); process.exit(0); }
const map = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(tmp, "map.json"))}, "utf8"));
const file = map[args[3]];
if (file && fs.existsSync(file)) process.stdout.write(fs.readFileSync(file));
`,
      { mode: 0o755 },
    );
    const out = path.join(tmp, "record");
    const result = spawnSync(
      process.execPath,
      [
        path.join(packageRoot, "scripts/android/device-qualify.ts"),
        "--serial",
        "emulator-5554",
        "--adb",
        adb,
        "--out",
        out,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const record = JSON.parse(
      fs.readFileSync(path.join(out, "record.json"), "utf8"),
    );
    assert.equal(record.evaluation.evidenceLevel, "emulator-observation");
    assert.equal(record.requirementsPath, defaultRequirementsPath);
    const allowed = new Set(Object.values(READ_ONLY_COMMANDS));
    const calls = fs
      .readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(calls[0], ["-s", "emulator-5554", "get-state"]);
    for (const call of calls.slice(1)) {
      assert.deepEqual(call.slice(0, 3), ["-s", "emulator-5554", "shell"]);
      assert.equal(call.length, 4);
      assert.ok(allowed.has(call[3]), call[3]);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
