/**
 * Cloud Billing Plugin
 *
 * Provides credit awareness to agents running on Eliza Cloud.
 * Enables agents to check their budget before expensive operations.
 *
 * Features:
 * - AGENT_CREDITS provider for budget awareness
 * - Budget check before operations
 * - Credit deduction tracking
 */

import { logger, type Plugin } from "@elizaos/core";
import { agentCreditsProvider } from "../providers/agent-credits-provider";

export const cloudBillingPlugin: Plugin = {
  name: "eliza-cloud-billing",
  description: "Credit and budget awareness for Eliza Cloud agents",

  providers: [agentCreditsProvider],

  actions: [],
  evaluators: [],
};

export default cloudBillingPlugin;

// Re-export utilities
export {
  agentCreditsProvider,
  getCreditsPromptSection,
  canAgentAfford,
  deductAgentBudget,
} from "../providers/agent-credits-provider";
