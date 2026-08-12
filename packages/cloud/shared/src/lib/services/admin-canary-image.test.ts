/**
 * Exercises the pure admin-canary request and durable-job validators at the
 * trust boundary, including repository allowlisting and exact digest syntax.
 */

import { describe, expect, test } from "bun:test";
import {
  type AdminCanaryImageJobData,
  assertAdminCanaryImageJobData,
  assertAdminCanaryRolloutInput,
  fingerprintAdminCanaryPlan,
  hashAdminCanaryRequest,
  parseAdminCanaryDemoImage,
} from "./admin-canary-image";

const AGENT = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";
const ROLLOUT = "44444444-4444-4444-8444-444444444444";
const REQUEST = "a5555555-5555-4555-8555-555555555555";
const SOURCE_DIGEST = `sha256:${"a".repeat(64)}`;
const TARGET_DIGEST = `sha256:${"b".repeat(64)}`;
const PLAN_FINGERPRINT = `sha256:${"c".repeat(64)}`;
const REQUEST_HASH = `sha256:${"d".repeat(64)}`;
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
        requestId: REQUEST,
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

    expect(() =>
      assertAdminCanaryRolloutInput({
        operation: "upgrade",
        requestId: REQUEST,
        dryRun: true,
        targetImage: `ghcr.io/elizaos/eliza-demo@${PLAN_FINGERPRINT}`,
        targets: [
          {
            agentId: AGENT,
            organizationId: ORG,
            expectedSourceImage: TARGET_IMAGE,
            expectedSourceDigest: TARGET_DIGEST,
          },
        ],
      }),
    ).not.toThrow();
    expect(() =>
      assertAdminCanaryRolloutInput({
        operation: "upgrade",
        requestId: REQUEST,
        dryRun: true,
        targetImage: `ghcr.io/elizaos/eliza-demo@${PLAN_FINGERPRINT}`,
        targets: [
          {
            agentId: AGENT,
            organizationId: ORG,
            expectedSourceImage: TARGET_IMAGE,
            expectedSourceDigest: SOURCE_DIGEST,
          },
        ],
      }),
    ).toThrow("must equal its image digest");
    expect(() =>
      assertAdminCanaryRolloutInput({
        operation: "upgrade",
        requestId: REQUEST,
        dryRun: true,
        targetImage: TARGET_IMAGE,
        targets: [
          {
            agentId: AGENT,
            organizationId: ORG,
            expectedSourceImage: TARGET_IMAGE,
            expectedSourceDigest: TARGET_DIGEST,
          },
        ],
      }),
    ).toThrow("must change the current image pair");
    expect(() =>
      parseAdminCanaryDemoImage(`ghcr.io/attacker/eliza-demo@${TARGET_DIGEST}`, "sourceImage"),
    ).toThrow("sourceImage must use");
  });

  test("requires canonical lowercase request IDs without changing other UUID fields", () => {
    const uppercaseAgent = "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF";
    const uppercaseOrganization = "FEDCBAFE-DCBA-4FED-8CBA-FEDCBAFEDCBA";
    const input = {
      operation: "upgrade" as const,
      requestId: REQUEST,
      dryRun: true as const,
      targetImage: TARGET_IMAGE,
      targets: [
        {
          agentId: uppercaseAgent,
          organizationId: uppercaseOrganization,
          expectedSourceImage: SOURCE_IMAGE,
          expectedSourceDigest: SOURCE_DIGEST,
        },
      ],
    };
    expect(() => assertAdminCanaryRolloutInput(input)).not.toThrow();
    expect(() =>
      assertAdminCanaryRolloutInput({
        ...input,
        requestId: REQUEST.toUpperCase(),
      }),
    ).toThrow("canonical lowercase UUID");
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
        requestId: REQUEST,
        dryRun: false,
        expectedPlanFingerprint: PLAN_FINGERPRINT,
        targetImage: TARGET_IMAGE,
        targets: [target, target],
      }),
    ).toThrow("duplicate");
    expect(() =>
      assertAdminCanaryRolloutInput({
        operation: "upgrade",
        requestId: REQUEST,
        dryRun: false,
        expectedPlanFingerprint: PLAN_FINGERPRINT,
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
        requestId: REQUEST,
        dryRun: true,
        source: { rolloutId: ROLLOUT },
      }),
    ).not.toThrow();
    expect(() =>
      assertAdminCanaryRolloutInput({
        operation: "rollback",
        requestId: REQUEST,
        dryRun: true,
        source: {},
      }),
    ).toThrow("exactly one");
    expect(() =>
      assertAdminCanaryRolloutInput({
        operation: "rollback",
        requestId: REQUEST,
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
      requestId: REQUEST,
      planFingerprint: PLAN_FINGERPRINT,
      canonicalRequestHash: REQUEST_HASH,
    };
    expect(() => assertAdminCanaryImageJobData(data)).not.toThrow();
    expect(() =>
      assertAdminCanaryImageJobData({
        ...data,
        sourceImage: TARGET_IMAGE,
        sourceDigest: TARGET_DIGEST,
      }),
    ).not.toThrow();
    expect(() =>
      assertAdminCanaryImageJobData({
        ...data,
        sourceImage: TARGET_IMAGE,
      }),
    ).toThrow("must equal its image digest");
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
        targetImage: TARGET_IMAGE,
        targetDigest: TARGET_DIGEST,
      }),
    ).not.toThrow();
    expect(() =>
      assertAdminCanaryImageJobData({
        ...rollback,
        sourceImage: `ghcr.io/elizaos/eliza-demo@${SOURCE_DIGEST}`,
      }),
    ).toThrow("must equal");
    expect(() => assertAdminCanaryImageJobData({ ...data, userId: AGENT })).toThrow(
      "must equal actorUserId",
    );
    expect(() =>
      assertAdminCanaryImageJobData({ ...data, canonicalRequestHash: undefined }),
    ).toThrow("all present or all absent");
    expect(() =>
      assertAdminCanaryImageJobData({
        ...data,
        requestId: 42 as unknown as string,
        planFingerprint: undefined,
        canonicalRequestHash: undefined,
      }),
    ).toThrow();
    expect(() =>
      assertAdminCanaryImageJobData({
        ...data,
        requestId: undefined,
        planFingerprint: undefined,
        canonicalRequestHash: undefined,
      }),
    ).not.toThrow();
  });

  test("binds exact request shape while canonical request and plan hashes ignore target order", async () => {
    const target = {
      operation: "upgrade" as const,
      agentId: AGENT,
      organizationId: ORG,
      targetOwnerUserId: USER,
      sourceImage: SOURCE_IMAGE,
      sourceDigest: SOURCE_DIGEST,
      targetImage: TARGET_IMAGE,
      targetDigest: TARGET_DIGEST,
    };
    const second = {
      ...target,
      agentId: "66666666-6666-4666-8666-666666666666",
    };
    const request = {
      operation: "upgrade" as const,
      requestId: REQUEST,
      dryRun: false as const,
      expectedPlanFingerprint: PLAN_FINGERPRINT,
      targetImage: TARGET_IMAGE,
      targets: [
        {
          agentId: AGENT,
          organizationId: ORG,
          expectedSourceImage: SOURCE_IMAGE,
          expectedSourceDigest: SOURCE_DIGEST,
        },
        {
          agentId: second.agentId,
          organizationId: ORG,
          expectedSourceImage: SOURCE_IMAGE,
          expectedSourceDigest: SOURCE_DIGEST,
        },
      ],
    };

    const requestHash = await hashAdminCanaryRequest(request, USER);
    const reorderedHash = await hashAdminCanaryRequest(
      { ...request, targets: [...request.targets].reverse() },
      USER,
    );
    expect(requestHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(reorderedHash).toBe(requestHash);

    const fingerprint = await fingerprintAdminCanaryPlan({
      actorUserId: USER,
      requestId: REQUEST,
      operation: "upgrade",
      targets: [target, second],
    });
    const reorderedFingerprint = await fingerprintAdminCanaryPlan({
      actorUserId: USER,
      requestId: REQUEST,
      operation: "upgrade",
      targets: [second, target],
    });
    expect(fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(reorderedFingerprint).toBe(fingerprint);
  });
});
