/**
 * Shared boolean env-flag parser for the Electrobun desktop shell.
 *
 * Every operator-facing desktop switch (`ELIZA_DESKTOP_TRAY*`,
 * `ELIZA_DESKTOP_BOTTOM_BAR`, `ELIZA_DESKTOP_CLOUD_ONLY`,
 * `ELIZA_DESKTOP_TEST_BRIDGE_ENABLED`, ...) accepts the same vocabulary as
 * core's `parseBooleanValue`: `1/true/yes/on` enable, `0/false/no/off`
 * disable (case-insensitive, surrounding whitespace ignored). Unset or empty
 * values resolve to the caller's default. Unrecognized values also resolve to
 * the default, but are reported with a warning so a typo in a kill switch is
 * visible instead of silently ignored.
 */
import { logger } from "./logger";

const TRUTHY_VALUES: ReadonlySet<string> = new Set(["1", "true", "yes", "on"]);
const FALSY_VALUES: ReadonlySet<string> = new Set(["0", "false", "no", "off"]);

const warnedUnrecognized = new Set<string>();

/**
 * Parse a desktop env flag. Returns `true`/`false` for recognized values and
 * `undefined` when the value is unset, empty, or unrecognized (the latter is
 * logged once per name/value pair).
 */
export function parseDesktopEnvFlag(
	name: string,
	value: string | undefined,
): boolean | undefined {
	if (value === undefined) return undefined;
	const normalized = value.trim().toLowerCase();
	if (!normalized) return undefined;
	if (TRUTHY_VALUES.has(normalized)) return true;
	if (FALSY_VALUES.has(normalized)) return false;
	const warnKey = `${name}=${normalized}`;
	if (!warnedUnrecognized.has(warnKey)) {
		warnedUnrecognized.add(warnKey);
		logger.warn(
			`[desktop-env] Unrecognized value ${JSON.stringify(value)} for ${name}; expected 1/true/yes/on or 0/false/no/off. Using the default.`,
		);
	}
	return undefined;
}

/** Read `env[name]` as a boolean flag, falling back to `defaultValue`. */
export function readDesktopEnvFlag(
	env: Record<string, string | undefined>,
	name: string,
	defaultValue: boolean,
): boolean {
	return parseDesktopEnvFlag(name, env[name]) ?? defaultValue;
}
