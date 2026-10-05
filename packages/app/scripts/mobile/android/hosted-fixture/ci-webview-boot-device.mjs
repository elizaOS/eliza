import { HostedFixtureError } from "./errors.mjs";
// Exact API35 x86_64 topology qualified by hosted trial37097983752.
// This CI-only identity is not a portable Android device rule.
export function requireBootDeviceIdentity(observations) {
  const devices =
    "pci0000:00/0000:00:03.0 pci0000:00/0000:00:05.0 pci0000:00/0000:00:06.0";
  const bootconfig =
    typeof observations.bootconfig === "string" ? observations.bootconfig : "";
  const keyRows = bootconfig
    .split("\n")
    .filter((line) => /^\s*androidboot\.boot_devices\b/.test(line));
  const values = [
    ...bootconfig.matchAll(
      /^androidboot\.boot_devices\s*=\s*"([^"\n]*)"\s*$/gm,
    ),
  ].map((match) => match[1]);
  if (
    keyRows.length !== 1 ||
    values.length !== 1 ||
    values[0] !== devices ||
    observations.bootDevices?.trim?.() !== devices ||
    observations.userdataAlias?.trim?.() !== "/dev/block/vdc" ||
    observations.userdataSysfs?.trim?.() !==
      "/sys/devices/pci0000:00/0000:00:05.0/virtio3/block/vdc" ||
    observations.systemSysfs?.trim?.() !==
      "/sys/devices/pci0000:00/0000:00:03.0/virtio1/block/vda" ||
    observations.metadataSysfs?.trim?.() !==
      "/sys/devices/pci0000:00/0000:00:06.0/virtio4/block/vdd"
  ) {
    throw new HostedFixtureError(
      "Boot-device readback or preexisting userdata alias mismatch",
    );
  }
}

export function readBootDeviceIdentity(run, record = () => {}) {
  const observations = {};
  for (const [key, args] of [
    ["bootconfig", ["shell", "cat", "/proc/bootconfig"]],
    ["bootDevices", ["shell", "getprop", "ro.boot.boot_devices"]],
    ["userdataAlias", ["shell", "readlink", "-f", "/dev/block/by-name/vdc"]],
    ["userdataSysfs", ["shell", "readlink", "-f", "/sys/class/block/vdc"]],
    ["systemSysfs", ["shell", "readlink", "-f", "/sys/class/block/vda"]],
    ["metadataSysfs", ["shell", "readlink", "-f", "/sys/class/block/vdd"]],
  ])
    observations[key] = run(...args);
  observations.bootconfig = observations.bootconfig
    .split("\n")
    .filter((line) => /^\s*androidboot\.boot_devices\b/.test(line))
    .join("\n");
  const truncatedFields = Object.keys(observations).filter(
    (key) => observations[key].length > 65536,
  );
  const readback = {
    ...Object.fromEntries(
      Object.entries(observations).map(([key, value]) => [
        key,
        value.slice(0, 65536),
      ]),
    ),
    truncatedFields,
  };
  record(readback);
  requireBootDeviceIdentity(observations);
  return readback;
}
