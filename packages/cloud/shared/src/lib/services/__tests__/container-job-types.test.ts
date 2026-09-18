/** Pins persisted container job wire values so existing rows retain their dispatch identity. */
import { describe, expect, test } from "bun:test";
import { JOB_TYPES } from "../provisioning-job-types";

const CONTAINER_TYPES = {
  CONTAINER_PROVISION: "container_provision",
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
});
