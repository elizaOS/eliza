/** Execution is embedded in this agent host; this says nothing about model inference. */
export interface WorkflowStatusResponse {
  mode: 'local' | 'disabled';
  host: string | null;
  status: 'ready' | 'error';
  cloudConnected: false;
  localEnabled: boolean;
  platform: 'runtime';
  executionLocation: 'agent-runtime';
  cloudHealth: 'unknown';
  engine: 'smthrs';
  errorMessage?: string | null;
}

export function workflowRuntimeStatus(
  authoringAvailable: boolean,
  executionAvailable: boolean
): WorkflowStatusResponse {
  const available = authoringAvailable && executionAvailable;
  return {
    mode: available ? 'local' : 'disabled',
    host: available ? 'eliza://workflow' : null,
    status: available ? 'ready' : 'error',
    cloudConnected: false,
    localEnabled: available,
    platform: 'runtime',
    executionLocation: 'agent-runtime',
    cloudHealth: 'unknown',
    engine: 'smthrs',
    ...(!available
      ? { errorMessage: 'Workflow authoring or execution service is not registered' }
      : {}),
  };
}
