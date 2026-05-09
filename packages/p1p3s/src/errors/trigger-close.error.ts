import type { INode } from '../interfaces.js';
import { ApplicationError, type ErrorLevel } from '../workflows-errors/index.js';

interface TriggerCloseErrorOptions extends ErrorOptions {
	level: ErrorLevel;
}

export class TriggerCloseError extends ApplicationError {
	constructor(
		readonly node: INode,
		{ cause, level }: TriggerCloseErrorOptions
	) {
		super('Trigger Close Failed', { cause, extra: { nodeName: node.name } });
		this.level = level;
	}
}
