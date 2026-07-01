/**
 * @module plugin-app-control/actions/views-snapshot
 *
 * Git snapshot + rollback helpers for the view/plugin create & edit flow.
 *
 * Before a coding agent edits a view/plugin workdir we take a pre-edit
 * snapshot: a non-destructive `git commit --no-verify --allow-empty` that
 * captures the working tree exactly as it was. The resulting SHA is recorded
 * on a Task so the `rollback` sub-mode can later restore that workdir (scoped
 * `git checkout <sha> -- .` + `git clean`, never a repo-wide `git reset --hard`)
 * if the edit goes wrong (the user's "undo creation"
 * ask, #8915).
 *
 * We shell out to `git` directly against the target `workdir` (mirroring
 * `plugin-agent-orchestrator/services/workspace-git-ops.ts`) rather than going
 * through CodingWorkspaceService: that service is keyed by managed-workspace
 * IDs (clones), whereas the view/plugin flow operates on a `workdir` inside the
 * local repo checkout. The git runner is injectable so unit tests stay
 * deterministic without touching a real repository.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";

const execFileAsync = promisify(execFile);

/** Tag used to persist the pre-edit snapshot SHA for a workdir. */
export const VIEWS_SNAPSHOT_TAG = "views-snapshot";

/** The canonical pre-edit snapshot commit message. */
export const PRE_EDIT_SNAPSHOT_MESSAGE = "pre-edit snapshot";

const GIT_TIMEOUT_MS = 30_000;

/**
 * Runs a single git subcommand inside `cwd`. Injectable so tests can supply a
 * deterministic stub instead of spawning a real `git` process.
 */
export type GitRunner = (
	args: readonly string[],
	cwd: string,
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

const defaultGitRunner: GitRunner = async (args, cwd) => {
	try {
		const { stdout, stderr } = await execFileAsync("git", [...args], {
			cwd,
			timeout: GIT_TIMEOUT_MS,
			maxBuffer: 8 * 1024 * 1024,
			encoding: "utf8",
			env: { ...process.env },
		});
		return { stdout, stderr, exitCode: 0 };
	} catch (err) {
		const e = err as NodeJS.ErrnoException & {
			stdout?: string | Buffer;
			stderr?: string | Buffer;
			code?: number | string;
		};
		const stdout =
			typeof e.stdout === "string"
				? e.stdout
				: (e.stdout?.toString("utf8") ?? "");
		const stderr =
			typeof e.stderr === "string"
				? e.stderr
				: (e.stderr?.toString("utf8") ?? "");
		const exitCode = typeof e.code === "number" ? e.code : 1;
		return { stdout, stderr, exitCode };
	}
};

export type SnapshotResult =
	| { ok: true; sha: string }
	| { ok: false; reason: string };

export type RollbackResult =
	| { ok: true; sha: string }
	| { ok: false; reason: string };

const SHA_RE = /^[0-9a-f]{7,40}$/i;

/** Validate a value as a plausible git object SHA (short or full). */
export function isLikelySha(value: string): boolean {
	return SHA_RE.test(value.trim());
}

/**
 * Take a pre-edit snapshot of `workdir`. Stages changes **scoped to the workdir**
 * (`git add -A -- .`, run with `cwd=workdir`, so the snapshot never sweeps in
 * unrelated repo changes) and writes a non-destructive commit
 * (`--no-verify --allow-empty`) so the workdir is preserved verbatim and the
 * returned SHA points at it. The commit is non-destructive: nothing in the
 * working tree is reset or discarded.
 *
 * Returns the snapshot SHA on success. On any git failure (not a repo, no
 * identity, etc.) returns `{ ok: false }` with the reason — callers treat a
 * failed snapshot as best-effort and continue the edit without rollback.
 */
export async function createPreEditSnapshot(
	workdir: string,
	options: { git?: GitRunner; message?: string } = {},
): Promise<SnapshotResult> {
	const git = options.git ?? defaultGitRunner;
	const message = options.message ?? PRE_EDIT_SNAPSHOT_MESSAGE;

	const inside = await git(["rev-parse", "--is-inside-work-tree"], workdir);
	if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") {
		return {
			ok: false,
			reason: `not a git work tree (${(inside.stderr || inside.stdout).trim() || "git rev-parse failed"})`,
		};
	}

	// Scope staging to the workdir subtree (cwd=workdir) so a snapshot never
	// stages unrelated changes elsewhere in the repo.
	const add = await git(["add", "-A", "--", "."], workdir);
	if (add.exitCode !== 0) {
		return {
			ok: false,
			reason: `git add failed: ${(add.stderr || add.stdout).trim()}`,
		};
	}

	const commit = await git(
		["commit", "--no-verify", "--allow-empty", "-m", message],
		workdir,
	);
	if (commit.exitCode !== 0) {
		return {
			ok: false,
			reason: `git commit failed: ${(commit.stderr || commit.stdout).trim()}`,
		};
	}

	const rev = await git(["rev-parse", "HEAD"], workdir);
	const sha = rev.stdout.trim();
	if (rev.exitCode !== 0 || !isLikelySha(sha)) {
		return {
			ok: false,
			reason: `git rev-parse HEAD failed: ${(rev.stderr || rev.stdout).trim()}`,
		};
	}

	logger.info(
		`[plugin-app-control] snapshot created sha=${sha} workdir=${workdir}`,
	);
	return { ok: true, sha };
}

