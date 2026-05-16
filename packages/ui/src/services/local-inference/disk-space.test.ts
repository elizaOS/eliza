import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  adviseDiskSpace,
  DISK_SPACE_DEFAULT_SAFETY_MARGIN_BYTES,
  probeDiskSpace,
} from "./disk-space";

const GIB = 1024 * 1024 * 1024;

describe("local-inference/disk-space", () => {
  it("probeDiskSpace returns plausible values on the test runner", async () => {
    const probe = await probeDiskSpace(tmpdir());
    expect(probe.freeBytes).toBeGreaterThan(0);
    expect(probe.totalBytes).toBeGreaterThanOrEqual(probe.freeBytes);
    expect(probe.pathProbed).toBe(tmpdir());
  });

  it("adviseDiskSpace marks an exact fit (free == model + margin) as fits with no warning", () => {
    const modelSize = 4 * GIB;
    const probe = {
      freeBytes: modelSize + DISK_SPACE_DEFAULT_SAFETY_MARGIN_BYTES,
      totalBytes: 100 * GIB,
      pathProbed: "/tmp",
    };
    const advice = adviseDiskSpace(probe, modelSize);
    expect(advice.fits).toBe(true);
    expect(advice.warning).toBeUndefined();
    expect(advice.freeAfterDownloadBytes).toBe(
      DISK_SPACE_DEFAULT_SAFETY_MARGIN_BYTES,
    );
  });

  it("adviseDiskSpace flags critical-disk when free < model size (one byte under)", () => {
    const modelSize = 4 * GIB;
    const probe = {
      freeBytes: modelSize - 1,
      totalBytes: 100 * GIB,
      pathProbed: "/tmp",
    };
    const advice = adviseDiskSpace(probe, modelSize);
    expect(advice.fits).toBe(false);
    expect(advice.warning).toBe("critical-disk");
    expect(advice.freeAfterDownloadBytes).toBe(-1);
  });

  it("adviseDiskSpace flags low-disk when free is between model size and model + margin", () => {
    const modelSize = 4 * GIB;
    const probe = {
      freeBytes: modelSize + 1,
      totalBytes: 100 * GIB,
      pathProbed: "/tmp",
    };
    const advice = adviseDiskSpace(probe, modelSize);
    expect(advice.fits).toBe(false);
    expect(advice.warning).toBe("low-disk");
    expect(advice.freeAfterDownloadBytes).toBe(1);
  });

  it("adviseDiskSpace respects a custom safety margin", () => {
    const modelSize = 1 * GIB;
    const customMargin = 512 * 1024 * 1024;
    const probe = {
      freeBytes: modelSize + customMargin,
      totalBytes: 100 * GIB,
      pathProbed: "/tmp",
    };
    const advice = adviseDiskSpace(probe, modelSize, customMargin);
    expect(advice.fits).toBe(true);
    expect(advice.warning).toBeUndefined();
  });

  it("adviseDiskSpace boundary: exactly one byte below safety margin yields low-disk", () => {
    const modelSize = 2 * GIB;
    const probe = {
      freeBytes: modelSize + DISK_SPACE_DEFAULT_SAFETY_MARGIN_BYTES - 1,
      totalBytes: 100 * GIB,
      pathProbed: "/tmp",
    };
    const advice = adviseDiskSpace(probe, modelSize);
    expect(advice.fits).toBe(false);
    expect(advice.warning).toBe("low-disk");
  });
});
