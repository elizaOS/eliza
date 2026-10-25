/**
 * Wire contract for proving control of a wallet's `clientAddress` key when
 * provisioning a cloud-custodied server wallet.
 *
 * The caller signs {@link buildWalletProvisionChallenge} with the
 * `clientAddress` private key; the server rebuilds the identical string and
 * verifies the signature. Both sides MUST construct the message the same way,
 * so this builder is the single source of truth shared by the client
 * (`@elizaos/plugin-elizacloud`) and the server (`@elizaos/cloud-shared`).
 *
 * `timestamp` (freshness) + `nonce` (single-use) bind the proof to one
 * provision request: the server rejects proofs outside a ±5-minute window and
 * rejects nonce replays.
 */
export const WALLET_PROVISION_CHALLENGE_PREFIX = "Eliza Cloud Wallet Provision";

export interface WalletProvisionChallengeInput {
  /** EVM address of the local agent key being proven (lower-cased in the message). */
  clientAddress: string;
  /** Target chain of the provisioned wallet ("evm" | "solana"). */
  chainType: string;
  /** Unix epoch milliseconds the proof was signed. */
  timestamp: number;
  /** Per-request unique value; rejected on replay. */
  nonce: string;
}

export function buildWalletProvisionChallenge(
  input: WalletProvisionChallengeInput,
): string {
  return [
    WALLET_PROVISION_CHALLENGE_PREFIX,
    `clientAddress: ${input.clientAddress.toLowerCase()}`,
    `chainType: ${input.chainType}`,
    `timestamp: ${input.timestamp}`,
    `nonce: ${input.nonce}`,
  ].join("\n");
}
