import { elizaLogger } from "@elizaos/core";
import { DeliverTxResponse } from "@cosmjs/stargate";
import { WalletProvider } from "./wallet";
import { Coin } from "@cosmjs/stargate";

export class StakingProvider {
    private wallet: WalletProvider;

    constructor(wallet: WalletProvider) {
        this.wallet = wallet;
    }

    async delegate(
        validator_address: string,
        amount: Coin
    ): Promise<DeliverTxResponse> {
        const address = await this.wallet.getAddress();
        if (!address) {
            throw new Error("Could not get address");
        }
        try {
            const client = await this.wallet.getClient();
            const tx = await client.delegateTokens(
                address,
                validator_address,
                amount,
                "auto",
                "Delegated tokens using Eliza"
            );
            return tx;
        } catch (e) {
            elizaLogger.error(`Error in delegate: ${e}`);
            throw e;
        }
    }

    async undelegate(
        validator_address: string,
        amount: Coin
    ): Promise<DeliverTxResponse> {
        const address = await this.wallet.getAddress();
        if (!address) {
            throw new Error("Could not get address");
        }
        try {
            const client = await this.wallet.getClient();
            const tx = await client.undelegateTokens(
                address,
                validator_address,
                amount,
                "auto",
                "Undelegated tokens using Eliza"
            );
            return tx;
        } catch (e) {
            elizaLogger.error(`Error in undelegate: ${e}`);
            throw e;
        }
    }

    async redelegate(
        validator_src_address: string,
        validator_dst_address: string,
        amount: Coin
    ): Promise<DeliverTxResponse> {
        const address = await this.wallet.getAddress();
        if (!address) {
            throw new Error("Could not get address");
        }

        const msg = {
            typeUrl: "/cosmos.staking.v1beta1.MsgBeginRedelegate",
            value: {
                delegatorAddress: address.trim(),
                validatorSrcAddress: validator_src_address.trim(),
                validatorDstAddress: validator_dst_address.trim(),
                amount: amount,
            },
        };
        try {
            const client = await this.wallet.getClient();
            const tx = await client.signAndBroadcast(
                address,
                [msg],
                "auto",
                "Redelegated tokens using Eliza"
            );
            return tx;
        } catch (e) {
            elizaLogger.error(`Error in redelegate: ${e}`);
            throw e;
        }
    }

    async cancelUnbondingDelegation(
        validator_address: string,
        creation_height: number,
        amount: Coin
    ): Promise<DeliverTxResponse> {
        const address = await this.wallet.getAddress();
        if (!address) {
            throw new Error("Could not get address");
        }

        const msg = {
            typeUrl: "/cosmos.staking.v1beta1.MsgCancelUnbondingDelegation",
            value: {
                delegatorAddress: address.trim(),
                validatorAddress: validator_address.trim(),
                amount: amount,
                creationHeight: BigInt(creation_height),
            },
        };

        try {
            const client = await this.wallet.getClient();
            const tx = await client.signAndBroadcast(
                address.trim(),
                [msg],
                "auto",
                "Cancelled unbonding delegation using Eliza"
            );
            return tx;
        } catch (e) {
            elizaLogger.error(`Error in cancelUnbondingDelegation: ${e}`);
            throw e;
        }
    }
}
