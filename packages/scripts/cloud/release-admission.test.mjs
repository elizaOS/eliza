/**
 * Covers release admission policy with deterministic event and ref inputs.
 */

import { describe, expect, it } from "vitest";

import { decideReleaseAdmission } from "./release-admission.mjs";

const staging = {
  eventName: "push",
  targetEnvironment: "",
  ref: "refs/heads/develop",
  force: false,
  runSha: "current",
  currentDevelopSha: "current",
};

describe("decideReleaseAdmission", () => {
  it("admits the current automatic staging SHA", () => {
    expect(decideReleaseAdmission(staging)).toEqual({
      shouldDeploy: true,
      reason: "current-staging-sha",
    });
  });

  it("rejects a superseded automatic staging SHA", () => {
    expect(
      decideReleaseAdmission({ ...staging, runSha: "superseded" }),
    ).toEqual({
      shouldDeploy: false,
      reason: "superseded-staging-sha",
    });
  });

  it.each([
    {
      eventName: "pull_request",
      targetEnvironment: "",
      ref: "refs/pull/1/merge",
      force: false,
    },
    {
      eventName: "push",
      targetEnvironment: "production",
      ref: "refs/heads/main",
      force: false,
    },
    {
      eventName: "workflow_dispatch",
      targetEnvironment: "staging",
      ref: "refs/heads/develop",
      force: true,
    },
  ])("always admits non-supersedable releases", (input) => {
    expect(
      decideReleaseAdmission({
        ...input,
        runSha: "older",
        currentDevelopSha: "newer",
      }),
    ).toEqual({
      shouldDeploy: true,
      reason: "non-supersedable-release",
    });
  });

  it("fails closed when automatic staging SHAs cannot be resolved", () => {
    expect(() =>
      decideReleaseAdmission({
        ...staging,
        currentDevelopSha: "",
      }),
    ).toThrow("requires both runSha and currentDevelopSha");
  });
});
