import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { probeRuntimeApi } from "./api-client.ts";
import type { RuntimeLogBuffer } from "./log-buffer.ts";
import type {
	RuntimeHealthResult,
	RuntimeLogEntry,
	RuntimeLogStream,
	RuntimeManagerEvent,
	RuntimeStartParams,
	RuntimeState,
} from "./protocol.ts";

type RuntimeEventCallback = (event: RuntimeManagerEvent) => void;
type RuntimeChild = ReturnType<typeof Bun.spawn>;

type RuntimeManagerOptions = {
	cwd?: string;
	command?: string[];
	apiBase?: string;
	logBuffer: RuntimeLogBuffer;
	onEvent?: RuntimeEventCallback;
};

const DEFAULT_API_BASE = "http://127.0.0.1:31337";
const DEFAULT_COMMAND = ["bun", "run", "dev"] as const;

function firstNonEmpty(values: Array<string | undefined>): string | null {
	for (const value of values) {
		if (value !== undefined && value.trim().length > 0) return value.trim();
	}
	return null;
}

function findRepoRoot(start: string): string | null {
	let current = resolve(start);
	while (true) {
		if (
			existsSync(join(current, "package.json")) &&
			existsSync(join(current, "packages")) &&
			existsSync(join(current, "plugins"))
		) {
			return current;
		}
		const parent = dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

function defaultCwd(): string {
	const configured = firstNonEmpty([
		process.env.MILADY_REPO_DIR,
		process.env.ELIZA_REPO_DIR,
	]);
	if (configured !== null) return configured;
	const sourceDir = dirname(fileURLToPath(import.meta.url));
	const fromSource = findRepoRoot(sourceDir);
	if (fromSource !== null) return fromSource;
	const fromProcess = findRepoRoot(process.cwd());
	if (fromProcess !== null) return fromProcess;
	return process.cwd();
}

export function parseRuntimeCommand(command: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: "'" | '"' | null = null;
	let escaping = false;

	for (const character of command) {
		if (escaping) {
			current += character;
			escaping = false;
			continue;
		}
		if (character === "\\") {
			escaping = true;
			continue;
		}
		if (quote !== null) {
			if (character === quote) {
				quote = null;
			} else {
				current += character;
			}
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			continue;
		}
		if (/\s/.test(character)) {
			if (current.length > 0) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += character;
	}

	if (escaping) current += "\\";
	if (quote !== null) {
		throw new Error("ELIZA_RUNTIME_COMMAND contains an unterminated quote.");
	}
	if (current.length > 0) tokens.push(current);
	if (tokens.length === 0) {
		throw new Error("ELIZA_RUNTIME_COMMAND did not contain a command.");
	}
	return tokens;
}

function defaultCommand(): string[] {
	const configured = firstNonEmpty([process.env.ELIZA_RUNTIME_COMMAND]);
	if (configured !== null) return parseRuntimeCommand(configured);
	return [...DEFAULT_COMMAND];
}

function defaultApiBase(): string {
	const configured = firstNonEmpty([process.env.ELIZA_RUNTIME_API_BASE]);
	return configured === null ? DEFAULT_API_BASE : configured;
}

function normalizeCommand(command: string[] | string): string[] {
	const parsed = typeof command === "string" ? parseRuntimeCommand(command) : command;
	if (parsed.length === 0) throw new Error("Runtime command cannot be empty.");
	for (const token of parsed) {
		if (typeof token !== "string" || token.length === 0) {
			throw new Error("Runtime command tokens must be non-empty strings.");
		}
	}
	return [...parsed];
}

function now(): string {
	return new Date().toISOString();
}

function errorMessage(error: Error): string {
	return error.message.length > 0 ? error.message : error.name;
}

function wait(ms: number): Promise<void> {
	return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

export class ElizaRuntimeManager {
	private child: RuntimeChild | null = null;
	private state: RuntimeState;
	private readonly logBuffer: RuntimeLogBuffer;
	private readonly onEvent: RuntimeEventCallback;
	private cwd: string;
	private command: string[];
	private apiBase: string;

	constructor(options: RuntimeManagerOptions) {
		this.cwd = options.cwd ?? defaultCwd();
		this.command = options.command ? normalizeCommand(options.command) : defaultCommand();
		this.apiBase = options.apiBase ?? defaultApiBase();
		this.logBuffer = options.logBuffer;
		this.onEvent = options.onEvent ?? (() => undefined);
		this.state = {
			mode: "stopped",
			cwd: this.cwd,
			command: [...this.command],
			apiBase: this.apiBase,
			pid: null,
			startedAt: null,
			stoppedAt: null,
			error: null,
		};
	}

	async start(params?: RuntimeStartParams): Promise<RuntimeState> {
		if (this.state.mode === "running" || this.state.mode === "starting") {
			return this.status();
		}

		const cwd = params?.cwd ?? this.cwd;
		const command =
			params?.command === undefined
				? [...this.command]
				: normalizeCommand(params.command);
		const apiBase = params?.apiBase ?? this.apiBase;

		this.cwd = cwd;
		this.command = [...command];
		this.apiBase = apiBase;
		this.updateState({
			mode: "starting",
			cwd,
			command,
			apiBase,
			pid: null,
			startedAt: null,
			stoppedAt: null,
			error: null,
		});
		this.pushLog("system", `Starting runtime: ${command.join(" ")}`);

		try {
			const child = Bun.spawn(command, {
				cwd,
				env: process.env,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			this.child = child;
			void this.consumeStream(child.stdout, "stdout");
			void this.consumeStream(child.stderr, "stderr");
			void child.exited
				.then((exitCode) => this.handleExit(child, exitCode))
				.catch((error) => {
					const message =
						error instanceof Error ? errorMessage(error) : "Runtime exit failed";
					this.markError(message);
				});
			this.updateState({
				mode: "running",
				pid: child.pid,
				startedAt: now(),
				stoppedAt: null,
				error: null,
			});
			this.emit({ name: "runtime.started", payload: this.status() });
			void this.health()
				.then((result) => {
					this.pushLog(
						"system",
						result.ok
							? `Runtime health probe succeeded at ${result.path}`
							: `Runtime health probe failed: ${result.error}`,
					);
				})
				.catch((error) => {
					const message =
						error instanceof Error ? errorMessage(error) : "Runtime health probe failed";
					this.pushLog("system", `Runtime health probe failed: ${message}`);
				});
			return this.status();
		} catch (error) {
			const message =
				error instanceof Error ? errorMessage(error) : "Runtime start failed";
			this.markError(message);
			throw new Error(message);
		}
	}

	async stop(): Promise<RuntimeState> {
		const child = this.child;
		if (child === null) {
			this.updateState({
				mode: "stopped",
				pid: null,
				stoppedAt: now(),
				error: null,
			});
			this.emit({ name: "runtime.stopped", payload: this.status() });
			return this.status();
		}

		this.updateState({ mode: "stopping" });
		this.pushLog("system", "Stopping runtime");
		child.kill("SIGTERM");
		const exited = await this.waitForExit(child, 5000);
		if (!exited) {
			this.pushLog("system", "Runtime did not stop after SIGTERM; sending SIGKILL");
			child.kill("SIGKILL");
			await this.waitForExit(child, 1000);
		}
		if (this.child !== child) return this.status();
		if (this.child === child) this.child = null;
		this.updateState({
			mode: "stopped",
			pid: null,
			stoppedAt: now(),
			error: null,
		});
		this.emit({ name: "runtime.stopped", payload: this.status() });
		return this.status();
	}

	async restart(params?: RuntimeStartParams): Promise<RuntimeState> {
		await this.stop();
		return this.start(params);
	}

	status(): RuntimeState {
		return {
			...this.state,
			command: [...this.state.command],
		};
	}

	async health(): Promise<RuntimeHealthResult> {
		const apiBase = this.state.apiBase === null ? this.apiBase : this.state.apiBase;
		return probeRuntimeApi(apiBase);
	}

	logsTail(limit?: number): RuntimeLogEntry[] {
		return this.logBuffer.tail(limit);
	}

	private updateState(next: Partial<RuntimeState>): void {
		this.state = {
			...this.state,
			...next,
			command: next.command ? [...next.command] : [...this.state.command],
		};
		this.emit({ name: "runtime.statusChanged", payload: this.status() });
	}

	private pushLog(stream: RuntimeLogStream, line: string): void {
		const entry = this.logBuffer.push(stream, line);
		this.emit({ name: "runtime.log", payload: entry });
	}

	private emit(event: RuntimeManagerEvent): void {
		this.onEvent(event);
	}

	private async consumeStream(
		stream: ReadableStream<Uint8Array> | null | undefined,
		logStream: RuntimeLogStream,
	): Promise<void> {
		if (stream === null || stream === undefined) return;
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		let pending = "";
		try {
			while (true) {
				const read = await reader.read();
				if (read.done) break;
				pending += decoder.decode(read.value, { stream: true });
				const lines = pending.split(/\r?\n/);
				const last = lines.pop();
				pending = last === undefined ? "" : last;
				for (const line of lines) {
					this.pushLog(logStream, line);
				}
			}
			pending += decoder.decode();
			if (pending.length > 0) this.pushLog(logStream, pending);
		} catch (error) {
			const message =
				error instanceof Error ? errorMessage(error) : "Runtime log stream failed";
			this.pushLog("system", `Failed to capture ${logStream}: ${message}`);
		} finally {
			reader.releaseLock();
		}
	}

	private async waitForExit(child: RuntimeChild, timeoutMs: number): Promise<boolean> {
		let didTimeout = false;
		await Promise.race([
			child.exited.then(() => undefined),
			wait(timeoutMs).then(() => {
				didTimeout = true;
			}),
		]);
		return !didTimeout;
	}

	private handleExit(child: RuntimeChild, exitCode: number): void {
		if (this.child !== child) return;
		this.child = null;
		const stoppedAt = now();
		if (this.state.mode === "stopping") {
			this.updateState({
				mode: "stopped",
				pid: null,
				stoppedAt,
				error: null,
			});
			this.emit({ name: "runtime.stopped", payload: this.status() });
			return;
		}
		if (exitCode === 0) {
			this.updateState({
				mode: "stopped",
				pid: null,
				stoppedAt,
				error: null,
			});
			this.emit({ name: "runtime.stopped", payload: this.status() });
			return;
		}
		this.markError(`Runtime exited unexpectedly with code ${exitCode}`);
	}

	private markError(message: string): void {
		this.updateState({
			mode: "error",
			pid: null,
			stoppedAt: now(),
			error: message,
		});
		this.pushLog("system", message);
		this.emit({ name: "runtime.error", payload: { message, state: this.status() } });
	}
}
