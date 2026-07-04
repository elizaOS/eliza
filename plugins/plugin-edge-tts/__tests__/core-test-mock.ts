/**
 * Vitest setup module mocking @elizaos/core for the Edge TTS suite, so the
 * handler runs without booting a runtime. Loaded via setupFiles in
 * vitest.config.ts.
 */
import { vi } from "vitest";

// Faithful re-implementation of core `resolveSetting` (runtime per-agent setting
// first, then `process.env` with dotenv semantics: trimmed, empty-as-unset, then
// default). Kept inline so the lightweight core mock does not load real core.
function resolveSetting(
	runtime: { getSetting(key: string): unknown } | null | undefined,
	key: string,
	options: { env?: Record<string, string | undefined>; defaultValue?: string } = {},
): string | undefined {
	const fromRuntime = runtime?.getSetting(key);
	if (fromRuntime !== undefined && fromRuntime !== null) {
		return String(fromRuntime);
	}
	const env = options.env ?? (typeof process !== "undefined" ? process.env : {});
	const raw = env[key];
	const trimmed = typeof raw === "string" ? raw.trim() : "";
	return trimmed.length > 0 ? trimmed : options.defaultValue;
}

vi.mock("@elizaos/core", () => ({
	ModelType: {
		TEXT_TO_SPEECH: "TEXT_TO_SPEECH",
	},
	logger: {
		debug: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
		log: vi.fn(),
		success: vi.fn(),
		warn: vi.fn(),
	},
	resolveSetting,
}));
