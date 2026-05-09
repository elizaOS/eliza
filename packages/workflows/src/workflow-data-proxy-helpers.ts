import type { INodeExecutionData, Workflow, WorkflowExecuteMode } from './index.js';

export function getPinDataIfManualExecution(
	workflow: Workflow,
	nodeName: string,
	mode: WorkflowExecuteMode
): INodeExecutionData[] | undefined {
	if (mode !== 'manual') {
		return undefined;
	}
	return workflow.getPinDataOfNode(nodeName);
}
