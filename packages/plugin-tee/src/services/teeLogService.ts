import path from "node:path";
import {
	type IAgentRuntime,
	type ITeeLogService,
	Service,
	ServiceType,
	type ServiceTypeName,
	TEEMode,
	type TeeAgent,
	type TeeLog,
	type TeeLogDAO,
	type TeeLogQuery,
	type TeePageQuery,
	TeeType,
} from "@elizaos/core";
import Database from "better-sqlite3";
import { SqliteTeeLogDAO } from "../adapters/sqliteDAO";
import { TeeLogManager } from "./teeLogManager";

/**
 * Represents a TeeLogService class that extends Service and implements ITeeLogService
 * This service is responsible for logging TEE attestation events
 */
export class TeeLogService extends Service implements ITeeLogService {
	private dbPath: string;

	private initialized = false;
	private enableTeeLog = false;
	private teeType: TeeType;
	private teeMode: TEEMode = TEEMode.OFF; // Only used for plugin-tee with TDX dstack

	private teeLogDAO: TeeLogDAO<Database.Database>;
	private teeLogManager: TeeLogManager;

	static serviceType: ServiceTypeName = ServiceType.TEE;
	capabilityDescription =
		"The agent is able to log TEE attestation events and is probably running in a TEE";

	/**
	 * Constructor for creating a new instance of a class.
	 * @param {IAgentRuntime} runtime - The runtime object to be assigned to the instance.
	 */
	constructor(runtime: IAgentRuntime) {
		super();
		this.runtime = runtime;
	}

	/**
	 * Start the TeeLogService with the given runtime.
	 *
	 * @param {IAgentRuntime} runtime - The agent runtime to start the service with
	 * @returns {Promise<TeeLogService>} - A promise that resolves with the TeeLogService instance
	 * @throws {Error} - If ENABLE_TEE_LOG is not set, SGX and TDX are configured at the same time, or if the TEE configuration is invalid
	 */
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

	/**
	 * Stop the TEE service running on the provided runtime.
	 *
	 * @param {IAgentRuntime} runtime - The runtime on which the TEE service is running.
	 * @returns {Promise<void>} - A promise that resolves once the TEE service has stopped.
	 */
	static async stop(runtime: IAgentRuntime) {
		const service = runtime.getService(ServiceType.TEE);
		if (service) {
			await service.stop();
		}
	}

	/**
	 * Asynchronous method to stop the operation.
	 * Does nothing.
	 */
	async stop() {
		// do nothing
	}

	/**
	 * Asynchronously logs the provided information if tee log is enabled.
	 *
	 * @param {string} agentId - The ID of the agent requesting the log.
	 * @param {string} roomId - The ID of the room where the log is taking place.
	 * @param {string} entityId - The ID of the entity related to the log.
	 * @param {string} type - The type of log entry.
	 * @param {string} content - The content of the log entry.
	 * @returns {Promise<boolean>} A promise that resolves to true if the log is successful, false if tee log is not enabled.
	 */
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

	/**
	 * Asynchronously retrieves all TeeAgents.
	 *
	 * @returns {Promise<TeeAgent[]>} A Promise that resolves with an array of TeeAgent objects. If Tee logging is not enabled, an empty array is returned.
	 */
	async getAllAgents(): Promise<TeeAgent[]> {
		if (!this.enableTeeLog) {
			return [];
		}

		return this.teeLogManager.getAllAgents();
	}

	/**
	 * Asynchronously retrieves a TeeAgent based on the provided agentId.
	 *
	 * @param {string} agentId - The ID of the agent to retrieve.
	 * @returns {Promise<TeeAgent | undefined>} A Promise that resolves with the retrieved TeeAgent, or undefined if TEE logging is not enabled.
	 */
	async getAgent(agentId: string): Promise<TeeAgent | undefined> {
		if (!this.enableTeeLog) {
			return undefined;
		}

		return this.teeLogManager.getAgent(agentId);
	}

	/**
	 * Retrieves Tee logs based on query, page, and page size.
	 *
	 * @param {TeeLogQuery} query - The query parameters to filter the logs.
	 * @param {number} page - The current page number.
	 * @param {number} pageSize - The number of logs to fetch per page.
	 * @returns {Promise<TeePageQuery<TeeLog[]>>} A Promise that resolves to a TeePageQuery object containing an array of TeeLog and pagination information.
	 */
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

	/**
	 * Asynchronously generates an attestation for the given user report.
	 *
	 * @param {string} userReport - The user report to generate attestation for.
	 * @returns {Promise<string>} A promise that resolves to the generated attestation.
	 */
	async generateAttestation(userReport: string): Promise<string> {
		return this.teeLogManager.generateAttestation(userReport);
	}
}

export default TeeLogService;
