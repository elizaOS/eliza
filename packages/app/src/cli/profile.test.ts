import { describe, expect, it } from "vitest";
import { applyCliProfileEnv, parseCliProfileArgs } from "./profile";

const argv = (...args: string[]) => ["node", "eliza", ...args];

describe("CLI profile selection", () => {
  it.each(["--profile=name=extra", "--profile=../other", "--profile="])(
    "rejects malformed selection %s without choosing another profile",
    (arg) => {
      expect(parseCliProfileArgs(argv(arg, "start")).ok).toBe(false);
    },
  );

  it.each([
    ["--dev", "--profile", "dev"],
    ["--profile", "dev", "--dev"],
    ["--profile=default", "--dev"],
    ["--dev", "--profile=default"],
  ])("rejects conflicting flags in order %j", (...flags) => {
    expect(parseCliProfileArgs(argv(...flags, "start"))).toEqual({
      ok: false,
      error: "Cannot combine --dev with --profile",
    });
  });

  it("keeps subcommand arguments untouched", () => {
    expect(
      parseCliProfileArgs(argv("--profile=work", "start", "--profile=inner")),
    ).toEqual({
      ok: true,
      profile: "work",
      argv: argv("start", "--profile=inner"),
    });
  });

  it("uses the selected namespace without replacing explicit paths or ports", () => {
    const env = {
      ELIZA_NAMESPACE: "custom",
      ELIZA_STATE_DIR: "/chosen/state",
      ELIZA_CONFIG_PATH: "/chosen/config.json",
      ELIZA_GATEWAY_PORT: "4321",
    };
    applyCliProfileEnv({ profile: "dev", env, homedir: () => "/home/test" });
    expect(env).toEqual({
      ELIZA_PROFILE: "dev",
      ELIZA_NAMESPACE: "custom",
      ELIZA_STATE_DIR: "/chosen/state",
      ELIZA_CONFIG_PATH: "/chosen/config.json",
      ELIZA_GATEWAY_PORT: "4321",
    });
  });
});
