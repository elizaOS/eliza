import { expect, it } from "vitest";
import {
  containsProtectedApplePartition,
  parseDiskutilPlist,
  validateDiskutilInfo,
  validateDiskutilList,
} from "../macos-inventory";

const external = {
  DeviceIdentifier: "disk4",
  Size: 4096,
  Content: "GUID_partition_scheme",
  Partitions: [
    {
      DeviceIdentifier: "disk4s1",
      Size: 3072,
      Content: "Microsoft Basic Data",
    },
  ],
};
it("checks protected Apple filesystems inside partition tables", () => {
  expect(containsProtectedApplePartition(external)).toBe(false);
  for (const Content of ["Apple_APFS", "Apple_HFS", "Apple_CoreStorage"]) {
    const value = {
      AllDisksAndPartitions: [
        { ...external, Partitions: [{ ...external.Partitions[0], Content }] },
      ],
    };
    const inventory = validateDiskutilList(value);
    const disk = inventory.AllDisksAndPartitions[0];
    if (!disk) throw new Error("Missing fixture disk.");
    expect(containsProtectedApplePartition(disk)).toBe(true);
  }
});

it("rejects missing, malformed, duplicate, and non-whole disk inventory", () => {
  for (const value of [
    null,
    {},
    { AllDisksAndPartitions: {} },
    { AllDisksAndPartitions: [{ ...external, DeviceIdentifier: "disk4s1" }] },
    { AllDisksAndPartitions: [{ ...external, Size: "4096" }] },
    {
      AllDisksAndPartitions: [
        { ...external, Size: Number.MAX_SAFE_INTEGER + 1 },
      ],
    },
    { AllDisksAndPartitions: [{ ...external, Partitions: false }] },
    { AllDisksAndPartitions: [external, external] },
  ])
    expect(() => validateDiskutilList(value)).toThrow();
  expect(
    validateDiskutilList({ AllDisksAndPartitions: [] }).AllDisksAndPartitions,
  ).toEqual([]);
});

it("requires an explicit typed internal-media classification and matching identity", () => {
  const value = {
    DeviceIdentifier: "disk4",
    Internal: false,
    BusProtocol: "USB",
    TotalSize: 4096,
  };
  expect(validateDiskutilInfo(value, "disk4")).toEqual(value);
  for (const input of [
    { ...value, DeviceIdentifier: "disk5" },
    { ...value, Internal: undefined },
    { ...value, Internal: "false" },
    { ...value, Ejectable: "true" },
    { ...value, TotalSize: NaN },
    { ...value, BusProtocol: [] },
  ])
    expect(() => validateDiskutilInfo(input, "disk4")).toThrow();
});

it("preserves converter failures and rejects invalid JSON instead of empty inventory", async () => {
  const failure = new Error("plutil failed");
  await expect(
    parseDiskutilPlist("fixture", async () => {
      throw failure;
    }),
  ).rejects.toMatchObject({ name: "PlistParseError", cause: failure });
  await expect(
    parseDiskutilPlist("fixture", async () => "malformed"),
  ).rejects.toMatchObject({
    name: "PlistParseError",
    cause: expect.any(SyntaxError),
  });
  await expect(
    parseDiskutilPlist("fixture", async () =>
      JSON.stringify({ MediaName: "A & B <USB>" }),
    ),
  ).resolves.toEqual({ MediaName: "A & B <USB>" });
});

it.skipIf(process.platform !== "darwin")(
  "converts real macOS plist XML with entities through plutil",
  async () => {
    await expect(
      parseDiskutilPlist(
        '<?xml version="1.0"?><plist version="1.0"><dict><key>MediaName</key><string>A &amp; B &lt;USB&gt;</string><key>Internal</key><false/></dict></plist>',
      ),
    ).resolves.toEqual({ MediaName: "A & B <USB>", Internal: false });
  },
);
