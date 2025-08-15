/**
 * MVP-Only Export - Clean implementation without broken complex dependencies
 *
 * This file exports ONLY the working MVP implementation,
 * avoiding all the broken complex imports and dependencies.
 */

// Export only MVP components
export { mvpCustomReasoningPlugin } from './mvp/mvp-plugin';
export { SimpleReasoningService } from './mvp/simple-reasoning-service';
export {
  enableCustomReasoningAction,
  disableCustomReasoningAction,
  checkReasoningStatusAction,
} from './mvp/simple-actions';
export type { TrainingDataRecord } from './mvp/simple-reasoning-service';

// Re-export as default for convenience
export { mvpCustomReasoningPlugin as default } from './mvp/mvp-plugin';
