import { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import { createKeyPairSignerFromBytes, createKeyPairSignerFromPrivateKeyBytes, KeyPairSigner } from "@solana/web3.js";
import crypto from "crypto";
import { TappdClient } from "@phala/dstack-sdk";
import { RemoteAttestationProvider } from "./remoteAttestationProvider";
import { TEEMode, RemoteAttestationQuote } from "./types";

interface DeriveKeyAttestationData {
    agentId: string;
    publicKey: string;
}

class DeriveKeyProvider {
    private client: TappdClient;
    private raProvider: RemoteAttestationProvider;

    constructor(teeMode?: string) {
        let endpoint: string | undefined;

        // Both LOCAL and DOCKER modes use the simulator, just with different endpoints
        switch (teeMode) {
            case TEEMode.LOCAL:
                endpoint = "http://localhost:8090";
                console.log(
                    "TEE: Connecting to local simulator at localhost:8090"
                );
                break;
            case TEEMode.DOCKER:
                endpoint = "http://host.docker.internal:8090";
                console.log(
                    "TEE: Connecting to simulator via Docker at host.docker.internal:8090"
                );
                break;
            case TEEMode.PRODUCTION:
                endpoint = undefined;
                console.log(
                    "TEE: Running in production mode without simulator"
                );
                break;
            default:
                throw new Error(
                    `Invalid TEE_MODE: ${teeMode}. Must be one of: LOCAL, DOCKER, PRODUCTION`
                );
        }

        this.client = endpoint ? new TappdClient(endpoint) : new TappdClient();
        this.raProvider = new RemoteAttestationProvider(teeMode);
    }

    private async generateDeriveKeyAttestation(
        agentId: string,
        publicKey: string
    ): Promise<RemoteAttestationQuote> {
        const deriveKeyData: DeriveKeyAttestationData = {
            agentId,
            publicKey,
        };
        const reportdata = JSON.stringify(deriveKeyData);
        console.log("Generating Remote Attestation Quote for Derive Key...");
        const quote = await this.raProvider.generateAttestation(reportdata);
        console.log("Remote Attestation Quote generated successfully!");
        return quote;
    }

    async deriveEd25519Keypair(
        path: string,
        subject: string,
        agentId: string
    ): Promise<{ keypair: KeyPairSigner; attestation: RemoteAttestationQuote }> {
        try {
            if (!path || !subject) {
                console.error(
                    "Path and Subject are required for key derivation"
                );
            }

            console.log("Deriving Key in TEE...");
            const derivedKey = await this.client.deriveKey(path, subject);
            const uint8ArrayDerivedKey = derivedKey.asUint8Array();

            const hash = crypto.createHash("sha256");
            hash.update(uint8ArrayDerivedKey);
            const seed = hash.digest();
            const seedArray = new Uint8Array(seed);
            const keypair = await createKeyPairSignerFromPrivateKeyBytes(seedArray.slice(0, 32));

            // Generate an attestation for the derived key data for public to verify
            const attestation = await this.generateDeriveKeyAttestation(
                agentId,
                keypair.address
            );
            console.log("Key Derived Successfully!");

            return { keypair, attestation };
        } catch (error) {
            console.error("Error deriving key:", error);
            throw error;
        }
    }
}

const deriveKeyProvider: Provider = {
    get: async (runtime: IAgentRuntime, _message?: Memory, _state?: State) => {
        const teeMode = runtime.getSetting("TEE_MODE");
        const provider = new DeriveKeyProvider(teeMode);
        const agentId = runtime.agentId;
        try {
            // Validate wallet configuration
            if (!runtime.getSetting("WALLET_SECRET_SALT")) {
                console.error(
                    "Wallet secret salt is not configured in settings"
                );
                return "";
            }

            try {
                const secretSalt =
                    runtime.getSetting("WALLET_SECRET_SALT") || "secret_salt";
                const solanaKeypair = await provider.deriveEd25519Keypair(
                    "/",
                    secretSalt,
                    agentId
                );
                return JSON.stringify({
                    solana: solanaKeypair.keypair.address,
                });
            } catch (error) {
                console.error("Error creating PublicKey:", error);
                return "";
            }
        } catch (error) {
            console.error("Error in derive key provider:", error.message);
            return `Failed to fetch derive key information: ${error instanceof Error ? error.message : "Unknown error"}`;
        }
    },
};

export { deriveKeyProvider, DeriveKeyProvider };
