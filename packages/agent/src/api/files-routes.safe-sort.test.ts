/**
 * Verifies safe sorting in files routes when createdAt contains NaN/undefined.
 */
import { describe, expect, it } from "vitest";

type FileItem = { name: string; createdAt: number };

function sortFiles(files: FileItem[]): FileItem[] {
  return [...files].sort((a, b) => {
    const aTime = Number.isFinite(a.createdAt) ? a.createdAt : 0;
    const bTime = Number.isFinite(b.createdAt) ? b.createdAt : 0;
    return bTime - aTime;
  });
}

describe("files-routes safe sort", () => {
  it("sorts safely when createdAt contains NaN and undefined", () => {
    const files: FileItem[] = [
      { name: "a", createdAt: NaN },
      { name: "b", createdAt: 1000 },
      { name: "c", createdAt: undefined as unknown as number },
      { name: "d", createdAt: 500 },
    ];
    const sorted = sortFiles(files);
    expect(sorted.map((f) => f.name)).toEqual(["b", "d", "a", "c"]);
  });

  it("handles Infinity by falling back to 0", () => {
    const files: FileItem[] = [
      { name: "inf", createdAt: Infinity },
      { name: "valid", createdAt: 100 },
    ];
    const sorted = sortFiles(files);
    expect(sorted[0].name).toBe("valid");
    expect(sorted[1].name).toBe("inf");
  });

  it("old comparator would return NaN for NaN inputs", () => {
    const a: FileItem = { name: "a", createdAt: NaN };
    const b: FileItem = { name: "b", createdAt: 100 };
    const oldResult = b.createdAt - a.createdAt;
    expect(Number.isNaN(oldResult)).toBe(true);
    const fixed = sortFiles([a, b]);
    expect(fixed[0].name).toBe("b");
  });
});
