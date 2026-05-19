/**
 * Sub-agent credential bridge — atomic action contracts.
 *
 * These types describe the runtime contract between the four atomic actions
 * in this feature and the parent-side credential tunnel service. Actions
 * never import the app-core service directly — they resolve a client
 * implementation via `runtime.getService(name)`. The Wave F follow-up wires
 * a concrete adapter that calls `CredentialTunnelService` in app-core.
 */

export const SUB_AGENT_CREDENTIAL_BRIDGE_SERVICE = "SubAgentCredentialBridge";
export const SUB_AGENT_CHILD_DECISION_BUS_SERVICE = "SubAgentChildDecisionBus";
export const SUB_AGENT_CHILD_RESULTS_CLIENT_SERVICE =
	"SubAgentChildResultsClient";

export interface SubAgentCredentialScope {
	credentialScopeId: string;
	scopedToken: string;
	/** epoch ms */
	expiresAt: number;
	/** request ids dispatched to collect the missing values, if any. */
	sensitiveRequestIds: readonly string[];
}

export interface ChildAgentDecision {
	childSessionId: string;
	/** epoch ms */
	decidedAt: number;
	/** Raw line emitted on the child's DECISION channel. */
	decision: string;
	/** Optional structured payload parsed from the decision line. */
	payload?: Record<string, unknown>;
}

export interface ChildAgentResultBundle {
	childSessionId: string;
	/** epoch ms */
	retrievedAt: number;
	/** Concatenated stdout transcript (sanitized — no scoped tokens). */
	transcript?: string;
	/** Filesystem artifacts produced by the child. */
	artifacts?: ReadonlyArray<{ path: string; bytes: number }>;
	/** Final structured result the child emitted, if any. */
	result?: Record<string, unknown>;
}

/**
 * Cloud / parent-runtime-backed bridge client. Resolved via
 * `runtime.getService(SUB_AGENT_CREDENTIAL_BRIDGE_SERVICE)`.
 *
 * Parent runtimes register an adapter that calls the app-core
 * `CredentialTunnelService` directly; sandboxed sub-agent runtimes get no
 * adapter and the actions cleanly degrade to a "service unavailable"
 * response.
 */
export interface SubAgentCredentialBridge {
	declareScope(input: {
		childSessionId: string;
		credentialKeys: readonly string[];
		actorPolicy?: "owner_only" | "owner_or_linked_identity";
		deliveryTarget?: "dm" | "owner_app_inline";
	}): Promise<SubAgentCredentialScope>;
	tunnelCredential(input: {
		childSessionId: string;
		credentialScopeId: string;
		key: string;
		value: string;
	}): Promise<void>;
}

/** Resolved via `runtime.getService(SUB_AGENT_CHILD_DECISION_BUS_SERVICE)`. */
export interface SubAgentChildDecisionBus {
	/**
	 * Subscribe to the child session's DECISION channel and resolve as soon
	 * as a decision arrives. Caller controls timeout via `timeoutMs`.
	 */
	awaitDecision(input: {
		childSessionId: string;
		timeoutMs: number;
	}): Promise<ChildAgentDecision>;
}

/** Resolved via `runtime.getService(SUB_AGENT_CHILD_RESULTS_CLIENT_SERVICE)`. */
export interface SubAgentChildResultsClient {
	getResults(input: {
		childSessionId: string;
	}): Promise<ChildAgentResultBundle>;
}
