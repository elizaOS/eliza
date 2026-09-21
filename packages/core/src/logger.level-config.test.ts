/**
 * LOG_LEVEL must be validated once at module load and honoured by every sink
 * (#31959): unknown names warn on stderr and fall back to the default instead
 * of silently meaning "info", the `warning` alias resolves to warn, `verbose`
 * reaches the console as well as the in-memory buffer, and `silent`/`off`/
 * `none` disable the buffer, the console, and the LOG_FILE sinks (output.log,
 * prompts.log, chat.log) alike, with a positive control under `info` proving
 * those same calls do write. Deterministic: the real module is re-imported
 * per case with the environment set, console methods are spied, file sinks
 * land in a per-case temp directory, and the global Adze setup is re-seated
 * afterwards.
 */
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type LoggerModule = typeof import("./logger");

const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug"] as const;

interface ConsoleSink {
	calls: () => number;
	/** Every console argument of every call, flattened to one string per call. */
	lines: () => string[];
}

async function withLogEnv(
	env: { LOG_LEVEL: string | undefined; LOG_FILE?: string },
	run: (fresh: LoggerModule, console: ConsoleSink) => Promise<void> | void,
): Promise<void> {
	const previousLevel = process.env.LOG_LEVEL;
	const previousFile = process.env.LOG_FILE;
	if (env.LOG_LEVEL === undefined) delete process.env.LOG_LEVEL;
	else process.env.LOG_LEVEL = env.LOG_LEVEL;
	if (env.LOG_FILE === undefined) delete process.env.LOG_FILE;
	else process.env.LOG_FILE = env.LOG_FILE;
	const spies = CONSOLE_METHODS.map((method) =>
		vi.spyOn(console, method).mockImplementation(() => undefined),
	);
	const sink: ConsoleSink = {
		calls: () => spies.reduce((total, spy) => total + spy.mock.calls.length, 0),
		lines: () =>
			spies.flatMap((spy) =>
				spy.mock.calls.map((args) => args.map(String).join(" ")),
			),
	};
	try {
		vi.resetModules();
		const fresh = await import("./logger");
		await run(fresh, sink);
	} finally {
		for (const spy of spies) spy.mockRestore();
		if (previousLevel === undefined) delete process.env.LOG_LEVEL;
		else process.env.LOG_LEVEL = previousLevel;
		if (previousFile === undefined) delete process.env.LOG_FILE;
		else process.env.LOG_FILE = previousFile;
		vi.resetModules();
		await import("./logger");
	}
}

async function withLogLevel(
	value: string | undefined,
	run: (fresh: LoggerModule, console: ConsoleSink) => Promise<void> | void,
): Promise<void> {
	await withLogEnv({ LOG_LEVEL: value }, run);
}

const FILE_SINKS = ["output.log", "prompts.log", "chat.log"] as const;

/** Bytes in a sink file; a sink that was never opened counts as empty. */
function fileSize(path: string): number {
	return existsSync(path) ? statSync(path).size : 0;
}

/** Drive every sink once; the markers are what the assertions look for. */
function exerciseEverySink(fresh: LoggerModule): { promptSlug: string } {
	fresh.logger.clear();
	fresh.logger.info("level-config-info");
	fresh.logger.warn("level-config-warn");
	fresh.logger.error("level-config-error");
	const promptSlug = fresh.logPrompt("TEXT_LARGE", "level-config-prompt", {
		agentName: "level-config-agent",
	});
	fresh.logResponse("TEXT_LARGE", "level-config-response", { promptSlug });
	fresh.logChatIn({
		agentName: "level-config-agent",
		agentId: "agent-0000",
		roomId: "room-0000",
		messageId: "msg-0000",
		text: "level-config-chat-in",
	});
	fresh.logChatOut({
		agentName: "level-config-agent",
		agentId: "agent-0000",
		roomId: "room-0000",
		action: "REPLY",
		text: "level-config-chat-out",
	});
	return { promptSlug };
}

