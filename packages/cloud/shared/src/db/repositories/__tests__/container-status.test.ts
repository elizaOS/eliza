/**
 * Pins the containers status vocabulary and its runtime guard (#15826) — pure
 * module, no DB. The Record below is the compile-time exhaustiveness check:
 * adding a member to `ContainerStatus` without listing it here fails typecheck.
 */

import { describe, expect, test } from "bun:test";
import { CONTAINER_STATUSES, isContainerStatus } from "../container-status";
import type { ContainerStatus } from "../containers";

// Typechecking forces one key per union member, so the vocabulary const can
// never silently trail the `ContainerStatus` type.
const EVERY_STATUS: Record<ContainerStatus, true> = {
  pending: true,
  building: true,
  deploying: true,
  running: true,
  stopped: true,
  failed: true,
  deleting: true,
  deleted: true,
};

describe("CONTAINER_STATUSES / isContainerStatus", () => {
  test("the vocabulary const covers the ContainerStatus union exactly", () => {
    // expect() is anchored on the wider string[] side so the literal-union
    // array widens into it — cloud-api's project-reference typecheck compiles
    // this file and rejects the reverse direction (string[] into a
    // ContainerStatus[] expectation).
    expect(Object.keys(EVERY_STATUS).sort()).toEqual([...CONTAINER_STATUSES].sort());
  });

  test("accepts every member of the vocabulary", () => {
    for (const status of Object.keys(EVERY_STATUS)) {
      expect(isContainerStatus(status)).toBe(true);
    }
  });

  test("rejects values outside the vocabulary", () => {
    for (const garbage of [
      "",
      " ",
      "zombie",
      "RUNNING", // case-sensitive: the column stores lowercase vocabulary values
      "running ", // no trimming — a padded value is not a valid status
      "delete",
      "deleteing",
      "null",
      "undefined",
    ]) {
      expect(isContainerStatus(garbage)).toBe(false);
    }
  });
});
