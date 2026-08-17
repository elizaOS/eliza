/**
 * Malformed percent-escapes in mapped route relative paths must not throw.
 * decodeURIComponent("%") used to escape mappedLocalTarget after new URL
 * succeeded.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/core/client-public", () => ({
  resolveAliasedEnvValue: (value: unknown) => value,
}));

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
