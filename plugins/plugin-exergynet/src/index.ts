import { Action, ActionExample, IAgentRuntime, Memory, Provider, State, HandlerCallback, Plugin, elizaLogger } from "@elizaos/core";
import { PublicKey, Transaction, SystemProgram, ComputeBudgetProgram, Connection, Keypair, TransactionInstruction, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as crypto from "crypto";
import bs58 from "bs58";

export const LNES_PROGRAM_ID = new PublicKey("7BCPpUMBxQMPomsgTaJsQdLEfycNwPWqkQD1Cea4CcCL");
export const OMEGA_MINT = new PublicKey("5fZZJ29oH5SDqxiz2tkEf1wopp5Sn5TtcCF3fPS9rdiJ");

// The default axiom hash used for ZK-state alignment when no specific job hash is provided.
// The 32-byte array is seeded with 7s to satisfy the LNES-03 PDA entropy requirement.
const DEFAULT_AXIOM_HASH = Buffer.from(new Uint8Array(32).fill(7)); 
const COMPUTE_TOLL_LAMPORTS = BigInt(2_000_000); // 0.002 SOL

export const requestExergyComputeAction: Action = {
    name: "REQUEST_EXERGY_COMPUTE",
    similes:["EXERGYNET_COMPUTE", "REQUEST_EXERGY"],
    description: "Triggers a ZK-proof computation order by locking 0.002 SOL into the ExergyNet Membrane.",
    validate: async (runtime: IAgentRuntime) => {
        return !!runtime.getSetting("SOLANA_PRIVATE_KEY");
    },
    handler: async (runtime: IAgentRuntime, _message: Memory, _state?: State, _options?: any, callback?: HandlerCallback): Promise<any> => {
        let sig: string | undefined;
        try {
            const autoSpendEnabled = runtime.getSetting("EXERGYNET_AUTO_SPEND") === "true";
            if (!autoSpendEnabled) {
                elizaLogger.warn("[exergynet] Action triggered, but auto-spend is disabled. Awaiting user confirmation.");
                if (callback) {
                    callback({
                        text: "I am ready to request a ZK-proof from ExergyNet. This will cost 0.002 SOL. Please confirm you wish to proceed.",
                        content: { status: "AWAITING_CONFIRMATION", action: "REQUEST_EXERGY_COMPUTE" }
                    });
                }
                return true;
            }

            const rpcUrl = (runtime.getSetting("RPC_URL") as string) || "https://api.mainnet-beta.solana.com";
            const connection = new Connection(rpcUrl, "confirmed");
            const privateKey = runtime.getSetting("SOLANA_PRIVATE_KEY") as string;
            
            if (!privateKey) throw new Error("Missing SOLANA_PRIVATE_KEY");
            const payer = Keypair.fromSecretKey(bs58.decode(privateKey));

            elizaLogger.log("[exergynet] Constructing LNES-03 OpenJob Strike...");

            const jobId = Keypair.generate().publicKey.toBytes();
            const [escrowPda] = PublicKey.findProgramAddressSync([Buffer.from("escrow"), Buffer.from(jobId)], LNES_PROGRAM_ID);
            const[escrowVault] = PublicKey.findProgramAddressSync([Buffer.from("vault"), Buffer.from(jobId)], LNES_PROGRAM_ID);
            const [mintAuth] = PublicKey.findProgramAddressSync([Buffer.from("mint_auth")], LNES_PROGRAM_ID);

            // FIXED: Explicit Little-Endian encoding for cross-platform deterministic payload serialization
            const tollBuffer = Buffer.alloc(8);
            tollBuffer.writeBigUInt64LE(COMPUTE_TOLL_LAMPORTS);

            const openJobData = Buffer.concat([
                crypto.createHash("sha256").update("global:open_job").digest().subarray(0, 8),
                Buffer.from(jobId),
                DEFAULT_AXIOM_HASH, 
                tollBuffer
            ]);

            const ix = new TransactionInstruction({
                programId: LNES_PROGRAM_ID,
                data: openJobData,
                keys:[
                    { pubkey: payer.publicKey, isSigner: true, isWritable: true },
                    { pubkey: escrowPda, isSigner: false, isWritable: true },
                    { pubkey: escrowVault, isSigner: false, isWritable: true },
                    { pubkey: OMEGA_MINT, isSigner: false, isWritable: true },
                    { pubkey: mintAuth, isSigner: false, isWritable: false },
                    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
                    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
                ]
            });

            const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 150000 }), ix);
            const latestBlockhash = await connection.getLatestBlockhash("confirmed");
            tx.recentBlockhash = latestBlockhash.blockhash;
            tx.feePayer = payer.publicKey;
            tx.sign(payer);

            elizaLogger.log("[exergynet] Broadcasting transaction...");
            sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });

            elizaLogger.log(`[exergynet] Awaiting confirmation for signature: ${sig}`);
            const confirmation = await connection.confirmTransaction({
                signature: sig,
                blockhash: latestBlockhash.blockhash,
                lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
            }, "confirmed");

            if (confirmation.value.err) {
                throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
            }

            if (callback) {
                callback({
                    text: `ExergyNet request confirmed on Solana.\nSignature: ${sig}`,
                    content: { signature: sig, status: "CONFIRMED" }
                });
            }
            return true;

        } catch (e: unknown) {
            const errMsg = e instanceof Error ? e.message : String(e);
            elizaLogger.error("[exergynet] Strike Fracture:", errMsg);

            if (callback) {
                callback({
                    text: `ExergyNet request failed: ${errMsg}${sig ? `\nPartial signature (check Solscan): ${sig}` : ""}`,
                    content: { status: "FAILED", error: errMsg, ...(sig ? { signature: sig } : {}) }
                });
            }
            return false;
        }
    },
        examples: [[
            { user: "user", content: { text: "Verify this logic via ExergyNet." } },
            { user: "assistant", content: { text: "Initiating thermodynamic proof order...", action: "REQUEST_EXERGY_COMPUTE" } }
        ] as unknown as ActionExample[]
    ]
};

export const exergynetPlugin: Plugin = {
    name: "exergynet",
    description: "ExergyNet LNES-03 ZK-Compute Membrane Integration",
    actions:[requestExergyComputeAction],
    providers:[{
        name: "exergynet-membrane",
        get: async (_runtime: IAgentRuntime, _message: Memory, _state?: State): Promise<any> => {
            return `ExergyNet LNES-03: OPERATIONAL | Membrane: ${LNES_PROGRAM_ID.toBase58()} | Toll: 0.002 SOL`;
        }
    } as Provider]
};

export default exergynetPlugin;
