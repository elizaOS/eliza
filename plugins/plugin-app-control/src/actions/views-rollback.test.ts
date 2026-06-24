/**
 * Tests for the VIEWS `rollback` sub-mode + git snapshot helpers (#8915).
 *
 * Deterministic: the git runner and the loopback re-registration call are both
 * injected/stubbed, so no real `git` process runs and no network is touched.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const coreMock = vi.hoisted(() => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
	resolveServerOnlyPort: vi.fn(() => 3456),
	hasOwnerAccess: vi.fn(async () => true),
	formatError: (error: unknown): string =>
		error instanceof Error ? error.message : String(error),
}));

vi.mock("@elizaos/core", () => coreMock);

import { isRollbackRequest, runViewsRollback } from "./views-rollback.js";
import {
	createPreEditSnapshot,
	findSnapshotRecord,
	type GitRunner,
	isLikelySha,
	persistSnapshotRecord,
	rollbackToSnapshot,
	VIEWS_SNAPSHOT_TAG,
} from "./views-snapshot.js";

type GitCall = { args: string[]; cwd: string };

/**
 * Build a deterministic git runner whose behavior is keyed by the first arg.
 * Records every call so assertions can prove which commands ran.
 */
function fakeGit(
	responses: Record<
		string,
		{ stdout?: string; stderr?: string; exitCode?: number }
	>,
): { git: GitRunner; calls: GitCall[] } {
	const calls: GitCall[] = [];
	const git: GitRunner = async (args, cwd) => {
		calls.push({ args: [...args], cwd });
		const sub = args[0] === "rev-parse" ? `rev-parse:${args[1]}` : args[0];
		const r = responses[sub] ?? responses[args[0]] ?? {};
		return {
			stdout: r.stdout ?? "",
			stderr: r.stderr ?? "",
			exitCode: r.exitCode ?? 0,
		};
	};
	return { git, calls };
}

function message(text: string, roomId = "room-1") {
	return {
		entityId: "user-1",
		roomId,
		agentId: "agent-1",
		content: { text },
	} as never;
}

type RuntimeTask = { id: string; metadata?: Record<string, unknown> };

function createRuntime(tasks: RuntimeTask[] = []) {
	return {
		agentId: "agent-1",
		getTasks: vi.fn(async () => tasks),
		createTask: vi.fn(async (task: { metadata?: Record<string, unknown> }) => {
			tasks.push({ id: `task-${tasks.length + 1}`, metadata: task.metadata });
		}),
		deleteTask: vi.fn(async (taskId: string) => {
			const idx = tasks.findIndex((t) => t.id === taskId);
			if (idx >= 0) tasks.splice(idx, 1);
		}),
	};
}

