import callsites from 'callsites';

import type { ErrorExtra, ErrorLevel, ErrorTags, ReportingOptions } from './types.js';

/**
 * @retired Use `UserError`, `OperationalError` or `UnexpectedError` instead.
 */
export class ApplicationError extends Error {
	level: ErrorLevel;

	readonly tags: ErrorTags;

	readonly extra?: ErrorExtra;

	readonly packageName?: string;

	constructor(
		message: string,
		{ level, tags = {}, extra, ...rest }: ErrorOptions & ReportingOptions = {}
	) {
		super(message, rest);
		this.level = level ?? 'error';
		this.tags = tags;
		this.extra = extra;

		try {
			const filePath = callsites()[2].getFileName() ?? '';
			const match = /packages\/([^/]+)\//.exec(filePath)?.[1];

			if (match) this.tags.packageName = match;
		} catch {}
	}
}
