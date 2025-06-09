import type { Metadata } from './primitives';

// Represents an agent in the TeeAgent table, containing details about the agent.
/**
 * Represents an agent's registration details within a Trusted Execution Environment (TEE) context.
 * This is typically stored in a database table (e.g., `TeeAgent`) to manage agents operating in a TEE.
 * It allows for multiple registrations of the same `agentId` to support scenarios where an agent might restart,
 * generating a new keypair and attestation each time.
 */
export interface TeeAgent {
  /** Primary key for the TEE agent registration record (e.g., a UUID or auto-incrementing ID). */
  id: string; // Primary key
  // Allow duplicate agentId.
  // This is to support the case where the same agentId is registered multiple times.
  // Each time the agent restarts, we will generate a new keypair and attestation.
  /** The core identifier of the agent, which can be duplicated across multiple TEE registrations. */
  agentId: string;
  /** The human-readable name of the agent. */
  agentName: string;
  /** Timestamp (e.g., Unix epoch in milliseconds) when this TEE registration was created. */
  createdAt: number;
  /** The public key associated with this specific TEE agent instance/session. */
  publicKey: string;
  /** The attestation document proving the authenticity and integrity of the TEE instance. */
  attestation: string;
}

/**
 * Defines the operational modes for a Trusted Execution Environment (TEE).
 * This enum is used to configure how TEE functionalities are engaged, allowing for
 * different setups for local development, Docker-based development, and production.
 */
export enum TEEMode {
  /** TEE functionality is completely disabled. */
  OFF = 'OFF',
  /** For local development, potentially using a TEE simulator. */
  LOCAL = 'LOCAL', // For local development with simulator
  /** For Docker-based development environments, possibly with a TEE simulator. */
  DOCKER = 'DOCKER', // For docker development with simulator
  /** For production deployments, using actual TEE hardware without a simulator. */
  PRODUCTION = 'PRODUCTION', // For production without simulator
}

/**
 * Represents a quote obtained during remote attestation for a Trusted Execution Environment (TEE).
 * This quote is a piece of evidence provided by the TEE, cryptographically signed, which can be
 * verified by a relying party to ensure the TEE's integrity and authenticity.
 */
export interface RemoteAttestationQuote {
  /** The attestation quote data, typically a base64 encoded string or similar format. */
  quote: string;
  /** Timestamp (e.g., Unix epoch in milliseconds) when the quote was generated or received. */
  timestamp: number;
}

/**
 * Data structure used in the attestation process for deriving a key within a Trusted Execution Environment (TEE).
 * This information helps establish a secure channel or verify the identity of the agent instance
 * requesting key derivation.
 */
export interface DeriveKeyAttestationData {
  /** The unique identifier of the agent for which the key derivation is being attested. */
  agentId: string;
  /** The public key of the agent instance involved in the key derivation process. */
  publicKey: string;
  /** Optional subject or context information related to the key derivation. */
  subject?: string;
}

/**
 * Represents a message that has been attested by a Trusted Execution Environment (TEE).
 * This structure binds a message to an agent's identity and a timestamp, all within the
 * context of a remote attestation process, ensuring the message originated from a trusted TEE instance.
 */
export interface RemoteAttestationMessage {
  /** The unique identifier of the agent sending the attested message. */
  agentId: string;
  /** Timestamp (e.g., Unix epoch in milliseconds) when the message was attested or sent. */
  timestamp: number;
  /** The actual message content, including details about the entity, room, and the content itself. */
  message: {
    entityId: string;
    roomId: string;
    content: string;
  };
}

/**
 * Enumerates different types or vendors of Trusted Execution Environments (TEEs).
 * This allows the system to adapt to specific TEE technologies, like Intel TDX on DSTACK.
 */
export enum TeeType {
  /** Represents Intel Trusted Domain Extensions (TDX) running on DSTACK infrastructure. */
  TDX_DSTACK = 'tdx_dstack',
}

/**
 * Configuration for a TEE (Trusted Execution Environment) plugin.
 * This allows specifying the TEE vendor and any vendor-specific configurations.
 * It's used to initialize and configure TEE-related functionalities within the agent system.
 */
export interface TeePluginConfig {
  /** Optional. The name or identifier of the TEE vendor (e.g., 'tdx_dstack' from `TeeType`). */
  vendor?: string;
  /** Optional. Vendor-specific configuration options, conforming to `TeeVendorConfig`. */
  vendorConfig?: Metadata;
}
