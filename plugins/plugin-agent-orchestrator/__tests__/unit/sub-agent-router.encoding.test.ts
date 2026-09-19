/** Mapped sub-agent route paths reject malformed percent-encoding. */
import { describe, expect, it } from "vitest";

import { decodeMappedRelativePath } from "../../src/services/sub-agent-router.js";

describe("decodeMappedRelativePath", () => {
  it("returns undefined for a lone % instead of throwing", () => {
    expect(decodeMappedRelativePath("%")).toBeUndefined();
  });

  it("returns undefined for %ZZ instead of throwing", () => {
    expect(decodeMappedRelativePath("%ZZ")).toBeUndefined();
  });

  it("returns undefined for truncated UTF-8 instead of throwing", () => {
    expect(decodeMappedRelativePath("%E0%A4%A")).toBeUndefined();
  });

  it("still decodes a canonical relative path", () => {
    expect(decodeMappedRelativePath("docs%2Freadme.md")).toBe("docs/readme.md");
  });
});
