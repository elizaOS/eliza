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
  runId: "200",
  latestEligibleRunId: "200",
};

describe("decideReleaseAdmission", () => {
  it("admits the latest deploy-eligible staging run", () => {
    expect(decideReleaseAdmission(staging)).toEqual({
      shouldDeploy: true,
      reason: "latest-eligible-staging-run",
    });
  });

  it("rejects a superseded automatic staging run", () => {
    expect(decideReleaseAdmission({ ...staging, runId: "199" })).toEqual({
      shouldDeploy: false,
      reason: "superseded-staging-run",
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
    {
      eventName: "workflow_dispatch",
      targetEnvironment: "staging",
      ref: "refs/heads/develop",
      force: false,
    },
  ])("always admits non-supersedable releases", (input) => {
    expect(
      decideReleaseAdmission({
        ...input,
        runId: "199",
        latestEligibleRunId: "200",
      }),
    ).toEqual({
      shouldDeploy: true,
      reason: "non-supersedable-release",
    });
  });

  it("fails closed when automatic staging run IDs cannot be resolved", () => {
    expect(() =>
      decideReleaseAdmission({
        ...staging,
        latestEligibleRunId: "",
      }),
    ).toThrow("requires both runId and latestEligibleRunId");
  });
});
