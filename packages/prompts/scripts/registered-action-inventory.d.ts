/**
 * Types for the registered-action inventory scanner so TypeScript consumers
 * (the builtin-view action ratchet test in packages/ui) can import the plain-JS
 * module that the catalog generator and the CI ratchet share.
 */
export interface RegisteredActionInventoryEntry {
  name: string;
  files: string[];
}

export function extractActionNames(src: string): Set<string>;

export function collectRegisteredActionInventory(
  repoRoot: string,
): RegisteredActionInventoryEntry[];
