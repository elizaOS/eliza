import {
    ActionExample,
    composeContext,
    generateObjectDeprecated,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    ModelClass,
    // settings,
    State,
    type Action,
} from "@elizaos/core";
// import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";
// import BigNumber from "bignumber.js";
// import { getWalletKey } from "../keypairUtils.ts";
// import { walletProvider, WalletProvider } from "../providers/wallet.ts";
// import { getTokenDecimals } from "./swapUtils.ts";

// async function swapToken(
//     connection: Connection,
//     walletPublicKey: PublicKey,
//     inputTokenCA: string,
//     outputTokenCA: string,
//     amount: number
// ): Promise<any> {
//     try {
//         // Get the decimals for the input token
//         const decimals =
//             inputTokenCA === settings.SOL_ADDRESS
//                 ? new BigNumber(9)
//                 : new BigNumber(
//                       await getTokenDecimals(connection, inputTokenCA)
//                   );

//         console.log("Decimals:", decimals.toString());

//         // Use BigNumber for adjustedAmount: amount * (10 ** decimals)
//         const amountBN = new BigNumber(amount);
//         const adjustedAmount = amountBN.multipliedBy(
//             new BigNumber(10).pow(decimals)
//         );

//         console.log("Fetching quote with params:", {
//             inputMint: inputTokenCA,
//             outputMint: outputTokenCA,
//             amount: adjustedAmount,
//         });

//         const quoteResponse = await fetch(
//             `https://quote-api.jup.ag/v6/quote?inputMint=${inputTokenCA}&outputMint=${outputTokenCA}&amount=${adjustedAmount}&slippageBps=50`
//         );
//         const quoteData = await quoteResponse.json();

//         if (!quoteData || quoteData.error) {
//             console.error("Quote error:", quoteData);
//             throw new Error(
//                 `Failed to get quote: ${quoteData?.error || "Unknown error"}`
//             );
//         }

//         console.log("Quote received:", quoteData);

//         const swapRequestBody = {
//             quoteResponse: quoteData,
//             userPublicKey: walletPublicKey.toString(),
//             wrapAndUnwrapSol: true,
//             computeUnitPriceMicroLamports: 2000000,
//             dynamicComputeUnitLimit: true,
//         };

//         console.log("Requesting swap with body:", swapRequestBody);

//         const swapResponse = await fetch("https://quote-api.jup.ag/v6/swap", {
//             method: "POST",
//             headers: {
//                 "Content-Type": "application/json",
//             },
//             body: JSON.stringify(swapRequestBody),
//         });

//         const swapData = await swapResponse.json();

//         if (!swapData || !swapData.swapTransaction) {
//             console.error("Swap error:", swapData);
//             throw new Error(
//                 `Failed to get swap transaction: ${swapData?.error || "No swap transaction returned"}`
//             );
//         }

//         console.log("Swap transaction received");
//         return swapData;
//     } catch (error) {
//         console.error("Error in swapToken:", error);
//         throw error;
//     }
// }

const swapTemplate = `Please extract the following swap details for SUI network:

{
    "inputTokenSymbol": string | null,     // Token being sold (e.g. "SUI")
    "outputTokenSymbol": string | null,    // Token being bought
    "inputTokenType": string | null,       // SUI token type path
    "outputTokenType": string | null,      // Target token type path
    "amount": number | null,               // Amount to swap
    "slippageBps": number | null          // Slippage tolerance in basis points (e.g. 50 = 0.5%)
}

Recent messages: {{recentMessages}}
Wallet info: {{walletInfo}}

Extract the swap parameters from the conversation and wallet context above. Return only a JSON object with the specified fields. Use null for any values that cannot be determined.

Example response:
{
    "inputTokenSymbol": "SUI",
    "outputTokenSymbol": "USDC",
    "inputTokenType": "0x2::sui::SUI",
    "outputTokenType": "0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN",
    "amount": 1.5,
    "slippageBps": 50
}
\`\`\``;

// if we get the token symbol but not the CA, check walet for matching token, and if we have, get the CA for it

<<<<<<< HEAD
// get all the tokens in the wallet using the wallet provider
// async function getTokensInWallet(runtime: IAgentRuntime) {
//     const { publicKey } = await getWalletKey(runtime, false);
//     const walletProvider = new WalletProvider(
//         new Connection("https://api.mainnet-beta.solana.com"),
//         publicKey
//     );

//     const walletInfo = await walletProvider.fetchPortfolioValue(runtime);
//     const items = walletInfo.items;
//     return items;
// }

// check if the token symbol is in the wallet
// async function getTokenFromWallet(runtime: IAgentRuntime, tokenSymbol: string) {
//     try {
//         const items = await getTokensInWallet(runtime);
//         const token = items.find((item) => item.symbol === tokenSymbol);

