import { describe, expect, it } from "vitest";
import { expandTildePath, resolveEnvFile, resolvePgliteDir } from "../../utils.browser";

describe("utils.browser", () => {
  it("expandTildePath returns input unchanged in browser", () => {
    expect(expandTildePath("~/data")).toBe("~/data");
    expect(expandTildePath("/absolute/path")).toBe("/absolute/path");
  });

  it("resolveEnvFile returns placeholder value", () => {
    expect(resolveEnvFile()).toBe(".env");
  });

  it("resolvePgliteDir returns stable placeholder", () => {
    expect(resolvePgliteDir()).toBe("in-memory");
    expect(resolvePgliteDir("/any/path")).toBe("in-memory");
  });
});
