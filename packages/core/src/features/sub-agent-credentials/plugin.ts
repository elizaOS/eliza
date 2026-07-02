/**
 * Sub-agent credential bridge — action slice.
 *
 * Registers four atomic actions for the parent runtime to orchestrate a
 * spawned coding sub-agent's credential lifecycle:
 *   - DECLARE_SUB_AGENT_CREDENTIAL_SCOPE
 *   - TUNNEL_CREDENTIAL_TO_CHILD_SESSION
 *   - AWAIT_CHILD_AGENT_DECISION
 *   - RETRIEVE_CHILD_AGENT_RESULTS
 *
 * The plugin is intentionally NOT auto-enabled. Wave F's wiring follow-up
 * registers `subAgentCredentialsPlugin` via the export point and the
 * orchestrator's runtime adapter resolves the bridge / decision-bus /
 * results-client services.
 */

import { logger } from "../../logger.ts";
import type { Plugin } from "../../types/index.ts";
// Import each action from its defining file, NOT through a re-export-only
// barrel. When the mobile agent bundle lowers @elizaos/core into lazy
// CJS-interop module inits (the core barrel graph is cyclic via
// features/basic-capabilities -> ../index.ts), Bun's tree-shaker drops
// modules that are reachable only through a pure re-export barrel while
// keeping this plugin (eagerly imported by name in @elizaos/agent). The
// plugin body then references bindings that were never emitted and the
// on-device agent dies at load with
// `ReferenceError: declareSubAgentCredentialScopeAction is not defined`.
import { awaitChildAgentDecisionAction } from "./actions/await-child-agent-decision.ts";
import { declareSubAgentCredentialScopeAction } from "./actions/declare-sub-agent-credential-scope.ts";
import { retrieveChildAgentResultsAction } from "./actions/retrieve-child-agent-results.ts";
import { tunnelCredentialToChildSessionAction } from "./actions/tunnel-credential-to-child-session.ts";

export const subAgentCredentialsPlugin: Plugin = {
	name: "sub-agent-credentials",
	description:
		"Sub-agent credential bridge: declare a scope, tunnel a credential to a child session, await its decision, retrieve its results.",
	actions: [
		declareSubAgentCredentialScopeAction,
		tunnelCredentialToChildSessionAction,
		awaitChildAgentDecisionAction,
		retrieveChildAgentResultsAction,
	],
	init: async () => {
		logger.info("[SubAgentCredentialsPlugin] Initialized");
	},
};

export default subAgentCredentialsPlugin;
