import { Chain, Asset, Route, TxnEvm } from "./types";
const baseUrl = "https://api2.blockend.com/v1";
import { Wallet, JsonRpcProvider } from "ethers";
import bs58 from "bs58";
import { decodeBase64 } from "ethers";
import { Keypair, VersionedTransaction, Connection } from "@solana/web3.js";
import { elizaLogger } from "@elizaos/core";
import { Config } from "./types";
export function createBlockendService(integratorId: string) {
    if (!integratorId) {
        throw new Error("Integrator ID is required");
    }
    const headers = {
        "Content-Type": "application/json",
        "x-integrator-id": integratorId,
    };
    async function getChains() {
        let req = await fetch(`${baseUrl}/chains`, { headers });
        let res = await req.json();
        let chainsObj: Record<string, Chain> = {};
        res.data.forEach((chain: Chain) => {
            chainsObj[chain.name?.toLowerCase()] = chain;
        });
        return chainsObj;
    }
    async function getTokens(chainId: string) {
        let req = await fetch(`${baseUrl}/tokens?chainId=${chainId}`, {
            headers,
        });
        let res = await req.json();
        let tokensObj: Record<string, Asset> = {};
        res?.data?.[chainId]?.forEach((token: Asset) => {
            tokensObj[token.symbol] = token;
        });
        return tokensObj;
    }
    function getSolanaAddress(keypair: string): string {
        const decodedKeypair = bs58.decode(keypair);
        const solanaKeypair = Keypair.fromSecretKey(decodedKeypair);
        return solanaKeypair.publicKey.toString();
    }
    function getEvmAddress(privateKey: string): string {
        const wallet = new Wallet(privateKey);
        return wallet.address;
    }
    function getWalletAddress(type: string, config: Config) {
        if (type === "sol") {
            if (!config.WALLET_KEYPAIR) {
                elizaLogger.error("No keypair found");
                return false;
            }
            return getSolanaAddress(config.WALLET_KEYPAIR!);
        } else if (type === "evm") {
            if (!config.WALLET_PRIVATE_KEY) {
                elizaLogger.error("No private key found");
                return false;
            }
            return getEvmAddress(config.WALLET_PRIVATE_KEY!);
        }
    }
    function handleAsset(
        fromChainIds: string,
        toChainIds: string,
        fromToken: string,
        toToken: string
    ) {
        if (!fromChainIds) {
            return {
                content: [{ type: "text", text: `No from chain id found` }],
            };
        } else if (!toChainIds) {
            return {
                content: [{ type: "text", text: `No to chain id found` }],
            };
        } else if (!fromToken) {
            return {
                content: [{ type: "text", text: `No from token found` }],
            };
        } else if (!toToken) {
            return {
                content: [{ type: "text", text: `No to token found` }],
            };
        } else {
            return;
        }
    }
    async function signAndSendSolanaTransaction(
        txnData: string,
        keypair: string
    ) {
        try {
            // Connect to Solana network
            const connection = new Connection(
                "https://tammi-n3hltb-fast-mainnet.helius-rpc.com/"
            );

            // Decode the keypair from base58 string
            const decodedKeypair = bs58.decode(keypair);
            const signer = Keypair.fromSecretKey(decodedKeypair);

            // Parse the transaction data
            const transactionBuffer = decodeBase64(txnData);
            const transaction =
                VersionedTransaction.deserialize(transactionBuffer);

            // Get a fresh blockhash
            const { blockhash, lastValidBlockHeight } =
                await connection.getLatestBlockhash();

            // Update the transaction with the new blockhash
            transaction.message.recentBlockhash = blockhash;

            // Sign the transaction
            transaction.sign([signer]);

            // Send and confirm the transaction
            const signature = await connection.sendTransaction(transaction);

            return {
                signature,
            };
        } catch (error) {
            console.error("Error signing and sending transaction:", error);
            throw error;
        }
    }

    async function sendEvmTransaction(
        rpc: string,
        txnData: TxnEvm,
        config: Config
    ) {
        let provider = new JsonRpcProvider(rpc);
        let wallet = new Wallet(config.WALLET_PRIVATE_KEY!, provider);
        let tx = await wallet.sendTransaction(txnData);
        return {
            signature: tx.hash,
        };
    }

    async function pollTransactionStatus(
        routeId: string,
        stepId: string,
        txnHash: string
    ) {
        let currentStatus = "in-progress";
        let statusResponse;
        const startTime = Date.now();
        const TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes in milliseconds

        while (currentStatus === "in-progress") {
            try {
                // Check if we've exceeded the timeout
                if (Date.now() - startTime > TIMEOUT_MS) {
                    throw new Error(
                        "Transaction polling timed out after 20 minutes"
                    );
                }

                const statusCheckReq = await fetch(
                    `${baseUrl}/status?routeId=${routeId}&stepId=${stepId}&txnHash=${txnHash}`,
                    { headers }
                );
                statusResponse = await statusCheckReq.json();

                if (statusResponse.status === "error") {
                    throw new Error(
                        `Status check failed: ${JSON.stringify(statusResponse)}`
                    );
                }

                currentStatus = statusResponse.data.status;

                if (currentStatus === "failed") {
                    throw new Error(
                        `Transaction failed: ${JSON.stringify(statusResponse)}`
                    );
                }

                if (currentStatus === "partially-success") {
                    return statusResponse;
                }

                if (currentStatus === "success") {
                    return statusResponse;
                }

                // Wait for 2 seconds before next poll
                await new Promise((resolve) => setTimeout(resolve, 2000));
            } catch (error) {
                throw error;
            }
        }

        return statusResponse;
    }
    async function executeTransaction(
        {
            fromChainName,
            toChainName,
            fromAssetSymbol,
            toAssetSymbol,
            amount,
            slippage = 50,
        },
        config: Config
    ) {
        try {
            let chains = await getChains();
            let fromChainIds =
                chains?.[fromChainName?.toLowerCase()]?.chainId || "";
            let toChainIds =
                chains?.[toChainName?.toLowerCase()]?.chainId || "";
            let userWallet = getWalletAddress(
                chains?.[fromChainName?.toLowerCase()]?.networkType,
                config
            );
            let recipientWallet = getWalletAddress(
                chains?.[toChainName?.toLowerCase()]?.networkType,
                config
            );
            let tokens = await getTokens(fromChainIds);
            let fromToken = tokens[fromAssetSymbol].address || "";
            let toToken = tokens[toAssetSymbol].address || "";
            handleAsset(fromChainIds, toChainIds, fromToken, toToken);
            elizaLogger.log("FromChainIds", fromChainIds);
            elizaLogger.log("ToChainIds", toChainIds);
            elizaLogger.log("FromToken", fromToken);
            elizaLogger.log("ToToken", toToken);
            elizaLogger.log("Amount", amount);
            elizaLogger.log("Slippage", slippage);
            elizaLogger.log("UserWallet", userWallet);
            let req = await fetch(
                `${baseUrl}/quotes?fromChainId=${fromChainIds}&toChainId=${toChainIds}&fromAssetAddress=${fromToken}&toAssetAddress=${toToken}&inputAmountDisplay=${amount}&slippage=${
                    slippage || 50
                }&userWalletAddress=${userWallet}&recipient=${recipientWallet}`,
                { headers }
            );
            let res = await req.json();
            let removeProviderArray = ["jupag-ultra", "pyth", "dflow"];
            let quote = res?.data?.quotes?.filter(
                (quote: Route) => !removeProviderArray.includes(quote.provider)
            )?.[0];
            elizaLogger.log("Quote", JSON.stringify(quote));
            if (!quote) {
                throw new Error(`No quote found ${JSON.stringify(res)}`);
            }

            let tx = await fetch(
                `${baseUrl}/createTx?routeId=${quote.routeId}`,
                { headers }
            );
            let txRes = await tx.json();
            let steps = txRes?.data?.steps;
            elizaLogger.log("Steps", JSON.stringify(steps));
            if (!txRes?.data) {
                throw new Error(`No txn data found ${JSON.stringify(txRes)}`);
            }

            let lastStatusResponse: any;
            for (const step of steps) {
                try {
                    elizaLogger.log(
                        "Step",
                        JSON.stringify(step),
                        quote.routeId,
                        step.stepId
                    );
                    let nextTx = await fetch(
                        `${baseUrl}/nextTx?routeId=${quote.routeId}&stepId=${step.stepId}`,
                        { headers }
                    );
                    let nextTxRes = await nextTx.json();
                    elizaLogger.log("NextTxRes", JSON.stringify(nextTxRes));
                    if (!nextTxRes?.data) {
                        throw new Error(
                            `Error in step ${step.stepId}: ${JSON.stringify(
                                nextTxRes
                            )}`
                        );
                    }

                    let networkType = nextTxRes.data.txnData.networkType;
                    let txnType = nextTxRes.data.txnData.txnType;
                    let txnData =
                        networkType === "sol"
                            ? nextTxRes.data.txnData.txnSol.data
                            : nextTxRes.data.txnData.txnEvm;

                    if (txnType !== "on-chain") {
                        throw new Error(
                            `Unsupported txn type ${txnType} for step ${step.stepId}`
                        );
                    }

                    let result = { signature: "" };
                    if (networkType === "sol") {
                        result = await signAndSendSolanaTransaction(
                            txnData,
                            config.WALLET_KEYPAIR!
                        );
                    } else {
                        let rpc =
                            process.env.EVM_RPC_URL ||
                            chains?.[fromChainName?.toLowerCase()]
                                ?.rpcUrls?.[0];
                        if (!rpc) {
                            throw new Error(
                                `No rpc found for step ${step.stepId}`
                            );
                        }
                        result = await sendEvmTransaction(rpc, txnData, config);
                    }

                    // Poll for transaction status
                    lastStatusResponse = await pollTransactionStatus(
                        quote.routeId,
                        step.stepId,
                        result.signature
                    );

                    // If the current step failed, break the loop and return error
                    if (lastStatusResponse.data.status === "failed") {
                        return lastStatusResponse;
                    }
                } catch (error: any) {
                    throw new Error(
                        `Error in step ${step.stepId}: ${error.message}`
                    );
                }
            }

            return {
                text: `All steps completed. Final status: ${
                    lastStatusResponse.data.status
                }. Response: ${JSON.stringify(lastStatusResponse)}`,
            };
        } catch (error: any) {
            throw new Error(`Error: ${error.message}`);
        }
    }
    return {
        getChains,
        getTokens,
        executeTransaction,
    };
}
