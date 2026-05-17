import {
  type Address,
  type Chain,
  createPublicClient,
  getContract,
  type Hash,
  http,
  type WalletClient,
  zeroAddress,
} from "viem";
import { arbitrum, base, baseSepolia, mainnet, polygon } from "viem/chains";
import { AgentAccountV2Abi } from "./abi.js";
import type { AgentWalletConfig, BudgetStatus, SpendPolicy } from "./types.js";

const CHAINS: Record<string, Chain> = {
  base,
  "base-sepolia": baseSepolia,
  ethereum: mainnet,
  arbitrum,
  polygon,
};

/** Asserts the viem wallet client has a selected account (required for writes). */
export function requireWalletAccount(client: WalletClient) {
  const { account } = client;
  if (!account) {
    throw new Error("WalletClient.account is required for this operation");
  }
  return account;
}

/** Native ETH token address (zero address) */
export const NATIVE_TOKEN: Address = zeroAddress;

/**
 * Create a wallet client connected to an existing AgentAccountV2.
 */
export function createWallet(
  config: AgentWalletConfig & { walletClient: WalletClient },
) {
  const chain = CHAINS[config.chain];
  if (!chain) throw new Error(`Unsupported chain: ${config.chain}`);

  const publicClient = createPublicClient({
    chain,
    transport: http(config.rpcUrl),
  });

  const contract = getContract({
    address: config.accountAddress,
    abi: AgentAccountV2Abi,
    client: { public: publicClient, wallet: config.walletClient },
  });

  return {
    address: config.accountAddress,
    contract,
    publicClient,
    walletClient: config.walletClient,
    chain,
  };
}

export type AgentWallet = ReturnType<typeof createWallet>;

/**
 * Set a spend policy for a token. Only callable by the NFT owner.
 * Use NATIVE_TOKEN (address(0)) for native ETH.
 */
export async function setSpendPolicy(
  wallet: AgentWallet,
  policy: SpendPolicy,
): Promise<Hash> {
  const periodLength = policy.periodLength || 86400;

  const hash = await wallet.contract.write.setSpendPolicy(
    [policy.token, policy.perTxLimit, policy.periodLimit, BigInt(periodLength)],
    { account: requireWalletAccount(wallet.walletClient), chain: wallet.chain },
  );

  return hash;
}

/**
 * Check remaining autonomous budget for a token.
 */
export async function checkBudget(
  wallet: AgentWallet,
  token: Address = NATIVE_TOKEN,
): Promise<BudgetStatus> {
  const [perTxLimit, remainingInPeriod] =
    await wallet.contract.read.remainingBudget([token]);

  return {
    token,
    perTxLimit,
    remainingInPeriod,
  };
}

/**
 * Transfer ERC20 tokens as the agent, respecting spend limits.
 */
export async function agentTransferToken(
  wallet: AgentWallet,
  params: { token: Address; to: Address; amount: bigint },
): Promise<Hash> {
  return wallet.contract.write.agentTransferToken(
    [params.token, params.to, params.amount],
    {
      account: requireWalletAccount(wallet.walletClient),
      chain: wallet.chain,
    },
  );
}
