/**
 * Parses a duration string (`500ms`, `30s`, `5m`, `2h`, `1d`) to milliseconds,
 * with a configurable default unit for bare numbers. Throws on empty or
 * unparseable input. Used by config zod schemas and CLI flag parsing.
 */
const DURATION_UNIT_MS = {
	ms: 1,
	s: 1000,
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
} as const;

type DurationUnit = keyof typeof DURATION_UNIT_MS;

export type DurationMsParseOptions = {
	defaultUnit?: DurationUnit;
};

export function parseDurationMs(
	raw: string,
	opts?: DurationMsParseOptions,
): number {
	if (typeof raw !== "string") {
		throw new Error("invalid duration (empty)");
	}
	const trimmed = raw.trim().toLowerCase();
	if (!trimmed) {
		throw new Error("invalid duration (empty)");
	}

	const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(trimmed);
	if (!m) {
		throw new Error(`invalid duration: ${raw}`);
	}

	const value = Number(m[1]);
	if (!Number.isFinite(value) || value < 0) {
		throw new Error(`invalid duration: ${raw}`);
	}

	const unit = (m[2] as DurationUnit | undefined) ?? opts?.defaultUnit ?? "ms";
	const milliseconds = value * DURATION_UNIT_MS[unit];
	if (
		!Number.isFinite(milliseconds) ||
		!Number.isSafeInteger(Math.round(milliseconds))
	) {
		throw new Error(`invalid duration: ${raw}`);
	}
	return Math.round(milliseconds);
}
