/**
 * Unit tests for CLI display-name resolution and command rewriting.
 * Drives the real `cli-name` module: the module-load env snapshot, prefix
 * matching, and every replace / leave-untouched branch. Does not mock the
 * system under test.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLI_PREFIX_RE, replaceCliName, resolveCliName } from "./cli-name";

describe("resolveCliName", () => {
  it("returns a stable snapshot across repeated calls", () => {
    const first = resolveCliName();
    const second = resolveCliName();
    expect(first).toBe(second);
    expect(typeof first).toBe("string");
    expect(first.length).toBeGreaterThan(0);
  });

  it("does not observe APP_CLI_NAME mutations after the module has loaded", () => {
    const snapshot = resolveCliName();
    const previous = process.env.APP_CLI_NAME;
    process.env.APP_CLI_NAME = `mutated-${snapshot}-later`;
    try {
      expect(resolveCliName()).toBe(snapshot);
    } finally {
      if (previous === undefined) {
        delete process.env.APP_CLI_NAME;
      } else {
        process.env.APP_CLI_NAME = previous;
      }
    }
  });
});

describe("resolveCliName module-load snapshot", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("uses APP_CLI_NAME captured at import, trimmed", async () => {
    vi.resetModules();
    vi.stubEnv("APP_CLI_NAME", "  custom-bin  ");
    const mod = await import("./cli-name");
    expect(mod.resolveCliName()).toBe("custom-bin");
    vi.stubEnv("APP_CLI_NAME", "ignored-later");
    expect(mod.resolveCliName()).toBe("custom-bin");
  });

  it("defaults to eliza when APP_CLI_NAME is unset", async () => {
    vi.resetModules();
    vi.stubEnv("APP_CLI_NAME", "");
    const mod = await import("./cli-name");
    expect(mod.resolveCliName()).toBe("eliza");
  });

  it("defaults to eliza when APP_CLI_NAME is whitespace-only", async () => {
    vi.resetModules();
    vi.stubEnv("APP_CLI_NAME", "   \t  ");
    const mod = await import("./cli-name");
    expect(mod.resolveCliName()).toBe("eliza");
  });
});

describe("CLI_PREFIX_RE", () => {
  it.each([
    "eliza",
    "eliza start",
    "elizaos",
    "elizaos run",
    "bun eliza start",
    "npm elizaos dev",
    "bunx eliza x",
    "npx elizaos y",
    "bun  eliza start",
  ])("matches %j", (input) => {
    expect(CLI_PREFIX_RE.test(input)).toBe(true);
  });

  it.each([
    "",
    "   ",
    " eliza start",
    "Eliza start",
    "ELIZA start",
    "elizafoo",
    "eliza_os",
    "git commit",
    "echo eliza",
    "pnpm eliza start",
    "yarn elizaos run",
    "node eliza start",
    "buneliza start",
    "other eliza",
  ])("does not match %j", (input) => {
    expect(CLI_PREFIX_RE.test(input)).toBe(false);
  });
});

describe("replaceCliName", () => {
  it("returns empty and whitespace-only commands unchanged", () => {
    expect(replaceCliName("", "mycli")).toBe("");
    expect(replaceCliName("   ", "mycli")).toBe("   ");
    expect(replaceCliName("\n\t", "mycli")).toBe("\n\t");
  });

  it("leaves commands that do not start with a CLI token unchanged", () => {
    expect(replaceCliName("git commit", "mycli")).toBe("git commit");
    expect(replaceCliName("echo eliza", "mycli")).toBe("echo eliza");
    expect(replaceCliName(" eliza start", "mycli")).toBe(" eliza start");
    expect(replaceCliName("Eliza start", "mycli")).toBe("Eliza start");
    expect(replaceCliName("elizafoo", "mycli")).toBe("elizafoo");
    expect(replaceCliName("pnpm eliza start", "mycli")).toBe(
      "pnpm eliza start",
    );
  });

  it("replaces a leading eliza token with the supplied name", () => {
    expect(replaceCliName("eliza", "mycli")).toBe("mycli");
    expect(replaceCliName("eliza start", "mycli")).toBe("mycli start");
    expect(replaceCliName("eliza start --verbose", "mycli")).toBe(
      "mycli start --verbose",
    );
  });

  it("replaces a leading elizaos token, not the eliza prefix of that word", () => {
    expect(replaceCliName("elizaos", "mycli")).toBe("mycli");
    expect(replaceCliName("elizaos run", "mycli")).toBe("mycli run");
  });

  it("rewrites only the leading token when the command repeats the name", () => {
    expect(replaceCliName("eliza start && eliza stop", "mycli")).toBe(
      "mycli start && eliza stop",
    );
  });

  it("treats a hyphen after eliza as a word boundary and rewrites the prefix", () => {
    expect(replaceCliName("eliza-os run", "mycli")).toBe("mycli-os run");
  });

  it.each([
    ["bun eliza start", "bun mycli start"],
    ["npm elizaos dev", "npm mycli dev"],
    ["bunx eliza x", "bunx mycli x"],
    ["npx elizaos y", "npx mycli y"],
    ["bun  eliza start", "bun  mycli start"],
  ] as const)("preserves runner prefix in %j", (input, expected) => {
    expect(replaceCliName(input, "mycli")).toBe(expected);
  });

  it("substitutes an empty display name when one is supplied", () => {
    expect(replaceCliName("eliza start", "")).toBe(" start");
    expect(replaceCliName("bun eliza start", "")).toBe("bun  start");
  });

  it("defaults the replacement name to resolveCliName()", () => {
    const name = resolveCliName();
    expect(replaceCliName("eliza start")).toBe(`${name} start`);
    expect(replaceCliName("elizaos run")).toBe(`${name} run`);
    expect(replaceCliName("bun eliza start")).toBe(`bun ${name} start`);
  });
});
