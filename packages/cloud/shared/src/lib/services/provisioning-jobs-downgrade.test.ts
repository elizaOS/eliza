/**
 * #9964 — the agent rollback (downgrade) job must be a first-class, reachable
 * job type: registered in the agent lane, cold-boot aware, and with a strict
 * data validator so a malformed enqueue can never reach `executeDowngrade`.
 *
 * `executeDowngrade` was fully implemented + unit-tested in eliza-sandbox but
 * had NO job type / executor / route — it was unreachable. These tests pin the
 * wiring contract (the live blue/green swap itself needs an armed daemon).
 */
import { describe, expect, test } from "bun:test";
import type { Job } from "../../db/repositories/jobs";
import { AGENT_JOB_TYPES, JOB_TYPES } from "./provisioning-job-types";
import { readAgentDowngradeJobData } from "./provisioning-jobs";

const VALID = {
  agentId: "agent-1",
  organizationId: "org-1",
  userId: "user-1",
  dockerImage: "ghcr.io/elizaos/eliza:stable",
  fromDigest: "sha256:" + "a".repeat(64),
};

function jobWith(data: unknown): Job {
  return { id: "job-1", data } as unknown as Job;
}

describe("agent_downgrade job wiring (#9964)", () => {
  test("AGENT_DOWNGRADE is registered and in the agent lane", () => {
    expect(JOB_TYPES.AGENT_DOWNGRADE).toBe("agent_downgrade");
    expect(AGENT_JOB_TYPES).toContain(JOB_TYPES.AGENT_DOWNGRADE);
  });

  test("readAgentDowngradeJobData accepts well-formed data", () => {
    expect(readAgentDowngradeJobData(jobWith(VALID))).toEqual(VALID);
  });

  test("rejects missing/wrong-typed required fields", () => {
    for (const key of [
      "agentId",
      "organizationId",
      "userId",
      "dockerImage",
      "fromDigest",
    ] as const) {
      const bad = { ...VALID, [key]: undefined };
      expect(() => readAgentDowngradeJobData(jobWith(bad))).toThrow(
        /Invalid agent downgrade job data/,
      );
    }
    // fromDigest must be a string (unlike upgrade's nullable fromDigest — a
    // rollback always swaps off a known current digest).
    expect(() => readAgentDowngradeJobData(jobWith({ ...VALID, fromDigest: null }))).toThrow(
      /Invalid agent downgrade job data/,
    );
    expect(() => readAgentDowngradeJobData(jobWith(null))).toThrow();
  });
});
