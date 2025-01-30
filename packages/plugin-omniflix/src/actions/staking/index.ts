import delegateTokens from './delegate_token.ts';
import undelegateTokens from './undelegate_token.ts';
import redelegate from './redelegate.ts';
import cancelUnbonding from './cancel_unbonding.ts';

export const stakingActions = [
    redelegate,
    undelegateTokens,
    delegateTokens,
    cancelUnbonding,
]

export default stakingActions;
