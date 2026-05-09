import { ExpressionError } from './expression.error.js';

export class ExpressionClassExtensionError extends ExpressionError {
	constructor(baseClass: string) {
		super(`Cannot extend "${baseClass}" due to security concerns`);
	}
}
