#!/usr/bin/env node
/**
 * clawd-zk-agent — CLI entry point.
 *
 * Subcommands:
 *
 *   clawd-zk-agent inspect
 *     Print the active configuration (RPC, program, network, signer).
 *
 *   clawd-zk-agent attest <modelHash> <payloadCommitment> <proof.json> [--context <ctx>]
 *     Build and (when a signer is attached) submit a publish_attestation
 *     instruction. The proof is read from <proof.json> as
 *     `{ a, b, c, verifyingKey }` (hex strings).
 *
 *   clawd-zk-agent commit <ciphertextCommitment> <stateVersion> <proof.json> [--model <modelHash>]
 *     Build a commit_encrypted_state instruction.
 *
 *   clawd-zk-agent verify <proof.json>
 *     Off-chain Groth16 sanity check (point sizes + public input packing).
 *
 *   clawd-zk-agent nullifier <context>
 *     Derive a deterministic 32-byte nullifier for the given context.
 *
 *   clawd-zk-agent ask "<natural language>"
 *     Use the deterministic intent router to map the text to an action,
 *     then dispatch it.
 *
 *   clawd-zk-agent help
 *     Print this help.
 */

import { Buffer } from "node:buffer";
import { ClawdZkAgent } from "./agent.js";
import { routeIntent } from "./intents.js";

const BANNER = "🦞🔐 clawd-zk-agent";

function printUsage(): void {
  console.log(`${BANNER} — subcommands

  inspect
      Show the active configuration.

  attest <modelHash> <payloadCommitment> <proof.json> [--context <ctx>]
      Build a publish_attestation instruction.

  commit <ciphertextCommitment> <stateVersion> <proof.json> [--model <modelHash>]
      Build a commit_encrypted_state instruction.

  verify <proof.json>
      Off-chain Groth16 sanity check.

  nullifier <context>
      Derive a deterministic 32-byte nullifier for the given context.

  ask "<natural language>"
      Use the intent router to map free-form text to an action.

  help
      Print this help.

Environment:
  CLAWD_ZK_RPC_URL          (required)  Solana RPC endpoint.
  CLAWD_ZK_PROGRAM_ID       (optional)  clawd-zk program id.
  CLAWD_ZK_PHOTON_URL       (optional)  Photon indexer URL.
  CLAWD_ZK_API_KEY          (optional)  RPC API key.
  CLAWD_ZK_COMMITMENT       (optional)  processed | confirmed | finalized.
  CLAWD_ZK_KEYPAIR          (optional)  Path to a Solana keypair JSON.
  CLAWD_ZK_NETWORK          (optional)  mainnet | devnet | localnet.
`);
}

function readFlag(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

function parseHex32(label: string, hex: string): Uint8Array {
  const cleaned = hex.trim().replace(/^0x/i, "");
  if (cleaned.length !== 64) {
    throw new Error(`${label} must be 32 bytes (64 hex chars); got ${cleaned.length}.`);
  }
  return Uint8Array.from(cleaned.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
    printUsage();
    return;
  }

  const sub = argv[0];
  const tail = argv.slice(1);

  if (sub === "inspect") {
    const agent = await ClawdZkAgent.fromEnv();
    console.log(agent.describe());
    return;
  }

  if (sub === "ask") {
    const text = tail.join(" ").trim();
    if (!text) throw new Error('Usage: clawd-zk-agent ask "<natural language>"');
    const agent = await ClawdZkAgent.fromEnv();
    const route = routeIntent(text, agent);
    console.log(JSON.stringify({ route }, null, 2));
    return;
  }

  if (sub === "verify") {
    const proofPath = tail[0];
    if (!proofPath) throw new Error("Usage: clawd-zk-agent verify <proof.json>");
    const agent = await ClawdZkAgent.fromEnv();
    const proof = await ClawdZkAgent.loadProof(proofPath);
    const result = agent.verifyProof({ proof });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (sub === "nullifier") {
    const context = tail[0];
    if (!context) throw new Error("Usage: clawd-zk-agent nullifier <context>");
    const agent = await ClawdZkAgent.fromEnv();
    const nullifier = await agent.computeNullifierFor(new Uint8Array(32), context);
    console.log(`🦞🔐 nullifier: 0x${Buffer.from(nullifier).toString("hex")}`);
    return;
  }

  if (sub === "attest") {
    const [modelHashHex, payloadCommitmentHex, proofPath] = tail;
    if (!modelHashHex || !payloadCommitmentHex || !proofPath) {
      throw new Error("Usage: clawd-zk-agent attest <modelHash> <payloadCommitment> <proof.json> [--context <ctx>]");
    }
    const context = readFlag(tail, "--context") ?? `model-attest:v1:${modelHashHex.slice(0, 12)}`;
    const agent = await ClawdZkAgent.fromEnv();
    const proof = await ClawdZkAgent.loadProof(proofPath);
    const result = await agent.attestModel({
      modelHash: parseHex32("modelHash", modelHashHex) as never,
      payloadCommitment: parseHex32("payloadCommitment", payloadCommitmentHex) as never,
      proof,
      context,
    });
    console.log(result.summary);
    if (result.signature) console.log(`signature: ${result.signature}`);
    return;
  }

  if (sub === "commit") {
    const [ciphertextCommitmentHex, stateVersionStr, proofPath] = tail;
    if (!ciphertextCommitmentHex || !stateVersionStr || !proofPath) {
      throw new Error("Usage: clawd-zk-agent commit <ciphertextCommitment> <stateVersion> <proof.json> [--model <modelHash>]");
    }
    const modelHashHex = readFlag(tail, "--model");
    const stateVersion = BigInt(stateVersionStr);
    const agent = await ClawdZkAgent.fromEnv();
    const proof = await ClawdZkAgent.loadProof(proofPath);
    const result = await agent.commitEncryptedState({
      modelHash: (modelHashHex
        ? parseHex32("modelHash", modelHashHex)
        : new Uint8Array(32)) as never,
      ciphertextCommitment: parseHex32("ciphertextCommitment", ciphertextCommitmentHex) as never,
      stateVersion,
      proof,
      context: `commit-state:v1:${stateVersion}`,
    });
    console.log(result.summary);
    return;
  }

  throw new Error(`Unknown subcommand: ${sub}. Run "clawd-zk-agent help".`);
}

/** Exported for testing — wraps the CLI body in a try/catch and exits with the right code. */
export async function runCli(argv: string[] = process.argv.slice(2)): Promise<number> {
  try {
    process.argv = ["node", "clawd-zk-agent", ...argv];
    await main();
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${BANNER} error: ${msg}`);
    return 1;
  }
}

// Only run main when invoked as a binary (not when imported by tests).
const invokedAsBinary =
  typeof process !== "undefined" &&
  process.argv[1] != null &&
  /cli\.(ts|js)$/.test(process.argv[1]) &&
  process.argv[1].includes("clawd-zk-agent");

if (invokedAsBinary) {
  runCli().then((code) => {
    if (code !== 0) process.exit(code);
  });
}
