import { vi } from "vitest";

vi.mock("@elizaos/core", () => {
	const logger = {
		debug: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
		log: vi.fn(),
		success: vi.fn(),
		warn: vi.fn(),
	};

	const TRUNCATION_SUFFIX = "...[truncated]";
	const DEFAULT_FIELD_CAP_BYTES = 64 * 1024;

	const encodeTrajectoryFieldValue = (value: unknown): string => {
		if (typeof value === "string") return value;
		if (value === undefined || value === null) return "";
		try {
			return JSON.stringify(value);
		} catch {
			return String(value);
		}
	};

	const applyTrajectoryFieldCap = (
		field: "args" | "result",
		value: string,
		capBytes: number,
	) => {
		const byteLength = Buffer.byteLength(value, "utf8");
		if (byteLength <= capBytes) {
			return { value, marker: null as null | object };
		}
		const suffixBytes = Buffer.byteLength(TRUNCATION_SUFFIX, "utf8");
		const sliceBudget = Math.max(0, capBytes - suffixBytes);
		let preview = Buffer.from(value, "utf8")
			.subarray(0, sliceBudget)
			.toString("utf8");
		while (
			Buffer.byteLength(preview, "utf8") + suffixBytes > capBytes &&
			preview.length > 0
		) {
			preview = preview.slice(0, -1);
		}
		return {
			value: `${preview}${TRUNCATION_SUFFIX}`,
			marker: { field, originalBytes: byteLength, capBytes },
		};
	};

	const captureSkillInvocationIO = (input: {
		args?: unknown;
		result?: unknown;
		capBytes?: number;
	}): { args?: string; result?: string; truncated?: unknown[] } => {
		const cap = input.capBytes ?? DEFAULT_FIELD_CAP_BYTES;
		const out: { args?: string; result?: string; truncated?: unknown[] } = {};
		const markers: unknown[] = [];
		if (input.args !== undefined) {
			const encoded = encodeTrajectoryFieldValue(input.args);
			const { value, marker } = applyTrajectoryFieldCap("args", encoded, cap);
			out.args = value;
			if (marker) markers.push(marker);
		}
		if (input.result !== undefined) {
			const encoded = encodeTrajectoryFieldValue(input.result);
			const { value, marker } = applyTrajectoryFieldCap("result", encoded, cap);
			out.result = value;
			if (marker) markers.push(marker);
		}
		if (markers.length > 0) out.truncated = markers;
		return out;
	};

	return {
		annotateActiveTrajectoryStep: vi.fn(async () => true),
		getTrajectoryContext: vi.fn(() => undefined),
		captureSkillInvocationIO,
		logger,
	};
});
