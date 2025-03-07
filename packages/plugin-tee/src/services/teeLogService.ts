import {
	type IAgentRuntime,
	Service,
	ServiceTypes,
	type ITeeLogService,
	TeeType,
	type TeeLogDAO,
	type TeeAgent,
	type TeeLog,
	type TeeLogQuery,
	type TeePageQuery,
	TEEMode,
	type ServiceType,
} from "@elizaos/core";
import { SqliteTeeLogDAO } from "../adapters/sqliteDAO";
import { TeeLogManager } from "./teeLogManager";
import Database from "better-sqlite3";
import path from "node:path";

export class TeeLogService extends Service implements ITeeLogService {
	private dbPath: string;

	private initialized = false;
	private enableTeeLog = false;
	private teeType: TeeType;
	private teeMode: TEEMode = TEEMode.OFF; // Only used for plugin-tee with TDX dstack

	private teeLogDAO: TeeLogDAO<Database.Database>;
	private teeLogManager: TeeLogManager;

	static serviceType: ServiceType = ServiceTypes.TEE;
	capabilityDescription =
		"The agent is able to log TEE attestation events and is probably running in a TEE";

	constructor(runtime: IAgentRuntime) {
		super();
		this.runtime = runtime;
	}

	static async start(runtime: IAgentRuntime): Promise<TeeLogService> {
		const service = new TeeLogService(runtime);

		const enableValues = ["true", "1", "yes", "enable", "enabled", "on"];

		const enableTeeLog = runtime.getSetting("ENABLE_TEE_LOG") as string;
		if (enableTeeLog === null) {
			throw new Error("ENABLE_TEE_LOG is not set.");
		}
		service.enableTeeLog = enableValues.includes(enableTeeLog.toLowerCase());
		if (!service.enableTeeLog) {
			console.log("TEE log is not enabled.");
			return;
		}

		const runInSgx = runtime.getSetting("SGX") as string;
		const teeMode = runtime.getSetting("TEE_MODE") as string;
		const walletSecretSalt = runtime.getSetting("WALLET_SECRET_SALT");

		service.teeMode = teeMode
			? TEEMode[teeMode as keyof typeof TEEMode]
			: TEEMode.OFF;

		const useSgxGramine =
			runInSgx && enableValues.includes(runInSgx.toLowerCase());
		const useTdxDstack = teeMode && teeMode !== TEEMode.OFF && walletSecretSalt;

		if (useSgxGramine && useTdxDstack) {
			throw new Error("Cannot configure both SGX and TDX at the same time.");
		}
		if (useSgxGramine) {
			service.teeType = TeeType.SGX_GRAMINE;
		} else if (useTdxDstack) {
			service.teeType = TeeType.TDX_DSTACK;
		} else {
			throw new Error("Invalid TEE configuration.");
		}

		const dbPathSetting = runtime.getSetting("TEE_LOG_DB_PATH") as string;
		service.dbPath = dbPathSetting || path.resolve("data/tee_log.sqlite");

		const db = new Database(service.dbPath);
		service.teeLogDAO = new SqliteTeeLogDAO(db);
		service.teeLogManager = new TeeLogManager(
			service.teeLogDAO,
			service.teeType,
			service.teeMode,
		);

		const isRegistered = await service.teeLogManager.registerAgent(
			runtime?.agentId,
			runtime?.character?.name,
		);
		if (!isRegistered) {
			throw new Error(`Failed to register agent ${runtime.agentId}`);
		}

		service.initialized = true;
		return service;
	}

	static async stop(runtime: IAgentRuntime) {
		const service = runtime.getService(ServiceTypes.TEE);
		if (service) {
			await service.stop();
		}
	}

	async stop() {
		// do nothing
	}

	async log(
		agentId: string,
		roomId: string,
		entityId: string,
		type: string,
		content: string,
	): Promise<boolean> {
		if (!this.enableTeeLog) {
			return false;
		}

		return this.teeLogManager.log(agentId, roomId, entityId, type, content);
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

	async getLogs(
		query: TeeLogQuery,
		page: number,
		pageSize: number,
	): Promise<TeePageQuery<TeeLog[]>> {
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
