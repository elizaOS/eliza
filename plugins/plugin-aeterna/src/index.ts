import { executeSwapAction } from './actions/swap';
import { rebalancePortfolioAction } from './actions/rebalance';

export const aeternaPlugin = {
  name: '@elizaos/plugin-aeterna',
  description: 'MEV-Protected Autonomous Execution & Intent Netting Plugin for Eliza Agents on Base',
  actions: [
    executeSwapAction,
    rebalancePortfolioAction
  ],
  evaluators: [],
  providers: []
};

export default aeternaPlugin;
