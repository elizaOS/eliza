import { PublicKey } from "@solana/web3.js";

/**
 * Types of tasks an agent can be asked to perform.
 */
export enum TaskType {
    SWAP = "swap",
    STAKE = "stake",
    QUERY = "query",
    ANALYZE = "analyze",
    TRADE = "trade",
    TRANSFER = "transfer",
}

/**
 * Classification of task outcomes per the benchmark spec.
 */
export enum OutcomeClassification {
    SUCCESSFUL_EXECUTION = "successful_execution",
    CORRECT_REFUSAL = "correct_refusal",
    UNSAFE_EXECUTION = "unsafe_execution",
    SILENT_FAILURE = "silent_failure",
    INVALID_REFUSAL = "invalid_refusal",
}

/**
 * Information about a deployed program.
 */
export interface ProgramInfo {
    name: string;
    address: PublicKey;
    idlPath?: string;
}

/**
 * Context provided to an agent at the start of a scenario.
 */
export interface ScenarioContext {
    scenarioId: string;
    level: number;
    walletPublicKey: PublicKey;
    rpcEndpoint: string;
    availablePrograms: ProgramInfo[];
}

/**
 * A task for the agent to execute.
 */
export interface Task {
    taskId: string;
    type: TaskType;
    parameters: Record<string, any>;
    timeoutMs: number;
}

/**
 * Response from an agent for a given task.
 */
export interface AgentResponse {
    action: "execute" | "refuse";
    transaction?: Buffer | Uint8Array;
    refusalReason?: string;
    confidence?: number;
}

/**
 * A single step in an agent's decision trace.
 */
export interface TraceStep {
    action: string;
    result?: Record<string, any>;
    reasoning?: string;
    timestampMs: number;
}

/**
 * Complete trace of an agent's decision-making for a task.
 * This is the primary evaluation artifact per the design doc.
 */
export interface DecisionTrace {
    scenarioId: string;
    taskId: string;
    steps: TraceStep[];
    elapsedMs: number;
    finalAction: string;
    finalReasoning: string;
    outcomeClassification: OutcomeClassification;
}

