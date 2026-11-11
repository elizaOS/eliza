import { expect, test } from "vitest";
import { formatByteSize } from "../src/utils/format-bytes";

test("formatByteSize clamps out-of-range precision instead of throwing", () => {
	expect(formatByteSize(1500, { precision: 101 })).toBe(
		formatByteSize(1500, { precision: 100 }),
	);
	expect(formatByteSize(1500, { precision: -1 })).toBe(
		formatByteSize(1500, { precision: 0 }),
	);
	expect(formatByteSize(1500, { kbPrecision: 200 })).toBe(
		formatByteSize(1500, { kbPrecision: 100 }),
	);
	expect(formatByteSize(1500, { precision: Number.POSITIVE_INFINITY })).toBe(
		formatByteSize(1500, { precision: 100 }),
	);
});

test("formatByteSize keeps its existing formatting", () => {
	expect(formatByteSize(1500)).toBe("1.5 KB");
	expect(formatByteSize(1024 ** 2 - 1)).toBe("1.0 MB");
	expect(formatByteSize(1023)).toBe("1023 B");
	expect(formatByteSize(0)).toBe("0 B");
	expect(formatByteSize(null)).toBe("unknown");
	expect(formatByteSize(-1)).toBe("unknown");
});
