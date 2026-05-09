import { NodeOperationError } from './node-operation.error.js';

/**
 * A type of NodeOperationError caused by a configuration problem somewhere in workflow.
 */
export class WorkflowConfigurationError extends NodeOperationError {}
