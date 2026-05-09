import type { IConnections, NodeConnectionType } from '../interfaces.js';
import { NodeConnectionTypes } from '../interfaces.js';
import { getConnectedNodes } from './get-connected-nodes.js';

export function getChildNodes(
	connectionsBySourceNode: IConnections,
	nodeName: string,
	type: NodeConnectionType | 'ALL' | 'ALL_NON_MAIN' = NodeConnectionTypes.Main,
	depth = -1
): string[] {
	return getConnectedNodes(connectionsBySourceNode, nodeName, type, depth);
}
