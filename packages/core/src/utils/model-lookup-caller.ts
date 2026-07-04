/**
 * Attributes a `runtime.useModel()` call to the plugin or package that triggered
 * it by parsing the captured stack trace down to package names, skipping internal
 * runtime frames and unrelated third-party `node_modules` dependencies while
 * still crediting installed `@elizaos/*` packages. Feeds model-lookup debug
 * diagnostics.
 */
export type ModelLookupCallerTrace = {
	/** Outermost plugin or package that triggered the lookup. */
	caller?: string;
	/** Call chain as plugin/package names only, outermost first. */
	callerStack: string[];
};

const INTERNAL_FRAME_RE =
	/model-lookup-caller\.(?:ts|js)(?::|$)|(?:^|[/\\])runtime\.(?:ts|js)|(?:^|[/\\])getModel|(?:^|[/\\])useModel|resolveModelRegistration|node:internal|@vitest\/|vitest\/|\/bun:/;

const STACK_FRAME_WITH_FN_RE = /^(?:async )?(.+?) \((.+?):(\d+):(\d+)\)$/;
const STACK_FRAME_FILE_ONLY_RE = /^(.+?):(\d+):(\d+)$/;

function parseFrameOrigin(line: string): string | null {
	const trimmed = line.trim();
	if (!trimmed.startsWith("at ")) return null;

	const rest = trimmed.slice(3);
	const withFn = STACK_FRAME_WITH_FN_RE.exec(rest);
	const file = withFn?.[2] ?? STACK_FRAME_FILE_ONLY_RE.exec(rest)?.[1];
	if (!file) return null;

	let framePath = file.trim();
	if (framePath.startsWith("file://")) {
		framePath = framePath.slice("file://".length);
	}
	framePath = framePath.replace(/\\/g, "/");

	if (INTERNAL_FRAME_RE.test(framePath)) return null;
	if (withFn?.[1] && INTERNAL_FRAME_RE.test(withFn[1])) return null;

	// Installed elizaOS packages live under node_modules in package-mode
	// deployments, so classify them before dropping unrelated dependencies.
	const installedPackageMatch =
		/(?:^|\/)node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?@elizaos\/([^/]+)\//.exec(
			framePath,
		);
	if (installedPackageMatch?.[1]) return installedPackageMatch[1];

	if (/(?:^|\/)node_modules\//.test(framePath)) return null;

	const pluginMatch = /(?:^|\/)plugins\/([^/]+)\//.exec(framePath);
	if (pluginMatch?.[1]) return pluginMatch[1];

	const packageMatch = /(?:^|\/)packages\/([^/]+)\//.exec(framePath);
	if (packageMatch?.[1]) return packageMatch[1];

	return null;
}

function dedupeConsecutive(names: string[]): string[] {
	const out: string[] = [];
	for (const name of names) {
		if (out[out.length - 1] === name) continue;
		out.push(name);
	}
	return out;
}

/**
 * Extract a trimmed caller trace from a stack captured for `runtime.useModel()`.
 * Returns plugin or package names only: no file paths or line numbers.
 */
export function captureModelLookupCallerFromStack(
	stack: string | undefined,
	maxFrames = 4,
): ModelLookupCallerTrace | undefined {
	if (!stack) return undefined;

	const origins: string[] = [];
	for (const line of stack.split("\n").slice(1)) {
		const origin = parseFrameOrigin(line);
		if (!origin) continue;
		origins.push(origin);
		if (origins.length >= maxFrames) break;
	}

	const callerStack = dedupeConsecutive(origins);
	if (callerStack.length === 0) return undefined;

	return {
		caller: callerStack[0],
		callerStack,
	};
}

/**
 * Capture a trimmed stack for `runtime.useModel()` calls.
 * Caller gates this behind debug logging because stack capture walks the hot
 * model path and should stay free when debug logs are disabled.
 */
export function captureModelLookupCaller(
	maxFrames = 4,
): ModelLookupCallerTrace | undefined {
	return captureModelLookupCallerFromStack(
		new Error("model lookup").stack,
		maxFrames,
	);
}
