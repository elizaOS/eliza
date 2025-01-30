import { type IAgentRuntime, Service, ServiceType, type ITeeLogService } from "@elizaos/core";
import { TEEMode } from "@elizaos/plugin-tee";
import { SqliteTeeLogDAO } from "../adapters/sqliteDAO";
import { TeeType, type TeeLogDAO, type TeeAgent, type TeeLog, type TeeLogQuery, type PageQuery } from "../types";
import { TeeLogManager } from "./teeLogManager";
import Database from "better-sqlite3";
import path from "path";

export class TeeLogService extends Service implements ITeeLogService {
    private dbPath: string;

    private initialized = false;
    private enableTeeLog = false;
    private teeType: TeeType;
    private teeMode: TEEMode = TEEMode.OFF; // Only used for plugin-tee with TDX dstack

    private teeLogDAO: TeeLogDAO;
    private teeLogManager: TeeLogManager;


    getInstance(): TeeLogService {
        return this;
    }

    static get serviceType(): ServiceType {
        return ServiceType.TEE_LOG;
    }

    async initialize(runtime: IAgentRuntime): Promise<void> {
        if (this.initialized) {
            return;
        }

        const enableValues = ["true", "1", "yes", "enable", "enabled", "on"];

        const enableTeeLog = runtime.getSetting("ENABLE_TEE_LOG");
        if (enableTeeLog === null) {
            throw new Error("ENABLE_TEE_LOG is not set.");
        }
        this.enableTeeLog = enableValues.includes(enableTeeLog.toLowerCase());
        if (!this.enableTeeLog) {
            console.log("TEE log is not enabled.");
            return;
        }

        const runInSgx = runtime.getSetting("SGX");
        const teeMode = runtime.getSetting("TEE_MODE");
        const walletSecretSalt = runtime.getSetting("WALLET_SECRET_SALT");

        this.teeMode = teeMode ? TEEMode[teeMode as keyof typeof TEEMode] : TEEMode.OFF;

        const useSgxGramine = runInSgx && enableValues.includes(runInSgx.toLowerCase());
        const useTdxDstack = teeMode && teeMode !== TEEMode.OFF && walletSecretSalt;

        if (useSgxGramine && useTdxDstack) {
            throw new Error("Cannot configure both SGX and TDX at the same time.");
        } else if (useSgxGramine) {
            this.teeType = TeeType.SGX_GRAMINE;
        } else if (useTdxDstack) {
            this.teeType = TeeType.TDX_DSTACK;
        } else {
            throw new Error("Invalid TEE configuration.");
        }

        const dbPathSetting = runtime.getSetting("TEE_LOG_DB_PATH");
        this.dbPath = dbPathSetting || path.resolve("data/tee_log.sqlite");

        const db = new Database(this.dbPath);
        this.teeLogDAO = new SqliteTeeLogDAO(db);
        await this.teeLogDAO.initialize();
        this.teeLogManager = new TeeLogManager(this.teeLogDAO, this.teeType, this.teeMode);

        const isRegistered = await this.teeLogManager.registerAgent(
            runtime?.agentId,
            runtime?.character?.name,
        );
        if (!isRegistered) {
            throw new Error(`Failed to register agent ${runtime.agentId}`);
        }

        this.initialized = true;
    }

    async log(agentId: string, roomId: string, userId: string, type: string, content: string): Promise<boolean> {
        if (!this.enableTeeLog) {
            return false;
        }

        return this.teeLogManager.log(agentId, roomId, userId, type, content);
    }

    async getAllAgents(): Promise<TeeAgent[]> {
        if (!this.enableTeeLog) {
            return [];
        }

        return this.teeLogManager.getAllAgents();
    }

    async getAgent(agentId: string): Promise<TeeAgent | undefined> {
        if (!this.enableTeeLog) {
            return undefined;
        }

        return this.teeLogManager.getAgent(agentId);
    }

    async getLogs(query: TeeLogQuery, page: number, pageSize: number): Promise<PageQuery<TeeLog[]>> {
        if (!this.enableTeeLog) {
            return {
                data: [],
                total: 0,
                page: page,
                pageSize: pageSize,
            };
        }

        return this.teeLogManager.getLogs(query, page, pageSize);
    }

    async generateAttestation(userReport: string): Promise<string> {
        return this.teeLogManager.generateAttestation(userReport);
    }
}

export default TeeLogService;
