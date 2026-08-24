import { describe, expect, it } from "vitest";
import { decodePathComponent } from "./route-utils";

describe("decodePathComponent", () => {
  it("passes through plain segments unchanged", () => {
    expect(decodePathComponent("abc")).toBe("abc");
    expect(decodePathComponent("")).toBe("");
  });

  it("decodes percent-encoded characters", () => {
    expect(decodePathComponent("a%20b")).toBe("a b");
    expect(decodePathComponent("%2Fetc%2Fpasswd")).toBe("/etc/passwd");
  });

  it("decodes UTF-8 multibyte sequences", () => {
    expect(decodePathComponent("%E4%B8%AD%E6%96%87")).toBe("中文");
  });

  it("returns null for malformed percent-encoding", () => {
    expect(decodePathComponent("%zz")).toBeNull();
    expect(decodePathComponent("a%")).toBeNull();
    expect(decodePathComponent("%E4%B8%AD%")).toBeNull();
  });

  it("returns null for a lone surrogate escape", () => {
    expect(decodePathComponent("%ED%A0%80")).toBeNull();
  });
});
