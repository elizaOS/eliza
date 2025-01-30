import {
    elizaLogger,
    Content,
    HandlerCallback,
    type Memory,
    type State,
    ActionExample,
    Action,
    IAgentRuntime,
} from "@elizaos/core";
import { WalletProvider, walletProvider } from "../../providers/wallet.ts";
import { GovProvider } from "../../providers/gov.ts";
import { VoteOption } from "cosmjs-types/cosmos/gov/v1beta1/gov";
import voteOnProposalExamples from "../../action_examples/gov/vote_on_proposal.ts";

export interface VoteOnProposalContent extends Content {
    proposal_id: string;
    vote: VoteOption;
    memo: string;
}

interface validationResult {
    success: boolean;
    message: string;
}

function isVoteOnProposalContent(content: Content): validationResult {
    let msg = "";
    if (!content.proposal_id) {
        msg += "Please provide a proposal id for the vote request.";
    }
    if (!content.vote) {
        msg += "Please provide a vote option for the vote request.";
    }
    if (msg !== "") {
        return {
            success: false,
            message: msg,
        };
    }
    return {
        success: true,
        message: "Vote on proposal request is valid.",
    };
}

const voteOnProposalTemplate = `Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined.

Example response:
\`\`\`json
{
    "proposal_id": "1",
    "vote": "VOTE_OPTION_YES",
}
\`\`\`

{{recentMessages}}

Given the recent messages, extract the following information about the requested vote on proposal:
- proposal_id mentioned in the current message
- deduce the vote option from the current message using these STRICT rules:
    - VOTE_OPTION_YES: when "yes" is mentioned
    - VOTE_OPTION_ABSTAIN: when "abstain" is mentioned
    - VOTE_OPTION_NO: when "no" is mentioned and "veto" is NOT present
    - VOTE_OPTION_NO_WITH_VETO: ONLY when the phrase "no with veto" appears exactly
    - VOTE_OPTION_UNSPECIFIED: when none of the above conditions are met

CRITICAL: For a NO vote:
- If the message contains "no" WITHOUT the word "veto" → use VOTE_OPTION_NO
- ONLY use VOTE_OPTION_NO_WITH_VETO if the exact phrase "no with veto" is present

Respond with a JSON markdown block containing only the extracted values.`;

function validateVoteOption(message: string): VoteOption {
    const lowercaseMessage = message.toLowerCase();

    if (lowercaseMessage.includes("no with veto")) {
        return VoteOption.VOTE_OPTION_NO_WITH_VETO;
    } else if (lowercaseMessage.includes("no")) {
        return VoteOption.VOTE_OPTION_NO;
    } else if (lowercaseMessage.includes("yes")) {
        return VoteOption.VOTE_OPTION_YES;
    } else if (lowercaseMessage.includes("abstain")) {
        return VoteOption.VOTE_OPTION_ABSTAIN;
    }

    return VoteOption.VOTE_OPTION_UNSPECIFIED;
}

export class VoteOnProposalAction {
    async voteOnProposal(
        params: VoteOnProposalContent,
        runtime: IAgentRuntime,
        message: Memory,
        state: State
    ): Promise<string> {
        try {
            const wallet: WalletProvider = await walletProvider.get(
                runtime,
                message,
                state
            );
            const govProvider = new GovProvider(wallet);

            const apiEndpoint =
                runtime.getSetting("apiEndpoint") ||
                process.env.OMNIFLIX_API_URL ||
                "https://rest.omniflix.network";

            const proposalStatus = await verifyProposalStatus(
                apiEndpoint,
                params.proposal_id
            );
            if (!proposalStatus) {
                throw new Error(
                    `Proposal ${params.proposal_id} is not in voting period.`
                );
            }

            const txHash = await govProvider.voteOnProposal(
                params.proposal_id,
                params.vote
            );

            return txHash.transactionHash;
        } catch (error) {
            throw new Error(`Vote on proposal failed: ${error.message}`);
        }
    }
}

const buildVoteOnProposalContent = async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State
): Promise<VoteOnProposalContent> => {
    if (!state) {
        state = (await runtime.composeState(message)) as State;
    }

    // Extract proposal ID from message
    const proposalMatch = message.content?.text?.match(/proposal[^\d]*(\d+)/i);
    if (!proposalMatch) {
        throw new Error("No proposal ID found in message");
    }
    const proposalId = proposalMatch[1];

    // Determine vote option
    const vote = validateVoteOption(message.content.text);
    if (vote === VoteOption.VOTE_OPTION_UNSPECIFIED) {
        throw new Error(
            "No valid vote option found. Please specify YES, NO, ABSTAIN, or NO WITH VETO"
        );
    }

    const voteOnProposalContent: VoteOnProposalContent = {
        proposal_id: proposalId,
        vote: vote,
        memo: "Vote submitted via Eliza",
        text: message.content.text,
    };

    elizaLogger.info(
        `Prepared vote content: ${JSON.stringify(voteOnProposalContent)}`
    );
    return voteOnProposalContent;
};

export default {
    name: "VOTE_ON_PROPOSAL",
    similes: [
        "^vote$",
        "^vote_on_proposal$",
        "^vote_proposal$",
        "^vote_proposal_on$",
    ],
    description: "Vote on a specified omniflix proposal.",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback
    ) => {
        elizaLogger.log("Starting VOTE_ON_PROPOSAL handler...");

        const voteOnProposalContent = await buildVoteOnProposalContent(
            runtime,
            message,
            state
        );

        const validationResult = isVoteOnProposalContent(voteOnProposalContent);
        if (!validationResult.success) {
            if (callback) {
                callback({
                    text: validationResult.message,
                    content: { error: validationResult.message },
                });
            }
            return false;
        }

        try {
            const action = new VoteOnProposalAction();
            const txHash = await action.voteOnProposal(
                voteOnProposalContent,
                runtime,
                message,
                state
            );

            state = await runtime.updateRecentMessageState(state);

            if (callback) {
                callback({
                    text: `Successfully voted on proposal ${voteOnProposalContent.proposal_id} with vote ${voteOnProposalContent.vote}\nTxHash: ${txHash}`,
                    content: {
                        success: true,
                        hash: txHash,
                        proposal_id: voteOnProposalContent.proposal_id,
                        vote: voteOnProposalContent.vote,
                    },
                });
            }
            return true;
        } catch (error) {
            if (callback) {
                callback({
                    text: `Error voting on proposal: ${error.message}`,
                    content: { error: error.message },
                });
            }
            return false;
        }
    },
    template: voteOnProposalTemplate,
    validate: async (_runtime: IAgentRuntime) => {
        return true;
    },
    examples: voteOnProposalExamples as ActionExample[][],
} as Action;

const verifyProposalStatus = async (
    apiEndpoint: string,
    proposalId: string
) => {
    const url = `${apiEndpoint}/cosmos/gov/v1/proposals/${proposalId}`;
    const response = await fetch(url);
    const data = await response.json();

    if (data.proposal.status === "PROPOSAL_STATUS_VOTING_PERIOD") {
        return true;
    }
    return false;
};
