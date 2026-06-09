/**
 * Wire-value coverage for the CONTAINER_* (Apps / Product 2) job lane. Same
 * rationale as the AGENT_* smoke tests in provisioning-job-types.test.ts: the
 * DB stores the string, not the symbol, so a typo silently mis-routes a job.
 */
import { describe, expect, test } from "bun:test";
import { JOB_TYPES } from "../provisioning-job-types";

const CONTAINER_TYPES = {
  CONTAINER_PROVISION: "container_provision",
  CONTAINER_STOP: "container_stop",
  CONTAINER_DELETE: "container_delete",
  CONTAINER_RESTART: "container_restart",
  CONTAINER_UPGRADE: "container_upgrade",
  CONTAINER_LOGS: "container_logs",
} as const;

describe("JOB_TYPES — CONTAINER_* lane", () => {
  test("registers every container job type with its wire value", () => {
    for (const [key, wire] of Object.entries(CONTAINER_TYPES)) {
      expect(JOB_TYPES[key as keyof typeof JOB_TYPES]).toBe(wire);
    }
  });

  test("container wire values are unique and don't collide with agent values", () => {
    const all = Object.values(JOB_TYPES);
    expect(new Set(all).size).toBe(all.length);
    for (const wire of Object.values(CONTAINER_TYPES)) {
      expect(all.filter((v) => v === wire)).toHaveLength(1);
    }
  });

  test("container wire values are snake_case and container-namespaced", () => {
    for (const wire of Object.values(CONTAINER_TYPES)) {
      expect(wire).toMatch(/^container_[a-z]+$/);
    }
  });
});
