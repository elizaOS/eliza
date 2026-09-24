/**
 * Direct unit coverage for CLI `--profile` / `--dev` argv extraction and
 * env default wiring. Drives `parseCliProfileArgs` and `applyCliProfileEnv`
 * without mocking the module under test.
 */
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyCliProfileEnv, parseCliProfileArgs } from "./profile";

const cli = (...args: string[]): string[] => ["node", "eliza", ...args];

describe("parseCliProfileArgs", () => {
  it("returns the original argv unchanged when it is shorter than node+script", () => {
    expect(parseCliProfileArgs([])).toEqual({
      ok: true,
      profile: null,
      argv: [],
    });
    expect(parseCliProfileArgs(["node"])).toEqual({
      ok: true,
      profile: null,
      argv: ["node"],
    });
  });

  it("leaves a node+script argv with no extra flags as a null profile", () => {
    expect(parseCliProfileArgs(cli())).toEqual({
      ok: true,
      profile: null,
      argv: ["node", "eliza"],
    });
  });

  it("strips --dev and sets the reserved dev profile", () => {
    expect(parseCliProfileArgs(cli("--dev", "start", "--verbose"))).toEqual({
      ok: true,
      profile: "dev",
      argv: ["node", "eliza", "start", "--verbose"],
    });
  });

  it("accepts a repeated --dev flag as still the dev profile", () => {
    expect(parseCliProfileArgs(cli("--dev", "--dev", "start"))).toEqual({
      ok: true,
      profile: "dev",
      argv: ["node", "eliza", "start"],
    });
  });

  it("strips --profile <name> and --profile=<name>, including trimmed equals values", () => {
    expect(parseCliProfileArgs(cli("--profile", "alice", "start"))).toEqual({
      ok: true,
      profile: "alice",
      argv: ["node", "eliza", "start"],
    });
    expect(parseCliProfileArgs(cli("--profile=bob", "--verbose"))).toEqual({
      ok: true,
      profile: "bob",
      argv: ["node", "eliza", "--verbose"],
    });
    expect(parseCliProfileArgs(cli("--profile=  carol  ", "start"))).toEqual({
      ok: true,
      profile: "carol",
      argv: ["node", "eliza", "start"],
    });
  });

  it("lets a later --profile overwrite an earlier one", () => {
    expect(
      parseCliProfileArgs(cli("--profile", "alice", "--profile=bob", "start")),
    ).toEqual({
      ok: true,
      profile: "bob",
      argv: ["node", "eliza", "start"],
    });
  });

  it("preserves non-profile flags that appear before the command word", () => {
    expect(
      parseCliProfileArgs(
        cli("--verbose", "--profile", "alice", "start", "-x"),
      ),
    ).toEqual({
      ok: true,
      profile: "alice",
      argv: ["node", "eliza", "--verbose", "start", "-x"],
    });
  });

  it("stops parsing profile flags once a non-flag command word is seen", () => {
    expect(
      parseCliProfileArgs(cli("start", "--dev", "--profile", "alice")),
    ).toEqual({
      ok: true,
      profile: null,
      argv: ["node", "eliza", "start", "--dev", "--profile", "alice"],
    });
  });

  it("does not treat -- as a command word, so later --profile still applies", () => {
    expect(
      parseCliProfileArgs(cli("--", "--profile", "alice", "start")),
    ).toEqual({
      ok: true,
      profile: "alice",
      argv: ["node", "eliza", "--", "start"],
    });
  });

  it("skips holes in the args array before the command word", () => {
    const argv: string[] = ["node", "eliza"];
    argv[3] = "--dev";
    argv[4] = "start";
    expect(parseCliProfileArgs(argv)).toEqual({
      ok: true,
      profile: "dev",
      argv: ["node", "eliza", "start"],
    });
  });

  it("rejects --profile without a usable value", () => {
    expect(parseCliProfileArgs(cli("--profile"))).toEqual({
      ok: false,
      error: "--profile requires a value",
    });
    expect(parseCliProfileArgs(cli("--profile="))).toEqual({
      ok: false,
      error: "--profile requires a value",
    });
    expect(parseCliProfileArgs(cli("--profile=   "))).toEqual({
      ok: false,
      error: "--profile requires a value",
    });
    expect(parseCliProfileArgs(cli("--profile", ""))).toEqual({
      ok: false,
      error: "--profile requires a value",
    });
  });

  it("rejects names that fail the path-safe profile charset or length cap", () => {
    const invalid = 'Invalid --profile (use letters, numbers, "_", "-" only)';
    expect(parseCliProfileArgs(cli("--profile", "has space"))).toEqual({
      ok: false,
      error: invalid,
    });
    expect(parseCliProfileArgs(cli("--profile", "a/b"))).toEqual({
      ok: false,
      error: invalid,
    });
    expect(parseCliProfileArgs(cli("--profile", "-leading"))).toEqual({
      ok: false,
      error: invalid,
    });
    expect(parseCliProfileArgs(cli("--profile", "foo=bar"))).toEqual({
      ok: false,
      error: invalid,
    });
    expect(parseCliProfileArgs(cli("--profile", "a".repeat(65)))).toEqual({
      ok: false,
      error: invalid,
    });
    expect(parseCliProfileArgs(cli("--profile", "a".repeat(64)))).toEqual({
      ok: true,
      profile: "a".repeat(64),
      argv: ["node", "eliza"],
    });
  });

  it("treats a following flag as the --profile value when no equals form is used", () => {
    expect(parseCliProfileArgs(cli("--profile", "--dev"))).toEqual({
      ok: false,
      error: 'Invalid --profile (use letters, numbers, "_", "-" only)',
    });
  });

  it("rejects combining --dev with a non-dev --profile, regardless of order", () => {
    expect(parseCliProfileArgs(cli("--dev", "--profile", "alice"))).toEqual({
      ok: false,
      error: "Cannot combine --dev with --profile",
    });
    expect(parseCliProfileArgs(cli("--profile=alice", "--dev"))).toEqual({
      ok: false,
      error: "Cannot combine --dev with --profile",
    });
    expect(parseCliProfileArgs(cli("--dev", "--profile=dev"))).toEqual({
      ok: false,
      error: "Cannot combine --dev with --profile",
    });
  });

  it("allows --dev after --profile dev because the names already match", () => {
    expect(
      parseCliProfileArgs(cli("--profile", "dev", "--dev", "start")),
    ).toEqual({
      ok: true,
      profile: "dev",
      argv: ["node", "eliza", "start"],
    });
  });
});

