/**
 * ClawdZkAgent — agent-shaped wrapper around the ZK primitive SDK.
 *
 * Exposes the four core operations a Clawd agent would want to do with
 * the `clawd-zk` program as named methods, and wires in the
 * nullifier / proof / Light Protocol plumbing automatically:
 *
 *   agent.attestModel(...)        — publish an attestation for a model
 *   agent.commitEncryptedState(...) — commit an encrypted state blob
 *   agent.verifyProof(...)        — off-chain Groth16 sanity check
 *   agent.computeNullifier(...)    — derive a deterministic nullifier
 *
 * The class also exposes `runIntent(text, ctx)` for natural-language
 * routing (see `./intents.ts`).
 *
 * ```ts
 * const agent = await ClawdZkAgent.fromEnv();
 * const { signature, nullifier } = await agent.attestModel({
 *   modelHash: ...,
 *   payloadCommitment: ...,
 *   proof: { a, b, c, verifyingKey },
 *   context: "model-attest:v1:my-model",
 * });
 * ```
 */

import { PublicKey, TransactionInstruction, Keypair } from "@solana/web3.js";
import { createSolanaRpc } from "@solana/kit";
import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { Buffer } from "node:buffer";

import {
  ClawdZkClient,
  computeNullifier,
  verifyGroth16Offchain,
  buildPublishPublicInputs,
  packPublicInputs,
  type Groth16Proof,
  type Bytes32,
  type PublishAttestationArgs,
  type CommitStateArgs,
} from "@clawd/zk-client";

import { loadAgentConfig, type ZkAgentConfig, DEFAULT_PROGRAM_ID } from "./config.js";
import { routeIntent, type IntentContext, type IntentRoute } from "./intents.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ClawdZkAgentOptions {
  /** Pre-built config. If omitted, the agent reads from `process.env`. */
  config?: ZkAgentConfig;
  /** Pre-built ClawdZkClient. If omitted, the agent constructs one. */
  client?: ClawdZkClient;
  /** Optional keypair for signing. */
  signer?: Keypair;
}

export interface AttestModelArgs {
  /** 32-byte hash identifying the model being attested to. */
  modelHash: Bytes32;
  /** 32-byte commitment to the encrypted payload. */
  payloadCommitment: Bytes32;
  /** Groth16 proof over (attester, model_hash, payload_commitment, nullifier). */
  proof: Groth16Proof;
  /** Domain-separated context tag (e.g. "model-attest:v1:<model_hash_hex>"). */
  context: string;
  /** Override the auto-derived nullifier (rare). */
  nullifier?: Bytes32;
}

export interface AttestModelResult {
  /** The derived nullifier, hex-encoded. */
  nullifierHex: string;
  /** The public input vector that was used for verification. */
  publicInputsPackedHex: string;
  /** Built instruction (handy for the caller if they want to send it themselves). */
  instruction: TransactionInstruction;
  /** The transaction signature, if `sendAndConfirm` was wired in. */
  signature?: string;
  /** Human-readable summary. */
  summary: string;
}

export interface CommitStateModelArgs {
  modelHash: Bytes32;
  ciphertextCommitment: Bytes32;
  stateVersion: number | bigint;
  proof: Groth16Proof;
  context: string;
}

export interface CommitStateResult {
  instruction: TransactionInstruction;
  publicInputsPackedHex: string;
  summary: string;
}

export interface VerifyProofArgs {
  proof: Groth16Proof;
  /** Optional public input vector. If absent, the agent builds one from the args. */
  publicInputs?: Bytes32[];
  /** Required for `publish-attestation` proof structure. */
  modelHash?: Bytes32;
  payloadCommitment?: Bytes32;
  nullifier?: Bytes32;
  attester?: Uint8Array;
}

