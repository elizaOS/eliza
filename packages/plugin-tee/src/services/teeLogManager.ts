import { SgxAttestationProvider } from '../providers/sgxAttestationProvider';
import { RemoteAttestationProvider as TdxAttestationProvider } from '../providers/remoteAttestationProvider';
import {
    type TEEMode,
    TeeType,
    type TeeLogDAO,
    type TeeAgent,
    type TeeLog,
    type TeeLogQuery,
    type TeePageQuery,
} from '@elizaos/core';
import elliptic from 'elliptic';
import { v4 } from 'uuid';

export class TeeLogManager {
    private teeLogDAO: TeeLogDAO;
    private teeType: TeeType;
    private teeMode: TEEMode; // Only used for plugin-tee with TDX dstack

    // Map of agentId to its key pair
    // These keypairs only store in memory.
    // When the agent restarts, we will generate new keypair.
    private keyPairs: Map<string, elliptic.ec.KeyPair> = new Map();

    constructor(teeLogDAO: TeeLogDAO, teeType: TeeType, teeMode: TEEMode) {
        this.teeLogDAO = teeLogDAO;
        this.teeType = teeType;
        this.teeMode = teeMode;
    }

    public async registerAgent(agentId: string, agentName: string): Promise<boolean> {
        if (!agentId) {
            throw new Error('Agent ID is required');
        }

        const keyPair = this.generateKeyPair();
        this.keyPairs.set(agentId, keyPair);

        const publicKey = keyPair.getPublic().encode('hex', true);
        const attestation = await this.generateAttestation(publicKey);

        const new_agent = {
            id: v4(),
            agentId,
            agentName: agentName || '',
            createdAt: new Date().getTime(),
            publicKey,
            attestation,
        };

        console.log('registerAgent new_agent', new_agent);

        return this.teeLogDAO.addAgent(new_agent);
    }

    public async getAllAgents(): Promise<TeeAgent[]> {
        return this.teeLogDAO.getAllAgents();
    }

    public async getAgent(agentId: string): Promise<TeeAgent | undefined> {
        return this.teeLogDAO.getAgent(agentId);
    }

    public async log(
        agentId: string,
        roomId: string,
        userId: string,
        type: string,
        content: string,
    ): Promise<boolean> {
        const keyPair = this.keyPairs.get(agentId);
        if (!keyPair) {
            throw new Error(`Agent ${agentId} not found`);
        }

        const timestamp = new Date().getTime();

        // Join the information into a single string
        const messageToSign = `${agentId}|${roomId}|${userId}|${type}|${content}|${timestamp}`;

        // Sign the joined message
        const signature = '0x' + keyPair.sign(messageToSign).toDER('hex');

        return this.teeLogDAO.addLog({
            id: v4(),
            agentId,
            roomId,
            userId,
            type,
            content,
            timestamp,
            signature,
        });
    }

    public async getLogs(
        query: TeeLogQuery,
        page: number,
        pageSize: number,
    ): Promise<TeePageQuery<TeeLog[]>> {
        return this.teeLogDAO.getPagedLogs(query, page, pageSize);
    }

    public generateKeyPair(): elliptic.ec.KeyPair {
        const ec = new elliptic.ec('secp256k1');
        const key = ec.genKeyPair();
        return key;
    }

    public async generateAttestation(userReport: string): Promise<string> {
        if (this.teeType === TeeType.SGX_GRAMINE) {
            const sgxAttestationProvider = new SgxAttestationProvider();
            const sgxAttestation = await sgxAttestationProvider.generateAttestation(userReport);
            return JSON.stringify(sgxAttestation);
        } else if (this.teeType === TeeType.TDX_DSTACK) {
            const tdxAttestationProvider = new TdxAttestationProvider(this.teeMode);
            const tdxAttestation = await tdxAttestationProvider.generateAttestation(userReport);
            return JSON.stringify(tdxAttestation);
        } else {
            throw new Error('Invalid TEE type');
        }
    }
}
