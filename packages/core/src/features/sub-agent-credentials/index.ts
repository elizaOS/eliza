/**
 * Sub-agent credentials — atomic action slice.
 *
 * Re-exports the four atomic actions, the plugin scaffold, and the runtime
 * contract types (`SubAgentCredentialBridge`, `SubAgentChildDecisionBus`,
 * `SubAgentChildResultsClient`, scope/decision/result shapes, service name
 * constants).
 */

export {
	awaitChildAgentDecisionAction,
	declareSubAgentCredentialScopeAction,
	retrieveChildAgentResultsAction,
	tunnelCredentialToChildSessionAction,
} from "./actions/index.ts";

export {
	subAgentCredentialsPlugin,
	subAgentCredentialsPlugin as default,
} from "./plugin.ts";

export type {
	ChildAgentDecision,
	ChildAgentResultBundle,
	SubAgentChildDecisionBus,
	SubAgentChildResultsClient,
	SubAgentCredentialBridge,
	SubAgentCredentialScope,
} from "./types.ts";

export {
	SUB_AGENT_CHILD_DECISION_BUS_SERVICE,
	SUB_AGENT_CHILD_RESULTS_CLIENT_SERVICE,
	SUB_AGENT_CREDENTIAL_BRIDGE_SERVICE,
} from "./types.ts";
