/**
 * Sub-agent credentials — atomic action slice.
 *
 * Re-exports the four atomic actions, the plugin scaffold, and the runtime
 * contract types (`SubAgentCredentialBridge`, `SubAgentChildDecisionBus`,
 * `SubAgentChildResultsClient`, scope/decision/result shapes, service name
 * constants).
 */

// Re-export each action from its defining file, NOT through a re-export-only
// barrel — see the note in ./plugin.ts (Bun.build drops barrel-only-reachable
// modules when the mobile bundle lowers @elizaos/core to lazy CJS-interop
// inits, crashing the on-device agent at load).
export { awaitChildAgentDecisionAction } from "./actions/await-child-agent-decision.ts";
export { declareSubAgentCredentialScopeAction } from "./actions/declare-sub-agent-credential-scope.ts";
export { retrieveChildAgentResultsAction } from "./actions/retrieve-child-agent-results.ts";
export { tunnelCredentialToChildSessionAction } from "./actions/tunnel-credential-to-child-session.ts";

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
	SubAgentCredentialRequestOrigin,
	SubAgentCredentialScope,
} from "./types.ts";

export {
	SUB_AGENT_CHILD_DECISION_BUS_SERVICE,
	SUB_AGENT_CHILD_RESULTS_CLIENT_SERVICE,
	SUB_AGENT_CREDENTIAL_BRIDGE_ADAPTER_SERVICE,
	SUB_AGENT_CREDENTIAL_BRIDGE_SERVICE,
} from "./types.ts";
