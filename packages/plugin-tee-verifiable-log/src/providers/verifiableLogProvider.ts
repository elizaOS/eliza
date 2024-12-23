import {
    IVerifiableLogProvider,
    VerifiableAgent,
    VerifiableDAO,
    VerifiableLog,
} from "../types/logTypes.ts";
import {
    DeriveKeyProvider,
    RemoteAttestationProvider,
    RemoteAttestationQuote,
} from "@elizaos/plugin-tee";

export class VerifiableLogProvider implements IVerifiableLogProvider {
    private dao: VerifiableDAO;
    private keyPath: string = "/keys/verifiable_key";
    private remoteAttestationProvider: RemoteAttestationProvider;
    private provider: DeriveKeyProvider;

    constructor(dao: VerifiableDAO, teeMode: string) {
        this.dao = dao;
        this.remoteAttestationProvider = new RemoteAttestationProvider(teeMode);
        this.provider = new DeriveKeyProvider(teeMode);
    }

    async log(
        params: {
            agentId: string;
            roomId: string;
            userId: string;
            type: string;
            content: string;
        },
        subject: string
    ): Promise<boolean> {
        let singed: string = "";

        try {
            const evmKeypair = await this.provider.deriveEcdsaKeypair(
                this.keyPath,
                subject,
                params.agentId
            );
            const signature = await evmKeypair.keypair.signMessage({
                message: params.content,
            });
            singed = signature.toString();

            // evmKeypair can now be used for Ethereum operations
        } catch (error) {
            console.error("EVM key derivation failed:", error);

            return false;
        }
        return this.dao.addLog(<VerifiableLog>{
            agent_id: params.agentId,
            room_id: params.roomId,
            user_id: params.userId,
            type: params.type,
            content: params.content,
            signature: singed,
        });
    }

    async registerAgent(
        params: {
            agentId: string;
            agentName: string;
        },
        subject: string
    ): Promise<boolean> {
        if (params.agentId === undefined) {
            throw new Error("agentId is required");
        }

        const agent = await this.dao.getAgent(params.agentId);
        if (agent !== null) {
            return true;
        }
        const evmKeypair = await this.provider.deriveEcdsaKeypair(
            this.keyPath,
            subject,
            params.agentId
        );

        const publicKey = evmKeypair.keypair.publicKey;

        return this.dao.addAgent(<VerifiableAgent>{
            agent_id: params.agentId,
            agent_name: params.agentName,
            agent_keypair_path: this.keyPath,
            agent_keypair_vlog_pk: publicKey,
        });
    }

    async generateAttestation(
        params: {
            agentId: string;
            publicKey: string;
        }
    ): Promise<string> {
        if (params.agentId === undefined || params.publicKey === undefined) {
            throw new Error("agentId and publicKey are required");
        }
        try {
            // Generate 32-byte report data (reportData) containing the hash value of the public key.
            const reportData = JSON.stringify(params);
            // Call the remote attestation interface.
            const quote: RemoteAttestationQuote = await this.remoteAttestationProvider.generateAttestation(reportData);
            return JSON.stringify(quote);
        } catch (error) {
            console.error("Failed to generate attestation quote:", error);
            throw error;
        }
    }
}
