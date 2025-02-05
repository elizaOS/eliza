import { Address, OpenedContract, SendMode, TonClient } from "@ton/ton";
import { IAgentRuntime, Provider, Memory, State, elizaLogger } from "@elizaos/core";
import { internal } from "@ton/ton";
import { initWalletProvider, WalletProvider } from "./wallet";
import { mnemonicToPrivateKey } from "@ton/crypto";
import { StakeContent } from "../actions/stake";
import { PlatformFactory } from "../services/staking/platformFactory.ts";
import { TonWhalesStrategy } from "../services/staking/strategies/tonWhales.ts";
import { HipoStrategy } from "../services/staking/strategies/hipo.ts";

// Define types for pool info and transaction results.
// export interface PoolInfo {
//     totalStaked: number;
//     rewardRate: number; // Reward rate (e.g., reward per TON per time unit)
//     lockupPeriod: number; // Lock-up period in seconds (or per protocol spec)
//     minimumDeposit: number;
// }

export interface TransactionResult {
    hash: string; // The transaction hash for the operation
    success?: boolean;
    message?: string;
}

// Staking provider interface definition.
export interface IStakingProvider {
    stake(poolId: string, amount: number): Promise<string | null>;
    unstake(poolId: string, amount: number): Promise<string | null>;
    getPoolInfo(poolId: string): Promise<any>;
    getPortfolio(): Promise<string>;
}

// A full implementation of the staking provider that calls the TON RPC.
export class StakingProvider implements IStakingProvider {
    private client: TonClient;
    private walletProvider: WalletProvider;
    private contract: OpenedContract<any>;

    constructor(walletProvider: WalletProvider) {
        // Initialize the wallet provider (which uses TON_PRIVATE_KEY and TON_RPC_URL)
        this.walletProvider = walletProvider;

        // Get the TON client instance from the wallet provider.
        this.client = walletProvider.getWalletClient();

        this.contract = this.client.open(walletProvider.wallet);

        PlatformFactory.register("TON_WHALES", new TonWhalesStrategy());
        PlatformFactory.register("HIPO", new HipoStrategy());
    }

    // Private helper method to get the contract handle from the TON client.
    private async getContract(poolId: string) {
        // The TON client's 'open' method is assumed to return a contract handle
        // with methods: sendStake, sendUnstake, callGetPoolInfo, sendClaimRewards, and sendRestakeRewards.
        return await this.client.open(poolId as any);
    }

    async stake(poolId: string, amount: number): Promise<string | null> {
        elizaLogger.info("STAKING")

        try {
            // Create a transfer
            // Retrieve the wallet's current sequence number.
            const seqno: number = await this.contract.getSeqno();

            // Construct the staking message.
            // The 'internal' helper formats the message for proper on-chain transfers.
            // Here we send the specified amount with a "STAKE" instruction in the body.
            const strategy = PlatformFactory.getStrategy(poolId);

            const stakeMessage = await strategy.createStakeMessage(this.client, poolId, amount);

            // Create and sign the staking transaction using the wallet's secret key.
            const transfer = await this.contract.createTransfer({
                seqno,
                secretKey: this.walletProvider.keypair.secretKey,
                sendMode: SendMode.IGNORE_ERRORS | SendMode.PAY_GAS_SEPARATELY,
                messages: [stakeMessage],
                validUntil: Math.floor(Date.now() / 1000) + 300
            });

            elizaLogger.info("SENDING EXTERNAL MESSAGE:", transfer)

            await this.client.sendExternalMessage(this.walletProvider.wallet, transfer);
            return transfer.hash;
        } catch (error: any) {
            console.error("Error staking TON:", error);
            return null;
        }
    }

    async unstake(poolId: string, amount: number): Promise<string | null> {
        try {
            // Call the contract method to unstake TON.
            const seqno: number = await this.contract.getSeqno();

            const strategy = PlatformFactory.getStrategy(poolId);
            const unstakeMessage = strategy.createUnstakeMessage(this.client, poolId, amount);

            const transfer = await this.contract.createTransfer({
                seqno,
                secretKey: this.walletProvider.keypair.secretKey,
                sendMode: SendMode.IGNORE_ERRORS | SendMode.PAY_GAS_SEPARATELY,
                messages: [unstakeMessage],
                validUntil: Math.floor(Date.now() / 1000) + 300
            });

            await this.client.sendExternalMessage(this.walletProvider.wallet, transfer);
            return transfer.hash;
        } catch (error: any) {
            console.error("Error unstaking TON:", error);
            return null;
        }
    }

    async getPoolInfo(poolAddress: string): Promise<any> {
        try {
            // Call a contract method that queries pool information.
            const strategy = PlatformFactory.getStrategy(poolAddress);
            const info = await strategy.getPoolInfo(this.client, poolAddress);
            console.log(info);
            return info;
        } catch (error: any) {
            console.error("Error fetching pool info:", error);
            throw error;
        }
    }

    async getPortfolio(): Promise<string> {
        return `TON Staking Portfolio: \n`
    }
}

// Initializes the staking provider using settings from the runtime.
export const initStakingProvider = async (
    runtime: IAgentRuntime,
): Promise<IStakingProvider> => {
        const privateKey = runtime.getSetting("TON_PRIVATE_KEY");
    let mnemonics: string[];

    if (!privateKey) {
        throw new Error("TON_PRIVATE_KEY is missing");
    } else {
        mnemonics = privateKey.split(" ");
        if (mnemonics.length < 2) {
            throw new Error("TON_PRIVATE_KEY mnemonic seems invalid");
        }
    }
    const rpcUrl =
        runtime.getSetting("TON_RPC_URL") || "https://toncenter.com/api/v2/jsonRPC";

    const keypair = await mnemonicToPrivateKey(mnemonics, "");

    const walletProvider = new WalletProvider(keypair, rpcUrl, runtime.cacheManager);

    return new StakingProvider(walletProvider) as IStakingProvider;
};

/**
 * Staking provider that sends an on-chain staking transaction.
 *
 * It expects the runtime settings to provide:
 *   - TON_PRIVATE_KEY (for the wallet)
 *   - TON_RPC_URL (or it will default to the mainnet endpoint)
 *   - TON_STAKING_CONTRACT_ADDRESS (the address of the staking contract)
 *
 * The Memory object (message) must also include an `amount` property, e.g.:
 *   {
 *     amount: "1.5"
 *   }
 */
export const nativeStakingProvider: Provider = {
    async get(
        runtime: IAgentRuntime,
        message: Memory,
        state?: State,
    ): Promise<string | null> {
        try {
            const stakingProvider = await initStakingProvider(runtime);

            const stakingPortfolio = await stakingProvider.getPortfolio();
            
            console.log(stakingPortfolio);
            return stakingPortfolio;
        } catch (error) {
            console.error("Error in staking provider:", error);
            return null;
        }
    },
};