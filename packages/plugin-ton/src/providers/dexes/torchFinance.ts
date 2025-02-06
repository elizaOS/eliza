import { JettonDeposit, DEX, Token, JettonWithdrawal } from "./dex";
import {
    TorchSDK,
    generateQueryId,
    DepositParams,
    toUnit,
    WithdrawParams,
} from "@torch-finance/sdk";
import { Asset } from "@torch-finance/core";
import {
    internal,
    OpenedContract,
    SenderArguments,
    SendMode,
    WalletContractV5R1,
} from "@ton/ton";
import { IAgentRuntime } from "@elizaos/core";
import { CONFIG_KEYS } from "../../enviroment";
import { KeyPair, mnemonicToWalletKey } from "@ton/crypto";

const sdk = new TorchSDK();

const TON_ASSET = Asset.ton();
const TSTON_ADDRESS = "EQC98_qAmNEptUtPc7W6xdHh_ZHrBUFpw5Ft_IzNU20QAJav";
const TSTON_ASSET = Asset.jetton(TSTON_ADDRESS);
const STTON_ADDRESS = "EQDNhy-nxYFgUqzfUzImBEP67JqsyMIcyk2S5_RwNNEYku0k";
const STTON_ASSET = Asset.jetton(STTON_ADDRESS);

const SUPPORTED_TOKENS = [
    "EQC98_qAmNEptUtPc7W6xdHh_ZHrBUFpw5Ft_IzNU20QAJav",
    "EQDNhy-nxYFgUqzfUzImBEP67JqsyMIcyk2S5_RwNNEYku0k",
    "EQDPdq8xjAhytYqfGSX8KcFWIReCufsB9Wdg0pLlYSO_h76w",
];

const TriTONPoolAddress = "EQDTvrxTLp9yKHpsAtcXkJGno_d9HYw62yaWpghlFhDUNQPJ";

// TODO
// Get pool data
// leveraged farming(tsTON/USDT) a pool?

export class TorchFinance implements DEX {
    private wallet: OpenedContract<WalletContractV5R1>;
    private keyPair: KeyPair;

    async send(args: SenderArguments | SenderArguments[]): Promise<string> {
        args = Array.isArray(args) ? args : [args];
        const msg = this.wallet.createTransfer({
            seqno: await this.wallet.getSeqno(),
            secretKey: this.keyPair.secretKey,
            messages: args.map((arg) => {
                return internal({
                    to: arg.to,
                    value: arg.value,
                    body: arg.body,
                });
            }),
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            timeout: Math.floor(Date.now() / 1000) + 60,
        });
        await this.wallet.send(msg);
        const msgHash = "getMsgHash(wallet.address.toString(), msg)";
        return msgHash;
    }

    constructor(wallet, runtime: IAgentRuntime) {
        this.wallet = wallet;
        const privateKey = runtime.getSetting(CONFIG_KEYS.TON_PRIVATE_KEY);
        if (!privateKey) {
            throw new Error(`${CONFIG_KEYS.TON_PRIVATE_KEY} is missing`);
        }
        const mnemonics = privateKey.split(" ");
        if (mnemonics.length < 2) {
            throw new Error(
                `${CONFIG_KEYS.TON_PRIVATE_KEY} mnemonic seems invalid`
            );
        }

        mnemonicToWalletKey(mnemonics, "").then((keyPair) => {
            this.keyPair = keyPair;
        });
    }

    // Not supported
    async createPool() {
        throw new Error("Not Supported");
    }

    supportedTokens() {
        return SUPPORTED_TOKENS.push("TON");
    }

    async deposit(params: {
        jettonDeposits: JettonDeposit[];
        isTon: boolean;
        tonAmount: number;
        slippageTolerance?: number;
        pool?: string;
    }) {
        const { jettonDeposits, isTon, tonAmount, slippageTolerance, pool } =
            params;

        const queryId = await generateQueryId();
        jettonDeposits.forEach((asset) => {
            if (!SUPPORTED_TOKENS.includes(asset.jetton.address.toString())) {
                throw new Error("Unsupported asset");
            }
        });

        let depositAmounts = [];

        if (isTon) {
            depositAmounts.push({
                asset: TSTON_ASSET,
                value: tonAmount,
            });
        }

        jettonDeposits.map((asset) => {
            depositAmounts.push({
                asset:
                    asset.jetton.address.toString() === STTON_ADDRESS
                        ? STTON_ASSET
                        : TSTON_ASSET,
                value: toUnit(asset.amount, 9),
            });
        });

        const depositParams: DepositParams = {
            queryId,
            // TODO Look supported pools
            pool: pool ?? TriTONPoolAddress,
            depositAmounts,
            slippageTolerance: slippageTolerance ?? 0.01, // 1%
        };

        const { result, getDepositPayload } = await sdk.simulateDeposit(
            depositParams
        );

        const sender = this.wallet.address;
        const senderArgs = await getDepositPayload(sender, {
            ...depositParams,
            blockNumber: 27724599,
        });

        const msgHash = await this.send(senderArgs);
        console.log(`Transaction sent with msghash: ${msgHash}`);
    }

    async withdraw(params: {
        jettonWithdrawals: JettonWithdrawal[];
        isTon: boolean;
        amount: number;
    }) {
        const { isTon, jettonWithdrawals, amount} =
            params;

        const queryId = await generateQueryId();
        const LpDecimals = 18;
        // If you want to speed up the swap process, you can set the blockNumber to reduce the number of queries
        const blockNumber = 27724599;

        let withdrawParams: WithdrawParams;

        if (isTon && !jettonWithdrawals) {
            withdrawParams = {
                mode: "Single", // Single Mode: Withdraw one specific asset
                queryId,
                pool: TriTONPoolAddress, // Base Pool address
                burnLpAmount: toUnit(amount, LpDecimals), // Amount of Base Pool LP tokens (TriTon) to remove
                withdrawAsset: TON_ASSET, // Specify the asset to withdraw (TON)
            };
        }

        if (isTon && jettonWithdrawals.length === 2) {
            withdrawParams = {
                mode: "Balanced", // Balanced Mode: Withdraw all assets proportionally
                queryId,
                pool: TriTONPoolAddress, // Base Pool address
                burnLpAmount: toUnit(amount, LpDecimals), // Amount of Base Pool LP tokens (TriTon) to remove
            };
        }

        // Simulate the transaction
        const { result, getWithdrawPayload } = await sdk.simulateWithdraw(
            withdrawParams
        );

        const sender = this.wallet.address;
        const senderArgs = await getWithdrawPayload(sender, {
            blockNumber: blockNumber,
        });

        return senderArgs;
    }

    async claimFee() {
        throw new Error("Not supported");
    }
}
