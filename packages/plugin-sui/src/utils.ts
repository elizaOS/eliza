import { IAgentRuntime } from "@elizaos/core";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

const parseAccount = (runtime: IAgentRuntime): Ed25519Keypair => {
    const privateKey = runtime.getSetting("SUI_PRIVATE_KEY");
    if (!privateKey) {
        throw new Error("SUI_PRIVATE_KEY is not set");
    } else if (privateKey.startsWith("suiprivkey")) {
        return Ed25519Keypair.fromSecretKey(privateKey);
    } else {
        return Ed25519Keypair.deriveKeypairFromSeed(privateKey);
    }
};

export { parseAccount };
