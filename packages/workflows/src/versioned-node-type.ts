import type { INodeType, INodeTypeBaseDescription, IVersionedNodeType } from './interfaces.js';

export class VersionedNodeType implements IVersionedNodeType {
	currentVersion: number;

	nodeVersions: IVersionedNodeType['nodeVersions'];

	description: INodeTypeBaseDescription;

	constructor(
		nodeVersions: IVersionedNodeType['nodeVersions'],
		description: INodeTypeBaseDescription
	) {
		this.nodeVersions = nodeVersions;
		this.currentVersion = description.defaultVersion ?? this.getLatestVersion();
		this.description = description;
	}

	getLatestVersion() {
		return Math.max(...Object.keys(this.nodeVersions).map(Number));
	}

	getNodeType(version?: number): INodeType {
		if (version) {
			return this.nodeVersions[version];
		} else {
			return this.nodeVersions[this.currentVersion];
		}
	}
}
