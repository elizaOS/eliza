/**
 * Runtime vocabulary for `containers.status`. The column is free text at the
 * schema level, so any status read back from a row must be validated here
 * before being handed to a `ContainerStatus`-typed writer (e.g. the deploy
 * runner reverting a retire flip, #15826). Kept separate from the repository
 * module so DB-free consumers and tests can use the guard without loading the
 * process database singletons.
 */

import type { ContainerStatus } from "./containers";

/**
 * Every value `ContainerStatus` admits. `satisfies` rejects entries outside
 * the union; the exhaustiveness of the list (no union member missing) is
 * pinned by the vocabulary test alongside this module.
 */
export const CONTAINER_STATUSES = [
  "pending",
  "building",
  "deploying",
  "running",
  "stopped",
  "failed",
  "deleting",
  "deleted",
] as const satisfies readonly ContainerStatus[];

/** True when a free-text status value is inside the containers vocabulary. */
export function isContainerStatus(value: string): value is ContainerStatus {
  return (CONTAINER_STATUSES as readonly string[]).includes(value);
}
