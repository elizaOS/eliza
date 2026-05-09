import { ExpressionError } from './expression.error.js';

export class ExpressionWithStatementError extends ExpressionError {
	constructor() {
		super('Cannot use "with" statements due to security concerns');
	}
}
