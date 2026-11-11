/**
 * Derives the log-line prefix (once, cached) from the runtime process's argv/cwd/
 * env so structured log messages carry a consistent `[…]` tag. Reads a globalThis
 * process shim, so it is safe in non-Node hosts where `process` is absent.
 */
let cachedPrefix: string | null = null;

type RuntimeProcess = {
	argv?: string[];
	cwd?: () => string;
	env?: Record<string, string | undefined>;
};

function getRuntimeProcess(): RuntimeProcess | undefined {
	const candidate = (globalThis as { process?: RuntimeProcess }).process;
	return candidate && typeof candidate === "object" ? candidate : undefined;
}

/**
 * A log prefix is one bracketed token on one line. The name comes from the
 * environment or argv, so strip the characters that would break that shape:
 * newlines and line/paragraph separators (which would split one log call
 * across lines), brackets (which would forge a second tag), and control
 * characters (which would ride an escape sequence into the logs).
 */
function sanitizePrefixName(name: string): string {
	return name.replace(/[\p{Cc}\u2028\u2029[\]]/gu, "");
}

function prefixFromPackageName(name: string): string {
	let packageName = name;
	if (packageName.startsWith("@"))
		packageName = packageName.split("/")[1] ?? packageName;
	if (packageName === "elizaos" || packageName.includes("eliza")) {
		return "[eliza]";
	}
	return `[${packageName}]`;
}

export function getLogPrefix(): string {
	if (cachedPrefix !== null) {
		return cachedPrefix;
	}

	const runtimeProcess = getRuntimeProcess();

	const appCliName = sanitizePrefixName(
		runtimeProcess?.env?.APP_CLI_NAME?.trim() ?? "",
	);
	if (appCliName) {
		cachedPrefix = `[${appCliName}]`;
		return cachedPrefix;
	}

	const packageName = sanitizePrefixName(
		runtimeProcess?.env?.npm_package_name?.trim() ?? "",
	);
	if (packageName) {
		cachedPrefix = prefixFromPackageName(packageName);
		return cachedPrefix;
	}

	const nameArgMatch = runtimeProcess?.argv?.find((a) =>
		a.startsWith("--name="),
	);
	if (nameArgMatch) {
		const name = sanitizePrefixName(
			nameArgMatch.slice("--name=".length).trim(),
		);
		if (name) {
			cachedPrefix = `[${name}]`;
			return cachedPrefix;
		}
	}

	const cwd =
		typeof runtimeProcess?.cwd === "function" ? runtimeProcess.cwd() : "";
	if (cwd.includes("eliza-workspace") || cwd.includes("eliza")) {
		cachedPrefix = "[eliza]";
		return cachedPrefix;
	}

	cachedPrefix = "[eliza]";
	return cachedPrefix;
}
