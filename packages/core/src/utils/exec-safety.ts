/**
 * Guards config values that may be executed as commands, rejecting shell
 * metacharacters and validating bare-name/path-with-args shapes. Used by the zod
 * config schemas to keep injected/executable strings from smuggling shell syntax.
 */
const UNSAFE_CHARS = /[\0\r\n;&|`$<>"']/;
const BARE_NAME = /^[A-Za-z0-9._+-]+$/;

function hasPathArguments(value: string): boolean {
	// Any second whitespace-separated token is an argument, whatever it
	// looks like. The old check only caught bare-name and dash tokens, so
	// a path-like token ("/usr/bin/foo bar/baz") slipped through and the
	// caller below then accepted the whole string as a plain path.
	let index = 0;
	while (index < value.length && value[index]?.trim() !== "") index += 1;
	while (index < value.length && value[index]?.trim() === "") index += 1;
	return index < value.length;
}

function isLikelyPath(value: string): boolean {
	return (
		value.startsWith(".") ||
		value.startsWith("~") ||
		value.includes("/") ||
		value.includes("\\") ||
		/^[A-Za-z]:[\\/]/.test(value)
	);
}

export function isSafeExecutableValue(value: unknown): boolean {
	if (typeof value !== "string") return false;
	if (UNSAFE_CHARS.test(value)) return false;
	const trimmed = value.trim();
	if (!trimmed) return false;
	if (hasPathArguments(trimmed)) return false;
	if (trimmed.startsWith("-")) return false;
	if (isLikelyPath(trimmed)) return true;
	return BARE_NAME.test(trimmed);
}
