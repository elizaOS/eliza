/**
 * Enum representing different types of Tee.
 * @enum {string}
 * @readonly
 */

export enum TeeType {
  SGX_GRAMINE = 'sgx_gramine',
  TDX_DSTACK = 'tdx_dstack',
}

// Represents a log entry in the TeeLog table, containing details about agent activities.
/**
 * Interface representing a log entry for a tee.
 * @typedef {Object} TeeLog
 * @property {string} id - The unique identifier for the log entry.
 * @property {string} agentId - The identifier of the agent who created the log entry.
 * @property {string} roomId - The identifier of the room where the log entry was created.
 * @property {string} entityId - The identifier of the entity associated with the log entry.
 * @property {string} type - The type of the log entry.
 * @property {string} content - The content of the log entry.
 * @property {number} timestamp - The timestamp when the log entry was created.
 * @property {string} signature - The signature of the log entry.
 */

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

/**
 * Interface for defining query parameters for fetching TeeLog data.
 * @property {string} [agentId] - The ID of the agent associated with the log.
 * @property {string} [roomId] - The ID of the room associated with the log.
 * @property {string} [entityId] - The ID of the entity associated with the log.
 * @property {string} [type] - The type of log.
 * @property {string} [containsContent] - The content that the log must contain.
 * @property {number} [startTimestamp] - The starting timestamp for filtering logs.
 * @property {number} [endTimestamp] - The ending timestamp for filtering logs.
 */
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
/**
 * Interface for representing a TeeAgent.
 * @interface
 * @property {string} id - Primary key
 * @property {string} agentId - Allow duplicate agentId. This is to support the case where the same agentId is registered multiple times. Each time the agent restarts, a new keypair and attestation will be generated.
 * @property {string} agentName - The name of the agent.
 * @property {number} createdAt - The timestamp when the agent was created.
 * @property {string} publicKey - The public key of the agent.
 * @property {string} attestation - The attestation of the agent.
 */

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

/**
 * Interface for defining the structure of a paginated query result.
 * @template Result The type of data contained in the query result.
 * @property {number} page The current page number.
 * @property {number} pageSize The number of items per page.
 * @property {number} [total] The total number of items in the query result (optional).
 * @property {Result} [data] The data contained in the query result (optional).
 */
export interface TeePageQuery<Result> {
  page: number;
  pageSize: number;
  total?: number;
  data?: Result;
}

/**
 * Represents a Data Access Object for managing Tee logs and agents.
 * @template DB - Type of the database connection or client
 */
export abstract class TeeLogDAO<DB> {
  db: DB;

  abstract initialize(): Promise<void>;

  abstract addLog(log: TeeLog): Promise<boolean>;

  abstract getPagedLogs(
    query: TeeLogQuery,
    page: number,
    pageSize: number
  ): Promise<TeePageQuery<TeeLog[]>>;

  abstract addAgent(agent: TeeAgent): Promise<boolean>;

  abstract getAgent(agentId: string): Promise<TeeAgent>;

  abstract getAllAgents(): Promise<TeeAgent[]>;
}
