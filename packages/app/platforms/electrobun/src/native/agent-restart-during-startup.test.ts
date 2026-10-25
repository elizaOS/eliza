import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AgentManager } from "./agent";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-restart-"));
const distDir = path.join(directory, "dist");
const pidLog = path.join(directory, "runtime-pids.log");

const fakeRuntime = `
const fs = require("node:fs");
const http = require("node:http");
const pidLog = process.env.FAKE_RUNTIME_PID_LOG;
const launchIndex = fs.existsSync(pidLog)
	? fs.readFileSync(pidLog, "utf8").split("\\n").filter(Boolean).length
	: 0;
fs.appendFileSync(pidLog, process.pid + "\\n");
const readyAt = launchIndex === 0 ? Number.POSITIVE_INFINITY : 0;
const server = http.createServer((req, res) => {
	if (req.url === "/api/health") {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ ready: Date.now() >= readyAt }));
		return;
	}
	res.writeHead(404);
	res.end();
});
server.listen(Number(process.env.ELIZA_API_PORT), "127.0.0.1");
process.on("SIGTERM", () => process.exit(0));
`;

function nodeBackedBunSpawn(
	cmd: string[],
	opts: { cwd: string; env: Record<string, string> },
) {
	const child = spawn(process.execPath, [cmd[2]], {
		cwd: opts.cwd,
		env: opts.env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const proc = {
		pid: child.pid,
		exitCode: null as number | null,
		signalCode: null as NodeJS.Signals | null,
		stdout: Readable.toWeb(child.stdout as Readable),
		stderr: Readable.toWeb(child.stderr as Readable),
		exited: new Promise<number>((resolve) => {
			child.once("exit", (code, signal) => {
				proc.signalCode = signal;
				proc.exitCode = code ?? 128;
				resolve(proc.exitCode);
			});
		}),
		kill: (signal?: NodeJS.Signals) => child.kill(signal),
	};
	return proc;
}

function runtimePids(): number[] {
	if (!fs.existsSync(pidLog)) return [];
	return fs
		.readFileSync(pidLog, "utf8")
		.split("\n")
		.filter(Boolean)
		.map(Number);
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

beforeAll(() => {
	fs.mkdirSync(distDir, { recursive: true });
	fs.writeFileSync(path.join(distDir, "entry.js"), fakeRuntime);
	vi.spyOn(os, "homedir").mockReturnValue(directory);
	vi.stubEnv("FAKE_RUNTIME_PID_LOG", pidLog);
	vi.stubEnv("ELIZA_DIST_PATH", distDir);
	vi.stubEnv("ELIZA_STATE_DIR", path.join(directory, "state"));
	vi.stubEnv("ELIZA_API_PORT", String(40_000 + (process.pid % 10_000)));
	vi.stubEnv("ELIZA_AGENT_HEALTH_TIMEOUT_MS", "20000");
	vi.stubEnv("ELIZA_DESKTOP_API_BASE", "");
	vi.stubEnv("ELIZA_DESKTOP_SKIP_EMBEDDED_AGENT", "");
	if (typeof Bun === "undefined") {
		vi.stubGlobal("Bun", {
			spawn: nodeBackedBunSpawn,
			sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
		});
	}
});

afterAll(() => {
	for (const pid of runtimePids()) {
		if (isAlive(pid)) process.kill(pid, "SIGKILL");
	}
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	fs.rmSync(directory, { recursive: true, force: true });
});

describe("restart while the embedded agent is still starting", () => {
	it("keeps ownership of the replacement runtime so stop() terminates it", async () => {
		const manager = new AgentManager();
		const errors: Array<string | null> = [];
		manager.onStatusChange((status) => {
			if (status.state === "error") errors.push(status.error);
		});
		const firstStart = manager.start();
		await vi.waitFor(() => expect(runtimePids()).toHaveLength(1), {
			timeout: 10_000,
		});
		expect(manager.getStatus().state).toBe("starting");

		const restarted = await manager.restart();
		await firstStart;

		const [firstPid, secondPid] = runtimePids();
		expect(runtimePids()).toHaveLength(2);
		expect(restarted.state).toBe("running");
		expect(manager.getStatus().state).toBe("running");

		await manager.stop();

		expect(isAlive(firstPid)).toBe(false);
		expect(isAlive(secondPid)).toBe(false);
		expect(manager.getStatus().state).toBe("stopped");
		expect(errors).toEqual([]);
	}, 30_000);
});
