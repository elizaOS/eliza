/**
 * Replays quint/SpawnEnvGitHelpers.qnt through sanitizeSpawnEnv and a real
 * `git ls-remote` child process. Each overlay key points at a planted script
 * or directory that writes a marker file if git runs it, so a step's outcome
 * is what git actually executed, not what the denylist says.
 */
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { sanitizeSpawnEnv } from "../src/security/spawn-env-policy";

const KEYS = [
	"GIT_PROXY_COMMAND",
	"GIT_EXEC_PATH",
	"GIT_SSH_COMMAND",
	"GIT_AUTHOR_NAME",
] as const;
type Key = (typeof KEYS)[number];
const ACTIONS = ["write", "fetchGit", "fetchHttps"] as const;
type Action = (typeof ACTIONS)[number];
/** outcome: 0 no spawn yet, 1 git ran no planted helper, 2 a planted helper ran. */
interface ModelStep {
	action: Action;
	key?: Key;
	overlay: Key[];
	outcome: number;
	child: Key[];
}
type ModelCase = ModelStep[];

const write = (key: Key, overlay: Key[], outcome: number, child: Key[]) => ({
	action: "write" as const,
	key,
	overlay,
	outcome,
	child,
});
const fetch = (
	action: "fetchGit" | "fetchHttps",
	overlay: Key[],
	child: Key[],
) => ({
	action,
	overlay,
	outcome: 1,
	child,
});

// Without generated cases, each first action replays these sequences.
const DEFAULT_CASES: ModelCase[] = [
	[
		write("GIT_PROXY_COMMAND", ["GIT_PROXY_COMMAND"], 0, []),
		fetch("fetchGit", ["GIT_PROXY_COMMAND"], []),
	],
	[
		write("GIT_EXEC_PATH", ["GIT_EXEC_PATH"], 0, []),
		fetch("fetchHttps", ["GIT_EXEC_PATH"], []),
	],
	[
		write("GIT_AUTHOR_NAME", ["GIT_AUTHOR_NAME"], 0, []),
		write("GIT_PROXY_COMMAND", ["GIT_AUTHOR_NAME", "GIT_PROXY_COMMAND"], 0, []),
		fetch(
			"fetchGit",
			["GIT_AUTHOR_NAME", "GIT_PROXY_COMMAND"],
			["GIT_AUTHOR_NAME"],
		),
	],
	[fetch("fetchGit", [], [])],
	[
		fetch("fetchHttps", [], []),
		write("GIT_EXEC_PATH", ["GIT_EXEC_PATH"], 1, []),
		fetch("fetchHttps", ["GIT_EXEC_PATH"], []),
	],
];
const generated = process.env.ELIZA_SPAWN_ENV_GIT_HELPERS_MODEL_CASES;
const cases: ModelCase[] = generated
	? JSON.parse(readFileSync(generated, "utf8"))
	: DEFAULT_CASES;

const root = mkdtempSync(join(tmpdir(), "spawn-env-git-helpers-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function planted(dir: string, name: string, marker: string): string {
	const file = join(dir, name);
	writeFileSync(file, `#!/bin/sh\necho ran > '${join(dir, marker)}'\nexit 1\n`);
	chmodSync(file, 0o755);
	return file;
}

const MARKERS = ["PROXY_RAN", "EXEC_RAN", "SSH_RAN"];

function replay(modelCase: ModelCase, name: string): void {
	const dir = join(root, name);
	mkdirSync(join(dir, "exec"), { recursive: true });
	planted(join(dir, "exec"), "git-remote-https", "../EXEC_RAN");
	const values: Record<Key, string> = {
		GIT_PROXY_COMMAND: planted(dir, "proxy.sh", "PROXY_RAN"),
		GIT_EXEC_PATH: join(dir, "exec"),
		GIT_SSH_COMMAND: planted(dir, "ssh.sh", "SSH_RAN"),
		GIT_AUTHOR_NAME: "Model Author",
	};
	// The untrusted overlay a config, API or MCP env write produced.
	const overlay: Partial<Record<Key, string>> = {};
	let outcome = 0;
	let child: Key[] = [];
	for (const [index, expected] of modelCase.entries()) {
		if (expected.action === "write") {
			const key = expected.key as Key;
			overlay[key] = values[key];
		} else {
			for (const marker of MARKERS) rmSync(join(dir, marker), { force: true });
			// The spawn consumers merge the overlay over the host env, sanitize
			// it, then restore their PATH/HOME baseline.
			const env: Record<string, string | undefined> = {
				...sanitizeSpawnEnv({
					PATH: process.env.PATH,
					HOME: dir,
					GIT_TERMINAL_PROMPT: "0",
					GIT_CONFIG_NOSYSTEM: "1",
					...overlay,
				}),
				PATH: process.env.PATH,
				HOME: dir,
			};
			const url =
				expected.action === "fetchGit"
					? "git://127.0.0.1:1/repo.git"
					: "https://127.0.0.1:1/repo.git";
			const git = spawnSync("git", ["ls-remote", url], {
				env,
				stdio: "ignore",
				timeout: 15_000,
			});
			expect(git.error).toBeUndefined();
			outcome = MARKERS.some((marker) => existsSync(join(dir, marker))) ? 2 : 1;
			child = KEYS.filter((key) => env[key] !== undefined);
		}
		const where = `step ${index + 1} (${expected.action}) of ${JSON.stringify(modelCase.map((item) => item.key ?? item.action))}`;
		expect(Object.keys(overlay).sort(), where).toEqual(
			[...expected.overlay].sort(),
		);
		expect(outcome, where).toBe(expected.outcome);
		expect(child.sort(), where).toEqual([...expected.child].sort());
	}
}

describe("spawn env git helpers model", () => {
	it.each([...ACTIONS])(
		"replays the spawn env git helpers model from %s",
		(first) => {
			const own = cases.filter((item) => item[0]?.action === first);
			expect(own.length).toBeGreaterThan(0);
			for (const [seq, modelCase] of own.entries()) {
				replay(modelCase, `${first}-${seq}`);
			}
		},
		120_000,
	);
});
