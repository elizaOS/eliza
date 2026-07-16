import { describe, expect, it } from "vitest";
import {
  classifyCheckRollup,
  compareClaimedFiles,
  groundTruthHardFailEnabled,
  type RemotePullRequest,
  renderGroundTruthEvidence,
  shouldIncludeGroundTruthEvidence,
  verifyGroundTruth,
} from "../../src/services/ground-truth-verifier.js";

const completion = "Done: https://github.com/elizaos/eliza/pull/123";

function remote(overrides: Partial<RemotePullRequest> = {}): RemotePullRequest {
  return {
    url: "https://github.com/elizaos/eliza/pull/123",
    state: "open",
    headSha: "abc123",
    changedFiles: ["src/a.ts"],
    checks: [],
    ...overrides,
  };
}

const now = () => new Date("2026-07-15T00:00:00.000Z");

describe("ground-truth pure comparison", () => {
  it("reports changed remote files that were not claimed", () => {
    expect(compareClaimedFiles(["src/a.ts"], ["src/a.ts", "src/b.ts"])).toEqual(
      {
        claimed: ["src/a.ts"],
        actual: ["src/a.ts", "src/b.ts"],
        changedButNotClaimed: ["src/b.ts"],
        claimedButNotChanged: [],
      },
    );
  });

  it("reports claimed files absent from the PR", () => {
    expect(compareClaimedFiles(["src/a.ts", "src/b.ts"], ["src/a.ts"])).toEqual(
      {
        claimed: ["src/a.ts", "src/b.ts"],
        actual: ["src/a.ts"],
        changedButNotClaimed: [],
        claimedButNotChanged: ["src/b.ts"],
      },
    );
  });

  it("classifies red and pending required checks", () => {
    expect(
      classifyCheckRollup([
        {
          name: "test",
          status: "completed",
          conclusion: "failure",
          required: true,
        },
        {
          name: "lint",
          status: "completed",
          conclusion: "success",
          required: true,
        },
      ]).state,
    ).toBe("red");
    expect(
      classifyCheckRollup([
        {
          name: "test",
          status: "in_progress",
          conclusion: null,
          required: true,
        },
      ]).state,
    ).toBe("pending");
  });
});

describe("verifyGroundTruth", () => {
  it("records a missing unrequired PR without hard-failing", async () => {
    const verdict = await verifyGroundTruth(
      {
        completion: "finished without a link",
        claimedFiles: ["src/a.ts"],
        requirePullRequest: false,
        hardFailEnabled: true,
      },
      { fetchPullRequest: async () => remote(), now },
    );
    expect(verdict.status).toBe("missing_pr");
    expect(verdict.hardFail).toBe(false);
    expect(verdict.pr.claimed).toBe(false);
    expect(renderGroundTruthEvidence(verdict)).toContain(
      "pullRequest: not claimed",
    );
  });

  it("hard-fails a missing PR only when policy requires one", async () => {
    const verdict = await verifyGroundTruth(
      {
        completion: "finished without a link",
        claimedFiles: [],
        requirePullRequest: true,
        hardFailEnabled: true,
      },
      { fetchPullRequest: async () => remote(), now },
    );
    expect(verdict.hardFail).toBe(true);
    expect(verdict.hardFailReasons[0]).toContain("required");
  });

  it("hard-fails a claimed URL that does not resolve", async () => {
    const verdict = await verifyGroundTruth(
      {
        completion,
        claimedFiles: [],
        requirePullRequest: false,
        hardFailEnabled: true,
      },
      { fetchPullRequest: async () => null, now },
    );
    expect(verdict.pr.exists).toBe(false);
    expect(verdict.hardFail).toBe(true);
  });

  it("hard-fails red required checks", async () => {
    const verdict = await verifyGroundTruth(
      {
        completion,
        claimedFiles: ["src/a.ts"],
        requirePullRequest: false,
        hardFailEnabled: true,
      },
      {
        fetchPullRequest: async () =>
          remote({
            checks: [
              {
                name: "unit-tests",
                status: "completed",
                conclusion: "failure",
                required: true,
              },
            ],
          }),
        now,
      },
    );
    expect(verdict.checks.state).toBe("red");
    expect(verdict.hardFail).toBe(true);
    expect(verdict.hardFailReasons[0]).toContain("unit-tests");
  });

  it("reports pending checks without a false failure", async () => {
    const verdict = await verifyGroundTruth(
      {
        completion,
        claimedFiles: ["src/a.ts"],
        requirePullRequest: true,
        hardFailEnabled: true,
      },
      {
        fetchPullRequest: async () =>
          remote({
            checks: [
              {
                name: "unit-tests",
                status: "queued",
                conclusion: null,
                required: true,
              },
            ],
          }),
        now,
      },
    );
    expect(verdict.checks.state).toBe("pending");
    expect(verdict.status).toBe("inconclusive");
    expect(verdict.hardFail).toBe(false);
  });

  it("preserves both directions of file mismatch in the structured verdict", async () => {
    const verdict = await verifyGroundTruth(
      {
        completion,
        claimedFiles: ["src/claimed.ts", "src/shared.ts"],
        requirePullRequest: false,
        hardFailEnabled: false,
      },
      {
        fetchPullRequest: async () =>
          remote({ changedFiles: ["src/remote.ts", "src/shared.ts"] }),
        now,
      },
    );
    expect(verdict.status).toBe("mismatch");
    expect(verdict.files.changedButNotClaimed).toEqual(["src/remote.ts"]);
    expect(verdict.files.claimedButNotChanged).toEqual(["src/claimed.ts"]);
  });

  it("turns API errors into inconclusive verdicts, never hard failures", async () => {
    const verdict = await verifyGroundTruth(
      {
        completion,
        claimedFiles: ["src/a.ts"],
        requirePullRequest: true,
        hardFailEnabled: true,
      },
      {
        fetchPullRequest: async () => {
          throw new Error("rate limited");
        },
        now,
      },
    );
    expect(verdict.status).toBe("inconclusive");
    expect(verdict.hardFail).toBe(false);
    expect(verdict.error).toBe("rate limited");
  });
});

describe("ground-truth settings", () => {
  it("defaults evidence on and hard-fail off", () => {
    const unset = () => undefined;
    expect(shouldIncludeGroundTruthEvidence(unset)).toBe(true);
    expect(groundTruthHardFailEnabled(unset)).toBe(false);
  });
});
