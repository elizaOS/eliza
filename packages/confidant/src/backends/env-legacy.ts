import { parseReference } from "../references.js";
import type { VaultReference } from "../types.js";
import { BackendError, type VaultBackend } from "./types.js";

/**
 * Read-only wrapper around `process.env`. Migration scaffolding only — used
 * during phases 0-5 so legacy code paths can resolve through Confidant
 * without yet being rewritten. Removed in phase 6 of the migration plan.
 *
 * Reference shape: `env://VAR_NAME`.
 */
export class EnvLegacyBackend implements VaultBackend {
  readonly source = "env-legacy" as const;

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async resolve(ref: VaultReference): Promise<string> {
    const parsed = parseReference(ref);
    if (parsed.source !== "env-legacy") {
      throw new BackendError(this.source, `cannot resolve ref ${ref}`);
    }
    const varName = parsed.path;
    const value = this.env[varName];
    if (typeof value !== "string" || value.length === 0) {
      throw new BackendError(
        this.source,
        `process.env.${varName} is not set`,
      );
    }
    return value;
  }
}
