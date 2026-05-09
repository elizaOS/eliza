import type { IConnections, NodeConnectionType } from '../interfaces.js';
import { NodeConnectionTypes } from '../interfaces.js';
import { getConnectedNodes } from './get-connected-nodes.js';

/**
 * Returns all the nodes before the given one
 *
 * @param {NodeConnectionType} [type='main']
 * @param {*} [depth=-1]
 */
export function getParentNodes(
	connectionsByDestinationNode: IConnections,
	nodeName: string,
	type: NodeConnectionType | 'ALL' | 'ALL_NON_MAIN' = NodeConnectionTypes.Main,
	depth = -1
): string[] {
	return getConnectedNodes(connectionsByDestinationNode, nodeName, type, depth);
}
