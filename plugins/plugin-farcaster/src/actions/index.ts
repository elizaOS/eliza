export { sendCastAction } from './sendCast';
export { replyCastAction } from './replyCast';

import { sendCastAction } from './sendCast';
import { replyCastAction } from './replyCast';

// Export all actions as an array for easy plugin registration
export const farcasterActions = [sendCastAction, replyCastAction];
