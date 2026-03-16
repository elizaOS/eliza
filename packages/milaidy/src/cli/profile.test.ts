import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatCliCommand } from "./command-format.js";
import { applyCliProfileEnv, parseCliProfileArgs } from "./profile.js";

describe("parseCliProfileArgs", () => {
  it("leaves plugins --dev for subcommands", () => {
    const res = parseCliProfileArgs([
      "node",
      "milaidy",
      "plugins",
      "--dev",
      "--allow-unconfigured",
    ]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBeNull();
    expect(res.argv).toEqual(["node", "milaidy", "plugins", "--dev", "--allow-unconfigured"]);
  });

  it("still accepts global --dev before subcommand", () => {
    const res = parseCliProfileArgs(["node", "milaidy", "--dev", "plugins"]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBe("dev");
    expect(res.argv).toEqual(["node", "milaidy", "plugins"]);
  });

  it("parses --profile value and strips it", () => {
    const res = parseCliProfileArgs(["node", "milaidy", "--profile", "work", "start"]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBe("work");
    expect(res.argv).toEqual(["node", "milaidy", "start"]);
  });

  it("rejects missing profile value", () => {
    const res = parseCliProfileArgs(["node", "milaidy", "--profile"]);
    expect(res.ok).toBe(false);
  });

  it("rejects combining --dev with --profile (dev first)", () => {
    const res = parseCliProfileArgs(["node", "milaidy", "--dev", "--profile", "work", "start"]);
    expect(res.ok).toBe(false);
  });

  it("rejects combining --dev with --profile (profile first)", () => {
    const res = parseCliProfileArgs(["node", "milaidy", "--profile", "work", "--dev", "start"]);
    expect(res.ok).toBe(false);
  });
});

describe("applyCliProfileEnv", () => {
  it("fills env defaults for dev profile", () => {
    const env: Record<string, string | undefined> = {};
    applyCliProfileEnv({
      profile: "dev",
      env,
      homedir: () => "/home/peter",
    });
    const expectedStateDir = path.join("/home/peter", ".milaidy-dev");
    expect(env.MILAIDY_PROFILE).toBe("dev");
    expect(env.MILAIDY_STATE_DIR).toBe(expectedStateDir);
    expect(env.MILAIDY_CONFIG_PATH).toBe(path.join(expectedStateDir, "milaidy.json"));
    expect(env.MILAIDY_GATEWAY_PORT).toBe("19001");
  });

  it("does not override explicit env values", () => {
    const env: Record<string, string | undefined> = {
      MILAIDY_STATE_DIR: "/custom",
      MILAIDY_GATEWAY_PORT: "19099",
    };
    applyCliProfileEnv({
      profile: "dev",
      env,
      homedir: () => "/home/peter",
    });
    expect(env.MILAIDY_STATE_DIR).toBe("/custom");
    expect(env.MILAIDY_GATEWAY_PORT).toBe("19099");
    expect(env.MILAIDY_CONFIG_PATH).toBe(path.join("/custom", "milaidy.json"));
  });
});

describe("formatCliCommand", () => {
  it("returns command unchanged when no profile is set", () => {
    expect(formatCliCommand("milaidy setup --fix", {})).toBe("milaidy setup --fix");
  });

  it("returns command unchanged when profile is default", () => {
    expect(formatCliCommand("milaidy setup --fix", { MILAIDY_PROFILE: "default" })).toBe(
      "milaidy setup --fix",
    );
  });

  it("returns command unchanged when profile is Default (case-insensitive)", () => {
    expect(formatCliCommand("milaidy setup --fix", { MILAIDY_PROFILE: "Default" })).toBe(
      "milaidy setup --fix",
    );
  });

  it("returns command unchanged when profile is invalid", () => {
    expect(formatCliCommand("milaidy setup --fix", { MILAIDY_PROFILE: "bad profile" })).toBe(
      "milaidy setup --fix",
    );
  });

  it("returns command unchanged when --profile is already present", () => {
    expect(
      formatCliCommand("milaidy --profile work setup --fix", { MILAIDY_PROFILE: "work" }),
    ).toBe("milaidy --profile work setup --fix");
  });

  it("returns command unchanged when --dev is already present", () => {
    expect(formatCliCommand("milaidy --dev setup", { MILAIDY_PROFILE: "dev" })).toBe(
      "milaidy --dev setup",
    );
  });

  it("inserts --profile flag when profile is set", () => {
    expect(formatCliCommand("milaidy setup --fix", { MILAIDY_PROFILE: "work" })).toBe(
      "milaidy --profile work setup --fix",
    );
  });

  it("trims whitespace from profile", () => {
    expect(formatCliCommand("milaidy setup --fix", { MILAIDY_PROFILE: "  jbmilaidy  " })).toBe(
      "milaidy --profile jbmilaidy setup --fix",
    );
  });

  it("handles command with no args after milaidy", () => {
    expect(formatCliCommand("milaidy", { MILAIDY_PROFILE: "test" })).toBe(
      "milaidy --profile test",
    );
  });

  it("handles pnpm wrapper", () => {
    expect(formatCliCommand("pnpm milaidy setup", { MILAIDY_PROFILE: "work" })).toBe(
      "pnpm milaidy --profile work setup",
    );
  });
});
