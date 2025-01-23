import { elizaLogger } from "@elizaos/core";
import {
    Chains,
    TokenMetadata,
    TrustWalletGithubJson,
    TrustWalletTokenMetadata,
} from "./types";
import { NATIVE_TOKENS } from "./constants";

export class EVMTokenRegistry {
    private static instance: EVMTokenRegistry;
    private chainTokenMaps: Map<number, Map<string, TokenMetadata>>;
    private initializedChains: Set<number>;

    private static CHAIN_NAMES: Record<number, string> = Object.fromEntries(
        Object.keys(Chains)
            .map(name => [Chains[name as keyof typeof Chains], name.toLowerCase()])
    );

    private constructor() {
        this.chainTokenMaps = new Map();
        this.initializedChains = new Set();
    }

    public static getInstance(): EVMTokenRegistry {
        if (!EVMTokenRegistry.instance) {
            EVMTokenRegistry.instance = new EVMTokenRegistry();
        }
        return EVMTokenRegistry.instance;
    }

    private async fetchTokenList(
        chainId: number
    ): Promise<TrustWalletTokenMetadata[]> {
        const chainName = EVMTokenRegistry.CHAIN_NAMES[chainId];
        if (!chainName) {
            throw new Error(`Unsupported chain ID: ${chainId}`);
        }

        const url = `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/${chainName}/tokenlist.json`;

        try {
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const data: TrustWalletGithubJson = await response.json();
            return data.tokens;
        } catch (error) {
            elizaLogger.error(
                `Failed to fetch token list for chain ${chainName}:`,
                error
            );
            throw error;
        }
    }

    public async initializeChain(chainId: number): Promise<void> {
        if (this.initializedChains.has(chainId)) return;

        const tokens = await this.fetchTokenList(chainId);
        const tokenMap = new Map<string, TokenMetadata>();

        // Add native token first
        const nativeToken = NATIVE_TOKENS[chainId];
        if (nativeToken) {
            tokenMap.set(nativeToken.symbol.toUpperCase(), nativeToken);
        }

        for (const token of tokens) {
            const { pairs, ...restToken } = token;
            tokenMap.set(token.symbol.toUpperCase(), {
                chainId,
                ...restToken,
            });
        }

        this.chainTokenMaps.set(chainId, tokenMap);
        // Only add to initializedChains if tokens were fetched successfully
        if (tokenMap.size > 0) {
            this.initializedChains.add(chainId);
        }
    }

    public getTokenBySymbol(
        symbol: string,
        chainId: number
    ): TokenMetadata | undefined {
        if (!EVMTokenRegistry.CHAIN_NAMES[chainId]) {
            throw new Error(`Unsupported chain ID: ${chainId}`);
        }

        const chainTokens = this.chainTokenMaps.get(chainId);
        if (!chainTokens) return undefined;

        return chainTokens.get(symbol.toUpperCase());
    }

    public getTokenByAddress(
        address: string,
        chainId: number
    ): TokenMetadata | undefined {
        if (!EVMTokenRegistry.CHAIN_NAMES[chainId]) {
            throw new Error(`Unsupported chain ID: ${chainId}`);
        }

        const tokens = this.chainTokenMaps.get(chainId)?.values();
        if (!tokens) return undefined;

        const normalizedAddress = address.toLowerCase();
        for (const token of tokens) {
            if (token.address.toLowerCase() === normalizedAddress) {
                return token;
            }
        }
        return undefined;
    }

    public async getAllTokensForChain(
        chainId: number
    ): Promise<TokenMetadata[]> {
        if (!EVMTokenRegistry.CHAIN_NAMES[chainId]) {
            throw new Error(`Unsupported chain ID: ${chainId}`);
        }

        await this.initializeChain(chainId);
        return Array.from(this.chainTokenMaps.get(chainId)?.values() ?? []);
    }

    public isChainSupported(chainId: number): boolean {
        return chainId in EVMTokenRegistry.CHAIN_NAMES;
    }
}