/**
 * Restore `workdir` to the snapshot `sha`, **scoped to the workdir only**:
 * `git checkout <sha> -- .` restores tracked files and `git clean -fd -- .`
 * removes files created after the snapshot (respecting `.gitignore`). We
 * deliberately do NOT `git reset --hard`, which would discard unrelated
 * working-tree changes across the entire repo — a data-loss footgun.
 */
export async function rollbackToSnapshot(
	workdir: string,
	sha: string,
	options: { git?: GitRunner } = {},
): Promise<RollbackResult> {
	const git = options.git ?? defaultGitRunner;
	const trimmed = sha.trim();
	if (!isLikelySha(trimmed)) {
		return { ok: false, reason: `invalid snapshot sha "${sha}"` };
	}

	const inside = await git(["rev-parse", "--is-inside-work-tree"], workdir);
	if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") {
		return {
			ok: false,
			reason: `not a git work tree (${(inside.stderr || inside.stdout).trim() || "git rev-parse failed"})`,
		};
	}

	// Restore only this workdir — NEVER `git reset --hard`, which is repo-wide
	// and would discard unrelated uncommitted work elsewhere in the checkout.
	const restore = await git(["checkout", trimmed, "--", "."], workdir);
	if (restore.exitCode !== 0) {
		return {
			ok: false,
			reason: `git checkout ${trimmed} failed: ${(restore.stderr || restore.stdout).trim()}`,
		};
	}

	// Remove files created after the snapshot, scoped to the workdir. `-d` for
	// new dirs; no `-x`, so .gitignore'd build output / deps are left untouched.
	const clean = await git(["clean", "-fd", "--", "."], workdir);
	if (clean.exitCode !== 0) {
		return {
			ok: false,
			reason: `git clean failed: ${(clean.stderr || clean.stdout).trim()}`,
		};
	}

	logger.info(
		`[plugin-app-control] rolled back to sha=${trimmed} workdir=${workdir}`,
	);
	return { ok: true, sha: trimmed };
}

// ---------------------------------------------------------------------------
// Snapshot record persistence (Task-backed)
// ---------------------------------------------------------------------------

