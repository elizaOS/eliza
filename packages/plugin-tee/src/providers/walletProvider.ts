/* This is an example of how WalletProvider can use DeriveKeyProvider to generate a Solana Keypair */
import { type IAgentRuntime, type Memory, type Provider, type State, logger } from '@elizaos/core';
import { Connection, type Keypair, type PublicKey } from '@solana/web3.js';
import BigNumber from 'bignumber.js';
import NodeCache from 'node-cache';
import { DeriveKeyProvider } from './deriveKeyProvider';
import type { RemoteAttestationQuote } from '@elizaos/core';
// Provider configuration
const PROVIDER_CONFIG = {
    BIRDEYE_API: 'https://public-api.birdeye.so',
    MAX_RETRIES: 3,
    RETRY_DELAY: 2000,
    DEFAULT_RPC: 'https://api.mainnet-beta.solana.com',
    TOKEN_ADDRESSES: {
        SOL: 'So11111111111111111111111111111111111111112',
        BTC: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh',
        ETH: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
    },
};

export interface Item {
    name: string;
    address: string;
    symbol: string;
    decimals: number;
    balance: string;
    uiAmount: string;
    priceUsd: string;
    valueUsd: string;
    valueSol?: string;
}

interface WalletPortfolio {
    totalUsd: string;
    totalSol?: string;
    items: Array<Item>;
}

interface _BirdEyePriceData {
    data: {
        [key: string]: {
            price: number;
            priceChange24h: number;
        };
    };
}

interface Prices {
    solana: { usd: string };
    bitcoin: { usd: string };
    ethereum: { usd: string };
}

export class WalletProvider {
    private cache: NodeCache;

    constructor(
        private connection: Connection,
        private walletPublicKey: PublicKey,
    ) {
        this.cache = new NodeCache({ stdTTL: 300 }); // Cache TTL set to 5 minutes
    }

    private async fetchWithRetry(runtime, url: string, options: RequestInit = {}): Promise<any> {
        let lastError: Error;

        for (let i = 0; i < PROVIDER_CONFIG.MAX_RETRIES; i++) {
            try {
                const apiKey = runtime.getSetting('BIRDEYE_API_KEY');
                const response = await fetch(url, {
                    ...options,
                    headers: {
                        Accept: 'application/json',
                        'x-chain': 'solana',
                        'X-API-KEY': apiKey || '',
                        ...options.headers,
                    },
                });

                if (!response.ok) {
                    const errorText = await response.text();
                    throw new Error(
                        `HTTP error! status: ${response.status}, message: ${errorText}`,
                    );
                }

                const data = await response.json();
                return data;
            } catch (error) {
                logger.error(`Attempt ${i + 1} failed:`, error);
                lastError = error;
                if (i < PROVIDER_CONFIG.MAX_RETRIES - 1) {
                    const delay = PROVIDER_CONFIG.RETRY_DELAY * 2 ** i;
                    await new Promise((resolve) => setTimeout(resolve, delay));
                }
            }
        }

        logger.error('All attempts failed. Throwing the last error:', lastError);
        throw lastError;
    }

    async fetchPortfolioValue(runtime): Promise<WalletPortfolio> {
        try {
            const cacheKey = `portfolio-${this.walletPublicKey.toBase58()}`;
            const cachedValue = this.cache.get<WalletPortfolio>(cacheKey);

            if (cachedValue) {
                logger.log('Cache hit for fetchPortfolioValue');
                return cachedValue;
            }
            logger.log('Cache miss for fetchPortfolioValue');

            const walletData = await this.fetchWithRetry(
                runtime,
                `${
                    PROVIDER_CONFIG.BIRDEYE_API
                }/v1/wallet/token_list?wallet=${this.walletPublicKey.toBase58()}`,
            );

            if (!walletData?.success || !walletData?.data) {
                logger.error('No portfolio data available', walletData);
                throw new Error('No portfolio data available');
            }

            const data = walletData.data;
            const totalUsd = new BigNumber(data.totalUsd.toString());
            const prices = await this.fetchPrices(runtime);
            const solPriceInUSD = new BigNumber(prices.solana.usd.toString());

            const items = data.items.map((item: any) => ({
                ...item,
                valueSol: new BigNumber(item.valueUsd || 0).div(solPriceInUSD).toFixed(6),
                name: item.name || 'Unknown',
                symbol: item.symbol || 'Unknown',
                priceUsd: item.priceUsd || '0',
                valueUsd: item.valueUsd || '0',
            }));

            const totalSol = totalUsd.div(solPriceInUSD);
            const portfolio = {
                totalUsd: totalUsd.toString(),
                totalSol: totalSol.toFixed(6),
                items: items.sort((a, b) =>
                    new BigNumber(b.valueUsd).minus(new BigNumber(a.valueUsd)).toNumber(),
                ),
            };
            this.cache.set(cacheKey, portfolio);
            return portfolio;
        } catch (error) {
            logger.error('Error fetching portfolio:', error);
            throw error;
        }
    }

