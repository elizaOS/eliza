/**
 * @clawd/zk-agent — public exports
 *
 * The agent-shaped wrapper around `@clawd/zk-client`. Use this when you
 * want your Clawd agent (or REPL, or MCP tool) to be able to say
 * "attest this model" / "commit this encrypted state" / "verify this
 * proof" without hand-rolling the underlying nullifier, Groth16, and
 * Light Protocol plumbing.
 *
 * Quick start:
 *
 * ```ts
 * import { ClawdZkAgent } from "@clawd/zk-agent";
 * import { createSolanaRpc } from "@solana/kit";
 *
 * const agent = await ClawdZkAgent.fromEnv();
 * const result = await agent.attestModel({
 *   modelHash: new Uint8Array(32),
 *   payloadCommitment: new Uint8Array(32),
 *   proof: loadProofFromDisk("./proof.json"),
 *   context: "model-attest:v1:my-model",
 * });
 * console.log(result.signature);
 * ```
 *
 * The package also ships a `clawd-zk-agent` binary (see `src/cli.ts`)
 * that exposes the same operations as subcommands and as a
 * natural-language intent router.
 */

export { ClawdZkAgent, type ClawdZkAgentOptions, type AttestModelResult, type CommitStateResult, type VerifyProofResult } from "./agent.js";
export { routeIntent, type IntentRoute, type IntentContext, KNOWN_INTENTS } from "./intents.js";
export { loadAgentConfig, type ZkAgentConfig, DEFAULT_PROGRAM_ID } from "./config.js";
export { runCli } from "./cli.js";
export {
  // Re-export the lower-level SDK so callers can drop down when they
  // need to construct instructions by hand.
  computeNullifier,
  computeNullifierBatch,
  deriveNullifierAddress,
  buildPublishPublicInputs,
  buildCommitPublicInputs,
  buildConsumePublicInputs,
  packPublicInputs,
  serializeProof,
  verifyGroth16Offchain,
  type NullifierInputs,
  type Groth16Proof,
  type Bytes32,
  type PublishAttestationArgs,
  type CommitStateArgs,
} from "@clawd/zk-client";
