/**
 * Exercises the pure admin-canary request and durable-job validators at the
 * trust boundary, including repository allowlisting and exact digest syntax.
 */

import { describe, expect, test } from "bun:test";
import {
  type AdminCanaryImageJobData,
  assertAdminCanaryImageJobData,
  assertAdminCanaryRolloutInput,
  parseAdminCanaryDemoImage,
} from "./admin-canary-image";

const AGENT = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";
const ROLLOUT = "44444444-4444-4444-8444-444444444444";
const SOURCE_DIGEST = `sha256:${"a".repeat(64)}`;
const TARGET_DIGEST = `sha256:${"b".repeat(64)}`;
const SOURCE_IMAGE = "ghcr.io/elizaos/eliza:sha-production";
const TARGET_IMAGE = `ghcr.io/elizaos/eliza-demo@${TARGET_DIGEST}`;

describe("admin canary image contract", () => {
  test("accepts one to five exact targets and the allowlisted immutable demo image", () => {
    expect(parseAdminCanaryDemoImage(TARGET_IMAGE)).toEqual({
      repository: "ghcr.io/elizaos/eliza-demo",
      digest: TARGET_DIGEST,
    });
    expect(() =>
      assertAdminCanaryRolloutInput({
        operation: "upgrade",
        dryRun: true,
        targetImage: TARGET_IMAGE,
        targets: [
          {
            agentId: AGENT,
            organizationId: ORG,
            expectedSourceImage: SOURCE_IMAGE,
            expectedSourceDigest: SOURCE_DIGEST,
          },
        ],
      }),
    ).not.toThrow();
  });

  test("rejects mutable, foreign, uppercase, duplicate, and oversized targets", () => {
    expect(() => parseAdminCanaryDemoImage("ghcr.io/elizaos/eliza-demo:latest")).toThrow(
      "allowlisted",
    );
    expect(() => parseAdminCanaryDemoImage(`ghcr.io/attacker/eliza-demo@${TARGET_DIGEST}`)).toThrow(
      "allowlisted",
    );
    expect(() =>
      parseAdminCanaryDemoImage(`ghcr.io/elizaos/eliza-demo@sha256:${"B".repeat(64)}`),
    ).toThrow("lowercase");

    const target = {
      agentId: AGENT,
      organizationId: ORG,
      expectedSourceImage: SOURCE_IMAGE,
      expectedSourceDigest: SOURCE_DIGEST,
    };
    expect(() =>
      assertAdminCanaryRolloutInput({
        operation: "upgrade",
        dryRun: false,
        targetImage: TARGET_IMAGE,
        targets: [target, target],
      }),
    ).toThrow("duplicate");
    expect(() =>
      assertAdminCanaryRolloutInput({
        operation: "upgrade",
        dryRun: false,
        targetImage: TARGET_IMAGE,
        targets: Array.from({ length: 6 }, (_, index) => ({
          ...target,
          agentId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        })),
      }),
    ).toThrow("between 1 and 5");
  });

  test("rollback accepts exactly one server audit identifier and no image pair", () => {
    expect(() =>
      assertAdminCanaryRolloutInput({
        operation: "rollback",
        dryRun: true,
        source: { rolloutId: ROLLOUT },
      }),
    ).not.toThrow();
    expect(() =>
      assertAdminCanaryRolloutInput({
        operation: "rollback",
        dryRun: true,
        source: {},
      }),
    ).toThrow("exactly one");
    expect(() =>
      assertAdminCanaryRolloutInput({
        operation: "rollback",
        dryRun: true,
        source: { rolloutId: ROLLOUT, jobId: AGENT },
      }),
    ).toThrow("exactly one");
  });

  test("durable job data binds actor, owner, operation, and both exact pairs", () => {
    const data: AdminCanaryImageJobData = {
      operation: "upgrade",
      rolloutId: ROLLOUT,
      actorUserId: USER,
      userId: USER,
      targetOwnerUserId: USER,
      decisionAt: "2026-07-23T00:00:00.000Z",
      agentId: AGENT,
      organizationId: ORG,
      sourceImage: SOURCE_IMAGE,
      sourceDigest: SOURCE_DIGEST,
      targetImage: TARGET_IMAGE,
      targetDigest: TARGET_DIGEST,
    };
    expect(() => assertAdminCanaryImageJobData(data)).not.toThrow();
    expect(() => assertAdminCanaryImageJobData({ ...data, targetDigest: SOURCE_DIGEST })).toThrow(
      "must equal",
    );
    const rollback: AdminCanaryImageJobData = {
      ...data,
      operation: "rollback",
      sourceImage: TARGET_IMAGE,
      sourceDigest: TARGET_DIGEST,
      targetImage: SOURCE_IMAGE,
      targetDigest: SOURCE_DIGEST,
      sourceRolloutId: ROLLOUT,
      sourceJobId: AGENT,
    };
    expect(() => assertAdminCanaryImageJobData(rollback)).not.toThrow();
    expect(() =>
      assertAdminCanaryImageJobData({
        ...rollback,
        sourceImage: `ghcr.io/elizaos/eliza-demo@${SOURCE_DIGEST}`,
      }),
    ).toThrow("must equal");
    expect(() => assertAdminCanaryImageJobData({ ...data, userId: AGENT })).toThrow(
      "must equal actorUserId",
    );
  });
});
