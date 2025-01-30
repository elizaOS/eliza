import type { IAgentRuntime, Memory, State, HandlerCallback } from "@elizaos/core";
import { WalletProvider } from "../providers/wallet";
import { voteTemplate } from "../templates";
import type { VoteParams, SupportedChain, Transaction } from "../types";
import governorArtifacts from "../contracts/artifacts/OZGovernor.json";
import { type ByteArray, type Hex, encodeFunctionData, type Address } from "viem";

export { voteTemplate };

export class VoteAction {
    constructor(private walletProvider: WalletProvider) {
        this.walletProvider = walletProvider;
    }

    async vote(params: VoteParams): Promise<Transaction> {
        const walletClient = this.walletProvider.getWalletClient(params.chain);

        const proposalId = BigInt(params.proposalId.toString());
        const support = BigInt(params.support.toString());

        const txData = encodeFunctionData({
            abi: governorArtifacts.abi,
            functionName: "castVote",
            args: [proposalId, support],
        });

        try {
            const chainConfig = this.walletProvider.getChainConfigs(
                params.chain
            );

            // Log current block before sending transaction
            const publicClient = this.walletProvider.getPublicClient(
                params.chain
            );

            const hash = await walletClient.sendTransaction({
                account: walletClient.account,
                to: params.governor,
                value: BigInt(0),
                data: txData as Hex,
                chain: chainConfig,
                kzg: {
                    blobToKzgCommitment: (_blob: ByteArray): ByteArray => {
                        throw new Error("Function not implemented.");
                    },
                    computeBlobKzgProof: (
                        _blob: ByteArray,
                        _commitment: ByteArray
                    ): ByteArray => {
                        throw new Error("Function not implemented.");
                    },
                },
            });

            const receipt = await publicClient.waitForTransactionReceipt({
                hash,
            });

            return {
                hash,
                from: walletClient.account.address,
                to: params.governor,
                value: BigInt(0),
                data: txData as Hex,
                chainId: this.walletProvider.getChainConfigs(params.chain).id,
                logs: receipt.logs,
            };
        } catch (error) {
            throw new Error(`Vote failed: ${error.message}`);
        }
    }
}

export const voteAction = {
    name: "vote",
    description: "Vote for a DAO governance proposal",
    handler: async (
        runtime: IAgentRuntime,
        _message: Memory,
        _state: State,
        options: Record<string, unknown>,
        callback?: HandlerCallback
    ) => {
        try {
            // Validate required fields
            if (!options.chain || !options.governor || 
                !options.proposalId || !options.support) {
                throw new Error("Missing required parameters for vote");
            }

            // Convert options to VoteParams
            const voteParams: VoteParams = {
                chain: options.chain as SupportedChain,
                governor: options.governor as Address,
                proposalId: String(options.proposalId),
                support: Number(options.support)
            };

            const privateKey = runtime.getSetting(
                "EVM_PRIVATE_KEY"
            ) as `0x${string}`;
            const walletProvider = new WalletProvider(privateKey, runtime.cacheManager);
            const action = new VoteAction(walletProvider);
            return await action.vote(voteParams);
        } catch (error) {
            console.error("Error in vote handler:", error.message);
            if (callback) {
                callback({ text: `Error: ${error.message}` });
            }
            return false;
        }
    },
    template: voteTemplate,
    validate: async (runtime: IAgentRuntime) => {
        const privateKey = runtime.getSetting("EVM_PRIVATE_KEY");
        return typeof privateKey === "string" && privateKey.startsWith("0x");
    },
    examples: [
        [
            {
                user: "user",
                content: {
                    text: "Vote yes on proposal 123 on the governor at 0x1234567890123456789012345678901234567890 on Ethereum",
                    action: "GOVERNANCE_VOTE",
                },
            },
        ],
        [
            {
                user: "user",
                content: {
                    text: "Vote no on proposal 456 on the governor at 0xabcdef1111111111111111111111111111111111 on Ethereum",
                    action: "GOVERNANCE_VOTE",
                },
            },
        ],
        [
            {
                user: "user",
                content: {
                    text: "Abstain from voting on proposal 789 on the governor at 0x0000111122223333444455556666777788889999 on Ethereum",
                    action: "GOVERNANCE_VOTE",
                },
            },
        ],
    ],
    similes: ["VOTE", "GOVERNANCE_VOTE", "CAST_VOTE"],
}; // TODO: add more examples
