import { expect, it } from "vitest";
import type { RemovableDrive, WritePlan } from "../types";
import { assertWriteTargetUnchanged } from "../write-safety";

const drive: RemovableDrive = {
  id: "4",
  devicePath: "disk4",
  name: "USB",
  platform: "darwin",
  bus: "usb",
  sizeBytes: 4096,
  safety: "safe-removable",
  stableId: "device-serial",
};
const plan = { drive, request: { driveId: "4" } } as WritePlan;
it("requires exactly the selected device to remain safe before mutation", () => {
  expect(() => assertWriteTargetUnchanged(plan, [{ ...drive }])).not.toThrow();
  const unidentified = { ...drive };
  delete unidentified.stableId;
  for (const inventory of [
    [],
    [drive, drive],
    [{ ...drive, safety: "blocked-system" as const }],
    [{ ...drive, platform: "win32" as const }],
    [{ ...drive, bus: "unknown" as const }],
    [{ ...drive, devicePath: "disk5" }],
    [{ ...drive, sizeBytes: 8192 }],
    [{ ...drive, stableId: "replacement" }],
    [unidentified],
  ]) {
    expect(() => assertWriteTargetUnchanged(plan, inventory)).toThrow();
  }
});
it("compares against the reviewed plan even when request expectations are absent", () => {
  const stale = { ...drive, stableId: "new-device" };
  expect(() => assertWriteTargetUnchanged(plan, [stale])).toThrow(
    /hardware identity/,
  );
});
