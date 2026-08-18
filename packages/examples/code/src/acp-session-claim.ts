/**
 * Authenticates and applies the single session-environment handoff consumed by
 * a pre-initialized eliza-code ACP child. A claimed child is deliberately not
 * reusable: callers clear the applied environment and dispose its process.
 */
import { timingSafeEqual } from "node:crypto";
import { delimiter, isAbsolute } from "node:path";

export type AcpSessionClaimMeta = {
  elizaSessionClaim?: {
    token?: unknown;
    env?: unknown;
    executionPath?: unknown;
  };
};

export class AcpWarmSessionClaim {
  private token: string;
  private consumed = false;
  private readonly appliedKeys = new Set<string>();

  constructor(token = "") {
    this.token = token.trim();
  }

  get wasConsumed(): boolean {
    return this.consumed;
  }

  apply(meta: unknown, targetEnv = process.env): void {
    const record =
      meta && typeof meta === "object" && !Array.isArray(meta)
        ? (meta as AcpSessionClaimMeta)
        : undefined;
    const claim = record?.elizaSessionClaim;
    if (this.consumed) throw new Error("warm-session claim already consumed");
    if (!this.token) {
      if (claim) throw new Error("unexpected warm-session claim");
      return;
    }
    if (
      !claim ||
      typeof claim.token !== "string" ||
      !this.equalToken(claim.token)
    ) {
      throw new Error("invalid warm-session claim");
    }
    if (
      !claim.env ||
      typeof claim.env !== "object" ||
      Array.isArray(claim.env)
    ) {
      throw new Error("invalid warm-session environment");
    }
    const entries = Object.entries(claim.env as Record<string, unknown>);
    if (entries.length > 256) {
      throw new Error("warm-session environment is too large");
    }
    const validatedEntries: Array<[string, string]> = [];
    for (const [key, value] of entries) {
      if (
        !/^[A-Z_][A-Z0-9_]*$/.test(key) ||
        key === "ELIZA_ACP_WARM_CLAIM_TOKEN" ||
        typeof value !== "string"
      ) {
        throw new Error("invalid warm-session environment entry");
      }
      validatedEntries.push([key, value]);
    }
    if (
      typeof claim.executionPath !== "string" ||
      !isTrustedExecutionPath(claim.executionPath)
    ) {
      throw new Error("invalid warm-session execution path");
    }
    for (const [key, value] of validatedEntries) {
      if (key === "PATH") continue;
      targetEnv[key] = value;
      this.appliedKeys.add(key);
    }
    targetEnv.PATH = claim.executionPath;
    this.appliedKeys.add("PATH");
    this.consumed = true;
    this.token = "";
  }

  clear(targetEnv = process.env): void {
    for (const key of this.appliedKeys) delete targetEnv[key];
    this.appliedKeys.clear();
  }

  private equalToken(candidate: string): boolean {
    const expected = Buffer.from(this.token);
    const received = Buffer.from(candidate);
    return (
      expected.length > 0 &&
      expected.length === received.length &&
      timingSafeEqual(expected, received)
    );
  }
}

function isTrustedExecutionPath(value: string): boolean {
  if (!value || value.includes("\0")) return false;
  return value
    .split(delimiter)
    .every((entry) => entry.length > 0 && isAbsolute(entry));
}
