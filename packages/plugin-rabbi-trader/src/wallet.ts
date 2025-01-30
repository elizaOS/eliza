import { elizaLogger, type IAgentRuntime } from "@elizaos/core";
import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";
import { decodeBase58 } from "./utils";
import { SAFETY_LIMITS } from "./constants";

/**
 * Gets wallet keypair from runtime settings
 * @param runtime Agent runtime environment
 * @returns Solana keypair for transactions
 * @throws Error if private key is missing or invalid
 */
export function getWalletKeypair(runtime?: IAgentRuntime): Keypair {
    // Check chain type from token address or configuration

    const privateKeyString = runtime?.getSetting("WALLET_PRIVATE_KEY");
    if (!privateKeyString) {
        throw new Error("No wallet private key configured");
    }

    try {
        const privateKeyBytes = decodeBase58(privateKeyString);
        return Keypair.fromSecretKey(privateKeyBytes);
    } catch (error) {
        elizaLogger.error("Failed to create wallet keypair:", error);
        throw error;
    }
}

/**
 * Gets current SOL balance for wallet
 * @param runtime Agent runtime environment
 * @returns Balance in SOL
 */
export async function getWalletBalance(
    runtime: IAgentRuntime
): Promise<number> {
    try {
        // Existing Solana balance logic
        const walletKeypair = getWalletKeypair(runtime);
        const walletPubKey = walletKeypair.publicKey;
        const connection = new Connection(
            runtime.getSetting("SOLANA_RPC_URL") ||
                "https://api.mainnet-beta.solana.com"
        );

        const balance = await connection.getBalance(walletPubKey);
        const solBalance = balance / 1e9;

        elizaLogger.log("Fetched Solana wallet balance:", {
            address: walletPubKey.toBase58(),
            lamports: balance,
            sol: solBalance,
        });

        return solBalance;
    } catch (error) {
        elizaLogger.error("Failed to get wallet balance:", error);
        return 0;
    }
}

// Add helper function to get connection
async function getConnection(runtime: IAgentRuntime): Promise<Connection> {
    return new Connection(
        runtime.getSetting("SOLANA_RPC_URL") || "https://api.mainnet-beta.solana.com"
    );
}

