import {
    type Action,
    type ActionExample,
    composeContext,
    elizaLogger,
    generateObject,
    type HandlerCallback,
    type IAgentRuntime,
    type Memory,
    ModelClass,
    settings,
    type State,
} from '@elizaos/core';
import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js';
import BigNumber from 'bignumber.js';
import { getWalletKey } from '../keypairUtils';
import type { ISolanaClient, Item } from '../types';
import { SOLANA_CLIENT_NAME } from '../constants';

async function getTokenDecimals(connection: Connection, mintAddress: string): Promise<number> {
    const mintPublicKey = new PublicKey(mintAddress);
    const tokenAccountInfo = await connection.getParsedAccountInfo(mintPublicKey);

    if (
        tokenAccountInfo.value &&
        typeof tokenAccountInfo.value.data === 'object' &&
        'parsed' in tokenAccountInfo.value.data
    ) {
        const parsedInfo = tokenAccountInfo.value.data.parsed?.info;
        if (parsedInfo && typeof parsedInfo.decimals === 'number') {
            return parsedInfo.decimals;
        }
    }

    throw new Error('Unable to fetch token decimals');
}

async function swapToken(
    connection: Connection,
    walletPublicKey: PublicKey,
    inputTokenCA: string,
    outputTokenCA: string,
    amount: number,
): Promise<any> {
    try {
        const decimals =
            inputTokenCA === settings.SOL_ADDRESS
                ? new BigNumber(9)
                : new BigNumber(await getTokenDecimals(connection, inputTokenCA));

        elizaLogger.log('Decimals:', decimals.toString());

        const amountBN = new BigNumber(amount);
        const adjustedAmount = amountBN.multipliedBy(new BigNumber(10).pow(decimals));

        elizaLogger.log('Fetching quote with params:', {
            inputMint: inputTokenCA,
            outputMint: outputTokenCA,
            amount: adjustedAmount,
        });

        const quoteResponse = await fetch(
            `https://quote-api.jup.ag/v6/quote?inputMint=${inputTokenCA}&outputMint=${outputTokenCA}&amount=${adjustedAmount}&dynamicSlippage=true&maxAccounts=64`,
        );
        const quoteData = await quoteResponse.json();

        if (!quoteData || quoteData.error) {
            elizaLogger.error('Quote error:', quoteData);
            throw new Error(`Failed to get quote: ${quoteData?.error || 'Unknown error'}`);
        }

        const swapRequestBody = {
            quoteResponse: quoteData,
            userPublicKey: walletPublicKey.toBase58(),
            dynamicComputeUnitLimit: true,
            dynamicSlippage: true,
            priorityLevelWithMaxLamports: {
                maxLamports: 4000000,
                priorityLevel: 'veryHigh',
            },
        };

        const swapResponse = await fetch('https://quote-api.jup.ag/v6/swap', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(swapRequestBody),
        });

        const swapData = await swapResponse.json();

        if (!swapData || !swapData.swapTransaction) {
            elizaLogger.error('Swap error:', swapData);
            throw new Error(
                `Failed to get swap transaction: ${
                    swapData?.error || 'No swap transaction returned'
                }`,
            );
        }

        return swapData;
    } catch (error) {
        elizaLogger.error('Error in swapToken:', error);
        throw error;
    }
}

// Get token from wallet data using SolanaClient
async function getTokenFromWallet(
    runtime: IAgentRuntime,
    tokenSymbol: string,
): Promise<string | null> {
    try {
        const solanaClient = runtime.getClient(SOLANA_CLIENT_NAME) as ISolanaClient;
        if (!solanaClient) {
            throw new Error('SolanaClient not initialized');
        }

        const walletData = await solanaClient.getCachedData();
        if (!walletData) {
            return null;
        }

        const token = walletData.items.find(
            (item: Item) => item.symbol.toLowerCase() === tokenSymbol.toLowerCase(),
        );

        return token ? token.address : null;
    } catch (error) {
        elizaLogger.error('Error checking token in wallet:', error);
        return null;
    }
}

const swapTemplate = `Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined.

Example response:
\`\`\`json
{
    "inputTokenSymbol": "SOL",
    "outputTokenSymbol": "USDC",
    "inputTokenCA": "So11111111111111111111111111111111111111112",
    "outputTokenCA": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "amount": 1.5
}
\`\`\`

{{recentMessages}}

Given the recent messages and wallet information below:

{{walletInfo}}

Extract the following information about the requested token swap:
- Input token symbol (the token being sold)
- Output token symbol (the token being bought)
- Input token contract address if provided
- Output token contract address if provided
- Amount to swap

Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined.`;

