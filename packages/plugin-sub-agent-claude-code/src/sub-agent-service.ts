/**
 * ClaudeCodeSubAgentService — spawns `claude` CLI as a subprocess and
 * exposes session/prompt/output/terminate over host-RPC.
 *
 * Each session is a long-lived `Bun.spawn` of the claude-code binary
 * with stdin/stdout piped. Prompts are written to stdin; output is
 * line-streamed back. The service caches sessions by id and tears them
 * down on `terminate()` or worker shutdown.
 *
 * This is a *reference* implementation. The full real-world version
 * needs PTY (not raw stdin/stdout) so the CLI's interactive features
 * work; `Bun.spawn({ stdin: 'pipe', stdout: 'pipe' })` is good enough
 * for the prompt-and-collect pattern but not for editing tools.
 */

import type { JsonValue } from "@elizaos/plugin-remote-manifest";

export interface ClaudeCodeSession {
	sessionId: string;
	createdAt: number;
	cwd: string;
	model?: string;
	binary: string;
	proc: ReturnType<typeof Bun.spawn>;
	output: string[];
}

export interface CreateSessionParams {
	cwd: string;
	model?: string;
	/** Override the claude CLI binary name/path. Default: "claude". */
	binary?: string;
	/** Initial prompt to send after the session boots. */
	initialPrompt?: string;
}

export interface SendPromptParams {
	sessionId: string;
	prompt: string;
}

export interface GetOutputParams {
	sessionId: string;
	/** Drain mode: return all output, or just the new lines since last call. */
	mode?: "all" | "since-last";
}

export interface TerminateParams {
	sessionId: string;
}

export class ClaudeCodeSubAgentService {
	static readonly serviceType = "sub-agent.claude-code";
	static readonly rpcMethods = [
		"createSession",
		"sendPrompt",
		"getOutput",
		"terminate",
		"listSessions",
	] as const;
	static readonly capabilityDescription =
		"Drives the Claude Code CLI in an isolated subprocess.";

	readonly capabilityDescription = ClaudeCodeSubAgentService.capabilityDescription;

	private readonly sessions = new Map<string, ClaudeCodeSession>();
	private readonly outputCursors = new Map<string, number>();
	private nextSessionId = 1;

	static async start(_runtime: unknown): Promise<ClaudeCodeSubAgentService> {
		return new ClaudeCodeSubAgentService();
	}

	async stop(): Promise<void> {
		for (const session of this.sessions.values()) {
			try {
				session.proc.kill("SIGTERM");
			} catch {
				// already dead
			}
		}
		this.sessions.clear();
		this.outputCursors.clear();
	}

	async createSession(params: CreateSessionParams): Promise<JsonValue> {
		const sessionId = `cc-${this.nextSessionId++}-${Date.now()}`;
		const binary = params.binary ?? "claude";
		const args = ["--print"];
		if (params.model) args.push("--model", params.model);

		const proc = Bun.spawn({
			cmd: [binary, ...args],
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			cwd: params.cwd,
		});

		const session: ClaudeCodeSession = {
			sessionId,
			createdAt: Date.now(),
			cwd: params.cwd,
			...(params.model ? { model: params.model } : {}),
			binary,
			proc,
			output: [],
		};
		this.sessions.set(sessionId, session);
		this.outputCursors.set(sessionId, 0);

		// Pump stdout into the session's output buffer.
		void this.pumpStdout(session);

		if (params.initialPrompt) {
			await this.sendPrompt({ sessionId, prompt: params.initialPrompt });
		}

		return { sessionId, createdAt: session.createdAt };
	}

	async sendPrompt(params: SendPromptParams): Promise<JsonValue> {
		const session = this.requireSession(params.sessionId);
		const writer = session.proc.stdin as unknown as {
			write(data: string): void;
		};
		writer.write(`${params.prompt}\n`);
		return { ok: true };
	}

	async getOutput(params: GetOutputParams): Promise<JsonValue> {
		const session = this.requireSession(params.sessionId);
		const mode = params.mode ?? "since-last";
		if (mode === "all") {
			return { lines: [...session.output] };
		}
		const cursor = this.outputCursors.get(params.sessionId) ?? 0;
		const newLines = session.output.slice(cursor);
		this.outputCursors.set(params.sessionId, session.output.length);
		return { lines: newLines };
	}

	async terminate(params: TerminateParams): Promise<JsonValue> {
		const session = this.sessions.get(params.sessionId);
		if (!session) return { terminated: false };
		try {
			session.proc.kill("SIGTERM");
		} catch {
			// already dead
		}
		this.sessions.delete(params.sessionId);
		this.outputCursors.delete(params.sessionId);
		return { terminated: true };
	}

	async listSessions(): Promise<JsonValue> {
		return {
			sessions: Array.from(this.sessions.values()).map((s) => ({
				sessionId: s.sessionId,
				createdAt: s.createdAt,
				cwd: s.cwd,
				model: s.model ?? null,
			})),
		};
	}

	private requireSession(id: string): ClaudeCodeSession {
		const session = this.sessions.get(id);
		if (!session) throw new Error(`Unknown session: ${id}`);
		return session;
	}

	private async pumpStdout(session: ClaudeCodeSession): Promise<void> {
		if (!session.proc.stdout) return;
		const reader = (
			session.proc.stdout as unknown as ReadableStream<Uint8Array>
		).getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		try {
			// eslint-disable-next-line no-constant-condition
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				if (!value) continue;
				buffer += decoder.decode(value, { stream: true });
				let nl = buffer.indexOf("\n");
				while (nl !== -1) {
					const line = buffer.slice(0, nl);
					buffer = buffer.slice(nl + 1);
					session.output.push(line);
					nl = buffer.indexOf("\n");
				}
			}
			if (buffer.length > 0) session.output.push(buffer);
		} finally {
			reader.releaseLock?.();
		}
	}
}
