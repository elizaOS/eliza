/**
 * Shared assertion helper for entity-creation tests: checks that
 * `createEntities` reports exactly the expected set of entity IDs as created,
 * order-independent. Used across the entity/base-adapter test suites so each
 * one doesn't hand-roll the same length + set-membership check.
 */
import type { UUID } from "@elizaos/core";
import { expect } from "vitest";

export function expectCreatedEntityIds(
  result: UUID[],
  entities: ReadonlyArray<{ id?: UUID }>
): UUID[] {
  const expectedIds = entities
    .map((entity) => entity.id)
    .filter((id): id is UUID => id !== undefined);

  expect(result).toHaveLength(expectedIds.length);
  expect(result).toEqual(expect.arrayContaining(expectedIds));

  return expectedIds;
}
