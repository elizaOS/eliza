import { IAgentRuntime, type Plugin, Service, ServiceType } from "@elizaos/core";
import { VerifiableLogProvider } from "./providers/verifiableLogProvider.ts";
import { SQLite3VerifiableDAO } from "./adapters/sqliteVerifiableDAO.ts";
import {
    PageQuery,
    VerifiableAgent,
    VerifiableDAO,
    VerifiableLog,
    VerifiableLogQuery,
} from "./types/logTypes.ts";

export { PageQuery, VerifiableAgent, VerifiableLog, VerifiableLogQuery };

export class VerifiableLogService extends Service {
    getInstance(): VerifiableLogService {
        return this;
    }

    static get serviceType(): ServiceType {
        return ServiceType.VERIFIABLE_LOGGING;
    }

    private verifiableLogProvider: VerifiableLogProvider;
    private verifiableDAO: VerifiableDAO;

    private teeMode: string;
    private vlogOpen: boolean = false;

    // Add abstract initialize method that must be implemented by derived classes
    async initialize(runtime: IAgentRuntime): Promise<void> {
        if (runtime.databaseAdapter.db === null) {
            throw new Error("Database adapter is not initialized.");
        }
        if (runtime.getSetting("TEE_MODE") === null) {
            throw new Error("TEE_MODE is not set.");
        }
        if (runtime.getSetting("WALLET_SECRET_SALT") === null) {
            throw new Error("WALLET_SECRET_SALT is not set.");
        }
        this.teeMode = runtime.getSetting("TEE_MODE");
        const value = runtime.getSetting("VLOG");
        const truthyValues = ["yes", "true", "YES", "TRUE", "Yes", "True", "1"];
        this.vlogOpen = truthyValues.includes(value.toLowerCase());
        this.verifiableDAO = new SQLite3VerifiableDAO(
            runtime.databaseAdapter.db
        );
        this.verifiableLogProvider = new VerifiableLogProvider(
            this.verifiableDAO,
            this.teeMode
        );
        const isOK = await this.verifiableLogProvider.registerAgent(
            { agentId: runtime?.agentId, agentName: runtime?.character?.name },
            this.teeMode
        );
        if (!isOK) {
            throw new Error(`Failed to register agent.${runtime.agentId}`);
        }
        return;
    }

    async log(params: {
        agentId: string;
        roomId: string;
        userId: string;
        type: string;
        content: string;
    }): Promise<boolean> {
        if (this.vlogOpen) {
            return this.verifiableLogProvider.log(params, this.teeMode);
        }
        return false;
    }

    async generateAttestation(params: {
        agentId: string;
        publicKey: string;
    }): Promise<string> {
        if (this.vlogOpen) {
            return this.verifiableLogProvider.generateAttestation(
                params,
            );
        }
        return "";
    }

    async listAgent(): Promise<VerifiableAgent[]> {
        return this.verifiableDAO.listAgent();
    }

    async pageQueryLogs(
        query: VerifiableLogQuery,
        page: number,
        pageSize: number
    ): Promise<PageQuery<VerifiableLog[]>> {
        return this.verifiableDAO.pageQueryLogs(query, page, pageSize);
    }
}

export const verifiableLogPlugin: Plugin = {
    name: "TeeVerifiableLog",
    description:
        "While Eliza operates within the TEE, it uses a derived key pair to sign its actions, ensuring that these actions are definitively executed by Eliza. Third-party users can remotely verify Eliza's public key to validate these actions",
    actions: [],
    evaluators: [],
    providers: [],
    services: [new VerifiableLogService()],
};
