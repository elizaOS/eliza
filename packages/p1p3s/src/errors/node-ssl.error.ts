import { ExecutionBaseError } from './abstract/execution-base.error.js';

export class NodeSslError extends ExecutionBaseError {
	constructor(cause: Error) {
		super("SSL Issue: consider using the 'Ignore SSL issues' option", { cause });
	}
}
