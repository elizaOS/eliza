import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, sendAndConfirmTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import idl from "../../agent_template/agent_os.json";

export interface IAgentRuntime {
    getSetting(key: string): string | undefined;
}
export interface Memory {
    userId: string;
    content: { text: string };
}
export interface State {}
export type HandlerCallback = (response: any) => void;

export const executeMicroSwapAction = {
    name: "EXECUTE_MICRO_SWAP",
    similes: ["SWAP_TOKENS"],
    description: "Executes a parallelized micro-swap on the Solana 256-lane Agent OS AMM.",
    validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
        return !!runtime.getSetting("SOLANA_PRIVATE_KEY");
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        options: any,
        callback: HandlerCallback
    ): Promise<boolean> => {
        try {
            const privateKeyStr = runtime.getSetting("SOLANA_PRIVATE_KEY");
            if (!privateKeyStr) throw new Error("Missing SOLANA_PRIVATE_KEY");

            const rpcUrl = runtime.getSetting("SOLANA_RPC_URL") || "https://api.devnet.solana.com";
            const connection = new Connection(rpcUrl, "confirmed");
            
            const keypair = Keypair.fromSecretKey(Buffer.from(JSON.parse(privateKeyStr)));
            const wallet = new anchor.Wallet(keypair);
            const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
            const programId = new PublicKey("FeHW6dU94sxFyYfU6o8jPacNFbZkAeHLj3fMraxLpL5f");
            
            const program = new Program(idl as any, programId, provider);

            const USDC_MINT = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
            const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
            const amountIn = new anchor.BN(100_000_000); 

            // Force Lane 42 for the demo pitch
            const laneId = 42;
            const laneIdBuffer = Buffer.from([laneId]);

            const [ammLanePDA] = PublicKey.findProgramAddressSync(
                [Buffer.from("amm"), USDC_MINT.toBuffer(), WSOL_MINT.toBuffer(), laneIdBuffer],
                program.programId
            );
            const [vaultA] = PublicKey.findProgramAddressSync([Buffer.from("vault_a"), ammLanePDA.toBuffer()], program.programId);
            const [vaultB] = PublicKey.findProgramAddressSync([Buffer.from("vault_b"), ammLanePDA.toBuffer()], program.programId);

            const userTokenIn = getAssociatedTokenAddressSync(USDC_MINT, wallet.publicKey);
            const userTokenOut = getAssociatedTokenAddressSync(WSOL_MINT, wallet.publicKey);

            // Build the transaction
            const tx = await program.methods
                .executeMicroSwap(amountIn, new anchor.BN(1), true)
                .accounts({
                    ammLane: ammLanePDA,
                    vaultA: vaultA,
                    vaultB: vaultB,
                    userTokenIn: userTokenIn,
                    userTokenOut: userTokenOut,
                    user: wallet.publicKey,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .transaction();

            tx.feePayer = wallet.publicKey;
            const latestBlockhash = await connection.getLatestBlockhash();
            tx.recentBlockhash = latestBlockhash.blockhash;
            tx.sign(keypair);

            let txSignature = "";
            try {
                // Send raw transaction with skipPreflight to force it onto the ledger even if it fails
                txSignature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
                await connection.confirmTransaction({
                    signature: txSignature,
                    blockhash: latestBlockhash.blockhash,
                    lastValidBlockHeight: latestBlockhash.lastValidBlockHeight
                });
            } catch (err: any) {
                // If it fails on chain, we STILL want the signature!
                txSignature = err.signature || txSignature || "UNKNOWN";
                throw new Error(`On-Chain Error. Signature: ${txSignature}`);
            }

            callback({
                text: `Successfully executed parallel micro-swap on Lane ${laneId}. TX: ${txSignature}`,
                content: { txSignature, laneId }
            });

            return true;

        } catch (error) {
            console.error("AgentOS Swap Failed:", error);
            // We want to pass the signature back even on failure so the user has the proof!
            const msg = error instanceof Error ? error.message : "Unknown error";
            const match = msg.match(/Signature: ([A-Za-z0-9]+)/);
            const sig = match ? match[1] : undefined;
            
            callback({
                text: `Swap attempted: ${msg}`,
                content: { txSignature: sig, laneId: 42 }
            });
            return false;
        }
    },
    examples: []
};

export const agentOsPlugin = {
    name: "AgentOS-Solana",
    description: "Enables agents to route parallel swaps and HTLC claims via Agent OS on Solana",
    actions: [executeMicroSwapAction],
    evaluators: [],
    providers: []
};

export default agentOsPlugin;
