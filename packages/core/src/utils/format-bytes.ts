/** Pure byte-count formatting for model diagnostics and UI labels. */
type ByteSizeFormatterOptions = {
	/**
	 * Fallback string for invalid or negative byte values.
	 */
	unknownLabel?: string;
	/**
	 * Uniform precision applied to all of KB / MB / GB / TB. Individual
	 * per-unit overrides below take precedence when supplied.
	 */
	precision?: number;
	/**
	 * Precision for KB / MB / GB / TB values.
	 */
	kbPrecision?: number;
	mbPrecision?: number;
	gbPrecision?: number;
	tbPrecision?: number;
};

export function formatByteSize(
	bytes: number | null | undefined,
	options: ByteSizeFormatterOptions = {},
): string {
	const {
		unknownLabel = "unknown",
		precision,
		kbPrecision = precision ?? 1,
		mbPrecision = precision ?? 1,
		gbPrecision = precision ?? 1,
		tbPrecision = precision ?? 1,
	} = options;

	if (bytes == null || !Number.isFinite(bytes) || bytes < 0) {
		return unknownLabel;
	}
	// Largest unit first. A value just under a boundary can ROUND across it —
	// 1024**2 - 1 bytes is 1023.999… KB, which toFixed renders as the impossible
	// "1024.0 KB" — so when the rounded magnitude reaches 1024 the value is
	// promoted to the next-larger unit instead (same defect class the duration
	// formatter below guards against). TB, having no larger unit, legitimately
	// displays magnitudes of 1024 and above.
	const units = [
		{ size: 1024 ** 4, suffix: "TB", precision: tbPrecision },
		{ size: 1024 ** 3, suffix: "GB", precision: gbPrecision },
		{ size: 1024 ** 2, suffix: "MB", precision: mbPrecision },
		{ size: 1024, suffix: "KB", precision: kbPrecision },
	];
	for (const [index, unit] of units.entries()) {
		if (bytes < unit.size) continue;
		const rounded = (bytes / unit.size).toFixed(unit.precision);
		const larger = units[index - 1];
		if (larger && Number(rounded) >= 1024) {
			return `${(bytes / larger.size).toFixed(larger.precision)} ${larger.suffix}`;
		}
		return `${rounded} ${unit.suffix}`;
	}
	return `${bytes} B`;
}
