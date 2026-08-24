/**
 * Unit coverage for shouldLoadRemoteCodingRunnerForBoot — the boot-time gate
 * deciding whether to load the optional remote coding-runner module. Verifies it
 * skips when nothing is configured, loads for explicit provider settings so an
 * invalid provider can still be rejected downstream, and loads when a
 * cloud/home runner URL implies a provider. Deterministic settings/env stubs.
 */
import { describe, expect, it } from "vitest";

import { shouldLoadRemoteCodingRunnerForBoot } from "../remote-coding-runner-gate.ts";

function runtimeWith(settings: Record<string, string | undefined> = {}) {
  return {
    getSetting(key: string): unknown {
      return settings[key];
    },
  };
}

describe("shouldLoadRemoteCodingRunnerForBoot", () => {
  it("skips the optional runner module when no remote runner is configured", () => {
    expect(
      shouldLoadRemoteCodingRunnerForBoot(runtimeWith(), {
        ELIZA_CODING_REMOTE_RUNNER: "",
        ELIZA_REMOTE_RUNNER: undefined,
      }),
    ).toBe(false);
  });

  it("loads for explicit runner settings so invalid providers can still be rejected by the service", () => {
    expect(
      shouldLoadRemoteCodingRunnerForBoot(
        runtimeWith({ ELIZA_CODING_REMOTE_RUNNER: "eliza-cloud" }),
        {},
      ),
    ).toBe(true);
    expect(
      shouldLoadRemoteCodingRunnerForBoot(
        runtimeWith({ ELIZA_REMOTE_RUNNER: "cloudflare" }),
        {},
      ),
    ).toBe(true);
  });

  it("loads when cloud or home remote-runner URLs imply a provider", () => {
    expect(
      shouldLoadRemoteCodingRunnerForBoot(runtimeWith(), {
        ELIZA_CLOUD_RUNNER_URL: "https://runner.example",
      }),
    ).toBe(true);
    expect(
      shouldLoadRemoteCodingRunnerForBoot(runtimeWith(), {
        ELIZA_HOME_REMOTE_RUNNER_URL: "http://home.local",
      }),
    ).toBe(true);
  });
});

/**
 * Additional branch coverage appended without modifying the original cases:
 * env fallback for runner-mode keys, non-string runtime values falling through,
 * trim semantics, the remaining URL keys, presence-flag semantics,
 * short-circuit ordering, error propagation, and the default process.env
 * source.
 */
describe("shouldLoadRemoteCodingRunnerForBoot additional branches", () => {
  it("falls back to env for runner-mode keys when the runtime has nothing", () => {
    expect(
      shouldLoadRemoteCodingRunnerForBoot(runtimeWith(), {
        ELIZA_CODING_REMOTE_RUNNER: "eliza-cloud",
      }),
    ).toBe(true);
    expect(
      shouldLoadRemoteCodingRunnerForBoot(runtimeWith(), {
        ELIZA_REMOTE_RUNNER: "cloudflare",
      }),
    ).toBe(true);
  });

  it("falls back to env when the runtime value is not a usable string", () => {
    const invalidRuntimeValues: unknown[] = [undefined, null, "", 7, false];
    for (const invalid of invalidRuntimeValues) {
      const runtime = {
        getSetting(key: string): unknown {
          return key === "ELIZA_REMOTE_RUNNER" ? invalid : undefined;
        },
      };
      expect(
        shouldLoadRemoteCodingRunnerForBoot(runtime, {
          ELIZA_REMOTE_RUNNER: "cloudflare",
        }),
        `expected env fallback for runtime value ${String(invalid)}`,
      ).toBe(true);
    }
  });

  it("trims configured values before deciding presence", () => {
    expect(
      shouldLoadRemoteCodingRunnerForBoot(
        runtimeWith({ ELIZA_CODING_REMOTE_RUNNER: "  eliza-cloud  " }),
        {},
      ),
    ).toBe(true);
    expect(
      shouldLoadRemoteCodingRunnerForBoot(runtimeWith(), {
        ELIZA_CLOUD_RUNNER_URL: "  https://runner.example  ",
      }),
    ).toBe(true);
  });

  it("ignores whitespace-only values in both sources", () => {
    const whitespaceOnly = ["   ", "\t", "\n"];
    for (const blank of whitespaceOnly) {
      expect(
        shouldLoadRemoteCodingRunnerForBoot(
          runtimeWith({ ELIZA_REMOTE_RUNNER: blank }),
          {},
        ),
        `expected whitespace-only runtime value ${JSON.stringify(blank)} to be ignored`,
      ).toBe(false);
      expect(
        shouldLoadRemoteCodingRunnerForBoot(runtimeWith(), {
          ELIZA_CLOUD_SANDBOX_BASE_URL: blank,
        }),
        `expected whitespace-only env value ${JSON.stringify(blank)} to be ignored`,
      ).toBe(false);
    }
  });

  it("treats every supported runner URL key as sufficient on its own", () => {
    const urlKeys = [
      "ELIZA_CLOUD_SANDBOX_BASE_URL",
      "ELIZA_CLOUD_REMOTE_RUNNER_URL",
      "ELIZA_HOME_RUNNER_URL",
    ] as const;
    for (const key of urlKeys) {
      expect(
        shouldLoadRemoteCodingRunnerForBoot(runtimeWith(), {
          [key]: "https://runner.example",
        }),
        `expected ${key} to load the runner`,
      ).toBe(true);
    }
  });

  it("treats configured values as presence flags, not parsed booleans or URLs", () => {
    const presenceFlags = ["false", "0", "not-a-url"];
    for (const flag of presenceFlags) {
      expect(
        shouldLoadRemoteCodingRunnerForBoot(
          runtimeWith({ ELIZA_REMOTE_RUNNER: flag }),
          {},
        ),
        `expected ${flag} to count as configured`,
      ).toBe(true);
    }
  });

  it("does not consult later keys once an earlier key resolves", () => {
    const runtime = {
      getSetting(key: string): unknown {
        if (key === "ELIZA_REMOTE_RUNNER") {
          throw new Error(`unexpected lookup: ${key}`);
        }
        return key === "ELIZA_CODING_REMOTE_RUNNER" ? "eliza-cloud" : undefined;
      },
    };
    expect(shouldLoadRemoteCodingRunnerForBoot(runtime, {})).toBe(true);

    const urlGateRuntime = {
      getSetting(key: string): unknown {
        if (key === "ELIZA_CLOUD_REMOTE_RUNNER_URL") {
          throw new Error(`unexpected lookup: ${key}`);
        }
        return key === "ELIZA_CLOUD_SANDBOX_BASE_URL"
          ? "https://runner.example"
          : undefined;
      },
    };
    expect(shouldLoadRemoteCodingRunnerForBoot(urlGateRuntime, {})).toBe(true);
  });

  it("propagates a failing settings lookup instead of fabricating a skip", () => {
    const runtime = {
      getSetting(): unknown {
        throw new Error("settings backend offline");
      },
    };
    expect(() =>
      shouldLoadRemoteCodingRunnerForBoot(runtime, {
        ELIZA_REMOTE_RUNNER: "cloudflare",
      }),
    ).toThrow("settings backend offline");
  });

  it("reads process.env when no explicit env source is passed", () => {
    const key = "ELIZA_HOME_RUNNER_URL";
    const previous = process.env[key];
    process.env[key] = "http://home.local";
    try {
      expect(shouldLoadRemoteCodingRunnerForBoot(runtimeWith())).toBe(true);
    } finally {
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    }
  });
});
