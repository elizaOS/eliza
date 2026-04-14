/**
 * Opt-in live smoke tests for real Claude Code and Codex sessions.
 *
 * These are skipped by default. Run with:
 *   ORCHESTRATOR_LIVE=1 bun test src/__tests__/task-agent-live.e2e.test.ts
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { describe, it } from "vitest";

const RUN_LIVE = process.env.ORCHESTRATOR_LIVE === "1";
const liveDescribe = RUN_LIVE ? describe : describe.skip;

async function runLiveSmokeScript(
	framework: "claude" | "codex",
	mode: "sequential" | "web",
): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const bunBinary = process.execPath;
		const child = spawn(
			bunBinary,
			[
				"scripts/run-node-tsx.mjs",
				"test/scripts/task-agent-live-smoke.ts",
				"--framework",
				framework,
				"--mode",
				mode,
			],
			{
				cwd: process.cwd(),
				env: { ...process.env, ORCHESTRATOR_LIVE: "1", PWD: process.cwd() },
				stdio: "inherit",
			},
		);

		child.on("error", reject);
		child.on("exit", (code, signal) => {
			if (signal) {
				reject(
					new Error(
						`${framework} ${mode} live smoke exited via signal ${signal}`,
					),
				);
				return;
			}
			try {
				assert.equal(
					code,
					0,
					`${framework} ${mode} live smoke exited with code ${code ?? -1}`,
				);
				resolve();
			} catch (error) {
				reject(error);
			}
		});
	});
}

liveDescribe("task-agent live smoke", () => {
	it(
		"keeps a Claude Code session alive across sequential tracked tasks",
		async () => {
			await runLiveSmokeScript("claude", "sequential");
		},
		12 * 60 * 1000,
	);

	it(
		"keeps a Codex session alive across sequential tracked tasks",
		async () => {
			await runLiveSmokeScript("codex", "sequential");
		},
		12 * 60 * 1000,
	);

	it(
		"has Claude Code research a page and serve a generated webpage",
		async () => {
			await runLiveSmokeScript("claude", "web");
		},
		12 * 60 * 1000,
	);

	it(
		"has Codex research a page and serve a generated webpage",
		async () => {
			await runLiveSmokeScript("codex", "web");
		},
		12 * 60 * 1000,
	);
});
