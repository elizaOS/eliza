import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  evaluateRequiredChecks,
  readCheckResultDetails,
  readCheckResults,
  waitForRequiredChecks,
} from "../src/check-watcher.js";

describe("Forgejo check watcher", () => {
  it("passes when combined status includes all required checks", async () => {
    const result = await waitForRequiredChecks({
      client: client({
        combined: {
          statuses: [
            { context: "smoke", state: "success" },
            { context: "lint", state: "skipped" },
          ],
        },
      }),
      repo: "elizaos/eliza",
      ref: "eliza-queue/develop/elizaos-eliza-pr-12",
      requiredChecks: ["smoke", "lint"],
    });

    assert.equal(result.status, "passed");
    assert.equal(result.attempts, 1);
    assert.equal(result.checkDetails.smoke.state, "success");
  });

  it("falls back to commit statuses when combined status is unavailable", async () => {
    const checkResults = await readCheckResults({
      client: client({
        combinedError: true,
        statuses: [
          { context: "smoke", state: "success" },
          { context: "smoke", state: "failure" },
        ],
      }),
      repo: { owner: "elizaos", repo: "eliza" },
      ref: "head-sha",
    });

    assert.deepEqual(checkResults, { smoke: "success" });
  });

  it("preserves check provenance from commit status metadata", async () => {
    const details = await readCheckResultDetails({
      client: client({
        combined: {
          statuses: [
            {
              id: 101,
              context: "smoke",
              state: "success",
              target_url:
                "https://git.eliza.test/elizaos/eliza/actions/runs/42",
              description: "smoke passed",
            },
          ],
        },
      }),
      repo: { owner: "elizaos", repo: "eliza" },
      ref: "head-sha",
    });

    assert.deepEqual(details.checkResults, { smoke: "success" });
    assert.deepEqual(details.checkDetails.smoke, {
      state: "success",
      rawState: "success",
      targetUrl: "https://git.eliza.test/elizaos/eliza/actions/runs/42",
      runId: "42",
      description: "smoke passed",
      id: 101,
    });
  });

  it("fails fast on required check failures", async () => {
    const result = await waitForRequiredChecks({
      client: client({
        combined: { statuses: [{ context: "smoke", state: "failure" }] },
      }),
      repo: "elizaos/eliza",
      ref: "head-sha",
      requiredChecks: ["smoke"],
      config: { checkPollAttempts: 3 },
    });

    assert.equal(result.status, "failed");
    assert.equal(result.reason, "checks_failed");
    assert.deepEqual(result.failing, ["smoke"]);
    assert.equal(result.attempts, 1);
  });

  it("polls until pending checks pass", async () => {
    let attempt = 0;
    const sleeps = [];
    const result = await waitForRequiredChecks({
      client: {
        async getCombinedCommitStatus() {
          attempt += 1;
          return {
            statuses: [
              {
                context: "smoke",
                state: attempt === 1 ? "pending" : "success",
              },
            ],
          };
        },
      },
      repo: "elizaos/eliza",
      ref: "head-sha",
      requiredChecks: ["smoke"],
      config: { checkPollAttempts: 2, checkPollIntervalMs: 5 },
      sleep(ms) {
        sleeps.push(ms);
      },
    });

    assert.equal(result.status, "passed");
    assert.equal(result.attempts, 2);
    assert.deepEqual(sleeps, [5]);
  });

  it("times out when checks never finish", async () => {
    const result = await waitForRequiredChecks({
      client: client({
        combined: { statuses: [{ context: "smoke", state: "pending" }] },
      }),
      repo: "elizaos/eliza",
      ref: "head-sha",
      requiredChecks: ["smoke"],
      config: { checkPollAttempts: 2 },
    });

    assert.equal(result.status, "timed_out");
    assert.equal(result.reason, "checks_not_complete");
  });

  it("clamps poll attempts to at least one read", async () => {
    let reads = 0;
    const result = await waitForRequiredChecks({
      client: {
        async getCombinedCommitStatus() {
          reads += 1;
          return { statuses: [{ context: "smoke", state: "success" }] };
        },
      },
      repo: "elizaos/eliza",
      ref: "head-sha",
      requiredChecks: ["smoke"],
      config: { checkPollAttempts: 0 },
    });

    assert.equal(result.status, "passed");
    assert.equal(result.attempts, 1);
    assert.equal(reads, 1);
  });

  it("blocks empty required checks unless explicitly allowed", async () => {
    const blocked = await waitForRequiredChecks({
      client: client({ combined: { statuses: [] } }),
      repo: "elizaos/eliza",
      ref: "head-sha",
      requiredChecks: [],
    });
    const allowed = await waitForRequiredChecks({
      client: client({ combined: { statuses: [] } }),
      repo: "elizaos/eliza",
      ref: "head-sha",
      requiredChecks: [],
      config: { allowEmptyRequiredChecks: true },
    });

    assert.equal(blocked.status, "blocked");
    assert.equal(allowed.status, "passed");
  });

  it("reports missing and pending checks", () => {
    assert.deepEqual(
      evaluateRequiredChecks({
        requiredChecks: ["smoke", "lint"],
        checkResults: { smoke: "pending" },
      }),
      {
        status: "pending",
        reason: "checks_not_complete",
        missing: ["lint"],
        pending: ["smoke"],
        failing: [],
      },
    );
  });

  it("skips when the Forgejo client is missing", async () => {
    const result = await waitForRequiredChecks({
      repo: "elizaos/eliza",
      ref: "head-sha",
      requiredChecks: ["smoke"],
    });

    assert.equal(result.status, "skipped");
    assert.equal(result.reason, "forgejo_client_unconfigured");
  });
});

function client({ combined, statuses = [], combinedError = false } = {}) {
  return {
    async getCombinedCommitStatus() {
      if (combinedError) throw new Error("combined unavailable");
      return combined;
    },
    async listCommitStatuses() {
      return statuses;
    },
  };
}
