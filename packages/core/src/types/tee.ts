import type { JsonObject } from "./primitives";

/**
 * Operational modes for a TEE.
 */
export const TEEMode = {
	UNSPECIFIED: "UNSPECIFIED",
	OFF: "OFF",
	LOCAL: "LOCAL",
	DOCKER: "DOCKER",
	PRODUCTION: "PRODUCTION",
} as const;

export type TEEMode = (typeof TEEMode)[keyof typeof TEEMode];

/**
 * Types or vendors of TEEs.
 */
export const TeeType = {
	UNSPECIFIED: "UNSPECIFIED",
	TDX_DSTACK: "TDX_DSTACK",
} as const;

export type TeeType = (typeof TeeType)[keyof typeof TeeType];

/**
 * Registration details for an agent within a TEE context.
 */
export interface TeeAgent {
	id: string;
	agentId: string;
	agentName: string;
	createdAt: number;
	publicKey: string;
	attestation: string;
}

/**
 * Quote obtained during remote attestation.
 */
export interface RemoteAttestationQuote {
	quote: string;
	timestamp: number;
}

/**
 * Data used to derive a key within a TEE.
 */
export interface DeriveKeyAttestationData {
	agentId: string;
	publicKey: string;
	subject?: string;
}

/**
 * Message content attested by a TEE.
 */
export interface AttestedMessage {
	entityId: string;
	roomId: string;
	content: string;
}

/**
 * Represents a message that has been attested by a TEE.
 */
export interface RemoteAttestationMessage {
	agentId: string;
	timestamp: number;
	message: AttestedMessage;
}

/**
 * Configuration for a TEE plugin.
 */
export interface TeePluginConfig {
	vendor?: string;
	vendorConfig?: JsonObject;
}
