#!/usr/bin/env node
/**
 * Read-only qualification of a connected Android device against a requirements
 * file (default: android/device-requirements/treble-gsi.json).
 *
 *   node packages/os/scripts/android/device-qualify.ts --serial SERIAL \
 *     [--requirements FILE] [--out DIR] [--adb PATH]
 *   node packages/os/scripts/android/device-qualify.ts --serial SERIAL --fastboot \
 *     [--requirements FILE] [--out DIR] [--fastboot-bin PATH]
 *
 * adb mode runs only the fixed read-only commands below: no settings changes,
 * installs, flashing or transmissions. fastboot mode runs only `getvar`. The
 * record keeps every raw capture so each verdict can be re-checked. Emulator
 * captures are labelled emulator evidence, never device evidence.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { testOutputPath } from "../../../scripts/lib/test-output.ts";
import {
  deriveFacts,
  evaluate,
  parseFastbootVars,
  validateRequirements,
} from "./device-qualify-lib.ts";

export const defaultRequirementsPath = fileURLToPath(
  new URL("../../android/device-requirements/treble-gsi.json", import.meta.url),
);

// Each entry is one fixed shell command string. Nothing here writes state.
export const READ_ONLY_COMMANDS = {
  getprop: "getprop",
  uname: "uname -r",
  meminfo: "cat /proc/meminfo",
  dfData: "df -k /data",
  wmSize: "wm size",
  wmDensity: "wm density",
  getenforce: "getenforce",
  cameras: "dumpsys media.camera",
  audioPolicy: "dumpsys media.audio_policy",
  mediaCodecs:
    "cat /apex/com.android.media.swcodec/etc/media_codecs*.xml /system/etc/media_codecs*.xml /vendor/etc/media_codecs*.xml /odm/etc/media_codecs*.xml 2>/dev/null",
  wifiCountry: "cmd wifi get-country-code",
  wifiStatus: "cmd wifi status",
  wifiDump:
    "dumpsys wifi | grep -E 'supported_sta_bands|is5GHzBandSupported' | head -10",
  chargeControl:
    "ls -d /sys/class/power_supply/*/charge_control* /sys/class/power_supply/*/charge_*_threshold /sys/class/power_supply/*/charging_policy /sys/class/power_supply/*/input_suspend 2>/dev/null",
  battery: "dumpsys battery",
  wlanCountryProc: "ls -l /proc/net/wlan/country 2>&1",
  vendorFirmware: "ls -l /vendor/firmware/ 2>/dev/null",
  vintfManifest: "cat /vendor/etc/vintf/manifest.xml 2>/dev/null",
  vintfFragments: "ls /vendor/etc/vintf/manifest/ 2>/dev/null",
  vintfMatrix: "cat /vendor/etc/vintf/compatibility_matrix.xml 2>/dev/null",
};

// The only fastboot invocations this tool may make.
export const FASTBOOT_GETVARS = ["all", "partition-type:avb_custom_key"];

export function parseArgs(argv) {
  const args = { fastboot: false, requirements: defaultRequirementsPath };
  const valued = {
    "--serial": "serial",
    "--out": "out",
    "--requirements": "requirements",
    "--adb": "adb",
    "--fastboot-bin": "fastbootBin",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--fastboot") args.fastboot = true;
    else if (Object.hasOwn(valued, arg)) {
      if (!argv[i + 1] || argv[i + 1].startsWith("--"))
        throw new Error(`${arg} needs a value`);
      args[valued[arg]] = argv[++i];
    } else
      throw new Error(
        `Unknown argument ${arg}. Use --serial SERIAL [--requirements FILE] [--out DIR] [--fastboot]`,
      );
  }
  // Require an explicit serial so a run can never touch another device.
  if (!args.serial || !/^[\w.:-]+$/.test(args.serial))
    throw new Error("Supply --serial SERIAL (see `adb devices`).");
  return args;
}

function run(binary, argv) {
  const result = spawnSync(binary, argv, {
    encoding: "utf8",
    timeout: 60000,
    maxBuffer: 32 * 1024 ** 2,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error?.message,
  };
}

function collectAdb(adb, serial) {
  const state = run(adb, ["-s", serial, "get-state"]);
  if (state.stdout.trim() !== "device")
    throw new Error(
      `adb device ${serial} is not ready: ${state.error || state.stderr || state.stdout}`.trim(),
    );
  const raw = {};
  const errors = {};
  for (const [key, command] of Object.entries(READ_ONLY_COMMANDS)) {
    const out = run(adb, ["-s", serial, "shell", command]);
    raw[key] = out.stdout;
    if (out.status !== 0 && !out.stdout)
      errors[key] = (out.stderr || out.error || `exit ${out.status}`).trim();
  }
  return { raw, errors };
}

function collectFastboot(fastboot, serial) {
  const [all, custom] = FASTBOOT_GETVARS.map((name) =>
    run(fastboot, ["-s", serial, "getvar", name]),
  );
  const text = `${all.stderr}\n${all.stdout}`;
  const vars = parseFastbootVars(text);
  const customText = `${custom.stderr}\n${custom.stdout}`;
  const customVars = parseFastbootVars(customText);
  vars["partition-type:avb_custom_key"] =
    customVars["partition-type:avb_custom_key"] ??
    /FAILED[^\n]*/.exec(customText)?.[0] ??
    "";
  if (
    Object.keys(vars).length <= 1 ||
    (all.status !== 0 && !text.includes("(bootloader)"))
  )
    throw new Error(
      `fastboot device ${serial} did not answer getvar: ${(all.error || text).trim()}`,
    );
  return {
    raw: { getvarAll: text, getvarAvbCustomKey: customText },
    vars,
  };
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const requirementsPath = path.resolve(args.requirements);
  const requirements = validateRequirements(
    JSON.parse(fs.readFileSync(requirementsPath, "utf8")),
  );
  if (args.fastboot && !requirements.fastbootRequirements?.length)
    throw new Error(`${requirementsPath} has no fastbootRequirements`);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.resolve(
    args.out ??
      testOutputPath(
        "os-device-qualification",
        `${args.serial.replace(/[^\w.-]/g, "_")}-${args.fastboot ? "fastboot-" : ""}${stamp}`,
      ),
  );

  let facts: Record<string, unknown>;
  let raw: Record<string, string>;
  let errors: Record<string, string> = {};
  if (args.fastboot) {
    const collected = collectFastboot(
      args.fastbootBin ?? "fastboot",
      args.serial,
    );
    raw = collected.raw;
    facts = { emulator: false, fastboot: collected.vars };
  } else {
    ({ raw, errors } = collectAdb(args.adb ?? "adb", args.serial));
    facts = deriveFacts(raw);
  }
  fs.mkdirSync(path.join(outDir, "raw"), { recursive: true });
  for (const [key, value] of Object.entries(raw))
    fs.writeFileSync(path.join(outDir, "raw", `${key}.txt`), value as string);
  const evaluation = evaluate(facts, requirements, { fastboot: args.fastboot });
  const record = {
    schemaVersion: 1,
    tool: "packages/os/scripts/android/device-qualify.ts",
    capturedAt: new Date().toISOString(),
    serial: args.serial,
    mode: args.fastboot ? "fastboot" : "adb",
    requirementsPath,
    requirementsReviewedAt: requirements.reviewedAt ?? null,
    facts,
    collectionErrors: errors,
    evaluation,
  };
  fs.writeFileSync(
    path.join(outDir, "record.json"),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  const rows = evaluation.results.map(
    (r) =>
      `${r.result.padEnd(7)} ${r.level.padEnd(9)} ${r.id}  ${JSON.stringify(r.observed)}`,
  );
  console.log(
    `${args.serial}: ${evaluation.verdict} (${evaluation.evidenceLevel})\n${rows.join("\n")}\nRecord: ${path.join(outDir, "record.json")}`,
  );
  return record;
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}
