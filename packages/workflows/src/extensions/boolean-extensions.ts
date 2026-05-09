// NOTE: This file is intentionally mirrored in @workflows/expression-runtime/src/extensions/
// for use inside the isolated VM. Changes here must be reflected there and vice versa.
// TODO: Eliminate the duplication. The blocker is that @workflows/expression-runtime is
// Vite-stubbed for browser builds (to exclude isolated-vm), which prevents workflows-workflow
// from importing these extension utilities directly from the runtime package. Fix by
// splitting @workflows/expression-runtime into a browser-safe extensions subpath (not stubbed)
// and a node-only VM entry (stubbed).
import type { Extension, ExtensionMap } from './extensions.js';

export function toBoolean(value: boolean) {
	return value;
}

export function toInt(value: boolean) {
	return value ? 1 : 0;
}

export function toDateTime() {
	return undefined;
}

const toFloat = toInt;
const toNumber: Extension = toInt.bind({});

toNumber.doc = {
	name: 'toNumber',
	description:
		'Converts <code>true</code> to <code>1</code> and <code>false</code> to <code>0</code>.',
	examples: [
		{ example: 'true.toNumber()', evaluated: '1' },
		{ example: 'false.toNumber()', evaluated: '0' },
	],
	section: 'cast',
	returnType: 'number',
	docURL:
		'https://docs.workflows.io/code/builtin/data-transformation-functions/booleans/#boolean-toNumber',
};

export const booleanExtensions: ExtensionMap = {
	typeName: 'Boolean',
	functions: {
		toBoolean,
		toInt,
		toFloat,
		toNumber,
		toDateTime,
	},
};
