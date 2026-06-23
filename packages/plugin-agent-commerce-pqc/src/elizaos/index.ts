import type { Plugin } from '@elizaos/core';
import { commerceActions } from './actions';
import { commerceProvider } from './provider';
import { AgentCommerceService } from '../service';

// Note: security evaluation (rate limiting, prompt-injection detection) and job
// tracking run inside AgentCommerceService. The old validate/handler evaluator
// pattern is not compatible with elizaOS's schema-based Evaluator interface;
// a schema-driven evaluator adaption is tracked in a follow-up PR.

export const agentCommercePlugin: Plugin = {
  name: 'agent-commerce',
  description:
    'Agent commerce policy plugin: rate limiting, prompt-injection heuristics, and ERC-8183 job lifecycle',
  services: [AgentCommerceService],
  actions: commerceActions,
  providers: [commerceProvider],
};

export default agentCommercePlugin;

export { commerceActions } from './actions';
export { commerceProvider } from './provider';
export { AgentCommerceService } from '../service';
