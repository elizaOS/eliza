// Smoke test: verifies the public type surface of @elizaos/workflows.
//
// This package is intentionally types-only. The plugin-workflow consumer
// imports exactly five types: INode, INodeCredentialsDetails, INodeProperties,
// INodeTypeDescription, IWorkflowSettings. This test asserts each can be
// constructed with a minimal value at compile time.

import { describe, expect, it } from 'bun:test';
import type {
	INode,
	INodeCredentialsDetails,
	INodeProperties,
	INodeTypeDescription,
	IWorkflowSettings,
} from '../src/index.ts';

describe('@elizaos/workflows public type surface', () => {
	it('INode satisfies a minimal node value', () => {
		const node = {
			id: 'node-1',
			name: 'Manual Trigger',
			typeVersion: 1,
			type: 'workflows-nodes-base.manualTrigger',
			position: [0, 0] as [number, number],
			parameters: {},
		} satisfies INode;
		expect(node.id).toBe('node-1');
	});

	it('INodeCredentialsDetails satisfies a minimal credential reference', () => {
		const cred = { id: 'cred-1', name: 'My Credential' } satisfies INodeCredentialsDetails;
		expect(cred.name).toBe('My Credential');
	});

	it('INodeProperties satisfies a minimal property descriptor', () => {
		const prop = {
			displayName: 'URL',
			name: 'url',
			type: 'string',
			default: '',
		} satisfies INodeProperties;
		expect(prop.name).toBe('url');
	});

	it('INodeTypeDescription satisfies a minimal node type description', () => {
		const desc = {
			displayName: 'Manual Trigger',
			name: 'manualTrigger',
			group: ['trigger'],
			description: 'Run the workflow manually',
			version: 1,
			defaults: { name: 'Manual Trigger' },
			inputs: [],
			outputs: ['main'],
			properties: [],
		} satisfies INodeTypeDescription;
		expect(desc.name).toBe('manualTrigger');
	});

	it('IWorkflowSettings satisfies a minimal settings value', () => {
		const settings = {
			executionOrder: 'v1',
			saveManualExecutions: true,
		} satisfies IWorkflowSettings;
		expect(settings.executionOrder).toBe('v1');
	});

	it('exports exactly the documented top-level types', async () => {
		// Index re-exports types only; runtime exports should be just the
		// `NodeConnectionTypes` const object (used as a value by some consumers).
		const mod = await import('../src/index.ts');
		const runtimeExports = Object.keys(mod).sort();
		expect(runtimeExports).toEqual(['NodeConnectionTypes']);
	});
});
