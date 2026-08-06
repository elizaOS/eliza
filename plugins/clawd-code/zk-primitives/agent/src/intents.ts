/**
 * Natural-language intent router for the Clawd ZK Agent.
 *
 * Maps a free-form text input (e.g. "attest this model with hash 0xab12…")
 * to one of the agent's typed methods. Used by:
 *   - the `clawd-zk-agent` CLI (`clawd-zk-agent ask "…"`)
 *   - the Clawd REPL bridge (`clawd-code code "use the zk agent to attest…"`)
 *   - any external LLM that wants to drive the agent
 *
 * The router is deliberately deterministic and rule-based — no model
 * calls — so it is fast, predictable, and CI-testable.
 */

import { ClawdZkAgent } from "./agent.js";
// `ClawdZkAgent` is also used as a value (in `dispatchRoute` below),
// so this is a regular import, not `import type`.

/** Intents the agent knows how to handle. */
export const KNOWN_INTENTS = [
  "attest-model",
  "commit-state",
  "verify-proof",
  "compute-nullifier",
  "inspect",
  "help",
] as const;
export type KnownIntent = (typeof KNOWN_INTENTS)[number];

/** A concrete, executable plan — the agent method + its arguments. */
export interface IntentRoute {
  intent: KnownIntent;
  /** The agent method to invoke (or a synthetic action for `help` / `inspect`). */
  action:
    | "attestModel"
    | "commitEncryptedState"
    | "verifyProof"
    | "computeNullifier"
    | "describe"
    | "help";
  /** Args the caller should pass to the agent method. */
  args: Record<string, unknown>;
  /** Confidence score 0..1. Useful for LLM-driven callers. */
  confidence: number;
  /** Human-readable one-liner explaining the match. */
  rationale: string;
}

/** Extra context the caller can supply (e.g. the current model hash). */
export interface IntentContext {
  modelHash?: string;
  payloadCommitment?: string;
  ciphertextCommitment?: string;
  stateVersion?: number | bigint;
  context?: string;
  proofPath?: string;
}

interface MatchCandidate {
  intent: KnownIntent;
  action: IntentRoute["action"];
  weight: number;
  rationale: string;
  args: Record<string, unknown>;
}

function pickHex(s: string): string | undefined {
  const m = s.match(/0x[0-9a-fA-F]+/);
  return m?.[0];
}

const ATTEST_REGEX = /\b(attest|attestation|publish|publish_attestation)\b/i;
const COMMIT_REGEX = /\b(commit|commit_state|encrypted.?state|ciphertext)\b/i;
const VERIFY_REGEX = /\b(verify|check|validate)\b/i;
const NULLIFIER_REGEX = /\b(nullifier|derive|compute_nullifier)\b/i;
const INSPECT_REGEX = /\b(inspect|config|status|show)\b/i;
const HELP_REGEX = /\b(help|usage|how|what)\b/i;

/**
 * Route a free-form text input to a typed intent + args.
 *
 * Pure function — does NOT call any agent methods. The caller invokes
 * the returned `action` on the agent.
 */
export function routeIntent(
  text: string,
  _agent: ClawdZkAgent,
  ctx: IntentContext = {},
): IntentRoute {
  const candidates: MatchCandidate[] = [];

  // ----- attest-model -----
  if (ATTEST_REGEX.test(text)) {
    const modelHash = pickHex(text) ?? ctx.modelHash;
    const payloadCommitment = ctx.payloadCommitment;
    candidates.push({
      intent: "attest-model",
      action: "attestModel",
      weight: 0.7 + (modelHash ? 0.2 : 0) + (payloadCommitment ? 0.1 : 0),
      rationale: `Matched attestation verb${modelHash ? " + model hash" : ""}.`,
      args: {
        modelHash,
        payloadCommitment,
        context: ctx.context ?? `model-attest:v1:${modelHash ?? "adhoc"}`,
        proofPath: ctx.proofPath,
      },
    });
  }

  // ----- commit-state -----
  if (COMMIT_REGEX.test(text)) {
    const ciphertextCommitment = pickHex(text) ?? ctx.ciphertextCommitment;
    candidates.push({
      intent: "commit-state",
      action: "commitEncryptedState",
      weight: 0.7 + (ciphertextCommitment ? 0.2 : 0) + (ctx.modelHash ? 0.1 : 0),
      rationale: `Matched commit verb${ciphertextCommitment ? " + ciphertext commitment" : ""}.`,
      args: {
        modelHash: ctx.modelHash,
        ciphertextCommitment,
        stateVersion: ctx.stateVersion ?? 1,
        proofPath: ctx.proofPath,
      },
    });
  }

  // ----- verify-proof -----
  if (VERIFY_REGEX.test(text)) {
    candidates.push({
      intent: "verify-proof",
      action: "verifyProof",
      weight: 0.8,
      rationale: "Matched verify verb.",
      args: {
        proofPath: ctx.proofPath,
        modelHash: ctx.modelHash,
        payloadCommitment: ctx.payloadCommitment,
        nullifier: ctx.ciphertextCommitment, // user supplies a hex if needed
      },
    });
  }

  // ----- compute-nullifier -----
  if (NULLIFIER_REGEX.test(text)) {
    candidates.push({
      intent: "compute-nullifier",
      action: "computeNullifier",
      weight: 0.85,
      rationale: "Matched nullifier verb.",
      args: { context: ctx.context ?? pickHex(text) ?? "default" },
    });
  }

  // ----- inspect -----
  if (INSPECT_REGEX.test(text) && !ATTEST_REGEX.test(text) && !COMMIT_REGEX.test(text)) {
    candidates.push({
      intent: "inspect",
      action: "describe",
      weight: 0.7,
      rationale: "Matched inspect verb.",
      args: {},
    });
  }

  // ----- help -----
  if (HELP_REGEX.test(text) && !ATTEST_REGEX.test(text) && !COMMIT_REGEX.test(text)) {
    candidates.push({
      intent: "help",
      action: "help",
      weight: 0.6,
      rationale: "Matched help verb.",
      args: {},
    });
  }

  // Fallback: empty / unrecognised
  if (candidates.length === 0) {
    return {
      intent: "help",
      action: "help",
      args: { reason: `Could not match any known intent in: "${text}"` },
      confidence: 0.1,
      rationale: "No verb match; defaulting to help.",
    };
  }

  candidates.sort((a, b) => b.weight - a.weight);
  const winner = candidates[0];
  return {
    intent: winner.intent,
    action: winner.action,
    args: winner.args,
    confidence: Math.min(1, winner.weight),
    rationale: winner.rationale,
  };
}

