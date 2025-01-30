import { WalletClientBase } from "@goat-sdk/core";
import { viem, type Chain } from "@goat-sdk/wallet-viem";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mode } from "viem/chains";
import {
    zilliqaChainId,
    zilliqaJSViemWalletClient,
    ZilliqaWalletClient
} from "@goat-sdk/wallet-zilliqa";
import { Account } from "@zilliqa-js/zilliqa";

// Add the chain you want to use, remember to update also
// the ZILLIQA_PROVIDER_URL to the correct one for the chain
export const chain = mode;

function getViemChain(provider: string, id: number, decimals: number): Chain {
    return {
        id: id | 0x8000,
        name: "zilliqa",
        nativeCurrency: {
            decimals: decimals,
            name: "Zil",
            symbol: "ZIL",
        },
        rpcUrls: {
            default: {
                https: [provider],
            },
        },
    };
}

export async function getZilliqaWalletClient(
    getSetting: (key: string) => string | undefined
) {
    const privateKey = getSetting("ZILLIQA_PRIVATE_KEY");
    if (!privateKey) return null;

    const provider = getSetting("ZILLIQA_PROVIDER_URL");
    if (!provider) throw new Error("ZILLIQA_PROVIDER_URL not configured");

    const chainId = await zilliqaChainId(provider);
    const account = new Account(privateKey);
    const viemChain = getViemChain(provider, chainId, 18);
    const viemWallet = createWalletClient({
        account: privateKeyToAccount(privateKey as `0x${string}`),
        chain: viemChain,
        transport: http(provider),
    });

    return zilliqaJSViemWalletClient(viemWallet, provider, account, chainId);
}

export function getWalletProviders(
    walletClient: WalletClientBase,
    zilliqa: ZilliqaWalletClient
) {
    return [
        {
            async get(): Promise<string | null> {
                try {
                    const address = walletClient.getAddress();
                    const balance = await walletClient.balanceOf(address);
                    return `EVM Wallet Address: ${address}\nBalance: ${balance} ZIL`;
                } catch (error) {
                    console.error("Error in EVM wallet provider:", error);
                    return null;
                }
            },
        },
        {
            async get(): Promise<string | null> {
                try {
                    const address =
                        zilliqa.getZilliqa().wallet.defaultAccount?.address;
                    return `Zilliqa wallet address: ${address}\n`;
                } catch (error) {
                    console.error("Error in zilliqa wallet provider:", error);
                    return null;
                }
            },
        },
    ];
}
