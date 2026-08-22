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
