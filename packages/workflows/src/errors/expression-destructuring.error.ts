import { ExpressionError } from './expression.error.js';

export class ExpressionDestructuringError extends ExpressionError {
	constructor(property: string) {
		super(`Cannot destructure "${property}" due to security concerns`);
	}
}