export interface ViewsSnapshotRecord {
	/** Snapshot commit SHA recorded before the edit. */
	sha: string;
	/** Absolute workdir the snapshot was taken in. */
	workdir: string;
	/** Owning plugin name (used to resolve the snapshot on rollback). */
	pluginName: string;
	/** Whether the edit created a brand-new plugin (vs editing an existing one). */
	created: boolean;
	/** Room the originating request came from. */
	roomId: string;
	/** ISO-8601 timestamp; stored as a string so it round-trips through metadata. */
	snapshotCreatedAt: string;
}

function readString(
	record: Record<string, unknown>,
	key: string,
): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.trim().length > 0
		? value
		: undefined;
}

/**
 * Persist a snapshot record so the rollback sub-mode can resolve the SHA later.
 * Keyed by `pluginName` + `workdir` in metadata; the most recent record for a
 * room/plugin wins.
 */
export async function persistSnapshotRecord(
	runtime: IAgentRuntime,
	record: ViewsSnapshotRecord,
): Promise<void> {
	await runtime.createTask({
		name: "VIEWS snapshot",
		description: `Pre-edit snapshot ${record.sha} for ${record.pluginName}`,
		tags: [VIEWS_SNAPSHOT_TAG],
		metadata: {
			sha: record.sha,
			workdir: record.workdir,
			pluginName: record.pluginName,
			created: record.created,
			roomId: record.roomId,
			snapshotCreatedAt: record.snapshotCreatedAt,
		},
	});
}

/**
 * Resolve the most-recent snapshot record for a room, optionally filtered by a
 * target string that matches the plugin name or workdir. Returns `null` when no
 * snapshot is on record.
 */
export async function findSnapshotRecord(
	runtime: IAgentRuntime,
	roomId: string,
	target?: string,
): Promise<{ taskId: string; record: ViewsSnapshotRecord } | null> {
	const tasks = await runtime.getTasks({
		agentIds: [runtime.agentId],
		tags: [VIEWS_SNAPSHOT_TAG],
	});

	const normalizedTarget = target?.trim().toLowerCase();

	const matching = tasks
		.map((task) => {
			const meta = task.metadata as Record<string, unknown> | undefined;
			if (!meta) return null;
			const sha = readString(meta, "sha");
			const workdir = readString(meta, "workdir");
			const pluginName = readString(meta, "pluginName");
			const metaRoomId = readString(meta, "roomId");
			if (!sha || !workdir || !pluginName || !task.id) return null;
			if (metaRoomId && metaRoomId !== roomId) return null;
			const record: ViewsSnapshotRecord = {
				sha,
				workdir,
				pluginName,
				created: meta.created === true,
				roomId: metaRoomId ?? roomId,
				snapshotCreatedAt:
					readString(meta, "snapshotCreatedAt") ?? new Date(0).toISOString(),
			};
			return { taskId: task.id, record };
		})
		.filter(
			(entry): entry is { taskId: string; record: ViewsSnapshotRecord } =>
				entry !== null,
		)
		.filter((entry) => {
			if (!normalizedTarget) return true;
			const plugin = entry.record.pluginName.toLowerCase();
			const pluginBase = plugin.replace(/^@[^/]+\//, "");
			return (
				plugin === normalizedTarget ||
				pluginBase === normalizedTarget ||
				plugin.includes(normalizedTarget) ||
				entry.record.workdir.toLowerCase().includes(normalizedTarget)
			);
		})
		.sort(
			(a, b) =>
				Date.parse(b.record.snapshotCreatedAt) -
				Date.parse(a.record.snapshotCreatedAt),
		);

	return matching[0] ?? null;
}

/** Delete a consumed snapshot record (best-effort). */
export async function deleteSnapshotRecord(
	runtime: IAgentRuntime,
	taskId: string,
): Promise<void> {
	await runtime
		.deleteTask(taskId as `${string}-${string}-${string}-${string}-${string}`)
		.catch((err) => {
			logger.warn(
				`[plugin-app-control] failed to delete snapshot record ${taskId}: ${err instanceof Error ? err.message : String(err)}`,
			);
		});
}
