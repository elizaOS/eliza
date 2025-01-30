import type { IAgentRuntime } from "@elizaos/core";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Secp256k1Keypair } from "@mysten/sui/keypairs/secp256k1";
import { Secp256r1Keypair } from "@mysten/sui/keypairs/secp256r1";

const parseAccount = (
    runtime: IAgentRuntime
): Ed25519Keypair | Secp256k1Keypair | Secp256r1Keypair => {
    const privateKey = runtime.getSetting("SUI_PRIVATE_KEY");
    if (!privateKey) {
        throw new Error("SUI_PRIVATE_KEY is not set");
    }
    if (privateKey.startsWith("suiprivkey")) {
        return loadFromSecretKey(privateKey);
    }
    return loadFromMnemonics(privateKey);
};

const loadFromSecretKey = (privateKey: string) => {
    const keypairClasses = [Ed25519Keypair, Secp256k1Keypair, Secp256r1Keypair];
    for (const KeypairClass of keypairClasses) {
        try {
            return KeypairClass.fromSecretKey(privateKey);
        } catch {
            // Removed unnecessary continue
        }
    }
    throw new Error("Failed to initialize keypair from secret key");
};

const loadFromMnemonics = (mnemonics: string) => {
    const keypairMethods = [
        { Class: Ed25519Keypair, method: "deriveKeypairFromSeed" },
        { Class: Secp256k1Keypair, method: "deriveKeypair" },
        { Class: Secp256r1Keypair, method: "deriveKeypair" },
    ];
    for (const { Class, method } of keypairMethods) {
        try {
            return Class[method](mnemonics);
        } catch {
            // Removed unnecessary continue
        }
    }
    throw new Error("Failed to derive keypair from mnemonics");
};

export { parseAccount };
