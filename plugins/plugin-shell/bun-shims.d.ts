declare module "bun" {
	export function build(options: {
		entrypoints: string[];
		outdir: string;
		target?: string;
		format?: string;
		sourcemap?: string;
		minify?: boolean;
		external?: string[];
	}): Promise<unknown>;
}

interface ImportMeta {
	readonly dir: string;
}

declare const Bun: {
	spawn(
		cmd: string[],
		options?: {
			cwd?: string;
			stdio?: [string, string, string];
		},
	): {
		exited: Promise<number>;
	};
};
