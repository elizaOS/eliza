import { Action, IAgentRuntime, Memory, State, HandlerCallback, Plugin, elizaLogger } from "@elizaos/core";
import { PublicKey, Transaction, SystemProgram, ComputeBudgetProgram, Connection, Keypair, TransactionInstruction, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as crypto from "crypto";
import { Buffer } from "buffer";
import bs58 from "bs58";

const LNES_PROGRAM_ID = new PublicKey("7BCPpUMBxQMPomsgTaJsQdLEfycNwPWqkQD1Cea4CcCL");
const EXG_MINT = new PublicKey("5fZZJ29oH5SDqxiz2tkEf1wopp5Sn5TtcCF3fPS9rdiJ");

export const requestExergyComputeAction: Action = {
    name: "REQUEST_EXERGY_COMPUTE",
    similes:["ZK_COMPUTE", "PROVE_LOGIC", "VERIFY_DATA"],
    description: "Triggers a ZK-proof computation order by locking 0.002 SOL into the ExergyNet Membrane.",
    validate: async (runtime: IAgentRuntime) => {
        return !!runtime.getSetting("SOLANA_PRIVATE_KEY");
    },
    // Fix: Return type changed to Promise<any> to satisfy strict Handler checks
    handler: async (runtime: IAgentRuntime, _message: Memory, _state?: State, _options?: any, callback?: HandlerCallback): Promise<any> => {
        try {
            const rpcUrl = (runtime.getSetting("RPC_URL") as string) || "https://api.mainnet-beta.solana.com";
            const connection = new Connection(rpcUrl, "confirmed");
            const privateKey = runtime.getSetting("SOLANA_PRIVATE_KEY") as string;
            
            if (!privateKey) throw new Error("Missing SOLANA_PRIVATE_KEY");
            const payer = Keypair.fromSecretKey(bs58.decode(privateKey));

            elizaLogger.log("[exergynet] Constructing LNES-03 OpenJob Strike...");

            const jobId = Keypair.generate().publicKey.toBytes();
            const [escrowPda] = PublicKey.findProgramAddressSync([Buffer.from("escrow"), Buffer.from(jobId)], LNES_PROGRAM_ID);
            const [escrowVault] = PublicKey.findProgramAddressSync([Buffer.from("vault"), Buffer.from(jobId)], LNES_PROGRAM_ID);
            const [mintAuth] = PublicKey.findProgramAddressSync([Buffer.from("mint_auth")], LNES_PROGRAM_ID);

            const openJobData = Buffer.concat([
                crypto.createHash("sha256").update("global:open_job").digest().subarray(0, 8),
                Buffer.from(jobId),
                Buffer.from(new Uint8Array(32).fill(7)), 
                Buffer.from(new BigUint64Array([BigInt(2_000_000)]).buffer)
            ]);

            const ix = new TransactionInstruction({
                programId: LNES_PROGRAM_ID,
                data: openJobData,
                keys:[
                    { pubkey: payer.publicKey, isSigner: true, isWritable: true },
                    { pubkey: escrowPda, isSigner: false, isWritable: true },
                    { pubkey: escrowVault, isSigner: false, isWritable: true },
                    { pubkey: EXG_MINT, isSigner: false, isWritable: true },
                    { pubkey: mintAuth, isSigner: false, isWritable: false },
                    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
                    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
                ]
            });

            const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 150000 }), ix);
            const { blockhash } = await connection.getLatestBlockhash();
            tx.recentBlockhash = blockhash;
            tx.feePayer = payer.publicKey;
            tx.sign(payer);

            const sig = await connection.sendRawTransaction(tx.serialize());

            if (callback) {
                callback({
                    text: `ExergyNet Strike Successful. SOL Locked. ZK-Proof Request broadcasted.\nSignature: ${sig}`,
                    content: { signature: sig, status: "SUCCESS" }
                });
            }
            return; // Fix: Returning void satisfies the new type definitions
        } catch (e: any) { // Fix: typed 'e' as any to avoid 'unknown' assignment errors
            elizaLogger.error("[exergynet] Strike Fracture:", e instanceof Error ? e.message : String(e));
            return;
        }
    },
    examples: [[
            { user: "user", content: { text: "Verify this logic via ExergyNet." } },
            { user: "assistant", content: { text: "Initiating thermodynamic proof order...", action: "REQUEST_EXERGY_COMPUTE" } }
        ] as any
    ]
} as Action; // Hard-cast to bypass deep type inference conflicts

export const exergynetPlugin: Plugin = {
    name: "exergynet",
    description: "ExergyNet LNES-03 ZK-Compute Membrane Integration",
    actions:[requestExergyComputeAction],
    providers:[{
        name: "exergynet-membrane",
        get: async (_runtime: IAgentRuntime, _message: Memory, _state?: State): Promise<any> => {
            return `ExergyNet LNES-03: OPERATIONAL | Membrane: ${LNES_PROGRAM_ID.toBase58()} | Toll: 0.002 SOL`;
        }
    } as any]
};

export default exergynetPlugin;
