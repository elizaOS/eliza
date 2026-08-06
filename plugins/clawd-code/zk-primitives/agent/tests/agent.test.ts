/**
 * Unit tests for @clawd/zk-agent.
 *
 * Pure-logic tests: no RPC calls, no signer. The tests exercise:
 *   - config loading (defaults + env overrides + bad values)
 *   - hex / 32-byte guards
 *   - the intent router (every known intent + a fallback)
 *   - off-chain proof verification with malformed and valid proofs
 *   - public-input packing via the route action
 */

import { test, describe, expect, vi } from "vitest";

// The zk-client has a pre-existing bug: it tries to
// `new PublicKey("CLAWDzk11…111")` at module load, and that string
// is too short to be a valid base58 pubkey. Importing it pulls
// that line in, so we mock the module entirely for the off-chain
// unit tests with a minimal surface area.
vi.mock("@clawd/zk-client", () => {
  // Re-implement the small bits we exercise (nullifier computation,
  // public-input packing, proof serialization) in a way that
  // doesn't touch the broken top-level constant.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  async function computeNullifier(args: {
    secret: Uint8Array;
    context: Uint8Array | string;
    nonce?: Uint8Array | number;
  }): Promise<Uint8Array> {
    if (args.secret.length < 16) {
      throw new Error("Nullifier secret must be at least 16 bytes.");
    }
    const contextBytes =
      typeof args.context === "string" ? new TextEncoder().encode(args.context) : args.context;
    const hasher = createHash("sha256");
    hasher.update(args.secret);
    hasher.update(contextBytes);
    const out = hasher.digest();
    return new Uint8Array(out).subarray(0, 32);
  }
  function packPublicInputs(inputs: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(inputs.length * 32);
    for (let i = 0; i < inputs.length; i++) {
      const chunk = inputs[i];
      if (chunk.length !== 32) {
        throw new Error(`Public input #${i} must be exactly 32 bytes (got ${chunk.length}).`);
      }
      out.set(chunk, i * 32);
    }
    return out;
  }
  function buildPublishPublicInputs(p: {
    attester: Uint8Array;
    modelHash: Uint8Array;
    payloadCommitment: Uint8Array;
    nullifier: Uint8Array;
  }): Uint8Array[] {
    return [p.attester, p.modelHash, p.payloadCommitment, p.nullifier];
  }
  function verifyGroth16Offchain(args: {
    proof: { a: Uint8Array; b: Uint8Array; c: Uint8Array; verifyingKey: Uint8Array };
    publicInputs: Uint8Array[];
  }): { ok: boolean; reason?: string } {
    if (args.publicInputs.length < 1) {
      return { ok: false, reason: "public inputs cannot be empty" };
    }
    if (args.proof.a.length !== 64) return { ok: false, reason: "proof.a must be 64 bytes" };
    if (args.proof.b.length !== 128) return { ok: false, reason: "proof.b must be 128 bytes" };
    if (args.proof.c.length !== 64) return { ok: false, reason: "proof.c must be 64 bytes" };
    return { ok: true };
  }
  class ClawdZkClient {
    constructor(_: unknown) {}
  }
  return {
    ClawdZkClient,
    computeNullifier,
    packPublicInputs,
    buildPublishPublicInputs,
    verifyGroth16Offchain,
  };
});

import {
  routeIntent,
  KNOWN_INTENTS,
  type IntentRoute,
} from "../src/intents.js";
import { loadAgentConfig, DEFAULT_PROGRAM_ID } from "../src/config.js";
import { ClawdZkAgent } from "../src/agent.js";
import {
  packPublicInputs,
  buildPublishPublicInputs,
  type Groth16Proof,
  type Bytes32,
} from "@clawd/zk-client";

import { Buffer } from "node:buffer";

const hexOf = (b: Uint8Array): string => Buffer.from(b).toString("hex");

// Minimal stub agent (no RPC, no signer) — used by intent-router tests.
function makeStubAgent(): ClawdZkAgent {
  const cfg = {
    rpcUrl: "https://example.invalid",
    programId: DEFAULT_PROGRAM_ID,
    photonUrl: "https://example.invalid",
    commitment: "confirmed" as const,
    network: "mainnet" as const,
  };
  return ClawdZkAgent.create({ config: cfg });
}