beforeEach(() => {
	coreMock.logger.info.mockClear();
	coreMock.logger.warn.mockClear();
	delete process.env.ELIZA_BUILD_VARIANT;
	delete process.env.ELIZA_PLATFORM;
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("isLikelySha", () => {
	it("accepts short and full hex shas", () => {
		expect(isLikelySha("a1b2c3d")).toBe(true);
		expect(isLikelySha("0123456789abcdef0123456789abcdef01234567")).toBe(true);
	});
	it("rejects non-shas", () => {
		expect(isLikelySha("not-a-sha")).toBe(false);
		expect(isLikelySha("")).toBe(false);
		expect(isLikelySha("zzz")).toBe(false);
	});
});

describe("createPreEditSnapshot", () => {
	it("commits a non-destructive snapshot and returns the HEAD sha", async () => {
		const sha = "deadbeefcafef00d";
		const { git, calls } = fakeGit({
			"rev-parse:--is-inside-work-tree": { stdout: "true\n" },
			add: {},
			commit: {},
			"rev-parse:HEAD": { stdout: `${sha}\n` },
		});

		const result = await createPreEditSnapshot("/work/dir", { git });
		expect(result).toEqual({ ok: true, sha });

		// The snapshot must stage everything and commit with --no-verify (skip
		// hooks) + --allow-empty (no diff still produces a snapshot point).
		const addCall = calls.find((c) => c.args[0] === "add");
		expect(addCall?.args).toEqual(["add", "-A", "--", "."]);
		const commitCall = calls.find((c) => c.args[0] === "commit");
		expect(commitCall?.args).toContain("--no-verify");
		expect(commitCall?.args).toContain("--allow-empty");
		// Crucially it never resets/discards the working tree.
		expect(calls.some((c) => c.args[0] === "reset")).toBe(false);
	});

	it("fails gracefully when the workdir is not a git work tree", async () => {
		const { git } = fakeGit({
			"rev-parse:--is-inside-work-tree": {
				exitCode: 128,
				stderr: "not a git repository",
			},
		});
		const result = await createPreEditSnapshot("/work/dir", { git });
		expect(result.ok).toBe(false);
	});
});

describe("rollbackToSnapshot", () => {
	it("restores ONLY the workdir (checkout + clean, never reset --hard)", async () => {
		const sha = "abc1234";
		const { git, calls } = fakeGit({
			"rev-parse:--is-inside-work-tree": { stdout: "true\n" },
			checkout: {},
			clean: {},
		});
		const result = await rollbackToSnapshot("/work/dir", sha, { git });
		expect(result).toEqual({ ok: true, sha });
		// A repo-wide `git reset --hard` would discard unrelated uncommitted work.
		expect(calls.some((c) => c.args[0] === "reset")).toBe(false);
		const checkoutCall = calls.find((c) => c.args[0] === "checkout");
		expect(checkoutCall?.args).toEqual(["checkout", sha, "--", "."]);
		expect(checkoutCall?.cwd).toBe("/work/dir");
		const cleanCall = calls.find((c) => c.args[0] === "clean");
		expect(cleanCall?.args).toEqual(["clean", "-fd", "--", "."]);
		expect(cleanCall?.cwd).toBe("/work/dir");
	});

	it("refuses an invalid sha without touching git", async () => {
		const { git, calls } = fakeGit({});
		const result = await rollbackToSnapshot("/work/dir", "garbage", { git });
		expect(result.ok).toBe(false);
		expect(calls).toHaveLength(0);
	});

	it("surfaces a git checkout failure", async () => {
		const { git } = fakeGit({
			"rev-parse:--is-inside-work-tree": { stdout: "true\n" },
			checkout: { exitCode: 1, stderr: "unknown revision" },
		});
		const result = await rollbackToSnapshot("/work/dir", "abc1234", { git });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("git checkout");
	});
});

describe("snapshot record persistence", () => {
	it("persists and resolves the most-recent snapshot record for a room", async () => {
		const tasks: RuntimeTask[] = [];
		const runtime = createRuntime(tasks);

		await persistSnapshotRecord(runtime as never, {
			sha: "1111111",
			workdir: "/repo/plugins/plugin-old",
			pluginName: "@elizaos/plugin-old",
			created: false,
			roomId: "room-1",
			snapshotCreatedAt: "2026-01-01T00:00:00.000Z",
		});
		await persistSnapshotRecord(runtime as never, {
			sha: "2222222",
			workdir: "/repo/plugins/plugin-new",
			pluginName: "@elizaos/plugin-new",
			created: true,
			roomId: "room-1",
			snapshotCreatedAt: "2026-02-01T00:00:00.000Z",
		});

		expect(runtime.createTask).toHaveBeenCalledTimes(2);
		expect(tasks[0].metadata).toMatchObject({ sha: "1111111" });

		const latest = await findSnapshotRecord(runtime as never, "room-1");
		expect(latest?.record.sha).toBe("2222222");

		// Target filter narrows to a specific plugin even if it isn't the newest.
		const targeted = await findSnapshotRecord(
			runtime as never,
			"room-1",
			"plugin-old",
		);
		expect(targeted?.record.sha).toBe("1111111");
	});

	it("does not leak snapshots across rooms", async () => {
		const tasks: RuntimeTask[] = [];
		const runtime = createRuntime(tasks);
		await persistSnapshotRecord(runtime as never, {
			sha: "3333333",
			workdir: "/repo/plugins/plugin-x",
			pluginName: "@elizaos/plugin-x",
			created: true,
			roomId: "room-other",
			snapshotCreatedAt: "2026-03-01T00:00:00.000Z",
		});
		expect(await findSnapshotRecord(runtime as never, "room-1")).toBeNull();
	});

	it("tags records with the snapshot tag", async () => {
		const tasks: RuntimeTask[] = [];
		const runtime = createRuntime(tasks);
		await persistSnapshotRecord(runtime as never, {
			sha: "4444444",
			workdir: "/repo/plugins/plugin-y",
			pluginName: "@elizaos/plugin-y",
			created: true,
			roomId: "room-1",
			snapshotCreatedAt: "2026-04-01T00:00:00.000Z",
		});
		const created = runtime.createTask.mock.calls[0][0] as {
			tags?: string[];
		};
		expect(created.tags).toContain(VIEWS_SNAPSHOT_TAG);
	});
});

describe("isRollbackRequest", () => {
	it("matches natural-language rollback phrasings", () => {
		expect(isRollbackRequest("roll back the wallet view")).toBe(true);
		expect(isRollbackRequest("undo the plugin creation")).toBe(true);
		expect(isRollbackRequest("revert the last edit to the plugin")).toBe(true);
		expect(isRollbackRequest("undo that view edit")).toBe(true);
	});

	it("matches a bare 'rollback' / 'revert' reply to a failure offer", () => {
		expect(isRollbackRequest("rollback")).toBe(true);
		expect(isRollbackRequest("roll back")).toBe(true);
		expect(isRollbackRequest("revert")).toBe(true);
	});

	it("does not hijack generic navigation/undo", () => {
		expect(isRollbackRequest("go back to the home screen")).toBe(false);
		expect(isRollbackRequest("show me the wallet view")).toBe(false);
		// bare 'undo' belongs to BACKGROUND, not the plugin rollback offer.
		expect(isRollbackRequest("undo")).toBe(false);
	});
});

describe("runViewsRollback", () => {
	it("resets to the recorded snapshot and re-registers the plugin", async () => {
		const sha = "feedface";
		const tasks: RuntimeTask[] = [
			{
				id: "snap-1",
				metadata: {
					sha,
					workdir: "/repo/plugins/plugin-habits",
					pluginName: "@elizaos/plugin-habits",
					created: true,
					roomId: "room-1",
					snapshotCreatedAt: "2026-05-01T00:00:00.000Z",
				},
			},
		];
		const runtime = createRuntime(tasks);
		const { git, calls } = fakeGit({
			"rev-parse:--is-inside-work-tree": { stdout: "true\n" },
			checkout: {},
			clean: {},
		});
		const reregister = vi.fn(async () => ({
			ok: true,
			pluginName: "@elizaos/plugin-habits",
		}));
		const callback = vi.fn(async () => []);

		const result = await runViewsRollback({
			runtime: runtime as never,
			message: message("rollback"),
			options: { action: "rollback" },
			callback,
			git,
			reregister,
		});

		expect(result.success).toBe(true);
		// scoped checkout restored the recorded workdir (never reset --hard).
		expect(calls.some((c) => c.args[0] === "reset")).toBe(false);
		const checkoutCall = calls.find((c) => c.args[0] === "checkout");
		expect(checkoutCall?.args).toEqual(["checkout", sha, "--", "."]);
		expect(checkoutCall?.cwd).toBe("/repo/plugins/plugin-habits");
		// re-registration was triggered with the same workdir.
		expect(reregister).toHaveBeenCalledWith("/repo/plugins/plugin-habits");
		// the consumed snapshot record was deleted.
		expect(runtime.deleteTask).toHaveBeenCalledWith("snap-1");
		// success surfaced to the user.
		const said = callback.mock.calls.map(
			(c) => (c[0] as { text: string }).text,
		);
		expect(said.join("\n")).toMatch(/rolled .*back/i);
	});

	it("reports honestly when no snapshot is on record", async () => {
		const runtime = createRuntime([]);
		const { git } = fakeGit({});
		const callback = vi.fn(async () => []);
		const result = await runViewsRollback({
			runtime: runtime as never,
			message: message("rollback"),
			options: { action: "rollback" },
			callback,
			git,
			reregister: vi.fn(),
		});
		expect(result.success).toBe(false);
		expect((result.text ?? "").toLowerCase()).toContain("no pre-edit snapshot");
	});

	it("honors an explicit sha + workdir over the recorded snapshot", async () => {
		const runtime = createRuntime([]);
		const { git, calls } = fakeGit({
			"rev-parse:--is-inside-work-tree": { stdout: "true\n" },
			checkout: {},
			clean: {},
		});
		const reregister = vi.fn(async () => ({ ok: true }));
		const result = await runViewsRollback({
			runtime: runtime as never,
			message: message("rollback"),
			options: { action: "rollback", sha: "cafe123", workdir: "/explicit/dir" },
			callback: vi.fn(async () => []),
			git,
			reregister,
		});
		expect(result.success).toBe(true);
		const checkoutCall = calls.find((c) => c.args[0] === "checkout");
		expect(checkoutCall?.args).toEqual(["checkout", "cafe123", "--", "."]);
		expect(reregister).toHaveBeenCalledWith("/explicit/dir");
	});

	it("still reports success-with-warning when re-registration fails", async () => {
		const tasks: RuntimeTask[] = [
			{
				id: "snap-2",
				metadata: {
					sha: "abcdef0",
					workdir: "/repo/plugins/plugin-z",
					pluginName: "@elizaos/plugin-z",
					created: true,
					roomId: "room-1",
					snapshotCreatedAt: "2026-05-02T00:00:00.000Z",
				},
			},
		];
		const runtime = createRuntime(tasks);
		const { git } = fakeGit({
			"rev-parse:--is-inside-work-tree": { stdout: "true\n" },
			checkout: {},
			clean: {},
		});
		const reregister = vi.fn(async () => ({
			ok: false,
			error: "load failed",
		}));
		const callback = vi.fn(async () => []);
		const result = await runViewsRollback({
			runtime: runtime as never,
			message: message("rollback"),
			options: { action: "rollback" },
			callback,
			git,
			reregister,
		});
		// Source was restored even though live-reload failed → still a success,
		// with a message telling the user to reload the agent.
		expect(result.success).toBe(true);
		const said = callback.mock.calls.map(
			(c) => (c[0] as { text: string }).text,
		);
		expect(said.join("\n")).toMatch(/reload the agent/i);
	});
});
