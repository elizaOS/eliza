import type { NativeDoc } from '../extensions/extensions.js';
import { arrayMethods } from './array.methods.js';
import { booleanMethods } from './boolean.methods.js';
import { numberMethods } from './number.methods.js';
import { objectMethods } from './object.methods.js';
import { stringMethods } from './string.methods.js';

const NATIVE_METHODS: NativeDoc[] = [
	stringMethods,
	arrayMethods,
	numberMethods,
	objectMethods,
	booleanMethods,
];

export { NATIVE_METHODS as NativeMethods };
