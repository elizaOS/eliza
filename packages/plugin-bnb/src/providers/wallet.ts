import {
    type IAgentRuntime,
    type Provider,
    type Memory,
    type State,
} from "@elizaos/core";
import { EVM, createConfig, getToken } from "@lifi/sdk";
import type {
    Address,
    WalletClient,
    PublicClient,
    Chain,
    HttpTransport,
    Account,
    PrivateKeyAccount,
    Hex,
} from "viem";
import {
    createPublicClient,
    createWalletClient,
    formatUnits,
    http,
    erc20Abi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import * as viemChains from "viem/chains";
import { createWeb3Name } from "@web3-name-sdk/core";

import type { SupportedChain } from "../types";

export class WalletProvider {
    private currentChain: SupportedChain = "bsc";
    chains: Record<string, Chain> = { bsc: viemChains.bsc };
    account: PrivateKeyAccount;

    constructor(privateKey: `0x${string}`, chains?: Record<string, Chain>) {
        this.setAccount(privateKey);
        this.setChains(chains);

        if (chains && Object.keys(chains).length > 0) {
            this.setCurrentChain(Object.keys(chains)[0] as SupportedChain);
        }
    }

    getAccount(): PrivateKeyAccount {
        return this.account;
    }

    getAddress(): Address {
        return this.account.address;
    }

    getCurrentChain(): Chain {
        return this.chains[this.currentChain];
    }

    getPublicClient(
        chainName: SupportedChain
    ): PublicClient<HttpTransport, Chain, Account | undefined> {
        const transport = this.createHttpTransport(chainName);

        const publicClient = createPublicClient({
            chain: this.chains[chainName],
            transport,
        });
        return publicClient;
    }

    getWalletClient(chainName: SupportedChain): WalletClient {
        const transport = this.createHttpTransport(chainName);

        const walletClient = createWalletClient({
            chain: this.chains[chainName],
            transport,
            account: this.account,
        });

        return walletClient;
    }

    getChainConfigs(chainName: SupportedChain): Chain {
        const chain = viemChains[chainName];

        if (!chain?.id) {
            throw new Error("Invalid chain name");
        }

        return chain;
    }

    configureLiFiSdk(chainName: SupportedChain) {
        const chains = Object.values(this.chains);
        const walletClient = this.getWalletClient(chainName);

        createConfig({
            integrator: "eliza",
            providers: [
                EVM({
                    getWalletClient: async () => walletClient,
                    switchChain: async (chainId) =>
                        createWalletClient({
                            account: this.account,
                            chain: chains.find(
                                (chain) => chain.id == chainId
                            ) as Chain,
                            transport: http(),
                        }),
                }),
            ],
        });
    }

    async formatAddress(address: string): Promise<Address> {
        if (!address || address.length === 0) {
            throw new Error("Empty address");
        }

        if (address.startsWith("0x") && address.length === 42) {
            return address as Address;
        }

        const resolvedAddress = await this.resolveWeb3Name(address);
        if (resolvedAddress) {
            return resolvedAddress as Address;
        } else {
            throw new Error("Invalid address");
        }
    }

    async resolveWeb3Name(name: string): Promise<string | null> {
        const nameService = createWeb3Name();
        return await nameService.getAddress(name);
    }

    async checkERC20Allowance(
        chain: SupportedChain,
        token: Address,
        owner: Address,
        spender: Address,
    ): Promise<bigint> {
        const publicClient = this.getPublicClient(chain);
        return await publicClient.readContract({
            address: token,
            abi: erc20Abi,
            functionName: "allowance",
            args: [owner, spender],
        });
    }

    async approveERC20(
        chain: SupportedChain,
        token: Address,
        spender: Address,
        amount: bigint
    ): Promise<Hex> {
        const publicClient = this.getPublicClient(chain);
        const walletClient = this.getWalletClient(chain);
        const { request } = await publicClient.simulateContract({
            account: this.account,
            address: token,
            abi: erc20Abi,
            functionName: "approve",
            args: [spender, amount],
        });

        return await walletClient.writeContract(request);
    }

    async transfer(
        chain: SupportedChain,
        toAddress: Address,
        amount: bigint,
        options?: {
            gas?: bigint;
            gasPrice?: bigint;
            data?: Hex;
        }
    ): Promise<Hex> {
        const walletClient = this.getWalletClient(chain);
        return walletClient.sendTransaction({
            account: this.account!,
            to: toAddress,
            value: amount,
            chain: this.getChainConfigs(chain),
            ...options,
        });
    }

    async transferERC20(
        chain: SupportedChain,
        tokenAddress: Address,
        toAddress: Address,
        amount: bigint,
        options?: {
            gas?: bigint;
            gasPrice?: bigint;
        }
    ): Promise<Hex> {
        const publicClient = this.getPublicClient(chain);
        const walletClient = this.getWalletClient(chain);
        const { request } = await publicClient.simulateContract({
            account: this.account,
            address: tokenAddress as `0x${string}`,
            abi: erc20Abi,
            functionName: "transfer",
            args: [toAddress as `0x${string}`, amount],
            ...options,
        });

        return await walletClient.writeContract(request);
    }

    async getBalance(): Promise<string> {
        const client = this.getPublicClient(this.currentChain);
        const balance = await client.getBalance({
            address: this.account.address,
        });
        return formatUnits(balance, 18);
    }

    async getTokenAddress(
        chainName: SupportedChain,
        tokenSymbol: string
    ): Promise<string> {
        const token = await getToken(
            this.getChainConfigs(chainName).id,
            tokenSymbol
        );
        return token.address;
    }

    addChain(chain: Record<string, Chain>) {
        this.setChains(chain);
    }

    switchChain(chainName: SupportedChain, customRpcUrl?: string) {
        if (!this.chains[chainName]) {
            const chain = WalletProvider.genChainFromName(
                chainName,
                customRpcUrl
            );
            this.addChain({ [chainName]: chain });
        }
        this.setCurrentChain(chainName);
    }

    private setAccount = (pk: `0x${string}`) => {
        this.account = privateKeyToAccount(pk);
    };

    private setChains = (chains?: Record<string, Chain>) => {
        if (!chains) {
            return;
        }
        Object.keys(chains).forEach((chain: string) => {
            this.chains[chain] = chains[chain];
        });
    };

    private setCurrentChain = (chain: SupportedChain) => {
        this.currentChain = chain;
    };

    private createHttpTransport = (chainName: SupportedChain) => {
        const chain = this.chains[chainName];

        if (chain.rpcUrls.custom) {
            return http(chain.rpcUrls.custom.http[0]);
        }
        return http(chain.rpcUrls.default.http[0]);
    };

    static genChainFromName(
        chainName: string,
        customRpcUrl?: string | null
    ): Chain {
        const baseChain = viemChains[chainName];

        if (!baseChain?.id) {
            throw new Error("Invalid chain name");
        }

        const viemChain: Chain = customRpcUrl
            ? {
                  ...baseChain,
                  rpcUrls: {
                      ...baseChain.rpcUrls,
                      custom: {
                          http: [customRpcUrl],
                      },
                  },
              }
            : baseChain;

        return viemChain;
    }
}

const genChainsFromRuntime = (
    runtime: IAgentRuntime
): Record<string, Chain> => {
    const chainNames = ["bsc", "bscTestnet", "opBNB", "opBNBTestnet"];
    const chains = {};

    chainNames.forEach((chainName) => {
        const chain = WalletProvider.genChainFromName(chainName);
        chains[chainName] = chain;
    });

    const mainnet_rpcurl = runtime.getSetting("BSC_PROVIDER_URL");
    if (mainnet_rpcurl) {
        const chain = WalletProvider.genChainFromName("bsc", mainnet_rpcurl);
        chains["bsc"] = chain;
    }

    const opbnb_rpcurl = runtime.getSetting("OPBNB_PROVIDER_URL");
    if (opbnb_rpcurl) {
        const chain = WalletProvider.genChainFromName("opBNB", opbnb_rpcurl);
        chains["opBNB"] = chain;
    }

    return chains;
};

export const initWalletProvider = (runtime: IAgentRuntime) => {
    const privateKey = runtime.getSetting("BNB_PRIVATE_KEY");
    if (!privateKey) {
        throw new Error("BNB_PRIVATE_KEY is missing");
    }

    const chains = genChainsFromRuntime(runtime);

    return new WalletProvider(privateKey as `0x${string}`, chains);
};

export const bnbWalletProvider: Provider = {
    async get(
        runtime: IAgentRuntime,
        _message: Memory,
        _state?: State
    ): Promise<string | null> {
        try {
            const walletProvider = initWalletProvider(runtime);
            const address = walletProvider.getAddress();
            const balance = await walletProvider.getBalance();
            const chain = walletProvider.getCurrentChain();
            return `BNB chain Wallet Address: ${address}\nBalance: ${balance} ${chain.nativeCurrency.symbol}\nChain ID: ${chain.id}, Name: ${chain.name}`;
        } catch (error) {
            console.error("Error in BNB chain wallet provider:", error);
            return null;
        }
    },
};
