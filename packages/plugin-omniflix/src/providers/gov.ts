import { elizaLogger } from "@elizaos/core";
import { DeliverTxResponse } from "@cosmjs/stargate";
import { WalletProvider } from "./wallet";
import { VoteOption } from "cosmjs-types/cosmos/gov/v1beta1/gov";

export class GovProvider {
    private wallet: WalletProvider;

    constructor(wallet: WalletProvider) {
        this.wallet = wallet;
    }

    async voteOnProposal(
        proposalId: string,
        vote: VoteOption
    ): Promise<DeliverTxResponse> {
        try {
            const address = await this.wallet.getAddress();
            const client = await this.wallet.getClient();
            if (!address) {
                throw new Error("Could not get address");
            }

            const voteOption =
                VoteOption[vote as unknown as keyof typeof VoteOption];

            const msg = {
                typeUrl: "/cosmos.gov.v1beta1.MsgVote",
                value: {
                    proposalId: BigInt(proposalId),
                    voter: address,
                    option: VoteOption[voteOption],
                },
            };

            const tx = await client.signAndBroadcast(
                address,
                [msg],
                200000,
                "Voted on proposal using Eliza"
            );
            return tx;
        } catch (e) {
            elizaLogger.error(`Error in voteOnProposal: ${e}`);
            throw e;
        }
    }
}
