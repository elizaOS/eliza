import assert from "node:assert/strict";
import test from "node:test";
import {
  readBootDeviceIdentity,
  requireBootDeviceIdentity as requireBootDeviceTrial,
} from "./ci-webview-boot-device.mjs";

const devices =
  "pci0000:00/0000:00:03.0 pci0000:00/0000:00:05.0 pci0000:00/0000:00:06.0";
const observation = {
  bootconfig: `androidboot.boot_devices = "${devices}"`,
  bootDevices: devices,
  userdataAlias: "/dev/block/vdc",
  userdataSysfs: "/sys/devices/pci0000:00/0000:00:05.0/virtio3/block/vdc",
  systemSysfs: "/sys/devices/pci0000:00/0000:00:03.0/virtio1/block/vda",
  metadataSysfs: "/sys/devices/pci0000:00/0000:00:06.0/virtio4/block/vdd",
};
test("exact observed topology and boot-time alias required, missing/mismatched/duplicate readback refused", () => {
  requireBootDeviceTrial(observation);
  for (const key of Object.keys(observation))
    for (const value of [undefined, { unavailable: true }, "unexpected"])
      assert.throws(
        () => requireBootDeviceTrial({ ...observation, [key]: value }),
        /mismatch/,
      );
  assert.throws(
    () =>
      requireBootDeviceTrial({
        ...observation,
        bootconfig: `${observation.bootconfig}\n${observation.bootconfig}`,
      }),
    /mismatch/,
  );
  for (const malformed of [
    "androidboot.boot_devices = unquoted",
    "androidboot.boot_devices",
    " androidboot.boot_devices =",
  ])
    assert.throws(
      () =>
        requireBootDeviceTrial({
          ...observation,
          bootconfig: `${observation.bootconfig}\n${malformed}`,
        }),
      /mismatch/,
    );
  assert.throws(
    () =>
      requireBootDeviceTrial({
        ...observation,
        userdataAlias: "/dev/block/by-name/vdc",
      }),
    /mismatch/,
  );
  assert.throws(
    () =>
      requireBootDeviceTrial({
        ...observation,
        bootconfig: observation.bootconfig.replace(
          " pci0000:00/0000:00:05.0",
          "",
        ),
      }),
    /mismatch/,
  );
});

test("readback excludes unrelated boot properties and records malformed candidates before refusal", () => {
  const responses = {
    "shell cat /proc/bootconfig": `${observation.bootconfig}\nandroidboot.qemu.adb.pubkey = "unrelated-fixture"`,
    "shell getprop ro.boot.boot_devices": observation.bootDevices,
    "shell readlink -f /dev/block/by-name/vdc": observation.userdataAlias,
    "shell readlink -f /sys/class/block/vdc": observation.userdataSysfs,
    "shell readlink -f /sys/class/block/vda": observation.systemSysfs,
    "shell readlink -f /sys/class/block/vdd": observation.metadataSysfs,
  };
  const captured = [];
  const run = (...args) => responses[args.join(" ")];
  readBootDeviceIdentity(run, (value) => captured.push(value));
  assert.equal(captured[0].bootconfig, observation.bootconfig);
  assert.ok(!JSON.stringify(captured).includes("unrelated-fixture"));
  responses["shell cat /proc/bootconfig"] +=
    "\nandroidboot.boot_devices = malformed";
  assert.throws(
    () => readBootDeviceIdentity(run, (value) => captured.push(value)),
    /mismatch/,
  );
  assert.equal(captured.length, 2);
  assert.ok(
    captured[1].bootconfig.endsWith("androidboot.boot_devices = malformed"),
  );
  assert.ok(!JSON.stringify(captured).includes("unrelated-fixture"));
});

test("oversized retained fields are bounded without truncating validation input", () => {
  const records = [];
  const read = (...args) =>
    args.join(" ") === "shell cat /proc/bootconfig"
      ? `${observation.bootconfig}\nandroidboot.boot_devices = ${"x".repeat(70000)}`
      : "x".repeat(70000);
  assert.throws(
    () => readBootDeviceIdentity(read, (row) => records.push(row)),
    /mismatch/,
  );
  assert.equal(records.length, 1);
  assert.equal(records[0].bootconfig.length, 65536);
  assert.ok(records[0].truncatedFields.includes("bootconfig"));
  for (const [key, value] of Object.entries(records[0]))
    if (key !== "truncatedFields") assert.ok(value.length <= 65536);
});

test("valid identity with oversized whitespace cannot bypass retained admission bounds", () => {
  const responses = {
    "shell cat /proc/bootconfig": observation.bootconfig,
    "shell getprop ro.boot.boot_devices": observation.bootDevices,
    "shell readlink -f /dev/block/by-name/vdc": observation.userdataAlias,
    "shell readlink -f /sys/class/block/vdc": observation.userdataSysfs,
    "shell readlink -f /sys/class/block/vda": observation.systemSysfs,
    "shell readlink -f /sys/class/block/vdd": observation.metadataSysfs,
  };
  const records = [];
  const admitted = readBootDeviceIdentity(
    (...args) => responses[args.join(" ")] + " ".repeat(100000),
    (value) => records.push(value),
  );
  assert.equal(records.length, 1);
  assert.deepEqual(admitted, records[0]);
  assert.deepEqual(
    admitted.truncatedFields.sort(),
    Object.keys(observation).sort(),
  );
  for (const [key, value] of Object.entries(admitted))
    if (key !== "truncatedFields") assert.ok(value.length <= 65536, key);
});
