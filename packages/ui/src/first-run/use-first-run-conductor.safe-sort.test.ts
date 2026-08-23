/**
 * Safe NaN handling for newestLocalBackup sort.
 */
import { describe, expect, it } from "vitest";

function newestLocalBackup(backups: { createdAt: string; fileName: string }[]) {
  return (
    [...backups].sort((a, b) => {
      const aTime = Date.parse(a.createdAt);
      const bTime = Date.parse(b.createdAt);
      const aSafe = Number.isFinite(aTime) ? aTime : 0;
      const bSafe = Number.isFinite(bTime) ? bTime : 0;
      return bSafe - aSafe || b.fileName.localeCompare(a.fileName);
    })[0] ?? null
  );
}

describe("newestLocalBackup safe sort", () => {
  it("picks newest valid date", () => {
    const out = newestLocalBackup([
      { createdAt: "invalid", fileName: "b" },
      { createdAt: "2026-01-02T00:00:00.000Z", fileName: "a" },
      { createdAt: "2026-01-01T00:00:00.000Z", fileName: "c" },
    ]);
    expect(out?.createdAt).toBe("2026-01-02T00:00:00.000Z");
  });
  it("invalid dates tie-break by fileName", () => {
    const out = newestLocalBackup([
      { createdAt: "bad", fileName: "a" },
      { createdAt: "bad", fileName: "b" },
    ]);
    expect(out?.fileName).toBe("b");
  });
  it("never NaN comparator", () => {
    const a = Date.parse("bad");
    const diff =
      (Number.isFinite(a) ? a : 0) -
      (Number.isFinite(Date.parse("2026-01-01T00:00:00.000Z"))
        ? Date.parse("2026-01-01T00:00:00.000Z")
        : 0);
    expect(Number.isFinite(diff)).toBe(true);
  });
});
