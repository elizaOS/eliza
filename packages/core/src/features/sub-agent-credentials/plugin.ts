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
import {
	awaitChildAgentDecisionAction,
	declareSubAgentCredentialScopeAction,
	retrieveChildAgentResultsAction,
	tunnelCredentialToChildSessionAction,
} from "./actions/index.ts";

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
