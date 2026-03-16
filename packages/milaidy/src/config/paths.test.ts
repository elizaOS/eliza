import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveDefaultConfigCandidates,
  resolveConfigPath,
  resolveOAuthDir,
  resolveOAuthPath,
  resolveStateDir,
  resolveUserPath,
} from "./paths.js";

describe("oauth paths", () => {
  it("prefers MILAIDY_OAUTH_DIR over MILAIDY_STATE_DIR", () => {
    const env = {
      MILAIDY_OAUTH_DIR: "/custom/oauth",
      MILAIDY_STATE_DIR: "/custom/state",
    } as NodeJS.ProcessEnv;

    expect(resolveOAuthDir(env, "/custom/state")).toBe(path.resolve("/custom/oauth"));
    expect(resolveOAuthPath(env, "/custom/state")).toBe(
      path.join(path.resolve("/custom/oauth"), "oauth.json"),
    );
  });

  it("derives oauth path from MILAIDY_STATE_DIR when unset", () => {
    const env = {
      MILAIDY_STATE_DIR: "/custom/state",
    } as NodeJS.ProcessEnv;

    expect(resolveOAuthDir(env, "/custom/state")).toBe(path.join("/custom/state", "credentials"));
    expect(resolveOAuthPath(env, "/custom/state")).toBe(
      path.join("/custom/state", "credentials", "oauth.json"),
    );
  });
});

describe("state + config path candidates", () => {
  it("uses MILAIDY_STATE_DIR when set", () => {
    const env = {
      MILAIDY_STATE_DIR: "/new/state",
    } as NodeJS.ProcessEnv;

    expect(resolveStateDir(env, () => "/home/test")).toBe(path.resolve("/new/state"));
  });

  it("returns only milaidy.json in .milaidy directory", () => {
    const home = "/home/test";
    const candidates = resolveDefaultConfigCandidates({} as NodeJS.ProcessEnv, () => home);
    const expected = [path.join(home, ".milaidy", "milaidy.json")];
    expect(candidates).toEqual(expected);
  });

  it("defaults to ~/.milaidy when no env override", () => {
    const home = "/home/test";
    const resolved = resolveStateDir({} as NodeJS.ProcessEnv, () => home);
    expect(resolved).toBe(path.join(home, ".milaidy"));
  });

  it("config path defaults to milaidy.json in state dir", () => {
    const home = "/home/test";
    const state = resolveStateDir({} as NodeJS.ProcessEnv, () => home);
    const resolved = resolveConfigPath({} as NodeJS.ProcessEnv, state);
    expect(resolved).toBe(path.join(home, ".milaidy", "milaidy.json"));
  });

  it("respects state dir overrides", () => {
    const overrideDir = "/custom/override";
    const env = { MILAIDY_STATE_DIR: overrideDir } as NodeJS.ProcessEnv;
    const resolved = resolveConfigPath(env, overrideDir);
    expect(resolved).toBe(path.join(overrideDir, "milaidy.json"));
  });
});

describe("resolveUserPath", () => {
  it("expands ~ to home dir", () => {
    expect(resolveUserPath("~")).toBe(path.resolve(os.homedir()));
  });

  it("expands ~/ to home dir", () => {
    expect(resolveUserPath("~/milaidy")).toBe(path.resolve(os.homedir(), "milaidy"));
  });

  it("expands ~\\ (Windows separator) to home dir", () => {
    const result = resolveUserPath("~\\milaidy");
    expect(result).toContain("milaidy");
    expect(result.startsWith("~")).toBe(false);
  });

  it("resolves relative paths", () => {
    expect(resolveUserPath("tmp/dir")).toBe(path.resolve("tmp/dir"));
  });

  it("returns empty string for empty input", () => {
    expect(resolveUserPath("")).toBe("");
  });

  it("returns empty string for whitespace-only input", () => {
    expect(resolveUserPath("   ")).toBe("");
  });

  it("resolves absolute paths as-is", () => {
    expect(resolveUserPath("/usr/local/bin")).toBe(path.resolve("/usr/local/bin"));
  });

  it("does NOT expand ~user (only bare ~ or ~/)", () => {
    const result = resolveUserPath("~otheruser/foo");
    expect(result).toBe(path.resolve("~otheruser/foo"));
  });

  it("trims leading/trailing whitespace", () => {
    expect(resolveUserPath("  ~/foo  ")).toBe(path.resolve(os.homedir(), "foo"));
  });
});

describe("resolveConfigPath", () => {
  it("respects MILAIDY_CONFIG_PATH env override", () => {
    const env = { MILAIDY_CONFIG_PATH: "/custom/config.json" } as NodeJS.ProcessEnv;
    const result = resolveConfigPath(env);
    expect(result).toBe(path.resolve("/custom/config.json"));
  });

  it("ignores whitespace-only MILAIDY_CONFIG_PATH", () => {
    const env = { MILAIDY_CONFIG_PATH: "   " } as NodeJS.ProcessEnv;
    const home = "/home/test";
    const state = resolveStateDir(env, () => home);
    const result = resolveConfigPath(env, state);
    expect(result).toBe(path.join(home, ".milaidy", "milaidy.json"));
  });
});

describe("resolveDefaultConfigCandidates", () => {
  it("returns explicit path when MILAIDY_CONFIG_PATH is set", () => {
    const env = { MILAIDY_CONFIG_PATH: "/my/config.json" } as NodeJS.ProcessEnv;
    const candidates = resolveDefaultConfigCandidates(env, () => "/home/test");
    expect(candidates).toEqual([path.resolve("/my/config.json")]);
  });

  it("uses MILAIDY_STATE_DIR when MILAIDY_CONFIG_PATH is not set", () => {
    const env = { MILAIDY_STATE_DIR: "/custom/state" } as NodeJS.ProcessEnv;
    const candidates = resolveDefaultConfigCandidates(env, () => "/home/test");
    expect(candidates).toEqual([path.join(path.resolve("/custom/state"), "milaidy.json")]);
  });

  it("ignores whitespace-only env overrides", () => {
    const env = { MILAIDY_CONFIG_PATH: "  ", MILAIDY_STATE_DIR: "  " } as NodeJS.ProcessEnv;
    const home = "/home/test";
    const candidates = resolveDefaultConfigCandidates(env, () => home);
    expect(candidates).toEqual([path.join(home, ".milaidy", "milaidy.json")]);
  });
});
