/**
 * Enum representing different types of Tee.
 * @enum {string}
 * @readonly
 */

export enum TeeType {
  SGX_GRAMINE = 'sgx_gramine',
  TDX_DSTACK = 'tdx_dstack',
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
