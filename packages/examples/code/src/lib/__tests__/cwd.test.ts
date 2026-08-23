import { describe, expect, it } from "vitest";
import { getCwd, setCwd } from "./cwd.ts";

describe("cwd helpers", () => {
  it("returns the current working directory", () => {
    expect(getCwd()).toBe(process.cwd());
  });

  it("setCwd resolves relative to the current cwd", async () => {
    const result = await setCwd(".");
    expect(result.success).toBe(true);
    expect(result.path).toBe(process.cwd());
  });

  it("setCwd fails cleanly for invalid paths", async () => {
    const result = await setCwd("/definitely/not/a/real/dir-xyz");
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
