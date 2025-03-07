import { logger, type UUID } from "@elizaos/core";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { BaseDrizzleAdapter } from "../base";
import {
	DIMENSION_MAP,
	type EmbeddingDimensionColumn,
} from "../schema/embedding";
import type { PGliteClientManager } from "./manager";

export class PgliteDatabaseAdapter extends BaseDrizzleAdapter<PgliteDatabase> {
	private manager: PGliteClientManager;
	protected embeddingDimension: EmbeddingDimensionColumn = DIMENSION_MAP[384];

	constructor(agentId: UUID, manager: PGliteClientManager) {
		super(agentId);
		this.manager = manager;
		this.db = drizzle(this.manager.getConnection());
	}

	protected async withDatabase<T>(operation: () => Promise<T>): Promise<T> {
		if (this.manager.isShuttingDown()) {
			logger.warn("Database is shutting down");
			return null as unknown as T;
		}
		return operation();
	}

	async init(): Promise<void> {
		try {
			await this.manager.runMigrations();
		} catch (error) {
			logger.error("Failed to initialize database:", error);
			throw error;
		}
	}

	async close() {
		await this.manager.close();
	}
}
