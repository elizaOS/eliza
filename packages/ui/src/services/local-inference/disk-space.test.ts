import { describe, expect, it } from "vitest";
import { adviseDiskSpace, type DiskSpace } from "./disk-space";

const GIB = 1024 ** 3;

function probe(freeBytes: number): DiskSpace {
  return {
    path: "/models",
    totalBytes: 64 * GIB,
    freeBytes,
    availableBytes: freeBytes,
  };
}

describe("local inference disk space advice", () => {
  it("marks disk space critical when the download plus safety margin will not fit", () => {
    const advice = adviseDiskSpace(probe(11 * GIB), 10 * GIB);

    expect(advice.warning).toBe("critical-disk");
    expect(advice.requiredBytes).toBe(12 * GIB);
    expect(advice.recommendedFreeBytes).toBe(15 * GIB);
  });

  it("marks disk space low when it fits but has little post-download headroom", () => {
    const advice = adviseDiskSpace(probe(13 * GIB), 10 * GIB);

    expect(advice.warning).toBe("low-disk");
    expect(advice.requiredBytes).toBe(12 * GIB);
    expect(advice.recommendedFreeBytes).toBe(15 * GIB);
  });

  it("does not warn when the recommended free space is available", () => {
    const advice = adviseDiskSpace(probe(15 * GIB), 10 * GIB);

    expect(advice.warning).toBeUndefined();
    expect(advice.requiredBytes).toBe(12 * GIB);
    expect(advice.recommendedFreeBytes).toBe(15 * GIB);
  });
});