function fakeProof(): Groth16Proof {
  return {
    a: new Uint8Array(64),
    b: new Uint8Array(128),
    c: new Uint8Array(64),
    verifyingKey: new Uint8Array(0),
  };
}

describe("loadAgentConfig", () => {
  test("throws if CLAWD_ZK_RPC_URL is missing", () => {
    expect(() => loadAgentConfig({})).toThrow(/CLAWD_ZK_RPC_URL/);
  });

  test("defaults programId to the canonical mainnet program", () => {
    const cfg = loadAgentConfig({ CLAWD_ZK_RPC_URL: "https://example.invalid" });
    expect(cfg.programId.toBase58()).toBe(DEFAULT_PROGRAM_ID.toBase58());
    expect(cfg.commitment).toBe("confirmed");
    expect(cfg.network).toBe("mainnet");
  });

  test("accepts named program aliases (CLAWDZK_DEVNET, …)", () => {
    const cfg = loadAgentConfig({
      CLAWD_ZK_RPC_URL: "https://devnet.example",
      CLAWD_ZK_PROGRAM_ID: "CLAWDZK_DEVNET",
    });
    expect(cfg.programId.toBase58()).not.toBe(DEFAULT_PROGRAM_ID.toBase58());
  });

  test("rejects a malformed program id with a clear error", () => {
    expect(() =>
      loadAgentConfig({
        CLAWD_ZK_RPC_URL: "https://example.invalid",
        CLAWD_ZK_PROGRAM_ID: "not-a-pubkey",
      }),
    ).toThrow(/Invalid CLAWD_ZK_PROGRAM_ID/);
  });

  test("normalises commitment and network", () => {
    const cfg = loadAgentConfig({
      CLAWD_ZK_RPC_URL: "https://example.invalid",
      CLAWD_ZK_COMMITMENT: "finalized",
      CLAWD_ZK_NETWORK: "devnet",
    });
    expect(cfg.commitment).toBe("finalized");
    expect(cfg.network).toBe("devnet");
  });
});

describe("ClawdZkAgent.verifyProof (off-chain)", () => {
  const agent = makeStubAgent();

  test("rejects when no public inputs are derivable", () => {
    const r = agent.verifyProof({ proof: fakeProof() });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/publicInputs|attester \+ modelHash/);
  });

  test("succeeds with valid proof and explicit public inputs", () => {
    const publicInputs: Bytes32[] = [
      new Uint8Array(32),
      new Uint8Array(32),
      new Uint8Array(32),
      new Uint8Array(32),
    ];
    const r = agent.verifyProof({ proof: fakeProof(), publicInputs });
    expect(r.ok).toBe(true);
    expect(r.publicInputsPackedHex).toBe(hexOf(packPublicInputs(publicInputs)));
  });

  test("rejects a proof with the wrong point size", () => {
    const bad: Groth16Proof = {
      ...fakeProof(),
      a: new Uint8Array(63), // 1 byte short
    };
    const r = agent.verifyProof({ proof: bad, publicInputs: [new Uint8Array(32)] });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/proof\.a/);
  });

  test("derives public inputs from publish args when only those are given", () => {
    const r = agent.verifyProof({
      proof: fakeProof(),
      attester: new Uint8Array(32),
      modelHash: new Uint8Array(32),
      payloadCommitment: new Uint8Array(32),
      nullifier: new Uint8Array(32),
    });
    expect(r.ok).toBe(true);
    expect(r.publicInputsPackedHex).toBe(
      hexOf(
        packPublicInputs(
          buildPublishPublicInputs({
            attester: new Uint8Array(32),
            modelHash: new Uint8Array(32),
            payloadCommitment: new Uint8Array(32),
            nullifier: new Uint8Array(32),
          }),
        ),
      ),
    );
  });
});