//         if (token) {
//             return token.address;
//         } else {
//             return null;
//         }
//     } catch (error) {
//         console.error("Error checking token in wallet:", error);
//         return null;
//     }
// }

// swapToken should took CA, not symbol

export const executeSwap: Action = {
    name: "SUI_EXECUTE_SWAP",
    similes: ["SUI_SWAP_TOKENS", "SUI_TOKEN_SWAP", "SUI_TRADE_TOKENS", "SUI_EXCHANGE_TOKENS"],
    validate: async (runtime: IAgentRuntime, message: Memory) => {
        // Check if the necessary parameters are provided in the message
=======
// swapToken should took CA, not symbol

export const swap: Action = {
    name: "EXECUTE_SWAP",
    similes: ["SWAP_TOKENS", "TOKEN_SWAP", "TRADE_TOKENS", "EXCHANGE_TOKENS"],
    validate: async (runtime: IAgentRuntime, message: Memory) => {
>>>>>>> refs/remotes/origin/main
        console.log("Message:", message);
        return true;
    },
    description: "Perform a token swap.",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback
    ): Promise<boolean> => {
<<<<<<< HEAD
        // composeState
=======
>>>>>>> refs/remotes/origin/main
        if (!state) {
            state = (await runtime.composeState(message)) as State;
        } else {
            state = await runtime.updateRecentMessageState(state);
        }
<<<<<<< HEAD
        console.log("Stateofsuimarket:", state);
        // const walletInfo = await walletProvider.get(runtime, message, state);

        // state.walletInfo = walletInfo;
=======
>>>>>>> refs/remotes/origin/main

        const swapContext = composeContext({
            state,
            template: swapTemplate,
        });

        const response = await generateObjectDeprecated({
            runtime,
            context: swapContext,
            modelClass: ModelClass.LARGE,
        });
<<<<<<< HEAD

        const txid = "DvH9w7EoS3XBsSukB43tkjGp6P5veRe8JfSrBT5RyyAG"
        console.log("Response:", response);
        // // const type = response.inputTokenSymbol?.toUpperCase() === "SOL" ? "buy" : "sell";

        // // Add SOL handling logic
        // if (response.inputTokenSymbol?.toUpperCase() === "SOL") {
        //     response.inputTokenCA = settings.SOL_ADDRESS;
        // }
        // if (response.outputTokenSymbol?.toUpperCase() === "SOL") {
        //     response.outputTokenCA = settings.SOL_ADDRESS;
        // }

        // // if both contract addresses are set, lets execute the swap
        // // TODO: try to resolve CA from symbol based on existing symbol in wallet
        // if (!response.inputTokenCA && response.inputTokenSymbol) {
        //     console.log(
        //         `Attempting to resolve CA for input token symbol: ${response.inputTokenSymbol}`
        //     );
        //     response.inputTokenCA = await getTokenFromWallet(
        //         runtime,
        //         response.inputTokenSymbol
        //     );
        //     if (response.inputTokenCA) {
        //         console.log(`Resolved inputTokenCA: ${response.inputTokenCA}`);
        //     } else {
        //         console.log("No contract addresses provided, skipping swap");
        //         const responseMsg = {
        //             text: "I need the contract addresses to perform the swap",
        //         };
        //         callback?.(responseMsg);
        //         return true;
        //     }
        // }

        // if (!response.outputTokenCA && response.outputTokenSymbol) {
        //     console.log(
        //         `Attempting to resolve CA for output token symbol: ${response.outputTokenSymbol}`
        //     );
        //     response.outputTokenCA = await getTokenFromWallet(
        //         runtime,
        //         response.outputTokenSymbol
        //     );
        //     if (response.outputTokenCA) {
        //         console.log(
        //             `Resolved outputTokenCA: ${response.outputTokenCA}`
        //         );
        //     } else {
        //         console.log("No contract addresses provided, skipping swap");
        //         const responseMsg = {
        //             text: "I need the contract addresses to perform the swap",
        //         };
        //         callback?.(responseMsg);
        //         return true;
        //     }
        // }

        // if (!response.amount) {
        //     console.log("No amount provided, skipping swap");
        //     const responseMsg = {
        //         text: "I need the amount to perform the swap",
        //     };
        //     callback?.(responseMsg);
        //     return true;
        // }

        // // TODO: if response amount is half, all, etc, semantically retrieve amount and return as number
        // if (!response.amount) {
        //     console.log("Amount is not a number, skipping swap");
        //     const responseMsg = {
        //         text: "The amount must be a number",
        //     };
        //     callback?.(responseMsg);
        //     return true;
        // }
        try {
            // const connection = new Connection(
            //     "https://api.mainnet-beta.solana.com"
            // );
            // const { publicKey: walletPublicKey } = await getWalletKey(
            //     runtime,
            //     false
            // );

            // const provider = new WalletProvider(connection, walletPublicKey);

            // console.log("Wallet Public Key:", walletPublicKey);
            // console.log("inputTokenSymbol:", response.inputTokenCA);
            // console.log("outputTokenSymbol:", response.outputTokenCA);
            // console.log("amount:", response.amount);

            // const swapResult = await swapToken(
            //     connection,
            //     walletPublicKey,
            //     response.inputTokenCA as string,
            //     response.outputTokenCA as string,
            //     response.amount as number
            // );

            // console.log("Deserializing transaction...");
            // const transactionBuf = Buffer.from(
            //     swapResult.swapTransaction,
            //     "base64"
            // );
            // const transaction =
            //     VersionedTransaction.deserialize(transactionBuf);

            // console.log("Preparing to sign transaction...");

            // console.log("Creating keypair...");
            // const { keypair } = await getWalletKey(runtime, true);
            // // Verify the public key matches what we expect
            // if (keypair.publicKey.toBase58() !== walletPublicKey.toBase58()) {
            //     throw new Error(
            //         "Generated public key doesn't match expected public key"
            //     );
            // }

            // console.log("Signing transaction...");
            // transaction.sign([keypair]);

            // console.log("Sending transaction...");

            // const latestBlockhash = await connection.getLatestBlockhash();

            // const txid = await connection.sendTransaction(transaction, {
            //     skipPreflight: false,
            //     maxRetries: 3,
            //     preflightCommitment: "confirmed",
            // });

            // console.log("Transaction sent:", txid);

            // // Confirm transaction using the blockhash
            // const confirmation = await connection.confirmTransaction(
            //     {
            //         signature: txid,
            //         blockhash: latestBlockhash.blockhash,
            //         lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
            //     },
            //     "confirmed"
            // );

            // if (confirmation.value.err) {
            //     throw new Error(
            //         `Transaction failed: ${confirmation.value.err}`
            //     );
            // }

            // if (confirmation.value.err) {
            //     throw new Error(
            //         `Transaction failed: ${confirmation.value.err}`
            //     );
            // }

            console.log("Swap completed successfully!");
            console.log(`Transaction ID: ${txid}`);

            const responseMsg = {
                text: `Swap completed successfully! Transaction ID: ${txid}, ${response.inputTokenSymbol} -> ${response.outputTokenSymbol} ${response.inputTokenType} -> ${response.outputTokenType}, ${response.amount} ${response.inputTokenSymbol}`,
=======

        elizaLogger.log("swap info:", response);

        try {
            const responseMsg = {
                text: `Swap completed successfully! Transaction ID`,
                response: response
>>>>>>> refs/remotes/origin/main
            };

            callback?.(responseMsg);

            return true;
        } catch (error) {
            console.error("Error during token swap:", error);
            return false;
        }
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    inputTokenSymbol: "SUI",
<<<<<<< HEAD
                    outputTokenSymbol: "USDT",
                    amount: 10,
                    slippageBps: 50
                }
=======
                    outputTokenSymbol: "USDC",
                    amount: 0.1,
                },
>>>>>>> refs/remotes/origin/main
            },
            {
                user: "{{user2}}",
                content: {
<<<<<<< HEAD
                    text: "Initiating swap of 10 SUI for USDT on SUI network...",
                    action: "SUI_TOKEN_SWAP",
                    params: {
                        inputType: "0x2::sui::SUI",
                        outputType: "0x4fb3c0f9e62b5d3956e2f0e284f2a5d128954750b109203a0f34c92c6ba21247::coin::USDT",
                        amount: "10000000000", // Amount in base units
                        slippageBps: 50
                    }
                }
=======
                    text: "Swapping 0.1 SUI for USDC...",
                    action: "TOKEN_SWAP",
                },
>>>>>>> refs/remotes/origin/main
            },
            {
                user: "{{user2}}",
                content: {
<<<<<<< HEAD
                    text: "Swap executed successfully! Transaction digest: {{txDigest}}",
                    transactionDetails: {
                        digest: "8k2x9NM4pB6MiUx9YH1zKwP9K7Z8YfFvH1J5QrLZDvs2",
                        status: "success",
                        gasFee: "0.00234 SUI"
                    }
                }
            }
        ]
=======
                    text: "Swap completed successfully! Transaction ID: ...",
                },
            },
        ],
>>>>>>> refs/remotes/origin/main
    ] as ActionExample[][],
} as Action;