export const executeSwap: Action = {
    name: 'SWAP_SOLANA',
    similes: [
        'SWAP_SOL',
        'SWAP_TOKENS_SOLANA',
        'TOKEN_SWAP_SOLANA',
        'TRADE_TOKENS_SOLANA',
        'EXCHANGE_TOKENS_SOLANA',
    ],
    validate: async (runtime: IAgentRuntime, _message: Memory) => {
        const solanaClient = runtime.getClient(SOLANA_CLIENT_NAME);
        return !!solanaClient;
    },
    description:
        'Perform a token swap from one token to another on Solana. Works with SOL and SPL tokens.',
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback,
    ): Promise<boolean> => {
        try {
            if (!state) {
                state = await runtime.composeState(message);
            } else {
                state = await runtime.updateRecentMessageState(state);
            }

            const solanaClient = runtime.getClient(SOLANA_CLIENT_NAME) as ISolanaClient;
            if (!solanaClient) {
                throw new Error('SolanaClient not initialized');
            }

            const walletData = await solanaClient.getCachedData();
            state.walletInfo = walletData;

            const swapContext = composeContext({
                state,
                template: swapTemplate,
            });

            const response = await generateObject({
                runtime,
                context: swapContext,
                modelClass: ModelClass.LARGE,
            });

            // Handle SOL addresses
            if (response.inputTokenSymbol?.toUpperCase() === 'SOL') {
                response.inputTokenCA = settings.SOL_ADDRESS;
            }
            if (response.outputTokenSymbol?.toUpperCase() === 'SOL') {
                response.outputTokenCA = settings.SOL_ADDRESS;
            }

            // Resolve token addresses if needed
            if (!response.inputTokenCA && response.inputTokenSymbol) {
                response.inputTokenCA = await getTokenFromWallet(
                    runtime,
                    response.inputTokenSymbol,
                );
                if (!response.inputTokenCA) {
                    callback?.({ text: 'Could not find the input token in your wallet' });
                    return false;
                }
            }

            if (!response.outputTokenCA && response.outputTokenSymbol) {
                response.outputTokenCA = await getTokenFromWallet(
                    runtime,
                    response.outputTokenSymbol,
                );
                if (!response.outputTokenCA) {
                    callback?.({ text: 'Could not find the output token in your wallet' });
                    return false;
                }
            }

            if (!response.amount) {
                callback?.({ text: 'Please specify the amount you want to swap' });
                return false;
            }

            const connection = new Connection(
                runtime.getSetting('SOLANA_RPC_URL') || 'https://api.mainnet-beta.solana.com',
            );
            const { publicKey: walletPublicKey } = await getWalletKey(runtime, false);

            const swapResult = await swapToken(
                connection,
                walletPublicKey,
                response.inputTokenCA as string,
                response.outputTokenCA as string,
                response.amount as number,
            );

            const transactionBuf = Buffer.from(swapResult.swapTransaction, 'base64');
            const transaction = VersionedTransaction.deserialize(transactionBuf);

            const { keypair } = await getWalletKey(runtime, true);
            if (keypair.publicKey.toBase58() !== walletPublicKey.toBase58()) {
                throw new Error("Generated public key doesn't match expected public key");
            }

            transaction.sign([keypair]);

            const latestBlockhash = await connection.getLatestBlockhash();
            const txid = await connection.sendTransaction(transaction, {
                skipPreflight: false,
                maxRetries: 3,
                preflightCommitment: 'confirmed',
            });

            const confirmation = await connection.confirmTransaction(
                {
                    signature: txid,
                    blockhash: latestBlockhash.blockhash,
                    lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
                },
                'confirmed',
            );

            if (confirmation.value.err) {
                throw new Error(`Transaction failed: ${confirmation.value.err}`);
            }

            callback?.({
                text: `Swap completed successfully! Transaction ID: ${txid}`,
                content: { success: true, txid },
            });

            return true;
        } catch (error) {
            elizaLogger.error('Error during token swap:', error);
            callback?.({
                text: `Swap failed: ${error.message}`,
                content: { error: error.message },
            });
            return false;
        }
    },
    examples: [
        [
            {
                user: '{{user1}}',
                content: {
                    text: 'Swap 0.1 SOL for USDC',
                },
            },
            {
                user: '{{user2}}',
                content: {
                    text: "I'll help you swap 0.1 SOL for USDC",
                    action: 'SWAP_SOLANA',
                },
            },
        ],
    ] as ActionExample[][],
};
