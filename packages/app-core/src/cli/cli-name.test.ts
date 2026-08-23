import { describe, expect, it } from "vitest";
import { CLI_PREFIX_RE, replaceCliName, resolveCliName } from "./cli-name.ts";

describe("resolveCliName", () => {
  it("returns the resolved CLI name (default eliza)", () => {
    expect(resolveCliName()).toBe(process.env.APP_CLI_NAME?.trim() || "eliza");
  });
});

describe("replaceCliName", () => {
  it("replaces a leading eliza token", () => {
    expect(replaceCliName("eliza start", "mycli")).toBe("mycli start");
    expect(replaceCliName("elizaos run", "mycli")).toBe("mycli run");
  });

  it("preserves the runner prefix", () => {
    expect(replaceCliName("bun eliza start", "mycli")).toBe("bun mycli start");
    expect(replaceCliName("npx elizaos dev", "mycli")).toBe("npx mycli dev");
  });

  it("leaves unrelated commands untouched", () => {
    expect(replaceCliName("git commit", "mycli")).toBe("git commit");
    expect(replaceCliName("", "mycli")).toBe("");
  });

  it("uses the default name when not passed", () => {
    const out = replaceCliName("eliza start");
    expect(out.startsWith("eliza")).toBe(true);
  });

  it("CLI_PREFIX_RE matches runner + eliza forms", () => {
    expect(CLI_PREFIX_RE.test("eliza start")).toBe(true);
    expect(CLI_PREFIX_RE.test("bunx elizaos x")).toBe(true);
    expect(CLI_PREFIX_RE.test("other eliza")).toBe(false);
  });
});
