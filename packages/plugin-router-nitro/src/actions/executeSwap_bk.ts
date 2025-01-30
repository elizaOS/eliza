import {
    composeContext,
    elizaLogger,
    generateObjectDeprecated,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    ModelClass,
    State
} from "@elizaos/core";
import { swapTemplate } from "./swapTemplate.ts";
import { ChainUtils, fetchChains, fetchPathfinderQuote, fetchTokenConfig } from "./utils.ts";
import { validateRouterNitroConfig } from "../environment.ts";
import { checkAndSetAllowance, checkNativeTokenBalance, checkUserBalance, getSwapTransaction } from "./txns.ts";
import { ethers } from "ethers";
import { getBlockExplorerFromChainId, getRpcUrlFromChainId } from "./chains.ts";

export { swapTemplate };

// Add these interfaces
interface PathfinderDestinationAsset {
    decimals: number;
}

interface PathfinderDestination {
    tokenAmount: string;
    asset: PathfinderDestinationAsset;
}

interface PathfinderResponse {
    destination: PathfinderDestination;
    allowanceTo: string;
}

export const executeSwapAction = {
    name: "ROUTER_NITRO_SWAP",
    description: "Swaps tokens across chains from the agent's wallet to a recipient wallet. \n" +
        "By default the senders configured wallets will be used to send the assets to on the destination chains, unless clearly defined otherwise by providing a recipient address.\n" +
        "The system supports bridging, cross chain swaps and normal swaps.",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State | undefined,
        _options: { [key: string]: unknown } = {},
        callback?: HandlerCallback
    ): Promise<boolean> => {
        console.log("Starting ROUTER_NITRO_SWAP handler...");
        elizaLogger.log("Starting ROUTER_NITRO_SWAP handler...");

        // Initialize or update state
        let updatedState = state;
        if (!updatedState) {
            updatedState = (await runtime.composeState(message)) as State;
        } else {
            updatedState = await runtime.updateRecentMessageState(updatedState);
        }

        const swapContext = composeContext({
            state: updatedState, // Use the local variable
            template: swapTemplate,
        });

        const content = await generateObjectDeprecated({
            runtime,
            context: swapContext,
            modelClass: ModelClass.LARGE,
        });
        console.log("content: ", content);
        elizaLogger.log("swap content: ", JSON.stringify(content));

        if (content.toAddress === null || !(typeof content.toAddress === "string" && content.toAddress.startsWith("0x") && content.toAddress.length === 42)) {
            content.toAddress = runtime.getSetting("ROUTER_NITRO_EVM_ADDRESS");
        }

        const { fromChain, toChain, fromToken, toToken, amount, toAddress } = content;

        try {
            const apiResponse = await fetchChains();
            const chainUtils = new ChainUtils(apiResponse);
            const swapDetails = chainUtils.processChainSwap(fromChain, toChain);
            elizaLogger.log(`Chain Data Details: ${JSON.stringify(swapDetails)}`);

            const privateKey = runtime.getSetting("ROUTER_NITRO_EVM_PRIVATE_KEY");
            if (!privateKey) {
                throw new Error("Private key is missing. Please set ROUTER_NITRO_EVM_PRIVATE_KEY in the environment settings.");
            }
            const rpc = getRpcUrlFromChainId(swapDetails.fromChainId);
            const provider = new ethers.JsonRpcProvider(rpc);
            const wallet = new ethers.Wallet(privateKey, provider);
            const address = await wallet.getAddress();

            if (!swapDetails.fromChainId || !swapDetails.toChainId) {
                elizaLogger.log("Invalid chain data details");
                return false;
            }
            else {
                const fromTokenConfig = await fetchTokenConfig(Number(swapDetails.fromChainId), fromToken);
                const toTokenConfig = await fetchTokenConfig(Number(swapDetails.toChainId), toToken);
                
                let amountIn = BigInt(Math.floor(Number(amount) * 10 ** fromTokenConfig.decimals));

                console.log(`Amount to swap: ${amountIn}`);

                if (fromTokenConfig.address.toLowerCase() === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee") {
                    const userBalance = await checkNativeTokenBalance(wallet, fromTokenConfig.decimals);
           if (BigInt(userBalance) < amountIn) {
                        elizaLogger.log("Insufficient balance to perform the swap");
                        callback?.({ text: "Insufficient balance to perform the swap" });
                        return false;
                    }
                }
                else {
                    const userBalance = await checkUserBalance(wallet, fromTokenConfig.address, fromTokenConfig.decimals);
           if (BigInt(userBalance) < amountIn) {
                        elizaLogger.log("Insufficient balance to perform the swap");
                        callback?.({ text: "Insufficient balance to perform the swap" });
                        return false;
                    }
                }

                const pathfinderParams = {
                    fromTokenAddress: fromTokenConfig.address,
                    toTokenAddress: toTokenConfig.address,
                    amount: (amountIn).toString(), 
                    fromTokenChainId: Number(swapDetails.fromChainId),
                    toTokenChainId: Number(swapDetails.toChainId),
                    partnerId: 127,
                };
                // console.log("Pathfinder Params: ", pathfinderParams);
       const pathfinderResponse = await fetchPathfinderQuote(pathfinderParams) as PathfinderResponse;
                if (pathfinderResponse) {
                    let destinationData = pathfinderResponse.destination;
                    const amountOut = BigInt(destinationData.tokenAmount);
                    const decimals = 10 ** destinationData.asset.decimals;
                    // const decimals = Math.pow(10, destinationData.asset.decimals);
                    const normalizedAmountOut = Number(amountOut) / decimals;
                    elizaLogger.log(`Quote: ${normalizedAmountOut}`);

                     await checkAndSetAllowance(
                         wallet,
                         fromTokenConfig.address,
                         pathfinderResponse.allowanceTo,
                         amountIn
                     );
                    const txResponse = await getSwapTransaction(pathfinderResponse, address, toAddress);

                    const tx = await wallet.sendTransaction(txResponse.txn)
                    try {
                        await tx.wait();
                        const blockExplorerUrl = getBlockExplorerFromChainId(swapDetails.fromChainId).url;
                        if (blockExplorerUrl) {
                            const txExplorerUrl = `${blockExplorerUrl}/tx/${tx.hash}`;
                            elizaLogger.log(`Transaction Explorer URL: ${txExplorerUrl}`);
                            callback?.({
                                text: `Swap completed successfully! Txn: ${txExplorerUrl}`,
                            });
                            return true;

                        } else {
                            callback?.({
                                text: `Swap completed successfully! Txn: ${tx.hash}`,
                            });
                        }
                    }
                    catch (error) {
                        console.log(`Transaction failed with error: ${error}`)
                    }
                }
            }
        } catch (error) {
            elizaLogger.log(`Error during executing swap: ${error.message}`);
            callback?.({ text: `Error during swap: ${error.message}` });
            return false;
        }
        return true;
    },


    template: swapTemplate,
    validate: async (runtime: IAgentRuntime) => {
        await validateRouterNitroConfig(runtime);
        return true;
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Bridge 1 ETH from Ethereum to Base on address 0xCCa8009f5e09F8C5dB63cb0031052F9CB635Af62",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Sure, I'll send 1 ETH from Ethereum to Base",
                    action: "ROUTER_NITRO_SWAP",
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
                    text: "Please swap 1 ETH into USDC from Avalanche to Base on address 0xF43042865f4D3B32A19ECBD1C7d4d924613c41E8",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Sure, I'll swap 1 ETH into USDC from Solana to Base on address 0xF43042865f4D3B32A19ECBD1C7d4d924613c41E8",
                    action: "ROUTER_NITRO_SWAP",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Successfully Swapped 1 ETH into USDC and sent to 0xF43042865f4D3B32A19ECBD1C7d4d924613c41E8 on Base\nTransaction: 2sj3ifA5iPdRDfnkyK5LZ4KoyN57AH2QoHFSzuefom11F1rgdiUriYf2CodBbq9LBi77Q5bLHz4CShveisTu954B",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Send 100 UNI from Arbitrum to Ethereum on 0xCCa8009f5e09F8C5dB63cb0031052F9CB635Af62 ",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Sure, I'll send 100 UNI to Ethereum right away.",
                    action: "ROUTER_NITRO_SWAP",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Successfully sent 100 UNI to 0xCCa8009f5e09F8C5dB63cb0031052F9CB635Af62 on Ethereum\nTransaction: 0x4fed598033f0added272c3ddefd4d83a521634a738474400b27378db462a76ec",
                },
            },
        ],
        [
            {
                "user": "{{user1}}",
                "content": {
                    "text": "Transfer 50 AAVE from Polygon to Optimism on address 0x5C7EDE23cFeBB3A2F60d2D51901A53a276e8F001",
                }
            },
            {
                "user": "{{agent}}",
                "content": {
                    "text": "Sure, I'll transfer 50 AAVE from Polygon to Optimism",
                    "action": "ROUTER_NITRO_SWAP",
                }
            },
            {
                "user": "{{agent}}",
                "content": {
                    "text": "Successfully transferred 50 AAVE to 0x5C7EDE23cFeBB3A2F60d2D51901A53a276e8F001 on Optimism\nTransaction: 0x720b46c95f7f819f5d7e1e8df6fd7d8be12b8d06312bb9d96ea85a45fc65079a",
                }
            }
        ],
        [
            {
                "user": "{{user1}}",
                "content": {
                    "text": "Send 1000 USDT from Ethereum to Arbitrum on address 0x456dC2FfE61d8F92A29b9Bd6b32730d345e0638c",
                }
            },
            {
                "user": "{{agent}}",
                "content": {
                    "text": "Sure, I'll send 1000 USDT from Ethereum to Arbitrum",
                    "action": "ROUTER_NITRO_SWAP",
                }
            },
            {
                "user": "{{agent}}",
                "content": {
                    "text": "Successfully sent 1000 USDT to 0x456dC2FfE61d8F92A29b9Bd6b32730d345e0638c on Arbitrum\nTransaction: 0x3c72a5fe4d0278f2b46dbe765a5f5dbf2f78cbfdce3d0c2b8f11855969e9e173",
                }
            }
        ]
    ],
    similes: ["CROSS_CHAIN_SWAP", "CROSS_CHAIN_BRIDGE", "NITRO_BRIDGE", "SWAP", "BRIDGE", "TRANSFER"],
};

