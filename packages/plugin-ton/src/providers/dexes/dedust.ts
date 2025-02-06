import { DEX, JettonDeposit, JettonWithdrawal, Token } from "./dex";
import {
    Factory,
    JettonRoot,
    MAINNET_FACTORY_ADDR,
    Pool,
    PoolType,
    ReadinessStatus,
    VaultJetton,
} from "@dedust/sdk";
import {
    Address,
    Contract,
    JettonMaster,
    Sender,
    SenderArguments,
    toNano,
    TonClient,
    TonClient4,
    WalletContractV3R2,
} from "@ton/ton";
import { Asset } from "@dedust/sdk";
import { mnemonicToPrivateKey } from "@ton/crypto";
import { IAgentRuntime } from "@elizaos/core";
import { CONFIG_KEYS } from "../../enviroment";

const SCALE_ADDR = Address.parse(
    "EQBlqsm144Dq6SjbPI4jjZvA1hqTIP3CvHovbIfW_t-SCALE"
);

const tonClient = new TonClient4({
    endpoint: "https://mainnet-v4.tonhubapi.com",
});
const factory = tonClient.open(Factory.createFromAddress(MAINNET_FACTORY_ADDR));

const scale = tonClient.open(JettonRoot.createFromAddress(SCALE_ADDR));

export class Dedust implements DEX {
    sender: Sender;

    async init(runtime: IAgentRuntime) {
        const privateKey = runtime.getSetting(CONFIG_KEYS.TON_PRIVATE_KEY);
        if (!privateKey) {
            throw new Error(`${CONFIG_KEYS.TON_PRIVATE_KEY} is missing`);
        }
        const mnemonic = privateKey.split(" ");

        const keys = await mnemonicToPrivateKey(mnemonic);
        const wallet = tonClient.open(
            WalletContractV3R2.create({
                workchain: 0,
                publicKey: keys.publicKey,
            })
        );

        this.sender = wallet.sender(keys.secretKey);
    }

    async createPool(params: { isTon: boolean; jettons: JettonMaster[] }) {
        const { isTon, jettons } = params;
        jettons.map(async (jetton) => {
            await factory.sendCreateVault(this.sender, {
                asset: Asset.jetton(jetton.address),
            });
        });

        const TON = Asset.native();

        const assets: [Asset, Asset] = [
            isTon ? TON : Asset.jetton(jettons[0].address),
            Asset.jetton(jettons[isTon ? 0 : 1].address),
        ];

        const pool = tonClient.open(
            await factory.getPool(PoolType.VOLATILE, assets)
        );

        const poolReadiness = await pool.getReadinessStatus();

        if (poolReadiness === ReadinessStatus.NOT_DEPLOYED) {
            await factory.sendCreateVolatilePool(this.sender, {
                assets,
            });
        }
    }

    async deposit(params: {
        jettonDeposits: JettonDeposit[];
        isTon: boolean;
        tonAmount: number;
        slippageTolerance?: number;
        pool?: string;
    }) {
        const { isTon, tonAmount, jettonDeposits } = params;

        const TON = Asset.native();

        const assets: [Asset, Asset] = [
            isTon ? TON : Asset.jetton(jettonDeposits[0].jetton.address),
            Asset.jetton(jettonDeposits[isTon ? 0 : 1].jetton.address),
        ];

        const targetBalances: [bigint, bigint] = [
            toNano(isTon ? tonAmount : jettonDeposits[0].amount),
            toNano(jettonDeposits[isTon ? 0 : 1].amount),
        ];

        if (isTon) {
            const TON = Asset.native();
            const tonVault = tonClient.open(await factory.getNativeVault());

            await tonVault.sendDepositLiquidity(this.sender, {
                poolType: PoolType.VOLATILE,
                assets,
                targetBalances,
                amount: toNano(tonAmount),
            });
        }

        await Promise.all(
            jettonDeposits.map(async (jettonDeposit) => {
                const asset = Asset.jetton(jettonDeposit.jetton.address);

                const assetVault = tonClient.open(
                    await factory.getJettonVault(asset.address)
                );
                const assetWallet = tonClient.open(
                    await scale.getWallet(this.sender.address)
                );

                await assetWallet.sendTransfer(this.sender, toNano("0.5"), {
                    amount: toNano(jettonDeposit.amount),
                    destination: assetVault.address,
                    responseAddress: this.sender.address,
                    forwardAmount: toNano("0.4"),
                    forwardPayload: VaultJetton.createDepositLiquidityPayload({
                        poolType: PoolType.VOLATILE,
                        assets,
                        targetBalances,
                    }),
                });
            })
        );
    }

    async withdraw(params: {
        jettonWithdrawals: JettonWithdrawal[];
        isTon: boolean;
        amount: number;
    }) {
        const { isTon, amount, jettonWithdrawals } = params;
        const TON = Asset.native();

        const assets: [Asset, Asset] = [
            isTon ? TON : Asset.jetton(jettonWithdrawals[0].jetton.address),
            Asset.jetton(jettonWithdrawals[isTon ? 0 : 1].jetton.address),
        ];

        const pool = tonClient.open(
            await factory.getPool(PoolType.VOLATILE, assets)
        );
        const lpWallet = tonClient.open(
            await pool.getWallet(this.sender.address)
        );

        await lpWallet.sendBurn(this.sender, toNano(amount), {
            amount: await lpWallet.getBalance(),
        });
    }

    async claimFee(params: { isTon: boolean; jettons: JettonMaster[] }) {
        const { isTon, jettons } = params;

        const TON = Asset.native();

        const assets: [Asset, Asset] = [
            isTon ? TON : Asset.jetton(jettons[0].address),
            Asset.jetton(jettons[isTon ? 0 : 1].address),
        ];

        const pool = tonClient.open(
            await factory.getPool(PoolType.VOLATILE, assets)
        );

        await pool.getTradeFee();
    }
}