// Add executeTrade function
export async function executeTrade(
    runtime: IAgentRuntime,
    params: {
        tokenAddress: string;
        amount: number;
        slippage: number;
        isSell?: boolean;
        chain?: "base" | "solana";
    },
    retryCount = 0
): Promise<any> {
    // Existing Solana trade logic remains unchanged
    try {
        elizaLogger.log("Executing Solana trade with params:", params);

        const SOL_ADDRESS = "So11111111111111111111111111111111111111112";

        if (!params.isSell && params.amount < SAFETY_LIMITS.MINIMUM_TRADE) {
            elizaLogger.warn("Trade amount too small:", {
                amount: params.amount,
                minimumRequired: SAFETY_LIMITS.MINIMUM_TRADE,
            });
            return {
                success: false,
                error: "Trade amount too small",
                details: {
                    amount: params.amount,
                    minimumRequired: SAFETY_LIMITS.MINIMUM_TRADE,
                },
            };
        }

        const walletKeypair = getWalletKeypair(runtime);
        const connection = await getConnection(runtime);

        // Setup swap parameters
        const inputTokenCA = params.isSell ? params.tokenAddress : SOL_ADDRESS;
        const outputTokenCA = params.isSell ? SOL_ADDRESS : params.tokenAddress;
        const swapAmount = Math.floor(params.amount * 1e9);

        elizaLogger.log("Trade execution details:", {
            isSell: params.isSell,
            inputToken: inputTokenCA,
            outputToken: outputTokenCA,
            amount: params.amount,
            slippage: params.slippage,
        });

        // Get quote
        const quoteResponse = await fetch(
            `https://quote-api.jup.ag/v6/quote?inputMint=${inputTokenCA}&outputMint=${outputTokenCA}&amount=${swapAmount}&slippageBps=${Math.floor(params.slippage * 10000)}`
        );

        if (!quoteResponse.ok) {
            const error = await quoteResponse.text();
            elizaLogger.warn("Quote request failed:", {
                status: quoteResponse.status,
                error,
            });
            return {
                success: false,
                error: "Failed to get quote",
                details: { status: quoteResponse.status, error },
            };
        }

        const quoteData = await quoteResponse.json();
        if (!quoteData || quoteData.error) {
            elizaLogger.warn("Invalid quote data:", quoteData);
            return {
                success: false,
                error: "Invalid quote data",
                details: quoteData,
            };
        }

        elizaLogger.log("Quote received:", quoteData);

        // Get swap transaction
        const swapResponse = await fetch("https://quote-api.jup.ag/v6/swap", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                quoteResponse: quoteData,
                userPublicKey: walletKeypair.publicKey.toString(),
                wrapAndUnwrapSol: true,
                computeUnitPriceMicroLamports: 2000000,
                dynamicComputeUnitLimit: true,
            }),
        });

        const swapData = await swapResponse.json();
        if (!swapData?.swapTransaction) {
            throw new Error("No swap transaction returned");
        }

        elizaLogger.log("Swap transaction received");

        // Deserialize transaction
        const transactionBuf = Buffer.from(swapData.swapTransaction, "base64");
        const tx = VersionedTransaction.deserialize(transactionBuf);

        // Get fresh blockhash and sign transaction
        const { blockhash, lastValidBlockHeight } =
            await connection.getLatestBlockhash("finalized");
        tx.message.recentBlockhash = blockhash;
        tx.sign([walletKeypair]);

        // Send with confirmation using more lenient settings
        const signature = await connection.sendTransaction(tx, {
            skipPreflight: false,
            maxRetries: 5,
            preflightCommitment: "processed",
        });

        elizaLogger.log("Transaction sent:", signature);

        // Wait for confirmation with more lenient settings
        const confirmation = await connection.confirmTransaction(
            {
                signature,
                blockhash,
                lastValidBlockHeight,
            },
            "processed"
        ); // Use 'processed' instead of default 'finalized'

        if (confirmation.value.err) {
            throw new Error(`Transaction failed: ${confirmation.value.err}`);
        }

        // Add additional verification
        const status = await connection.getSignatureStatus(signature);
        if (status.value?.err) {
            throw new Error(
                `Transaction verification failed: ${status.value.err}`
            );
        }

        elizaLogger.log("Solana trade executed successfully:", {
            signature,
            explorer: `https://solscan.io/tx/${signature}`,
        });

        return {
            success: true,
            signature,
            confirmation,
            explorer: `https://solscan.io/tx/${signature}`,
        };
    } catch (error) {
        // Handle blockhash errors with retry and longer timeout
        if (
            (error.message?.includes("Blockhash not found") ||
                error.message?.includes("block height exceeded")) &&
            retryCount < 3
        ) {
            elizaLogger.warn(
                `Transaction error, retrying (${retryCount + 1}/3)...`
            );
            await new Promise((resolve) => setTimeout(resolve, 5000)); // Longer delay between retries
            return executeTrade(runtime, params, retryCount + 1);
        }

        elizaLogger.error("Trade execution failed:", {
            error: error instanceof Error ? error.message : error,
            stack: error instanceof Error ? error.stack : undefined,
            params,
            retryCount,
        });

        return {
            success: false,
            error: error.message || error,
            params,
            stack: error instanceof Error ? error.stack : undefined,
        };
    }
}

export async function getChainWalletBalance(
    runtime: IAgentRuntime,
    _tokenAddress: string
): Promise<number> {
    // Get Solana balance
    return await getWalletBalance(runtime);
}

// Add this helper function at the top level
export async function simulateTransaction(
    client: any,
    tx: any
): Promise<string> {
    try {
        const result = await client.call({
            account: client.account,
            to: tx.to,
            data: tx.data,
            value: tx.value,
            gas: tx.gas,
            gasPrice: tx.gasPrice,
        });
        return result;
    } catch (error) {
        return `Simulation failed: ${error.message}`;
    }
}
