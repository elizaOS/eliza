/**
 * Unit coverage for shouldLoadRemoteCodingRunnerForBoot — the boot-time gate
 * deciding whether to load the optional remote coding-runner module. Verifies it
 * skips when nothing is configured, loads for explicit provider settings (so an
 * invalid provider can still be rejected downstream), loads for the legacy E2B
 * opt-in only when truthy, and loads when a cloud/home runner URL implies a
 * provider. Deterministic — feeds a settings/env stub.
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
        ELIZA_E2B_REMOTE_RUNNER: "false",
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

  it("loads for the legacy direct E2B opt-in only when truthy", () => {
    expect(
      shouldLoadRemoteCodingRunnerForBoot(runtimeWith(), {
        ELIZA_E2B_REMOTE_RUNNER: "yes",
      }),
    ).toBe(true);
    expect(
      shouldLoadRemoteCodingRunnerForBoot(runtimeWith(), {
        ELIZA_E2B_REMOTE_RUNNER: "maybe",
      }),
    ).toBe(false);
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
