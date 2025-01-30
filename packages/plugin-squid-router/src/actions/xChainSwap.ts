import {
    composeContext,
    elizaLogger,
    generateObjectDeprecated,
    type HandlerCallback,
    type IAgentRuntime,
    type Memory,
    ModelClass,
    type State
} from "@elizaos/core";
import {xChainSwapTemplate} from "../templates";
import {convertToWei, isXChainSwapContent, validateSquidRouterConfig} from "../helpers/utils.ts";
import {ethers} from "ethers";
import {initSquidRouterProvider} from "../providers/squidRouter.ts";

export { xChainSwapTemplate };

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const approveSpending = async (transactionRequestTarget: string, fromToken: string, fromAmount: string, signer: ethers.Signer) => {
    const erc20Abi = [
        "function approve(address spender, uint256 amount) public returns (bool)"
    ];
    const tokenContract = new ethers.Contract(fromToken, erc20Abi, signer);
    try {
        const tx = await tokenContract.approve(transactionRequestTarget, fromAmount);
        await tx.wait();
        console.log(`Approved ${fromAmount} tokens for ${transactionRequestTarget}`);
    } catch (error) {
        console.error('Approval failed:', error);
        throw error;
    }
};

export const xChainSwapAction = {
    name: "X_CHAIN_SWAP",
    description: "Swaps tokens across chains from the agent's wallet to a recipient wallet. \n"+
        "By default the senders configured wallets will be used to send the assets to on the destination chains, unless clearly defined otherwise by providing a recipient address.\n" +
        "The system supports bridging, cross chain swaps and normal swaps.",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback
    ): Promise<boolean> => {
        elizaLogger.log("Starting X_CHAIN_SWAP handler...");

        let currentState = state; // Create new variable
        if (!currentState) {
            currentState = (await runtime.composeState(message)) as State;
        } else {
            currentState = await runtime.updateRecentMessageState(currentState);
        }

        // Compose X chain swap context
        const xChainSwapContext = composeContext({
            state: currentState, // Use the new variable
            template: xChainSwapTemplate,
        });

        // Generate X chain swap content
        const content = await generateObjectDeprecated({
            runtime,
            context: xChainSwapContext,
            modelClass: ModelClass.SMALL,
        });

        if(content.toAddress === null) {
            content.toAddress = runtime.getSetting("SQUID_EVM_ADDRESS");
        }

        elizaLogger.log("swap content: ",JSON.stringify(content));

        // Validate transfer content
        if (!isXChainSwapContent(content)) {
            console.error("Invalid content for X_CHAIN_SWAP action.");
            if (callback) {
                callback({
                    text: "Unable to process cross-chain swap request. Invalid content provided.",
                    content: { error: "Invalid cross-chain swap content" },
                });
            }
            return false;
        }

        try {

            const squidRouter = initSquidRouterProvider(runtime);
            await squidRouter.initialize();
            console.log("Initialized Squid SDK");

            const fromChainObject = squidRouter.getChain(content.fromChain);
            if(!fromChainObject) {
                throw new Error(
                    "Chain to swap from is not supported."
                );
            }

            const toChainObject = squidRouter.getChain(content.toChain);
            if(!toChainObject) {
                throw new Error(
                    "Chain to swap to is not supported."
                );
            }

            const fromTokenObject = squidRouter.getToken(fromChainObject, content.fromToken);
            if(!fromTokenObject?.enabled) {
                throw new Error(
                    "Token to swap from is not supported."
                );
            }

            const toTokenObject = squidRouter.getToken(toChainObject, content.toToken);
            if(!fromTokenObject?.enabled) {
                throw new Error(
                    "Token to swap into is not supported."
                );
            }

            const signer = await squidRouter.getEVMSignerForChain(fromChainObject, runtime);

            const params = {
                fromAddress: await signer.getAddress(),
                fromChain: fromChainObject.chainId,
                fromToken: fromTokenObject.address,
                fromAmount: convertToWei(content.amount, fromTokenObject),
                toChain: toChainObject.chainId,
                toToken: toTokenObject.address,
                toAddress: content.toAddress,
                quoteOnly: false
            };

            console.log("Parameters:", params); // Printing the parameters for QA

            const throttleInterval = runtime.getSetting("SQUID_API_THROTTLE_INTERVAL") ? Number(runtime.getSetting("SQUID_API_THROTTLE_INTERVAL")) : 0

            await delay(throttleInterval);

            // Get the swap route using Squid SDK
            const {route} = await squidRouter.getRoute(params);
            console.log("Calculated route:", route.estimate.toAmount);

            const transactionRequest = route.transactionRequest;

            // Approve the transactionRequest.target to spend fromAmount of fromToken
            if ("target" in transactionRequest) {
                if(!fromTokenObject.isNative) {
                    await approveSpending(transactionRequest.target, params.fromToken, params.fromAmount, signer);
                }
            } else {
                throw new Error(
                    "Non-expected transaction request"
                );
            }

            await delay(throttleInterval);

            // Execute the swap transaction
            const tx = (await squidRouter.executeRoute({
                signer,
                route,
            })) as unknown as ethers.TransactionResponse;
            const txReceipt = await tx.wait();

            // Show the transaction receipt with Axelarscan link
            const axelarScanLink = `https://axelarscan.io/gmp/${txReceipt.hash}`; // Fix: Use template literal
            elizaLogger.log(`Finished! Check Axelarscan for details: ${axelarScanLink}`);

            if (callback) {
                callback({
                    text: `Swap completed successfully! Check Axelarscan for details:\n${axelarScanLink}`, // Fix: Use template literal
                    content: {},
                });
            }



        } catch (error) {
            elizaLogger.error("Error during cross-chain swap:", error);
            if (callback) {
                callback({
                    text: `Error during cross-chain swap: ${error.message}`,
                    content: { error: error.message },
                });
            }
            return false;
        }
    },
    template: xChainSwapTemplate,
    validate: async (runtime: IAgentRuntime) => {
        await validateSquidRouterConfig(runtime);
        return true;
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Bridge 1 ETH from Ethereum to Base",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Sure, I'll send 1 ETH from Ethereum to Base",
                    action: "X_CHAIN_SWAP",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Successfully sent 1 ETH to 0xCCa8009f5e09F8C5dB63cb0031052F9CB635Af62 on Base\nTransaction: 0x4fed598033f0added272c3ddefd4d83a521634a738474400b27378db462a76ec",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Please swap 1 SOL into USDC from Solana to Base on address 0xF43042865f4D3B32A19ECBD1C7d4d924613c41E8",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Sure, I'll swap 1 SOL into USDC from Solana to Base on address 0xF43042865f4D3B32A19ECBD1C7d4d924613c41E8",
                    action: "X_CHAIN_SWAP",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Successfully Swapped 1 SOL into USDC and sent to 0xF43042865f4D3B32A19ECBD1C7d4d924613c41E8 on Base\nTransaction: 2sj3ifA5iPdRDfnkyK5LZ4KoyN57AH2QoHFSzuefom11F1rgdiUriYf2CodBbq9LBi77Q5bLHz4CShveisTu954B",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Send 100 UNI from Arbitrum to Ethereum",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Sure, I'll send 100 UNI to Ethereum right away.",
                    action: "X_CHAIN_SWAP",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Successfully sent 100 UNI to 0xCCa8009f5e09F8C5dB63cb0031052F9CB635Af62 on Ethereum\nTransaction: 0x4fed598033f0added272c3ddefd4d83a521634a738474400b27378db462a76ec",
                },
            },
        ]
    ],
    similes: ["CROSS_CHAIN_SWAP", "CROSS_CHAIN_BRIDGE", "MOVE_CROSS_CHAIN", "SWAP","BRIDGE"],
}; // TODO: add more examples / similies
