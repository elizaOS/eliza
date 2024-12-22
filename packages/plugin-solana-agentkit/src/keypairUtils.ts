import { Keypair, PublicKey } from "@solana/web3.js";
import { DeriveKeyProvider, TEEMode } from "@elizaos/plugin-tee";
import bs58 from "bs58";
import { IAgentRuntime } from "@elizaos/core";

export interface KeypairResult {
    keypair?: Keypair;
    publicKey?: PublicKey;
}

/**
 * Gets either a keypair or public key based on TEE mode and runtime settings
 * @param runtime The agent runtime
 * @param requirePrivateKey Whether to return a full keypair (true) or just public key (false)
 * @returns KeypairResult containing either keypair or public key
 */
export async function getWalletKey(
    runtime: IAgentRuntime,
    requirePrivateKey: boolean = true
): Promise<KeypairResult> {
    const teeMode = runtime.getSetting("TEE_MODE") || TEEMode.OFF;

    if (teeMode !== TEEMode.OFF) {
        const walletSecretSalt = runtime.getSetting("WALLET_SECRET_SALT");
        if (!walletSecretSalt) {
            throw new Error(
                "WALLET_SECRET_SALT required when TEE_MODE is enabled"
            );
        }

        const deriveKeyProvider = new DeriveKeyProvider(teeMode);
        const deriveKeyResult = await deriveKeyProvider.deriveEd25519Keypair(
            "/",
            walletSecretSalt,
            runtime.agentId
        );

        return requirePrivateKey
            ? { keypair: deriveKeyResult.keypair }
            : { publicKey: deriveKeyResult.keypair.publicKey };
    }

    // TEE mode is OFF
    if (requirePrivateKey) {
        const privateKeyString =
            runtime.getSetting("SOLANA_PRIVATE_KEY") ??
            runtime.getSetting("WALLET_PRIVATE_KEY");

        if (!privateKeyString) {
            throw new Error("Private key not found in settings");
        }

        try {
            // First try base58
            const secretKey = bs58.decode(privateKeyString);
            return { keypair: Keypair.fromSecretKey(secretKey) };
        } catch (e) {
            console.log("Error decoding base58 private key:", e);
            try {
                // Then try base64
                console.log("Try decoding base64 instead");
                const secretKey = Uint8Array.from(
                    Buffer.from(privateKeyString, "base64")
                );
                return { keypair: Keypair.fromSecretKey(secretKey) };
            } catch (e2) {
                console.error("Error decoding private key: ", e2);
                throw new Error("Invalid private key format");
            }
        }
    } else {
        const publicKeyString =
            runtime.getSetting("SOLANA_PUBLIC_KEY") ??
            runtime.getSetting("WALLET_PUBLIC_KEY");

        if (!publicKeyString) {
            throw new Error("Public key not found in settings");
        }

        return { publicKey: new PublicKey(publicKeyString) };
    }
}
