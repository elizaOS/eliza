/**
 * Vitest setup file that stubs @elizaos/core with a deterministic in-memory
 * double — no-op trajectory hooks, a byte-capped `captureSkillInvocationIO`,
 * and a minimal Service base class — so unit tests run without the full runtime.
 */

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

	// Faithful double of core's security-envelope unwrap (incoming-message-security):
	// returns the payload between the untrusted-content markers for messages
	// stamped externalContentWrapped, raw trimmed text otherwise.
	const EXTERNAL_CONTENT_START = "<<<EXTERNAL_UNTRUSTED_CONTENT>>>";
	const EXTERNAL_CONTENT_END = "<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>";
	const unwrapUserMessageText = (message: {
		content?: { text?: unknown; metadata?: unknown };
	}): string => {
		const text =
			typeof message?.content?.text === "string" ? message.content.text : "";
		const metadata = message?.content?.metadata as
			| { externalContentWrapped?: unknown }
			| undefined;
		if (metadata?.externalContentWrapped === true) {
			const start = text.indexOf(EXTERNAL_CONTENT_START);
			if (start >= 0) {
				const payloadStart = start + EXTERNAL_CONTENT_START.length;
				const end = text.indexOf(EXTERNAL_CONTENT_END, payloadStart);
				if (end >= 0) {
					const inner = text.slice(payloadStart, end);
					const separatorIndex = inner.indexOf("\n---\n");
					return (
						separatorIndex >= 0 ? inner.slice(separatorIndex + 5) : inner
					).trim();
				}
			}
		}
		return text.trim();
	};

	return {
		annotateActiveTrajectoryStep: vi.fn(async () => true),
		// Faithful double of core's structured error (errors.ts): preserves the
		// code/context/severity fields tests assert on.
		ElizaError: class ElizaError extends Error {
			readonly code: string;
			readonly context?: Record<string, unknown>;
			readonly severity?: string;
			constructor(
				message: string,
				options: {
					code: string;
					cause?: unknown;
					context?: Record<string, unknown>;
					severity?: string;
				},
			) {
				super(
					message,
					options.cause !== undefined ? { cause: options.cause } : undefined,
				);
				this.name = "ElizaError";
				this.code = options.code;
				this.context = options.context;
				this.severity = options.severity;
			}
		},
		// Confirmation double: tests exercising confirm-gated paths get an
		// immediate "confirmed" so handlers run to completion in one call.
		requireConfirmation: vi.fn(async () => ({ status: "confirmed" })),
		getTrajectoryContext: vi.fn(() => undefined),
		captureSkillInvocationIO,
		promoteSubactionsToActions: (action: unknown) => [action],
		unwrapUserMessageText,
		Service: class {
			constructor(public runtime?: unknown) {}
			static serviceType = "mock-service";
			capabilityDescription = "mock service";
			static async start() {
				return new this();
			}
			async stop() {}
		},
		resolveStateDir: vi.fn(() => "/tmp/elizaos-test-state"),
		formatError: vi.fn((err: unknown) =>
			err instanceof Error ? err.message : String(err),
		),
		logger,
	};
});
