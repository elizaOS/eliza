import assert from "node:assert/strict";
import { test } from "node:test";
import { assertSafeFlashMetadata } from "../aosp/build-grizzly-bundle.ts";

// Actual generated Android 17 grizzly plan: fastboot flashall adds the final
// reboot itself (system/core/fastboot/fastboot.cpp, flashall/update branches).
const fastbootInfo = `# fastboot-info for eliza_grizzly_phone
version 1
flash boot
flash init_boot
flash dtbo
flash vendor_kernel_boot
flash pvmfw
flash vendor_boot
flash --apply-vbmeta vbmeta
reboot fastboot
update-super
flash system
flash system_dlkm
flash system_ext
flash product
flash vendor
flash vendor_dlkm
flash --slot-other system system_other.img
if-wipe erase userdata
if-wipe erase metadata
`;
const validate = (plan) =>
  assertSafeFlashMetadata({
    androidInfo: "require board=grizzly\n",
    fastbootInfo: plan,
  });

test("accepts the real generated plan with CLI-owned final reboot", () => {
  const parsed = validate(fastbootInfo);
  assert.equal(parsed.terminalRebootAuthority, "fastboot-cli");
  assert.equal(parsed.rebootFastbootIndex, 8);
  assert.equal(parsed.updateSuperIndex, 9);
  assert.ok(parsed.artifacts.includes("super_empty.img"));
  assert.ok(parsed.artifacts.includes("system_other.img"));
});

test("accepts one explicit terminal reboot but rejects early and repeated reboots", () => {
  assert.equal(
    validate(`${fastbootInfo}reboot\n`).terminalRebootAuthority,
    "fastboot-info",
  );
  for (const plan of [
    fastbootInfo.replace("flash boot", "reboot\nflash boot"),
    fastbootInfo.replace(
      "if-wipe erase metadata",
      "reboot\nif-wipe erase metadata",
    ),
    `${fastbootInfo}reboot\nreboot\n`,
  ]) {
    assert.throws(
      () => validate(plan),
      /at most one terminal reboot, at the end/,
    );
  }
});

test("implicit final reboot does not relax dynamic ordering, wipes or complete-image checks", () => {
  for (const plan of [
    fastbootInfo.replace("reboot fastboot\n", ""),
    fastbootInfo.replace("update-super\n", ""),
    fastbootInfo.replace(
      "reboot fastboot\nupdate-super",
      "update-super\nreboot fastboot",
    ),
    fastbootInfo.replace(
      "update-super\nflash system",
      "flash system\nupdate-super",
    ),
    fastbootInfo.replace("if-wipe erase userdata", "erase userdata"),
    fastbootInfo.replace("if-wipe erase metadata", "erase metadata"),
    fastbootInfo.replace("flash boot\n", ""),
    fastbootInfo.replace("flash boot\n", "flash boot\nflash boot\n"),
    fastbootInfo.replace("flash system_dlkm\n", ""),
  ]) {
    assert.throws(() => validate(plan));
  }
});

// No partition, including future firmware/calibration names, is safe to erase
// unconditionally. These are parser-only tests: no transport is involved.
test("rejects every unconditional erase and unknown destructive instruction", () => {
  for (const partition of [
    "persist",
    "bootloader",
    "radio",
    "frp",
    "misc",
    "super",
    "boot_a",
    "avb_custom_key",
    "future_partition",
  ]) {
    assert.throws(
      () => validate(`${fastbootInfo}erase ${partition}\n`),
      /must not erase/,
    );
    assert.throws(
      () => validate(`${fastbootInfo}if-wipe erase ${partition}\n`),
      /invalid if-wipe/,
    );
  }
  for (const command of [
    "flashing lock",
    "oem mte on",
    "flash --force boot",
    "snapshot-update cancel",
  ]) {
    assert.throws(() => validate(`${fastbootInfo}${command}\n`));
  }
});

test("conditional wipes are target-specific, unique and last", () => {
  for (const candidate of [
    `${fastbootInfo}if-wipe erase cache\n`,
    `${fastbootInfo}if-wipe erase metadata\n`,
    fastbootInfo.replace("flash boot", "if-wipe erase userdata\nflash boot"),
  ])
    assert.throws(() => validate(candidate), /conditional erase/);
});
