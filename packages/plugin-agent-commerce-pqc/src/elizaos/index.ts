import { commerceActions } from './actions';
import { commerceProvider } from './provider';
import { commerceEvaluator, securityEvaluator } from './evaluator';

export const agentCommercePlugin = {
  name: "agent-commerce",
  description: "Secure PQC Commerce Plugin",
  actions: commerceActions,
  evaluators: [securityEvaluator, commerceEvaluator],
  providers: [commerceProvider],
};

export default agentCommercePlugin;

export { commerceActions } from './actions';
export { commerceProvider } from './provider';
export { commerceEvaluator, securityEvaluator } from './evaluator';
export { HybridMemoryManager, persistMemory } from './memory';
export type { IElizaRuntime, Memory, State, HandlerCallback, JobSummary } from './types';