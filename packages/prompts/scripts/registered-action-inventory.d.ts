/**
 * Types for the registered-action inventory scanner so TypeScript consumers
 * (the builtin-view action guard test in packages/ui) can import the plain-JS
 * module shared by source navigation and the CI guard.
 */
export interface RegisteredActionInventoryEntry {
  name: string;
  files: string[];
}

export function extractActionNames(src: string): Set<string>;

export function collectRegisteredActionInventory(
  repoRoot: string,
): RegisteredActionInventoryEntry[];
