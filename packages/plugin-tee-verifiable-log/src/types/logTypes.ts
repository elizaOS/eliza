export interface VerifiableLog {
    id: string; // Primary Key UUID
    created_at?: Date; // Default value: CURRENT_TIMESTAMP
    agent_id: string; // Not null
    room_id: string; // Not null
    user_id: string; // Not null
    type: string; // Not null
    content: string; // Not null
    signature: string; // Not null
}
export interface VerifiableLogQuery {
    idEq: string;
    agentIdEq: string;
    roomIdEq: string;
    userIdEq: string;
    typeEq: string;
    contLike: string;
    signatureEq: string;
}

export interface VerifiableAgent {
    id: string; // Primary Key
    created_at?: Date; // Default value: CURRENT_TIMESTAMP
    agent_id: string; // Not null
    agent_name: string; // Not null
    agent_keypair_path: string; // Not null
    agent_keypair_vlog_pk: string; // Not null
}

export interface PageQuery<Result = unknown> {
    page: number;
    pageSize: number;
    total?: number;
    data?: Result;
}

export abstract class VerifiableDAO<DB = unknown> {
    protected constructor() {}

    /**
     * The database instance.
     */
    db: DB;

    /**
     * Optional initialization method for the database adapter.
     * @returns A Promise that resolves when initialization is complete.
     */
    abstract initializeSchema(): Promise<void>;

    /**
     * insert log to table
     * @param log
     */
    abstract addLog(log: VerifiableLog): Promise<boolean>;

    /**
     * Performs a paginated query for VerifiableLogs based on the given criteria.
     *
     * @param agentQuery - The query parameters to filter the logs.
     * @param page - The page number to retrieve (1-based).
     * @param pageSize - The number of items per page.
     * @returns A Promise that resolves to a PageQuery object containing an array of VerifiableLogs.
     */
    abstract pageQueryLogs(
        agentQuery: VerifiableLogQuery,
        page: number,
        pageSize: number
    ): Promise<PageQuery<VerifiableLog[]>>;

    /**
     * insert Verifiable Agent info to table
     * @param agent
     */
    abstract addAgent(agent: VerifiableAgent): Promise<boolean>;

    /**
     * Retrieves a VerifiableAgent by its agentId.
     *
     * @param agentId - The unique identifier of the agent to retrieve.
     * @returns A Promise that resolves to a VerifiableAgent object.
     */
    abstract getAgent(agentId: string): Promise<VerifiableAgent>;

    /**
     * Retrieves a list of all VerifiableAgents.
     *
     * @returns A Promise that resolves to an array of VerifiableAgent objects.
     */
    abstract listAgent(): Promise<VerifiableAgent[]>;
}

export interface IVerifiableLogProvider {
    /**
     * Logs a message with the given parameters.
     *
     * @param params - The parameters for the log message.
     * @param endpoint - Tee endpoint.
     * @returns A Promise that resolves to a boolean indicating whether the log was successful.
     */
    log(
        params: {
            agentId: string;
            roomId: string;
            userId: string;
            type: string;
            content: string;
        },
        endpoint: string
    ): Promise<boolean>;

    /**
     * Registers a new agent with the given parameters.
     *
     * @param params - The parameters for the agent registration.
     * @param endpoint - Tee endpoint.
     * @returns A Promise that resolves to a boolean indicating whether the registration was successful.
     */
    registerAgent(
        params: {
            agentId: string;
        },
        endpoint: string
    ): Promise<boolean>;
}
