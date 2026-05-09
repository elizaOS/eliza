import type { IConnections, NodeConnectionType } from '../interfaces.js';

export function mapConnectionsByDestination(connections: IConnections) {
	const returnConnection: IConnections = {};

	for (const sourceNode in connections) {
		if (!Object.hasOwn(connections, sourceNode)) {
			continue;
		}

		for (const type of Object.keys(connections[sourceNode]) as NodeConnectionType[]) {
			if (!Object.hasOwn(connections[sourceNode], type)) {
				continue;
			}

			for (const inputIndex in connections[sourceNode][type]) {
				if (!Object.hasOwn(connections[sourceNode][type], inputIndex)) {
					continue;
				}

				for (const connectionInfo of connections[sourceNode][type][inputIndex] ?? []) {
					if (!Object.hasOwn(returnConnection, connectionInfo.node)) {
						returnConnection[connectionInfo.node] = {};
					}
					if (!Object.hasOwn(returnConnection[connectionInfo.node], connectionInfo.type)) {
						returnConnection[connectionInfo.node][connectionInfo.type] = [];
					}

					const maxIndex = returnConnection[connectionInfo.node][connectionInfo.type].length - 1;
					for (let j = maxIndex; j < connectionInfo.index; j++) {
						returnConnection[connectionInfo.node][connectionInfo.type].push([]);
					}

					returnConnection[connectionInfo.node][connectionInfo.type][connectionInfo.index]?.push({
						node: sourceNode,
						type,
						index: parseInt(inputIndex, 10),
					});
				}
			}
		}
	}

	return returnConnection;
}
