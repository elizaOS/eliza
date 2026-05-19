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

export function expectNoCreatedEntityIds(result: UUID[]): void {
  expect(result).toEqual([]);
}
