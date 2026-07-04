/**
 * Legacy plugin-tee attestation shapes (`TEEMode`, `TeeAgent`,
 * `RemoteAttestationQuote`, …) modeling the original Phala/dstack deterministic
 * key-derivation + TDX-quote surface. NOT the trust contract the agent boot path
 * uses — the canonical, provider-neutral evidence + fail-closed policy lives in
 * `packages/agent/src/services/tee-evidence.ts` and `tee-policy.ts`; add new
 * confidential-compute fields there, not here.
 */
import type { JsonObject } from "./primitives";

/**
 * LEGACY plugin-tee TEE shapes. `TEEMode`, `TeeType`, `TeeAgent`,
 * `RemoteAttestationQuote`, and the surrounding `DeriveKeyAttestationData` /
 * `AttestedMessage` / `RemoteAttestationMessage` / `TeePluginConfig` types model
 * the original Phala/dstack plugin-tee surface (deterministic key derivation +
 * per-derivation TDX quote). They are NOT the trust contract the agent boot path
 * uses, and they are not the place to add new confidential-compute fields.
 *
 * The canonical, provider-neutral evidence + trust-decision contract lives in
 * the agent runtime:
 *
 *   - `packages/agent/src/services/tee-evidence.ts` — the normalized `TeeEvidence`
 *     shape and `TeeKind` union (the single source of truth for attestation
 *     evidence: `kind`, `measurements`, `freshness`, `claims`, `quote`,
 *     `reportData`, ...). Add new evidence fields there, not here.
 *   - `packages/agent/src/services/tee-policy.ts` — `evaluateTeeEvidencePolicy`,
 *     the ONE fail-closed trust-decision path. Every gate (boot, key release,
 *     signer, remote-capability sync) routes its trust call through it.
 *
 * These legacy types and the canonical `TeeEvidence` contract describe different
 * concepts and do not conflict; the naming overlap is the only trap. Treat the
 * `tee-evidence.ts` / `tee-policy.ts` pair as authoritative for any new
 * confidential-AI / attestation work. See
 * `packages/agent/docs/tee-agent-implementation-plan.md` §1.2.
 */

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
