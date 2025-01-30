import { SolanaAgentKit } from "solana-agent-kit";
import type { IAgentRuntime } from "@elizaos/core";
import { getWalletKey } from "./keypairUtils";
import bs58 from "bs58";

export async function getSAK(runtime: IAgentRuntime) {
    const {publicKey} = await getWalletKey(runtime, false);
    const {keypair} = await getWalletKey(runtime, true);

    if (keypair.publicKey.toBase58() !== publicKey.toBase58()) {
        throw new Error(
            "Generated public key doesn't match expected public key"
        );
    }

    return new SolanaAgentKit(
        bs58.encode(keypair.secretKey),
        runtime.getSetting("SOLANA_RPC_URL"),
        {
            OPENAI_API_KEY: runtime.getSetting("OPENAI_API_KEY"),
        }
    );
}