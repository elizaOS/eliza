import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const LOG_LEVEL_KEY = "LOG_LEVEL";
const TTS_DEBUG_KEY = "ELIZA_TTS_DEBUG";

/**
 * The logger resolves `LOG_LEVEL` once, at import time, so each case sets
 * the environment first and then imports fresh modules.
 */
async function loadDebug() {
	const loggerModule = (await import("../src/logger.ts")) as {
		logger: {
			info: (...args: unknown[]) => void;
			warn: (...args: unknown[]) => void;
			error: (...args: unknown[]) => void;
			fatal: (...args: unknown[]) => void;
		};
	};
	const debugModule = (await import("../src/utils/tts-debug.ts")) as {
		ttsDebug: (phase: string) => void;
	};
	return { logger: loggerModule.logger, ttsDebug: debugModule.ttsDebug };
}

describe("ttsDebug LOG_LEVEL alias", () => {
	let savedLogLevel: string | undefined;
	let savedTtsDebug: string | undefined;

	beforeEach(() => {
		vi.resetModules();
		savedLogLevel = process.env[LOG_LEVEL_KEY];
		savedTtsDebug = process.env[TTS_DEBUG_KEY];
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (savedLogLevel === undefined) delete process.env[LOG_LEVEL_KEY];
		else process.env[LOG_LEVEL_KEY] = savedLogLevel;
		if (savedTtsDebug === undefined) delete process.env[TTS_DEBUG_KEY];
		else process.env[TTS_DEBUG_KEY] = savedTtsDebug;
		vi.resetModules();
	});

	it("emits at warn when LOG_LEVEL is the warning alias", async () => {
		process.env[LOG_LEVEL_KEY] = "warning";
		process.env[TTS_DEBUG_KEY] = "1";
		const { logger, ttsDebug } = await loadDebug();
		const warn = vi.spyOn(logger, "warn");
		const info = vi.spyOn(logger, "info");
		ttsDebug("server:local-tts:test");
		expect(warn).toHaveBeenCalled();
		expect(info).not.toHaveBeenCalled();
	});

	it("emits at warn for warn and at error for error", async () => {
		process.env[LOG_LEVEL_KEY] = "warn";
		process.env[TTS_DEBUG_KEY] = "1";
		const first = await loadDebug();
		vi.spyOn(first.logger, "warn");
		first.ttsDebug("server:local-tts:test");
		expect(first.logger.warn).toHaveBeenCalled();

		vi.resetModules();
		process.env[LOG_LEVEL_KEY] = "error";
		const second = await loadDebug();
		vi.spyOn(second.logger, "error");
		second.ttsDebug("server:local-tts:test");
		expect(second.logger.error).toHaveBeenCalled();
	});

	it("emits at info by default and stays silent without the flag", async () => {
		delete process.env[LOG_LEVEL_KEY];
		process.env[TTS_DEBUG_KEY] = "1";
		const first = await loadDebug();
		vi.spyOn(first.logger, "info");
		first.ttsDebug("server:local-tts:test");
		expect(first.logger.info).toHaveBeenCalled();

		vi.resetModules();
		delete process.env[TTS_DEBUG_KEY];
		const second = await loadDebug();
		const info = vi.spyOn(second.logger, "info");
		const warn = vi.spyOn(second.logger, "warn");
		second.ttsDebug("server:local-tts:test");
		expect(info).not.toHaveBeenCalled();
		expect(warn).not.toHaveBeenCalled();
	});
});
