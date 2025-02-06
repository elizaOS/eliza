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
import { Address, Contract, JettonMaster, toNano, TonClient, TonClient4 } from "@ton/ton";
import { Asset } from "@dedust/sdk";

const SCALE_ADDR = Address.parse(
    "EQBlqsm144Dq6SjbPI4jjZvA1hqTIP3CvHovbIfW_t-SCALE"
);

const tonClient = new TonClient4({
    endpoint: "https://mainnet-v4.tonhubapi.com",
});
const factory = tonClient.open(Factory.createFromAddress(MAINNET_FACTORY_ADDR));

const scale = tonClient.open(JettonRoot.createFromAddress(SCALE_ADDR));

export class Dedust implements DEX {

    async createPool(params: { isTon: boolean; jettons: JettonMaster[] }) {
        const { isTon, jettons } = params;
        jettons.map(async (jetton) => {
            await factory.sendCreateVault(sender, {
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
            await factory.sendCreateVolatilePool(sender, {
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

        if (isTon) {
            const TON = Asset.native();
            const tonVault = tonClient.open(await factory.getNativeVault());

            await tonVault.sendDepositLiquidity(sender, {
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
                    await scale.getWallet(sender.address)
                );

                await assetWallet.sendTransfer(sender, toNano("0.5"), {
                    amount: toNano(jettonDeposit.amount),
                    destination: assetVault.address,
                    responseAddress: this.wallet.address,
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
        const lpWallet = tonClient.open(await pool.getWallet(sender.address));

        await lpWallet.sendBurn(sender, toNano(amount), {
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