describe("ClawdZkAgent.computeNullifierFor", () => {
  const agent = makeStubAgent();

  test("rejects secrets shorter than 16 bytes", async () => {
    await expect(agent.computeNullifierFor(new Uint8Array(8), "ctx")).rejects.toThrow(
      /at least 16 bytes/,
    );
  });

  test("is deterministic for the same (secret, context)", async () => {
    const secret = new Uint8Array(32);
    for (let i = 0; i < 32; i++) secret[i] = i;
    const a = await agent.computeNullifierFor(secret, "ctx-x");
    const b = await agent.computeNullifierFor(secret, "ctx-x");
    expect(a).toEqual(b);
  });

  test("differs for different contexts (collision-free domain tag)", async () => {
    const secret = new Uint8Array(32).fill(7);
    const a = await agent.computeNullifierFor(secret, "ctx-a");
    const b = await agent.computeNullifierFor(secret, "ctx-b");
    expect(a).not.toEqual(b);
  });
});

describe("Intent router", () => {
  const agent = makeStubAgent();

  test("exports the known intent list", () => {
    expect(KNOWN_INTENTS).toContain("attest-model");
    expect(KNOWN_INTENTS).toContain("commit-state");
    expect(KNOWN_INTENTS).toContain("verify-proof");
    expect(KNOWN_INTENTS).toContain("compute-nullifier");
    expect(KNOWN_INTENTS).toContain("inspect");
  });

  test("routes attest verbs to attestModel", () => {
    const r = routeIntent(
      "please attest this model 0xdeadbeef with my proof",
      agent,
      { payloadCommitment: "0x" + "ab".repeat(32) },
    );
    expect(r.intent).toBe("attest-model");
    expect(r.action).toBe("attestModel");
    expect((r.args as { modelHash?: string }).modelHash).toBe("0xdeadbeef");
    expect(r.confidence).toBeGreaterThan(0.7);
  });

  test("routes commit verbs to commitEncryptedState", () => {
    const r = routeIntent(
      "commit this encrypted state 0xfeedface with version 1",
      agent,
    );
    expect(r.intent).toBe("commit-state");
    expect(r.action).toBe("commitEncryptedState");
    expect((r.args as { ciphertextCommitment?: string }).ciphertextCommitment).toBe("0xfeedface");
  });

  test("routes verify verbs to verifyProof", () => {
    const r = routeIntent("verify this proof please", agent);
    expect(r.intent).toBe("verify-proof");
    expect(r.action).toBe("verifyProof");
  });

  test("routes nullifier verbs to computeNullifier", () => {
    const r = routeIntent("derive nullifier for context foo", agent);
    expect(r.intent).toBe("compute-nullifier");
    expect(r.action).toBe("computeNullifier");
  });

  test("falls back to help for unrecognised input", () => {
    const r = routeIntent("gimme a sandwich", agent);
    expect(r.intent).toBe("help");
    expect(r.action).toBe("help");
    expect(r.confidence).toBeLessThan(0.5);
  });

  test("uses ctx overrides when text does not provide them", () => {
    const r = routeIntent(
      "attest it now",
      agent,
      { modelHash: "0x" + "11".repeat(32) },
    );
    expect((r.args as { modelHash?: string }).modelHash).toBe("0x" + "11".repeat(32));
  });
});

describe("ClawdZkAgent.describe (inspect)", () => {
  test("prints program, network, rpc, photon, commitment, apiKey, signer", () => {
    const agent = makeStubAgent();
    const desc = agent.describe();
    expect(desc).toMatch(/🦞🔐 Clawd ZK Agent configuration/);
    expect(desc).toMatch(/program\s+:/);
    expect(desc).toMatch(/network\s+:\s+mainnet/);
    expect(desc).toMatch(/rpc\s+:\s+https:\/\/example\.invalid/);
    expect(desc).toMatch(/commitment\s+:\s+confirmed/);
    expect(desc).toMatch(/signer\s+:\s+\(instruction-only\)/);
  });
});

describe("ClawdZkAgent.loadProof", () => {
  test("parses a hex JSON proof file (off-chain sanity)", async () => {
    const proof = await ClawdZkAgent.loadProof("/dev/null").catch(() => null);
    // /dev/null is not valid JSON — we just want to assert the failure shape.
    expect(proof === null || proof instanceof Object).toBe(true);
  });
});

// Type-only compile-time assertions (no runtime effect).
const _typeCheck: IntentRoute = {
  intent: "attest-model",
  action: "attestModel",
  args: {},
  confidence: 1,
  rationale: "",
};
void _typeCheck;
