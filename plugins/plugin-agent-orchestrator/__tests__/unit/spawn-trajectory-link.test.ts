/**
 * Verifies buildLinkedSpawnMetadata.
 * Deterministic unit test of pure helpers; no runtime, no live model.
 */
import { describe, expect, it } from "vitest";
import type { SpawnTrajectoryHandle } from "../../src/services/spawn-trajectory.js";
import {
  buildLinkedSpawnEnv,
  buildLinkedSpawnMetadata,
  TRAJECTORY_LINK_SOURCE_METADATA_KEY,
  TRAJECTORY_PARENT_STEP_ENV_KEY,
  TRAJECTORY_PARENT_STEP_METADATA_KEY,
} from "../../src/services/spawn-trajectory.js";

// #9146 — when the orchestrator spawns a coding sub-agent it links the child's
// trajectory to the parent step via metadata + env. Pin that linkage (and that
// a missing/blank parent step is a clean no-op so unlinked spawns stay clean).
const handle = (parentStepId?: string) =>
  ({ parentStepId }) as unknown as SpawnTrajectoryHandle;

describe("buildLinkedSpawnMetadata", () => {
  it("injects the parent step id + source alongside existing metadata", () => {
    expect(
      buildLinkedSpawnMetadata({ a: 1 }, handle("step-42"), "spawn"),
    ).toEqual({
      a: 1,
      [TRAJECTORY_PARENT_STEP_METADATA_KEY]: "step-42",
      [TRAJECTORY_LINK_SOURCE_METADATA_KEY]: "spawn",
    });
  });

  it("adds no link keys when the parent step id is missing or blank", () => {
    expect(
      buildLinkedSpawnMetadata({ a: 1 }, handle(undefined), "spawn"),
    ).toEqual({ a: 1 });
    expect(buildLinkedSpawnMetadata(undefined, handle("   "), "spawn")).toEqual(
      {},
    );
  });
});

describe("buildLinkedSpawnEnv", () => {
  it("adds the parent-step env var to the child environment", () => {
    expect(buildLinkedSpawnEnv({ X: "1" }, handle("step-42"))).toEqual({
      X: "1",
      [TRAJECTORY_PARENT_STEP_ENV_KEY]: "step-42",
    });
  });

  it("returns the env untouched when there is no parent step", () => {
    const env = { X: "1" };
    expect(buildLinkedSpawnEnv(env, handle("  "))).toBe(env);
    expect(buildLinkedSpawnEnv(undefined, handle(undefined))).toBeUndefined();
  });
});
