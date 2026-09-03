/**
 * Exercises the pure admin-canary request and durable-job validators at the
 * trust boundary, including repository allowlisting and exact digest syntax.
 */

import { describe, expect, test } from "bun:test";
import {
  ADMIN_CANARY_MAX_TARGETS,
  type AdminCanaryImageJobData,
  assertAdminCanaryImageJobData,
  assertAdminCanaryRolloutInput,
  assertDemoSourceImage,
  fingerprintAdminCanaryPlan,
  hashAdminCanaryRequest,
  isAdminCanaryImageJobData,
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

/**
 * The block above covers the happy path, the upper target bound, duplicate
 * agents and the plan fingerprint. These pin the edges beside them.
 *
 * All of it guards a super-admin seam that swaps the image under a running
 * agent, and `isAdminCanaryImageJobData` runs on a persisted job row
 * (`provisioning-jobs.ts:991`, `db/repositories/jobs.ts:173`) — so its inputs
 * are whatever survived a round trip through the database, not values a caller
 * just constructed.
 */
describe("admin canary image contract — boundaries", () => {
  const target = {
    agentId: AGENT,
    organizationId: ORG,
    expectedSourceImage: SOURCE_IMAGE,
    expectedSourceDigest: SOURCE_DIGEST,
  };

  function rollout(over: Record<string, unknown> = {}) {
    return {
      operation: "upgrade" as const,
      requestId: REQUEST,
      dryRun: true as const,
      targetImage: TARGET_IMAGE,
      targets: [target],
      ...over,
    };
  }

  function jobData(over: Record<string, unknown> = {}): AdminCanaryImageJobData {
    return {
      operation: "upgrade",
      rolloutId: ROLLOUT,
      actorUserId: USER,
      agentId: AGENT,
      organizationId: ORG,
      targetOwnerUserId: USER,
      userId: USER,
      sourceImage: SOURCE_IMAGE,
      sourceDigest: SOURCE_DIGEST,
      targetImage: TARGET_IMAGE,
      targetDigest: TARGET_DIGEST,
      decisionAt: new Date(1_750_000_000_000).toISOString(),
      ...over,
    } as AdminCanaryImageJobData;
  }

  // The bound is "between 1 and MAX". The upper half is covered; an empty list
  // is the half that reads as a no-op rollout rather than an error.
  test("refuses an empty target list, not just an oversized one", () => {
    expect(() => assertAdminCanaryRolloutInput(rollout({ targets: [] }))).toThrow(/between 1 and/);
    expect(() =>
      assertAdminCanaryRolloutInput(
        rollout({
          targets: Array.from({ length: ADMIN_CANARY_MAX_TARGETS }, (_unused, index) => ({
            ...target,
            agentId: `1111111${index}-1111-4111-8111-111111111111`,
          })),
        }),
      ),
    ).not.toThrow();
  });

  // The duplicate key is `organizationId:agentId`, not the agent id alone. The
  // same agent id under two organizations is two distinct targets; keying on
  // the agent id would reject a legitimate pair.
  test("scopes the duplicate-target check to the organization", () => {
    const otherOrg = "55555555-5555-4555-8555-555555555555";
    expect(() =>
      assertAdminCanaryRolloutInput(
        rollout({ targets: [target, { ...target, organizationId: otherOrg }] }),
      ),
    ).not.toThrow();
    expect(() =>
      assertAdminCanaryRolloutInput(rollout({ targets: [target, { ...target }] })),
    ).toThrow(/duplicate agent/);
  });

  // Both patterns are end-anchored. Without the `$`, a digest or id carrying
  // trailing bytes validates on its prefix — the classic way a fail-closed
  // syntax check stops being one.
  test.each([
    ["digest with trailing bytes", { sourceDigest: `${SOURCE_DIGEST}-extra` }, /sourceDigest/],
    ["digest with a trailing newline", { sourceDigest: `${SOURCE_DIGEST}\n` }, /sourceDigest/],
    ["uuid with trailing bytes", { agentId: `${AGENT}-extra` }, /agentId/],
    ["uuid with a trailing newline", { agentId: `${AGENT}\n` }, /agentId/],
  ] as const)("rejects a %s", (_label, over, expected) => {
    expect(() => assertAdminCanaryImageJobData(jobData(over))).toThrow(expected);
  });

  test.each([
    ["not a timestamp at all", "not-a-timestamp"],
    ["an empty string", ""],
  ] as const)("rejects a decisionAt that is %s", (_label, decisionAt) => {
    expect(() => assertAdminCanaryImageJobData(jobData({ decisionAt }))).toThrow(
      /decisionAt must be an ISO timestamp/,
    );
  });

  // `isAdminCanaryImageJobData` is the gate in front of the asserts: a row it
  // admits is then trusted enough to dispatch. Nothing exercised it.
  test("admits a well-formed persisted job row", () => {
    expect(isAdminCanaryImageJobData(jobData())).toBe(true);
    expect(isAdminCanaryImageJobData(jobData({ operation: "rollback" }))).toBe(true);
  });

  test.each([
    ["null", null],
    ["a string", "upgrade"],
    ["an array", []],
  ] as const)("rejects a persisted row that is %s", (_label, value) => {
    expect(isAdminCanaryImageJobData(value)).toBe(false);
  });

  test.each([
    ["an unknown operation", { operation: "sideways" }],
    ["a missing operation", { operation: undefined }],
    ["a numeric agentId", { agentId: 7 }],
    ["a missing sourceDigest", { sourceDigest: undefined }],
    ["a null targetImage", { targetImage: null }],
  ] as const)("rejects a persisted row with %s", (_label, over) => {
    expect(isAdminCanaryImageJobData({ ...jobData(), ...over })).toBe(false);
  });

  // At its only call site (`eliza-sandbox.ts:11417`) `assertDemoSourceImage` is
  // immediately followed by `parseAdminCanaryDemoImage` on the same value, and
  // parse is the stricter of the two: it demands the exact `repo@sha256:…`
  // form, while the assert compares only the repository and so accepts a
  // TAGGED demo reference. The pair below is what makes that ordering
  // load-bearing rather than incidental — the assert is worth keeping as
  // defence in depth on a super-admin seam, but the tagged form must be the
  // parse's job to refuse.
  test("the demo repository check is weaker than the exact-digest parse it precedes", () => {
    const tagged = `ghcr.io/elizaos/eliza-demo:v1@${TARGET_DIGEST}`;
    expect(() => assertDemoSourceImage(tagged, "sourceImage")).not.toThrow();
    expect(() => parseAdminCanaryDemoImage(tagged, "sourceImage")).toThrow(
      /exact repository@sha256 digest reference|allowlisted/,
    );

    for (const rejected of [
      `ghcr.io/elizaos/eliza@${TARGET_DIGEST}`,
      `ghcr.io/evil/eliza-demo@${TARGET_DIGEST}`,
      `ghcr.io/elizaos/eliza-demo-evil@${TARGET_DIGEST}`,
    ]) {
      expect(() => assertDemoSourceImage(rejected, "sourceImage")).toThrow(/eliza-demo/);
      expect(() => parseAdminCanaryDemoImage(rejected, "sourceImage")).toThrow(/allowlisted/);
    }
  });
});
