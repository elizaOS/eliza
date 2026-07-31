/**
 * Proves stale, preview, dirty, failed, or wrong-SHA Pages deployments cannot
 * satisfy the post-upload production metadata gate.
 */

import { describe, expect, it } from "vitest";
import { selectSuccessfulProductionDeployment } from "./select-pages-deployment.mjs";

const commitHash = "a".repeat(40);
const notBefore = Date.parse("2026-07-30T20:00:00.000Z");

function deployment(overrides = {}) {
  return {
    id: "f64788e9-fccd-4d4a-a28a-cb84f88f6",
    url: "https://f64788e9.eliza-computer.pages.dev",
    created_on: "2026-07-30T20:00:01.000Z",
    environment: "production",
    is_skipped: false,
    project_name: "eliza-computer",
    latest_stage: { name: "deploy", status: "success" },
    deployment_trigger: {
      metadata: {
        branch: "develop",
        commit_dirty: false,
        commit_hash: commitHash,
      },
    },
    ...overrides,
  };
}

function response(...deployments) {
  return { result: deployments, success: true };
}

describe("Cloudflare Pages deployment metadata selection", () => {
  it("selects a new successful clean production deployment for the exact SHA", () => {
    expect(
      selectSuccessfulProductionDeployment(response(deployment()), {
        commitHash,
        notBefore,
      }),
    ).toMatchObject({
      createdOn: "2026-07-30T20:00:01.000Z",
      id: "f64788e9-fccd-4d4a-a28a-cb84f88f6",
      url: "https://f64788e9.eliza-computer.pages.dev/",
    });
  });

  it.each([
    ["old", deployment({ created_on: "2026-07-30T19:59:59.999Z" })],
    ["preview", deployment({ environment: "preview" })],
    ["skipped", deployment({ is_skipped: true })],
    [
      "unfinished stage",
      deployment({ latest_stage: { name: "build", status: "success" } }),
    ],
    [
      "failed",
      deployment({ latest_stage: { name: "deploy", status: "failure" } }),
    ],
    [
      "dirty",
      deployment({
        deployment_trigger: {
          metadata: {
            branch: "develop",
            commit_dirty: true,
            commit_hash: commitHash,
          },
        },
      }),
    ],
    [
      "wrong branch",
      deployment({
        deployment_trigger: {
          metadata: {
            branch: "feature",
            commit_dirty: false,
            commit_hash: commitHash,
          },
        },
      }),
    ],
    [
      "wrong SHA",
      deployment({
        deployment_trigger: {
          metadata: {
            branch: "develop",
            commit_dirty: false,
            commit_hash: "b".repeat(40),
          },
        },
      }),
    ],
  ])("rejects a %s deployment without false success", (_name, candidate) => {
    expect(
      selectSuccessfulProductionDeployment(response(candidate), {
        commitHash,
        notBefore,
      }),
    ).toBeUndefined();
  });

  it("rejects malformed API success envelopes", () => {
    expect(() =>
      selectSuccessfulProductionDeployment(
        { result: [], success: false },
        { commitHash, notBefore },
      ),
    ).toThrow("successful result array");
  });
});
