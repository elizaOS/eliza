export type ErrorLevel = 'fatal' | 'error' | 'warning' | 'info';

export type ErrorTags = Record<
	string,
	string | number | boolean | bigint | symbol | null | undefined
>;

export type ErrorExtra = Record<string, unknown>;

export type ReportingOptions = {
	/** Whether the error should be reported to Sentry */
	shouldReport?: boolean;
	/** Whether the error log should be logged (default to true) */
	shouldBeLogged?: boolean;
	level?: ErrorLevel;
	tags?: ErrorTags;
	extra?: ErrorExtra;
	executionId?: string;
};