describe("LOG_LEVEL configuration", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it.each(["silent", "off", "none", "SILENT"])(
		"LOG_LEVEL=%s emits nothing to the buffer or the console",
		async (value) => {
			await withLogLevel(value, (fresh, sink) => {
				fresh.logger.clear();
				fresh.logger.info("level-config-info");
				fresh.logger.warn("level-config-warn");
				fresh.logger.error("level-config-error");
				expect(fresh.recentLogs()).not.toContain("level-config");
				expect(sink.calls()).toBe(0);
			});
		},
	);

	it("LOG_LEVEL=silent with LOG_FILE keeps every file sink closed", async () => {
		const dir = mkdtempSync(join(tmpdir(), "eliza-logger-silent-"));
		try {
			await withLogEnv(
				{ LOG_LEVEL: "silent", LOG_FILE: join(dir, "output.log") },
				(fresh, sink) => {
					const { promptSlug } = exerciseEverySink(fresh);
					expect(promptSlug).toBe("");
					expect(fresh.recentLogs()).not.toContain("level-config");
					expect(sink.calls()).toBe(0);
					for (const name of FILE_SINKS) {
						expect(fileSize(join(dir, name)), name).toBe(0);
					}
				},
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("LOG_LEVEL=info with LOG_FILE writes every file sink (positive control)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "eliza-logger-info-"));
		try {
			await withLogEnv(
				{ LOG_LEVEL: "info", LOG_FILE: join(dir, "output.log") },
				(fresh) => {
					const { promptSlug } = exerciseEverySink(fresh);
					expect(promptSlug).toBe("#0001/level-config-agent/TEXT_LARGE");
					const output = readFileSync(join(dir, "output.log"), "utf8");
					expect(output).toContain("level-config-info");
					expect(output).toContain("level-config-warn");
					expect(output).toContain("level-config-error");
					const prompts = readFileSync(join(dir, "prompts.log"), "utf8");
					expect(prompts).toContain(`${promptSlug}  PROMPT: TEXT_LARGE`);
					expect(prompts).toContain("level-config-prompt");
					expect(prompts).toContain(`${promptSlug}  RESPONSE: TEXT_LARGE`);
					expect(prompts).toContain("level-config-response");
					const chat = readFileSync(join(dir, "chat.log"), "utf8");
					expect(chat).toContain("[CHAT:IN]  #agent:level-config-agent");
					expect(chat).toContain("level-config-chat-in");
					expect(chat).toContain("[CHAT:OUT] #agent:level-config-agent");
					expect(chat).toContain("level-config-chat-out");
				},
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("treats the common misspelling warning as warn", async () => {
		await withLogLevel("warning", (fresh, sink) => {
			fresh.logger.clear();
			fresh.logger.info("level-config-info");
			fresh.logger.warn("level-config-warn");
			expect(fresh.recentLogs()).not.toContain("level-config-info");
			expect(fresh.recentLogs()).toContain("level-config-warn");
			const lines = sink.lines();
			expect(lines.some((line) => line.includes("level-config-info"))).toBe(
				false,
			);
			expect(lines.some((line) => line.includes("level-config-warn"))).toBe(
				true,
			);
		});
	});

	it("warns once on stderr for an unknown level and keeps the default", async () => {
		const stderr = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		await withLogLevel("verbosee", (fresh, sink) => {
			const warnings = stderr.mock.calls
				.map(([chunk]) => String(chunk))
				.filter((line) => line.includes("unknown LOG_LEVEL"));
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toContain('"verbosee"');
			fresh.logger.clear();
			fresh.logger.debug("level-config-debug");
			fresh.logger.info("level-config-info");
			expect(fresh.recentLogs()).not.toContain("level-config-debug");
			expect(fresh.recentLogs()).toContain("level-config-info");
			const lines = sink.lines();
			expect(lines.some((line) => line.includes("level-config-debug"))).toBe(
				false,
			);
			expect(lines.some((line) => line.includes("level-config-info"))).toBe(
				true,
			);
		});
		stderr.mockRestore();
	});

	it("delivers debug lines to both sinks under LOG_LEVEL=verbose", async () => {
		await withLogLevel("verbose", (fresh, sink) => {
			fresh.logger.clear();
			fresh.logger.debug("level-config-debug");
			expect(fresh.recentLogs()).toContain("level-config-debug");
			expect(
				sink.lines().some((line) => line.includes("level-config-debug")),
			).toBe(true);
		});
	});

	it("keeps error output under LOG_LEVEL=error", async () => {
		await withLogLevel("error", (fresh, sink) => {
			fresh.logger.clear();
			fresh.logger.info("level-config-info");
			expect(sink.calls()).toBe(0);
			fresh.logger.error("level-config-error");
			expect(fresh.recentLogs()).toContain("level-config-error");
			expect(
				sink.lines().some((line) => line.includes("level-config-error")),
			).toBe(true);
		});
	});
});
