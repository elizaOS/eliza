export enum TeeType {
	SGX_GRAMINE = "sgx_gramine",
	TDX_DSTACK = "tdx_dstack",
}

// Represents a log entry in the TeeLog table, containing details about agent activities.
export interface TeeLog {
	id: string;
	agentId: string;
	roomId: string;
	entityId: string;
	type: string;
	content: string;
	timestamp: number;
	signature: string;
}

export interface TeeLogQuery {
	agentId?: string;
	roomId?: string;
	entityId?: string;
	type?: string;
	containsContent?: string;
	startTimestamp?: number;
	endTimestamp?: number;
}

// Represents an agent in the TeeAgent table, containing details about the agent.
export interface TeeAgent {
	id: string; // Primary key
	// Allow duplicate agentId.
	// This is to support the case where the same agentId is registered multiple times.
	// Each time the agent restarts, we will generate a new keypair and attestation.
	agentId: string;
	agentName: string;
	createdAt: number;
	publicKey: string;
	attestation: string;
}

export interface TeePageQuery<Result> {
	page: number;
	pageSize: number;
	total?: number;
	data?: Result;
}

export abstract class TeeLogDAO<DB> {
	db: DB;

	abstract initialize(): Promise<void>;

	abstract addLog(log: TeeLog): Promise<boolean>;

	abstract getPagedLogs(
		query: TeeLogQuery,
		page: number,
		pageSize: number,
	): Promise<TeePageQuery<TeeLog[]>>;

	abstract addAgent(agent: TeeAgent): Promise<boolean>;

	abstract getAgent(agentId: string): Promise<TeeAgent>;

	abstract getAllAgents(): Promise<TeeAgent[]>;
}