    async fetchPrices(runtime): Promise<Prices> {
        try {
            const cacheKey = 'prices';
            const cachedValue = this.cache.get<Prices>(cacheKey);

            if (cachedValue) {
                logger.log('Cache hit for fetchPrices');
                return cachedValue;
            }
            logger.log('Cache miss for fetchPrices');

            const { SOL, BTC, ETH } = PROVIDER_CONFIG.TOKEN_ADDRESSES;
            const tokens = [SOL, BTC, ETH];
            const prices: Prices = {
                solana: { usd: '0' },
                bitcoin: { usd: '0' },
                ethereum: { usd: '0' },
            };

            for (const token of tokens) {
                const response = await this.fetchWithRetry(
                    runtime,
                    `${PROVIDER_CONFIG.BIRDEYE_API}/defi/price?address=${token}`,
                    {
                        headers: {
                            'x-chain': 'solana',
                        },
                    },
                );

                if (response?.data?.value) {
                    const price = response.data.value.toString();
                    prices[token === SOL ? 'solana' : token === BTC ? 'bitcoin' : 'ethereum'].usd =
                        price;
                } else {
                    logger.warn(`No price data available for token: ${token}`);
                }
            }

            this.cache.set(cacheKey, prices);
            return prices;
        } catch (error) {
            logger.error('Error fetching prices:', error);
            throw error;
        }
    }

    formatPortfolio(runtime, portfolio: WalletPortfolio, prices: Prices): string {
        let output = `${runtime.character.description}\n`;
        output += `Wallet Address: ${this.walletPublicKey.toBase58()}\n\n`;

        const totalUsdFormatted = new BigNumber(portfolio.totalUsd).toFixed(2);
        const totalSolFormatted = portfolio.totalSol;

        output += `Total Value: $${totalUsdFormatted} (${totalSolFormatted} SOL)\n\n`;
        output += 'Token Balances:\n';

        const nonZeroItems = portfolio.items.filter((item) =>
            new BigNumber(item.uiAmount).isGreaterThan(0),
        );

        if (nonZeroItems.length === 0) {
            output += 'No tokens found with non-zero balance\n';
        } else {
            for (const item of nonZeroItems) {
                const valueUsd = new BigNumber(item.valueUsd).toFixed(2);
                output += `${item.name} (${item.symbol}): ${new BigNumber(item.uiAmount).toFixed(
                    6,
                )} ($${valueUsd} | ${item.valueSol} SOL)\n`;
            }
        }

        output += '\nMarket Prices:\n';
        output += `SOL: $${new BigNumber(prices.solana.usd).toFixed(2)}\n`;
        output += `BTC: $${new BigNumber(prices.bitcoin.usd).toFixed(2)}\n`;
        output += `ETH: $${new BigNumber(prices.ethereum.usd).toFixed(2)}\n`;

        return output;
    }

    async getFormattedPortfolio(runtime): Promise<string> {
        try {
            const [portfolio, prices] = await Promise.all([
                this.fetchPortfolioValue(runtime),
                this.fetchPrices(runtime),
            ]);

            return this.formatPortfolio(runtime, portfolio, prices);
        } catch (error) {
            logger.error('Error generating portfolio report:', error);
            return 'Unable to fetch wallet information. Please try again later.';
        }
    }
}

const walletProvider: Provider = {
    get: async (runtime: IAgentRuntime, _message: Memory, _state?: State): Promise<string> => {
        const agentId = runtime.agentId;
        const teeMode = runtime.getSetting('TEE_MODE');
        const deriveKeyProvider = new DeriveKeyProvider(teeMode);
        try {
            // Validate wallet configuration
            if (!runtime.getSetting('WALLET_SECRET_SALT')) {
                logger.error('Wallet secret salt is not configured in settings');
                return '';
            }

            let publicKey: PublicKey;
            try {
                const derivedKeyPair: {
                    keypair: Keypair;
                    attestation: RemoteAttestationQuote;
                } = await deriveKeyProvider.deriveEd25519Keypair(
                    runtime.getSetting('WALLET_SECRET_SALT'),
                    'solana',
                    agentId,
                );
                publicKey = derivedKeyPair.keypair.publicKey;
                logger.log('Wallet Public Key: ', publicKey.toBase58());
            } catch (error) {
                logger.error('Error creating PublicKey:', error);
                return '';
            }

            const connection = new Connection(PROVIDER_CONFIG.DEFAULT_RPC);
            const provider = new WalletProvider(connection, publicKey);

            const porfolio = await provider.getFormattedPortfolio(runtime);
            return porfolio;
        } catch (error) {
            logger.error('Error in wallet provider:', error.message);
            return `Failed to fetch wallet information: ${
                error instanceof Error ? error.message : 'Unknown error'
            }`;
        }
    },
};

// Module exports
export { walletProvider };
