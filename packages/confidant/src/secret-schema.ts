import { assertSecretId } from "./identifiers.js";
import type { SecretSchemaEntry } from "./types.js";

/**
 * The schema registry is the single source of truth for "this id is a
 * secret" decisions. Plugins register the ids they own at registration time;
 * the runtime composes those into a global registry the Confidant consults.
 *
 * Phase 0 ships a process-global registry. Tests that want isolation should
 * call `__resetSecretSchemaForTests()` between cases.
 */

const registry = new Map<string, SecretSchemaEntry>();

export function defineSecretSchema(
  entries: Readonly<Record<string, Omit<SecretSchemaEntry, "id">>>,
): readonly SecretSchemaEntry[] {
  const added: SecretSchemaEntry[] = [];
  for (const [id, body] of Object.entries(entries)) {
    assertSecretId(id);
    const existing = registry.get(id);
    if (existing && existing.pluginId !== body.pluginId) {
      throw new SecretSchemaConflictError(id, existing.pluginId, body.pluginId);
    }
    const entry: SecretSchemaEntry = { id, ...body };
    registry.set(id, entry);
    added.push(entry);
  }
  return added;
}

export function lookupSchema(id: string): SecretSchemaEntry | null {
  return registry.get(id) ?? null;
}

export function listSchema(): readonly SecretSchemaEntry[] {
  return Array.from(registry.values());
}

export class SecretSchemaConflictError extends Error {
  constructor(id: string, existingPlugin: string, attemptedPlugin: string) {
    super(
      `Secret id "${id}" is already owned by plugin "${existingPlugin}"; plugin "${attemptedPlugin}" cannot register the same id.`,
    );
    this.name = "SecretSchemaConflictError";
  }
}

/** Test-only. Do not call from production code. */
export function __resetSecretSchemaForTests(): void {
  registry.clear();
}