describe("applyCliProfileEnv", () => {
  const homedir = (): string => "/home/eliza-profile-test";

  it("is a no-op when the profile is empty after trim", () => {
    const env: Record<string, string | undefined> = {
      ELIZA_PROFILE: "keep-me",
    };
    applyCliProfileEnv({ profile: "   ", env, homedir });
    applyCliProfileEnv({ profile: "", env, homedir });
    expect(env).toEqual({ ELIZA_PROFILE: "keep-me" });
  });

  it("always writes ELIZA_PROFILE and fills namespace, state dir, and config path", () => {
    const env: Record<string, string | undefined> = {
      ELIZA_PROFILE: "already-set",
    };
    applyCliProfileEnv({ profile: "  alice  ", env, homedir });
    expect(env.ELIZA_PROFILE).toBe("alice");
    expect(env.ELIZA_NAMESPACE).toBe("eliza");
    expect(env.ELIZA_STATE_DIR).toBe(
      path.join("/home/eliza-profile-test", ".eliza-alice"),
    );
    expect(env.ELIZA_CONFIG_PATH).toBe(
      path.join("/home/eliza-profile-test", ".eliza-alice", "eliza.json"),
    );
    expect(env.ELIZA_GATEWAY_PORT).toBeUndefined();
  });

  it("omits the state-dir suffix for default regardless of letter case", () => {
    const lower: Record<string, string | undefined> = {};
    applyCliProfileEnv({ profile: "default", env: lower, homedir });
    expect(lower.ELIZA_STATE_DIR).toBe(
      path.join("/home/eliza-profile-test", ".eliza"),
    );
    expect(lower.ELIZA_CONFIG_PATH).toBe(
      path.join("/home/eliza-profile-test", ".eliza", "eliza.json"),
    );

    const mixed: Record<string, string | undefined> = {};
    applyCliProfileEnv({ profile: "Default", env: mixed, homedir });
    expect(mixed.ELIZA_PROFILE).toBe("Default");
    expect(mixed.ELIZA_STATE_DIR).toBe(
      path.join("/home/eliza-profile-test", ".eliza"),
    );
  });

  it("keeps the original profile case in the non-default state-dir suffix", () => {
    const env: Record<string, string | undefined> = {};
    applyCliProfileEnv({ profile: "Alice", env, homedir });
    expect(env.ELIZA_STATE_DIR).toBe(
      path.join("/home/eliza-profile-test", ".eliza-Alice"),
    );
  });

  it("trims a provided namespace and uses it in both the state dir and config file", () => {
    const env: Record<string, string | undefined> = {
      ELIZA_NAMESPACE: "  customNS  ",
    };
    applyCliProfileEnv({ profile: "alice", env, homedir });
    expect(env.ELIZA_NAMESPACE).toBe("customNS");
    expect(env.ELIZA_STATE_DIR).toBe(
      path.join("/home/eliza-profile-test", ".customNS-alice"),
    );
    expect(env.ELIZA_CONFIG_PATH).toBe(
      path.join("/home/eliza-profile-test", ".customNS-alice", "customNS.json"),
    );
  });

  it("treats a blank namespace as the eliza default", () => {
    const env: Record<string, string | undefined> = {
      ELIZA_NAMESPACE: "   ",
    };
    applyCliProfileEnv({ profile: "alice", env, homedir });
    expect(env.ELIZA_NAMESPACE).toBe("eliza");
    expect(env.ELIZA_STATE_DIR).toBe(
      path.join("/home/eliza-profile-test", ".eliza-alice"),
    );
  });

  it("does not override a non-blank ELIZA_STATE_DIR or ELIZA_CONFIG_PATH", () => {
    const env: Record<string, string | undefined> = {
      ELIZA_STATE_DIR: "/explicit/state",
      ELIZA_CONFIG_PATH: "/explicit/config.json",
    };
    applyCliProfileEnv({ profile: "alice", env, homedir });
    expect(env.ELIZA_STATE_DIR).toBe("/explicit/state");
    expect(env.ELIZA_CONFIG_PATH).toBe("/explicit/config.json");
  });

  it("fills a whitespace state dir, then derives config path from the filled value", () => {
    const env: Record<string, string | undefined> = {
      ELIZA_STATE_DIR: "  ",
      ELIZA_CONFIG_PATH: "  ",
    };
    applyCliProfileEnv({ profile: "alice", env, homedir });
    const stateDir = path.join("/home/eliza-profile-test", ".eliza-alice");
    expect(env.ELIZA_STATE_DIR).toBe(stateDir);
    expect(env.ELIZA_CONFIG_PATH).toBe(path.join(stateDir, "eliza.json"));
  });

  it("derives ELIZA_CONFIG_PATH from an explicit state dir when config path is blank", () => {
    const env: Record<string, string | undefined> = {
      ELIZA_STATE_DIR: "/explicit/state",
    };
    applyCliProfileEnv({ profile: "alice", env, homedir });
    expect(env.ELIZA_CONFIG_PATH).toBe(
      path.join("/explicit/state", "eliza.json"),
    );
  });

  it("defaults the gateway port only for the exact trimmed profile name dev", () => {
    const dev: Record<string, string | undefined> = {};
    applyCliProfileEnv({ profile: "dev", env: dev, homedir });
    expect(dev.ELIZA_GATEWAY_PORT).toBe("19001");

    const already: Record<string, string | undefined> = {
      ELIZA_GATEWAY_PORT: "18080",
    };
    applyCliProfileEnv({ profile: "dev", env: already, homedir });
    expect(already.ELIZA_GATEWAY_PORT).toBe("18080");

    const blankPort: Record<string, string | undefined> = {
      ELIZA_GATEWAY_PORT: "  ",
    };
    applyCliProfileEnv({ profile: "dev", env: blankPort, homedir });
    expect(blankPort.ELIZA_GATEWAY_PORT).toBe("19001");

    const mixed: Record<string, string | undefined> = {};
    applyCliProfileEnv({ profile: "Dev", env: mixed, homedir });
    expect(mixed.ELIZA_GATEWAY_PORT).toBeUndefined();
    expect(mixed.ELIZA_STATE_DIR).toBe(
      path.join("/home/eliza-profile-test", ".eliza-Dev"),
    );
  });

  it("uses os.homedir when homedir is omitted", () => {
    const env: Record<string, string | undefined> = {};
    applyCliProfileEnv({ profile: "alice", env });
    expect(env.ELIZA_STATE_DIR).toBe(path.join(os.homedir(), ".eliza-alice"));
  });

  it("writes defaults onto process.env when env is omitted", () => {
    const keys = [
      "ELIZA_PROFILE",
      "ELIZA_NAMESPACE",
      "ELIZA_STATE_DIR",
      "ELIZA_CONFIG_PATH",
      "ELIZA_GATEWAY_PORT",
    ] as const;
    const snapshot: Record<string, string | undefined> = {};
    for (const key of keys) {
      snapshot[key] = process.env[key];
      delete process.env[key];
    }
    try {
      applyCliProfileEnv({
        profile: "alice",
        homedir: () => "/tmp/eliza-profile-process-env",
      });
      expect(process.env.ELIZA_PROFILE).toBe("alice");
      expect(process.env.ELIZA_NAMESPACE).toBe("eliza");
      expect(process.env.ELIZA_STATE_DIR).toBe(
        path.join("/tmp/eliza-profile-process-env", ".eliza-alice"),
      );
      expect(process.env.ELIZA_CONFIG_PATH).toBe(
        path.join(
          "/tmp/eliza-profile-process-env",
          ".eliza-alice",
          "eliza.json",
        ),
      );
    } finally {
      for (const key of keys) {
        const value = snapshot[key];
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});
