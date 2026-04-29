import { matchesPattern, selectMostSpecific } from "../identifiers.js";
import { lookupSchema } from "../secret-schema.js";
import type { Grant, GrantMode, SecretId } from "../types.js";

/**
 * Permission policy. Deny by default; explicit grants stored per-skill.
 *
 * Implicit grants:
 *  - The plugin that registered a secret id (via `defineSecretSchema`) gets
 *    `always` access to that exact id, no prompt.
 *
 * Explicit grants:
 *  - Persisted in the store under `permissions[skillId].grants`.
 *  - Patterns honor the glob rules in `identifiers.matchesPattern`.
 *  - Specificity wins: a more specific pattern overrides a broader one.
 *  - `deny` always wins, regardless of specificity.
 */

export type PolicyDecision =
  | { kind: "allow"; mode: Exclude<GrantMode, "deny">; pattern: string | "implicit" }
  | { kind: "prompt"; pattern: string }
  | { kind: "deny"; reason: string };

export interface PolicyInput {
  readonly skillId: string;
  readonly secretId: SecretId;
  readonly grants: readonly Grant[];
}

export function decide(input: PolicyInput): PolicyDecision {
  const denying = input.grants.find(
    (g) => g.mode === "deny" && matchesPattern(g.pattern, input.secretId),
  );
  if (denying) {
    return {
      kind: "deny",
      reason: `Explicit deny grant on pattern "${denying.pattern}".`,
    };
  }

  const schema = lookupSchema(input.secretId);
  if (schema && schema.pluginId === input.skillId) {
    return { kind: "allow", mode: "always", pattern: "implicit" };
  }

  const allowedPatterns = input.grants
    .filter((g) => g.mode !== "deny" && matchesPattern(g.pattern, input.secretId))
    .map((g) => g.pattern);
  const winner = selectMostSpecific(allowedPatterns, input.secretId);
  if (!winner) {
    return {
      kind: "deny",
      reason: `No grant matches "${input.secretId}" for skill "${input.skillId}".`,
    };
  }

  // Find the matching grant's mode. Multiple grants may share a pattern;
  // take the strictest among them (prompt > audit > always). `selectMostSpecific`
  // already guaranteed at least one match, so `matching` is non-empty.
  const matching = input.grants.filter(
    (g): g is Grant & { mode: Exclude<GrantMode, "deny"> } =>
      g.pattern === winner && g.mode !== "deny",
  );
  let mode: Exclude<GrantMode, "deny"> | undefined;
  for (const g of matching) {
    mode = mode === undefined ? g.mode : combineModes(mode, g.mode);
  }
  if (mode === undefined) {
    return {
      kind: "deny",
      reason: "internal: matched pattern had no allow-mode grants",
    };
  }
  if (mode === "prompt") {
    return { kind: "prompt", pattern: winner };
  }
  return { kind: "allow", mode, pattern: winner };
}

function combineModes(
  current: Exclude<GrantMode, "deny">,
  next: Exclude<GrantMode, "deny">,
): Exclude<GrantMode, "deny"> {
  // strictest wins: prompt > audit > always
  // (i.e. if any grant says prompt, the whole decision is prompt; audit
  // otherwise; only `always` if every grant says `always`).
  const order: Record<Exclude<GrantMode, "deny">, number> = {
    always: 0,
    audit: 1,
    prompt: 2,
  };
  return order[next] > order[current] ? next : current;
}

export class PermissionDeniedError extends Error {
  constructor(
    readonly skillId: string,
    readonly secretId: SecretId,
    reason: string,
  ) {
    super(
      `Skill ${JSON.stringify(skillId)} denied access to ${JSON.stringify(secretId)}: ${reason}`,
    );
    this.name = "PermissionDeniedError";
  }
}
