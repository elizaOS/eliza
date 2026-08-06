import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import type { PaymentChain } from "../utils/settings";

export async function createX402Fetch(
  privateKey: `0x${string}`,
  chain: PaymentChain,
): Promise<typeof globalThis.fetch> {
  const { x402Client, wrapFetchWithPayment } = await import("@x402/fetch");
  const { registerExactEvmScheme } = await import("@x402/evm/exact/client");

  const account = privateKeyToAccount(privateKey);
  const viemChain = chain === "base" ? base : baseSepolia;
  const walletClient = createWalletClient({
    account,
    chain: viemChain,
    transport: http(),
  });

  const signer = {
    address: account.address,
    signTypedData: walletClient.signTypedData.bind(walletClient),
    readContract: walletClient.extend(() => ({})),
  };

  const client = new x402Client();
  registerExactEvmScheme(client, { signer: signer as never });

  return wrapFetchWithPayment(fetch, client) as typeof globalThis.fetch;
}
