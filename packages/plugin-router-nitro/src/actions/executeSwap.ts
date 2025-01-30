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
import { swapTemplate } from "./swapTemplate.ts";
import { ChainUtils, fetchChains, fetchPathfinderQuote, fetchTokenConfig } from "./utils.ts";
import { validateRouterNitroConfig } from "../environment.ts";
import { checkAndSetAllowance, checkNativeTokenBalance, checkUserBalance, getSwapTransaction } from "./txns.ts";
import { ethers } from "ethers";
import { getBlockExplorerFromChainId, getRpcUrlFromChainId } from "./chains.ts";

// Types
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

interface SwapContent {
    fromChain: string;
    toChain: string;
    fromToken: string;
    toToken: string;
    amount: string;
    toAddress: string;
}

// Helper functions
const validateAddress = (address: string): boolean => 
    typeof address === "string" && address.startsWith("0x") && address.length === 42;

const initializeWallet = async (runtime: IAgentRuntime, rpc: string) => {
    const privateKey = runtime.getSetting("ROUTER_NITRO_EVM_PRIVATE_KEY");
    if (!privateKey) {
        throw new Error("Private key is missing. Please set ROUTER_NITRO_EVM_PRIVATE_KEY in the environment settings.");
    }
    const provider = new ethers.JsonRpcProvider(rpc);
    return new ethers.Wallet(privateKey, provider);
};

const checkBalances = async (wallet: ethers.Wallet, tokenConfig: any, amountIn: bigint) => {
    const isNativeToken = tokenConfig.address.toLowerCase() === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    
    if (isNativeToken) {
        const nativeBalance = await checkNativeTokenBalance(wallet, tokenConfig.decimals);
        if (BigInt(nativeBalance) < amountIn) {
            throw new Error("Insufficient native token balance");
        }
    }
    
    const tokenBalance = await checkUserBalance(wallet, tokenConfig.address, tokenConfig.decimals);
    if (BigInt(tokenBalance) < amountIn) {
        throw new Error("Insufficient token balance");
    }
};

const handleTransaction = async (
    wallet: ethers.Wallet, 
    txResponse: any, 
    blockExplorer: string,
    callback?: HandlerCallback
) => {
    const tx = await wallet.sendTransaction(txResponse.txn);
    const receipt = await tx.wait();
    
    if (!receipt?.status) {
        throw new Error("Transaction failed");
    }
    
    const txExplorerUrl = blockExplorer ? `${blockExplorer}/tx/${tx.hash}` : tx.hash;
    const successMessage = `Swap completed successfully! Txn: ${txExplorerUrl}`;
    
    callback?.({ text: successMessage });
    return true;
};

export const executeSwapAction = {
    name: "ROUTER_NITRO_SWAP",
    description: "Swaps tokens across chains from the agent's wallet to a recipient wallet.",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State | undefined,
        _options: { [key: string]: unknown } = {},
        callback?: HandlerCallback
    ): Promise<boolean> => {
        elizaLogger.log("Starting ROUTER_NITRO_SWAP handler...");

        try {
            // State initialization
            const updatedState = state ? 
                await runtime.updateRecentMessageState(state) : 
                await runtime.composeState(message);

            // Generate swap content
            const swapContext = composeContext({ state: updatedState, template: swapTemplate });
            const content = await generateObjectDeprecated({
                runtime,
                context: swapContext,
                modelClass: ModelClass.LARGE,
            }) as SwapContent;

            // Validate and set address
            if (!validateAddress(content.toAddress)) {
                content.toAddress = runtime.getSetting("ROUTER_NITRO_EVM_ADDRESS");
            }

            // Initialize chain data
            const chainUtils = new ChainUtils(await fetchChains());
            const swapDetails = chainUtils.processChainSwap(content.fromChain, content.toChain);
            
            if (!swapDetails.fromChainId || !swapDetails.toChainId) {
                throw new Error("Invalid chain data details");
            }

            // Initialize wallet
            const rpc = getRpcUrlFromChainId(swapDetails.fromChainId);
            const wallet = await initializeWallet(runtime, rpc);
            const address = await wallet.getAddress();

            // Fetch token configurations
            const [fromTokenConfig, toTokenConfig] = await Promise.all([
                fetchTokenConfig(Number(swapDetails.fromChainId), content.fromToken),
                fetchTokenConfig(Number(swapDetails.toChainId), content.toToken)
            ]);

            // Calculate amount and check balances
            const amountIn = BigInt(Math.floor(Number(content.amount) * 10 ** fromTokenConfig.decimals));
            await checkBalances(wallet, fromTokenConfig, amountIn);

            // Get pathfinder quote and process swap
            const pathfinderResponse = await fetchPathfinderQuote({
                fromTokenAddress: fromTokenConfig.address,
                toTokenAddress: toTokenConfig.address,
                amount: amountIn.toString(),
                fromTokenChainId: Number(swapDetails.fromChainId),
                toTokenChainId: Number(swapDetails.toChainId),
                partnerId: 127,
            }) as PathfinderResponse;

            if (pathfinderResponse) {
                await checkAndSetAllowance(
                    wallet,
                    fromTokenConfig.address,
                    pathfinderResponse.allowanceTo,
                    amountIn
                );

                const txResponse = await getSwapTransaction(pathfinderResponse, address, content.toAddress);
                const blockExplorer = getBlockExplorerFromChainId(swapDetails.fromChainId).url;
                
                return await handleTransaction(wallet, txResponse, blockExplorer, callback);
            }

            return false;
        } catch (error) {
            elizaLogger.log(`Error during executing swap: ${error.message}`);
            callback?.({ text: `Error during swap: ${error.message}` });
            return false;
        }
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
