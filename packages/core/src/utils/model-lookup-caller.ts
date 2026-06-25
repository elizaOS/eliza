/** Log levels at or below debug, matching @elizaos/logger filtering. */
const DEBUG_OR_TRACE_LEVELS = new Set(["trace", "verbose", "debug"]);

export type ModelLookupCallerTrace = {
	/** Outermost plugin or package that triggered the lookup. */
	caller?: string;
	/** Call chain as plugin/package names only, outermost first. */
	callerStack: string[];
};

const INTERNAL_FRAME_RE =
	/model-lookup-caller\.(?:ts|js)(?::|$)|(?:^|[/\\])runtime\.(?:ts|js)|(?:^|[/\\])getModel|(?:^|[/\\])useModel|resolveModelRegistration|node:internal|node_modules|@vitest\/|vitest\/|\/bun:/;

const STACK_FRAME_WITH_FN_RE = /^(?:async )?(.+?) \((.+?):(\d+):(\d+)\)$/;
const STACK_FRAME_FILE_ONLY_RE = /^(.+?):(\d+):(\d+)$/;

function isDebugOrTraceLogLevel(logLevel: string | undefined): boolean {
	return DEBUG_OR_TRACE_LEVELS.has(String(logLevel ?? "info").toLowerCase());
}

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
 * Capture a trimmed stack for `runtime.useModel()` calls.
 * Returns plugin or package names only: no file paths or line numbers.
 */
export function captureModelLookupCaller(
	logLevel: string | undefined,
	maxFrames = 4,
): ModelLookupCallerTrace | undefined {
	if (!isDebugOrTraceLogLevel(logLevel)) return undefined;

	const stack = new Error("model lookup").stack;
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
