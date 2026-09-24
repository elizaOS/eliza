import { describe, expect, it } from "vitest";
import {
  assertLinuxRestoreHelperPlan,
  canonicalLinuxRestorePlan,
  encodeLinuxRestoreHelperRequest,
  LINUX_RESTORE_HELPER_REQUEST_MAX_BYTES,
  type LinuxRestoreHelperPlan,
  parseLinuxRestoreHelperResponse,
} from "../linux-restore-helper-protocol";

const plan: LinuxRestoreHelperPlan = {
  planId: "0123456789abcdef0123456789abcdef",
  bootId: "01234567-89ab-cdef-0123-456789abcdef",
  devicePath: "/dev/sdz",
  expectedMajor: "8",
  expectedMinor: "240",
  expectedDiskseq: "42",
  expectedSizeBytes: "68719476736",
  partitionNumber: "1",
  filesystem: "exfat",
  label: "ELIZAOS-USB",
  acknowledgement: "ERASE",
};

describe("Linux Restore helper protocol", () => {
  it("encodes one canonical, bounded, digest-bound request", () => {
    const encoded = encodeLinuxRestoreHelperRequest(plan);
    const text = Buffer.from(encoded).toString("ascii");

    expect(encoded.byteLength).toBeLessThanOrEqual(
      LINUX_RESTORE_HELPER_REQUEST_MAX_BYTES,
    );
    expect(text).toMatch(
      /^ELIZAOS_USB_RESTORE_REQUEST_V1\noperation=restore\nplan_id=[a-f0-9]{32}\nplan_binding=[a-f0-9]{64}\n/,
    );
    expect(text).toContain("device_path=/dev/sdz\n");
    expect(text).toContain(`boot_id=${plan.bootId}\n`);
    expect(text.endsWith("acknowledgement=ERASE\nEND\n")).toBe(true);
    expect(canonicalLinuxRestorePlan(plan)).not.toContain("plan_binding=");
  });

  it("matches the native device-path field boundary exactly", () => {
    const accepted = { ...plan, devicePath: `/dev/${"a".repeat(122)}` };
    const rejected = { ...plan, devicePath: `/dev/${"a".repeat(123)}` };

    expect(accepted.devicePath.length).toBe(127);
    expect(() => assertLinuxRestoreHelperPlan(accepted)).not.toThrow();
    expect(rejected.devicePath.length).toBe(128);
    expect(() => assertLinuxRestoreHelperPlan(rejected)).toThrow();
  });

  it.each([
    null,
    [],
    { ...plan, unexpected: "field" },
    { ...plan, bootId: "01234567-89AB-cdef-0123-456789abcdef" },
    { ...plan, bootId: "0123456789abcdef0123456789abcdef" },
    { ...plan, expectedDiskseq: 42 },
    { ...plan, devicePath: "/dev/disk/by-id/usb-target" },
    { ...plan, devicePath: "/dev/../dev/sdz" },
    { ...plan, devicePath: "/dev/.hidden" },
    { ...plan, expectedMajor: "4294967296" },
    { ...plan, expectedMinor: "01" },
    { ...plan, expectedDiskseq: "0" },
    { ...plan, label: "MY-DISK" },
  ])("rejects non-canonical or expanded plans", (candidate) => {
    expect(() => assertLinuxRestoreHelperPlan(candidate)).toThrow();
  });

  it("rejects malformed, oversized, non-ASCII, and success-shaped garbage responses", () => {
    const invalid = [
      new Uint8Array(),
      Buffer.alloc(1025, 0x41),
      Buffer.from("ok\n"),
      Buffer.from(
        "ELIZAOS_USB_RESTORE_RESULT_V1\nstatus=ok\ncode=RESTORED\nmessage=done\nEND\nextra",
      ),
      Buffer.from([
        ...Buffer.from(
          "ELIZAOS_USB_RESTORE_RESULT_V1\nstatus=ok\ncode=RESTORED\nmessage=",
        ),
        0xff,
        ...Buffer.from("\nEND\n"),
      ]),
    ];
    for (const response of invalid) {
      expect(() => parseLinuxRestoreHelperResponse(response)).toThrow();
    }
  });

  it("parses only exact bounded response framing", () => {
    expect(
      parseLinuxRestoreHelperResponse(
        Buffer.from(
          "ELIZAOS_USB_RESTORE_RESULT_V1\nstatus=blocked\ncode=NATIVE_FD_QUALIFICATION_REQUIRED\nmessage=Restore is unavailable.\nEND\n",
        ),
      ),
    ).toEqual({
      status: "blocked",
      code: "NATIVE_FD_QUALIFICATION_REQUIRED",
      message: "Restore is unavailable.",
    });
  });
});
