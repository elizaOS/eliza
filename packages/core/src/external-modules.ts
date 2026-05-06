declare module "fast-redact" {
	interface FastRedactOptions {
		paths: string[];
		censor?: string | ((value: unknown, path: string) => unknown);
		serialize?: boolean | ((value: unknown) => string);
		strict?: boolean;
		remove?: boolean;
	}
	function fastRedact(
		opts: FastRedactOptions,
	): (obj: Record<string, unknown>) => string | Record<string, unknown>;
	export = fastRedact;
}

declare module "markdown-it" {
	interface Token {
		type: string;
		tag: string;
		nesting: number;
		content: string;
		children: Token[] | null;
		markup: string;
		info: string;
		level: number;
		block: boolean;
		hidden: boolean;
		attrs: [string, string][] | null;
		map: [number, number] | null;
		meta: unknown;
	}
	class MarkdownIt {
		constructor(
			presetOrOptions?: string | Record<string, unknown>,
			options?: Record<string, unknown>,
		);
		parse(src: string, env?: object): Token[];
		render(src: string, env?: object): string;
		enable(rule: string | string[], ignoreInvalid?: boolean): this;
		disable(rule: string | string[], ignoreInvalid?: boolean): this;
	}
	export = MarkdownIt;
}