/**
 * Execute a route against an agent. Convenience wrapper for the
 * CLI / REPL — single call that does the route + dispatch.
 */
export async function dispatchRoute(
  route: IntentRoute,
  agent: ClawdZkAgent,
): Promise<unknown> {
  switch (route.action) {
    case "attestModel": {
      const { modelHash, payloadCommitment, context, proofPath } = route.args as {
        modelHash?: string;
        payloadCommitment?: string;
        context: string;
        proofPath?: string;
      };
      if (!modelHash) throw new Error("attestModel intent requires a modelHash (hex).");
      if (!payloadCommitment) throw new Error("attestModel intent requires a payloadCommitment (hex).");
      if (!proofPath) throw new Error("attestModel intent requires a proofPath (JSON file).");
      const proof = await ClawdZkAgent.loadProof(proofPath);
      const hexToBytes = (s: string) =>
        Uint8Array.from(s.replace(/^0x/i, "").match(/.{1,2}/g)?.map((b) => parseInt(b, 16)) ?? []);
      return agent.attestModel({
        modelHash: hexToBytes(modelHash) as unknown as Parameters<typeof agent.attestModel>[0]["modelHash"],
        payloadCommitment: hexToBytes(payloadCommitment) as unknown as Parameters<typeof agent.attestModel>[0]["payloadCommitment"],
        proof,
        context,
      });
    }
    case "commitEncryptedState": {
      const { modelHash, ciphertextCommitment, stateVersion, proofPath } = route.args as {
        modelHash?: string;
        ciphertextCommitment?: string;
        stateVersion: number | bigint;
        proofPath?: string;
      };
      if (!ciphertextCommitment) throw new Error("commitEncryptedState intent requires a ciphertextCommitment (hex).");
      if (!proofPath) throw new Error("commitEncryptedState intent requires a proofPath (JSON file).");
      const proof = await ClawdZkAgent.loadProof(proofPath);
      const hexToBytes = (s: string) =>
        Uint8Array.from(s.replace(/^0x/i, "").match(/.{1,2}/g)?.map((b) => parseInt(b, 16)) ?? []);
      return agent.commitEncryptedState({
        modelHash: (modelHash ? hexToBytes(modelHash) : new Uint8Array(32)) as unknown as Parameters<typeof agent.commitEncryptedState>[0]["modelHash"],
        ciphertextCommitment: hexToBytes(ciphertextCommitment) as unknown as Parameters<typeof agent.commitEncryptedState>[0]["ciphertextCommitment"],
        stateVersion,
        proof,
        context: "commit-state",
      });
    }
    case "verifyProof": {
      const { proofPath } = route.args as { proofPath?: string };
      if (!proofPath) throw new Error("verifyProof intent requires a proofPath (JSON file).");
      const proof = await ClawdZkAgent.loadProof(proofPath);
      return agent.verifyProof({ proof });
    }
    case "computeNullifier": {
      const { context } = route.args as { context: string };
      // For a CLI-driven nullifier we use a deterministic 32-byte
      // zero-secret here. Production code should pass a real secret.
      const secret = new Uint8Array(32);
      return agent.computeNullifierFor(secret, context);
    }
    case "describe":
      return agent.describe();
    case "help":
      return HELP_TEXT;
    default:
      throw new Error(`Unhandled action: ${(route as { action: string }).action}`);
  }
}

const HELP_TEXT = `🦞🔐 clawd-zk-agent — recognised intents

  attest <modelHash> <payloadCommitment> <proof.json>  → agent.attestModel
  commit <ciphertextCommitment> <stateVersion> <proof.json> → agent.commitEncryptedState
  verify <proof.json>                                  → agent.verifyProof
  nullifier <context>                                  → agent.computeNullifierFor
  inspect                                               → agent.describe
  help                                                  → this text

You can also use the natural-language router:

  clawd-zk-agent ask "attest this model 0xab12… with proof.json"
`;