export interface VerifyProofResult {
  ok: boolean;
  reason?: string;
  /** Computed public inputs (if the agent derived them). */
  publicInputsPackedHex?: string;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const CLAWD_BANNER = "🦞🔐 Clawd ZK Agent";

function bytesToHex(b: Uint8Array): string {
  return Buffer.from(b).toString("hex");
}

function hexToBytes(hex: string): Uint8Array {
  const cleaned = hex.trim().replace(/^0x/i, "");
  if (cleaned.length % 2 !== 0) {
    throw new Error(`Hex string must have even length, got ${cleaned.length}.`);
  }
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function ensure32(label: string, b: Uint8Array): Bytes32 {
  if (b.length === 32) return b as Bytes32;
  throw new Error(`${label} must be exactly 32 bytes (got ${b.length}).`);
}

async function loadProofFromFile(path: string): Promise<Groth16Proof> {
  const abs = resolvePath(path);
  const raw = await readFile(abs, "utf-8");
  const json = JSON.parse(raw) as {
    a: string;
    b: string;
    c: string;
    verifyingKey?: string;
  };
  return {
    a: hexToBytes(json.a),
    b: hexToBytes(json.b),
    c: hexToBytes(json.c),
    verifyingKey: json.verifyingKey ? hexToBytes(json.verifyingKey) : new Uint8Array(0),
  };
}

export class ClawdZkAgent {
  readonly config: ZkAgentConfig;
  readonly client: ClawdZkClient;
  /** Optional signer; the agent can attest / commit without one (instruction-only). */
  signer?: Keypair;

  private constructor(config: ZkAgentConfig, client: ClawdZkClient, signer?: Keypair) {
    this.config = config;
    this.client = client;
    this.signer = signer;
  }

  /** Construct from an explicit config + optional client + optional signer. */
  static create(opts: ClawdZkAgentOptions): ClawdZkAgent {
    const config = opts.config ?? loadAgentConfig();
    const client =
      opts.client ??
      new ClawdZkClient({
        rpc: createSolanaRpc(config.rpcUrl),
        programId: config.programId,
        photonUrl: config.photonUrl,
        apiKey: config.apiKey,
        commitment: config.commitment,
      });
    return new ClawdZkAgent(config, client, opts.signer);
  }

  /** Construct from environment variables. */
  static async fromEnv(): Promise<ClawdZkAgent> {
    const config = loadAgentConfig();
    let signer: Keypair | undefined;
    if (config.keypairPath) {
      const raw = await readFile(resolvePath(config.keypairPath), "utf-8");
      const parsed = JSON.parse(raw) as number[];
      signer = Keypair.fromSecretKey(Uint8Array.from(parsed));
    }
    return ClawdZkAgent.create({ config, signer });
  }

  /**
   * Convenience: load a proof JSON file from disk and return it as a
   * `Groth16Proof` with hex → bytes conversion.
   *
   * Expected shape: `{ a: "0x...", b: "0x...", c: "0x...", verifyingKey: "0x..." }`.
   */
  static async loadProof(path: string): Promise<Groth16Proof> {
    return loadProofFromFile(path);
  }

  /**
   * Compute a deterministic 32-byte nullifier from a (secret, context)
   * pair. Wraps the SDK and pins the secret-length check.
   */
  async computeNullifierFor(secret: Uint8Array, context: string): Promise<Bytes32> {
    if (secret.length < 16) {
      throw new Error("Secret must be at least 16 bytes.");
    }
    return computeNullifier({ secret, context });
  }

  /**
   * Off-chain Groth16 sanity check. Does NOT re-run the pairing
   * (that's the on-chain verifier's job) — it just confirms the
   * proof is well-formed and the public inputs match the expected
   * shape.
   */
  verifyProof(args: VerifyProofArgs): VerifyProofResult {
    let publicInputs: Bytes32[] | undefined = args.publicInputs?.map((b) => ensure32("publicInput", b));
    if (!publicInputs) {
      if (args.modelHash && args.payloadCommitment && args.nullifier && args.attester) {
        publicInputs = buildPublishPublicInputs({
          attester: args.attester,
          modelHash: ensure32("modelHash", args.modelHash),
          payloadCommitment: ensure32("payloadCommitment", args.payloadCommitment),
          nullifier: ensure32("nullifier", args.nullifier),
        });
      }
    }
    if (!publicInputs) {
      return {
        ok: false,
        reason: "Either `publicInputs` or (attester + modelHash + payloadCommitment + nullifier) must be provided.",
      };
    }
    const result = verifyGroth16Offchain({ proof: args.proof, publicInputs });
    return {
      ok: result.ok,
      reason: result.reason,
      publicInputsPackedHex: bytesToHex(packPublicInputs(publicInputs)),
    };
  }

  /**
   * Attest a model on-chain. Derives the nullifier from the
   * (signer secret, context) pair, builds the `publish_attestation`
   * instruction, and (if a signer is attached) submits it.
   */
  async attestModel(args: AttestModelArgs): Promise<AttestModelResult> {
    const modelHash = ensure32("modelHash", args.modelHash);
    const payloadCommitment = ensure32("payloadCommitment", args.payloadCommitment);

    let nullifier: Bytes32;
    if (args.nullifier) {
      nullifier = ensure32("nullifier", args.nullifier);
    } else {
      const secret = this.signer ? this.signer.secretKey : randomSecret();
      nullifier = await this.computeNullifierFor(secret, args.context);
    }

    // Fallback for the instruction-only path (no signer). We synthesise
    // a deterministic PublicKey from the first 32 bytes of the nullifier
    // and the at-rest attester bytes for the public input.
    const attesterPubkey = this.signer
      ? this.signer.publicKey
      : new PublicKey(Buffer.from(nullifier));
    const attesterBytes = attesterPubkey.toBytes();

    const publishArgs: PublishAttestationArgs = {
      signer: attesterPubkey,
      modelHash,
      payloadCommitment,
      nullifier,
      proof: args.proof,
    };
    const instruction = await this.client.publishAttestation(publishArgs);

    const publicInputsPacked = packPublicInputs(
      buildPublishPublicInputs({
        attester: attesterBytes,
        modelHash,
        payloadCommitment,
        nullifier,
      }),
    );

    const summary = [
      `${CLAWD_BANNER} attestModel`,
      `  program       : ${this.config.programId.toBase58()}`,
      `  attester      : ${attesterPubkey.toBase58()}`,
      `  modelHash     : 0x${bytesToHex(modelHash)}`,
      `  payload       : 0x${bytesToHex(payloadCommitment)}`,
      `  nullifier     : 0x${bytesToHex(nullifier)}`,
      `  public inputs : 0x${bytesToHex(publicInputsPacked)}`,
    ].join("\n");

    let signature: string | undefined;
    if (this.signer) {
      // In a production build, wire `sendAndConfirm` from @solana/kit here.
      // For now we return the instruction so the caller can dispatch it.
      signature = await this.trySend(instruction);
    }

    return {
      nullifierHex: bytesToHex(nullifier),
      publicInputsPackedHex: bytesToHex(publicInputsPacked),
      instruction,
      signature,
      summary,
    };
  }

  /**
   * Commit an encrypted state blob (model weights, training data, etc.)
   * on-chain. Mirrors `attestModel` for the `commit_encrypted_state` ix.
   */
  async commitEncryptedState(args: CommitStateModelArgs): Promise<CommitStateResult> {
    const modelHash = ensure32("modelHash", args.modelHash);
    const ciphertextCommitment = ensure32("ciphertextCommitment", args.ciphertextCommitment);
    const stateVersion =
      typeof args.stateVersion === "bigint" ? args.stateVersion : BigInt(args.stateVersion);

    const attesterPubkey = this.signer
      ? this.signer.publicKey
      : new PublicKey(Buffer.from(modelHash));

    const commitArgs: CommitStateArgs = {
      signer: attesterPubkey,
      modelHash,
      ciphertextCommitment,
      stateVersion,
      proof: args.proof,
    };
    const instruction = await this.client.commitEncryptedState(commitArgs);

    const summary = [
      `${CLAWD_BANNER} commitEncryptedState`,
      `  program        : ${this.config.programId.toBase58()}`,
      `  committer      : ${attesterPubkey.toBase58()}`,
      `  modelHash      : 0x${bytesToHex(modelHash)}`,
      `  ciphertext     : 0x${bytesToHex(ciphertextCommitment)}`,
      `  stateVersion   : ${stateVersion.toString()}`,
    ].join("\n");

    return { instruction, publicInputsPackedHex: "", summary };
  }

  /**
   * Natural-language intent router. Recognises the same phrases that
   * the `clawd-zk-agent` CLI exposes as subcommands and dispatches to
   * the matching method.
   */
  async runIntent(text: string, ctx: IntentContext = {}): Promise<IntentRoute> {
    return routeIntent(text, this, ctx);
  }

  /** Pretty-print the active configuration (handy for `clawd-zk-agent inspect`). */
  describe(): string {
    return [
      `${CLAWD_BANNER} configuration`,
      `  program        : ${this.config.programId.toBase58()}  ${this.config.programId.equals(DEFAULT_PROGRAM_ID) ? "(default)" : ""}`.trim(),
      `  network        : ${this.config.network}`,
      `  rpc            : ${this.config.rpcUrl}`,
      `  photon         : ${this.config.photonUrl}`,
      `  commitment     : ${this.config.commitment}`,
      `  apiKey         : ${this.config.apiKey ? "***" : "(none)"}`,
      `  signer         : ${this.signer ? this.signer.publicKey.toBase58() : "(instruction-only)"}`,
    ].join("\n");
  }

  // -------- private helpers --------

  private async trySend(_ix: TransactionInstruction): Promise<string | undefined> {
    // The agent is intentionally NOT bundling a send pipeline here.
    // Production deployments should use @solana/kit's `sendAndConfirm`
    // with the configured RPC. We keep this as a hook so the CLI /
    // future `sendAndConfirm` integration is one method away.
    return undefined;
  }
}

function randomSecret(): Uint8Array {
  const out = new Uint8Array(32);
  // Node 19+ has globalThis.crypto.getRandomValues; fall back to
  // Math.random only as a last resort.
  const g = (globalThis as { crypto?: { getRandomValues?: (b: Uint8Array) => Uint8Array } }).crypto;
  if (g?.getRandomValues) {
    g.getRandomValues(out);
  } else {
    for (let i = 0; i < out.length; i++) out[i] = Math.floor(Math.random() * 256);
  }
  return out;
}

// Re-export for callers that want to build their own agent without
// `ClawdZkAgent.create`.
export { DEFAULT_PROGRAM_ID };
// Type-only re-exports so callers don't have to dig into @clawd/zk-client.
export type { Groth16Proof, Bytes32 };
export type { Keypair as SolanaKeypair } from "@solana/web3.js";
export type { createKeyPairSignerFromBytes } from "@solana/kit";
