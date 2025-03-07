import {
    JupiterClient,

} from "../clients";
import {
    WalletProvider
} from "../wallet";
import {
    SOL_ADDRESS,
} from "../constants";
import type { IAgentRuntime } from "@elizaos/core";
import {
    Connection,
    Keypair,
    type ParsedTransactionWithMeta,
    VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import type {
    QuoteInParams,
    QuoteResult,
    SwapInParams,
    SwapInResult,
    TrustWalletProvider,
} from "../types";
import { JitoRegion, sendTxUsingJito } from "./jitoBundle";

type JupiterQuoteResult = {
    inputMint: string;
    outputMint: string;
    inAmount: string;
    outAmount: string;
    routePlan: any[];
};

export function loadPrivateKey(runtime: IAgentRuntime) {
    const privateKeyString =
        runtime.getSetting("SOLANA_PRIVATE_KEY") ??
        runtime.getSetting("WALLET_PRIVATE_KEY")!;

    let secretKey: Uint8Array;
    try {
        // First try to decode as base58
        secretKey = bs58.decode(privateKeyString);
        // eslint-disable-next-line
    } catch (_e) {
        try {
            // If that fails, try base64
            secretKey = Uint8Array.from(
                Buffer.from(privateKeyString, "base64")
            );
            // eslint-disable-next-line
        } catch (_e2) {
            throw new Error("Invalid private key format");
        }
    }

    // Verify the key length
    if (secretKey.length !== 64) {
        console.error("Invalid key length:", secretKey.length);
        throw new Error(
            `Invalid private key length: ${secretKey.length}. Expected 64 bytes.`
        );
    }

    console.log("Creating keypair...");
    const keypair = Keypair.fromSecretKey(secretKey);

    // Verify the public key matches what we expect
    const expectedPublicKey =
        runtime.getSetting("SOLANA_PUBLIC_KEY") ??
        runtime.getSetting("WALLET_PUBLIC_KEY");
    if (keypair.publicKey.toBase58() !== expectedPublicKey) {
        throw new Error(
            "Generated public key doesn't match expected public key"
        );
    }

    return keypair;
}

// todo: add later to evm wallet
// const hashLength: number = 32; // 32 bytes = 64 hex characters
// const prefix: string = "0x";
// const generateTransactionHash = (): string => {
//     const randomBytes = new Uint8Array(hashLength);
//     crypto.getRandomValues(randomBytes);

// todo: toHex
//     const hash = Array.from(randomBytes)
//         .map((b) => b.toString(16).padStart(2, "0"))
//         .join("");

//     return prefix + hash;
// };

const generateTransactionHash = (): string => {
    const hashBytes = new Uint8Array(32);
    crypto.getRandomValues(hashBytes);
    return bs58.encode(hashBytes);
};

export class SolanaTrustWalletProvider
    implements TrustWalletProvider<JupiterQuoteResult>
{
    static createFromRuntime(runtime: IAgentRuntime) {
        const wallet = WalletProvider.createFromRuntime(runtime);
        const connection = new Connection(runtime.getSetting("RPC_URL")!);
        return new SolanaTrustWalletProvider(runtime, wallet, connection);
    }

    constructor(
        private runtime: IAgentRuntime,
        private wallet: WalletProvider,
        private connection: Connection
    ) {}

    getAddress(): string {
        return this.wallet.publicKey.toBase58();
    }

    getCurrencyAddress(): string {
        return SOL_ADDRESS;
    }

    async getTokenFromWallet(tokenSymbol: string): Promise<string | null> {
        return this.wallet.getTokenFromWallet(tokenSymbol);
    }

    async getAccountBalance(): Promise<bigint> {
        return this.wallet.getAccountBalance();
    }

    async getQuoteIn({
        inputToken,
        outputToken,
        amountIn,
        slippageBps,
    }: QuoteInParams): Promise<QuoteResult<JupiterQuoteResult>> {
        const quote = await JupiterClient.getQuote(
            inputToken,
            outputToken,
            amountIn.toString(),
            slippageBps
        );

        return {
            amountOut: BigInt(quote.outAmount),
            data: quote,
        };
    }

    async swapIn({
        inputToken,
        outputToken,
        minAmountOut,
        isSimulation,
        data,
    }: SwapInParams<JupiterQuoteResult>): Promise<
        SwapInResult<ParsedTransactionWithMeta | null>
    > {
        if (isSimulation) {
            return {
                amountOut: data?.outAmount
                    ? BigInt(data?.outAmount)
                    : minAmountOut,
                timestamp: new Date(),
                txHash: generateTransactionHash(),
            };
        }

        const swapData = await JupiterClient.swap(data, this.getAddress());

        const { txHash, timestamp, amountOut, details } =
            await this.executeSwap({
                inputToken,
                outputToken,
                swapData,
            });

        return {
            txHash,
            timestamp,
            amountOut,
            data: details,
        };
    }

    async executeSwap({
        outputToken,
        swapData,
    }: {
        inputToken: string;
        outputToken: string;
        swapData: any;
    }) {
        console.log("Deserializing transaction...");
        const transactionBuf = Buffer.from(swapData.swapTransaction, "base64");
        const transaction = VersionedTransaction.deserialize(transactionBuf);
        console.log("Preparing to sign transaction...");

        const keypair = loadPrivateKey(this.runtime);
        console.log("Signing transaction...");
        transaction.sign([keypair]);

        const latestBlockhash = await this.connection.getLatestBlockhash();

        const bundleResponse = await sendTxUsingJito({
            versionedTxs: [transaction],
            region: JitoRegion.Mainnet,
            authority: keypair,
            lastestBlockhash: latestBlockhash,
        });
        if (!bundleResponse) {
            throw new Error("Bundle response is null");
        }
        const txHash = bundleResponse?.transactions?.[0];

        if (!txHash) {
            throw new Error("Transaction hash is null");
        }
        // const txHash = await sendTransaction(this.connection, transaction);

        const details = await this.connection.getParsedTransaction(txHash, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
        });

        const owner = this.wallet.publicKey.toBase58();

        const preBalance =
            details?.meta?.preTokenBalances?.find(
                (tokenBalance) =>
                    tokenBalance.owner === owner &&
                    tokenBalance.mint === outputToken
            )?.uiTokenAmount.amount ?? "0";

        const postBalance =
            details?.meta?.postTokenBalances?.find(
                (tokenBalance) =>
                    tokenBalance.owner === owner &&
                    tokenBalance.mint === outputToken
            )?.uiTokenAmount.amount ?? "0";

        const amountOut = BigInt(postBalance) - BigInt(preBalance);

        return {
            txHash,
            amountOut,
            timestamp: details?.blockTime
                ? new Date(details.blockTime)
                : new Date(),
            details,
        };
    }
}
