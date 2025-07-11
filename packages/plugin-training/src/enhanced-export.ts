/**
 * Enhanced Plugin Export
 *
 * Provides the enhanced custom reasoning plugin with comprehensive
 * database and file system integration.
 */

// Export enhanced plugin and components
export { enhancedCustomReasoningPlugin } from './enhanced/enhanced-plugin';
export { EnhancedReasoningService } from './enhanced/enhanced-reasoning-service';
export { enhancedActions } from './enhanced/enhanced-actions';
export { trainingSchema } from './enhanced/schema';

// Export types
export type {
  TrainingDataRecord,
  TrainingDataSelect,
  TrainingSession,
  TrainingSessionSelect,
} from './enhanced/schema';

// Import for default export
import { enhancedCustomReasoningPlugin } from './enhanced/enhanced-plugin';

// Default export for convenience
export default enhancedCustomReasoningPlugin;
