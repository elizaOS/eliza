/**
 * @module plugin-app-control/actions/views-rollback
 *
 * rollback sub-mode of the VIEWS action (#8915).
 *
 * Undoes a view/plugin create or edit by resetting its workdir back to the
 * pre-edit snapshot recorded before the coding agent ran, then re-registering
 * the plugin through the same `load-from-directory` path create uses so the
 * running runtime reflects the restored source.
 *
 * Snapshot SHA resolution order:
 *  1. explicit `sha` option,
 *  2. the most-recent persisted snapshot record for this room (optionally
 *     narrowed by a `view`/`target` string matching the plugin name/workdir).
 *
 * Owner-gated by the VIEWS action like create/edit/delete.
 *
 * FOLLOW-UP (#8915): a full live scenario — dispatch a real failing edit via a
 * live model/sub-agent spawn, accept the rollback offer, and assert the source
 * on disk is restored end-to-end — is tracked separately; it needs a live model
 * and is not faked here. The git snapshot/rollback helpers, the sub-mode wiring,
 * and the failure-offer text are fully covered by deterministic unit tests
 * (views-rollback.test.ts, views-management.test.ts, verification-room-bridge.test.ts).
 */

import type {
	ActionResult,
	HandlerCallback,
	IAgentRuntime,
	Memory,
} from "@elizaos/core";
import { logger, resolveServerOnlyPort } from "@elizaos/core";
import { readStringOption } from "../params.js";
import { isRestrictedPlatform } from "./views-platform.js";
import {
	deleteSnapshotRecord,
	findSnapshotRecord,
	type GitRunner,
	isLikelySha,
	rollbackToSnapshot,
} from "./views-snapshot.js";

/** Re-register a plugin workdir into the running runtime over loopback HTTP. */
export type ReregisterFn = (
	workdir: string,
) => Promise<{ ok: boolean; pluginName?: string; error?: string }>;

export interface ViewsRollbackInput {
	runtime: IAgentRuntime;
	message: Memory;
	options?: Record<string, unknown>;
	callback?: HandlerCallback;
	/** Injectable git runner (tests). */
	git?: GitRunner;
	/** Injectable re-registration path (tests). */
	reregister?: ReregisterFn;
}

/**
 * Re-register the rolled-back plugin source via the same loopback endpoint the
 * verification bridge / create flow use to load a freshly-built plugin.
 */
async function reregisterPluginFromWorkdir(
	workdir: string,
): Promise<{ ok: boolean; pluginName?: string; error?: string }> {
	const port = resolveServerOnlyPort(process.env);
	try {
		const resp = await fetch(
			`http://127.0.0.1:${port}/api/plugins/load-from-directory`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ directory: workdir }),
				signal: AbortSignal.timeout(30_000),
			},
		);
		const body = (await resp.json().catch(() => ({}))) as Record<
			string,
			unknown
		>;
		if (resp.ok && body.ok === true) {
			return {
				ok: true,
				pluginName:
					typeof body.pluginName === "string" ? body.pluginName : undefined,
			};
		}
		return {
			ok: false,
			error:
				typeof body.error === "string"
					? body.error
					: `load returned HTTP ${resp.status}`,
		};
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

// "undo that creation", "roll back the wallet view", "revert the last edit",
// "restore the plugin" — all map to the rollback sub-mode. Kept narrow so a
// generic "go back" (a navigation request) does not hijack a rollback.
const ROLLBACK_RE =
	/\b(roll ?back|revert|undo)\b.{0,40}\b(view|views|plugin|plugins|edit|edits|change|changes|creation|create|app)\b|\b(view|views|plugin|plugins|edit|edits|change|changes|creation|app)\b.{0,40}\b(roll ?back|revert|undo)\b/i;

// A bare one-word reply to the verification-failure rollback offer
// ("rollback" / "roll back" / "revert"). Matches only when the entire trimmed
// message is that verb so it can't hijack unrelated turns.
const BARE_ROLLBACK_RE = /^(roll ?back|revert)$/i;

/**
 * True when the request asks to roll back / undo a view-or-plugin create/edit.
 * Explicit `action=rollback` is handled by the dispatcher's mode inference; this
 * covers natural-language phrasings and the bare 'rollback' reply to a failed
 * verification offer.
 */
export function isRollbackRequest(text: string): boolean {
	const trimmed = text.trim();
	return BARE_ROLLBACK_RE.test(trimmed) || ROLLBACK_RE.test(trimmed);
}

function readRollbackTarget(
	options: Record<string, unknown> | undefined,
): string | undefined {
	return (
		readStringOption(options, "view") ??
		readStringOption(options, "viewId") ??
		readStringOption(options, "id") ??
		readStringOption(options, "name") ??
		readStringOption(options, "target") ??
		readStringOption(options, "pluginName") ??
		undefined
	);
}

export async function runViewsRollback({
	runtime,
	message,
	options,
	callback,
	git,
	reregister = reregisterPluginFromWorkdir,
}: ViewsRollbackInput): Promise<ActionResult> {
	if (isRestrictedPlatform()) {
		const text =
			"Rolling back view/plugin changes is not available on this platform.";
		await callback?.({ text });
		return { success: false, text };
	}

	const roomId =
		typeof message.roomId === "string" ? message.roomId : runtime.agentId;
	const target = readRollbackTarget(options);
	const explicitSha = readStringOption(options, "sha");
	const explicitWorkdir = readStringOption(options, "workdir");

	const snapshot = await findSnapshotRecord(runtime, roomId, target);

	// Resolve the SHA + workdir from the explicit options first, falling back to
	// the persisted snapshot record.
	const sha = explicitSha ?? snapshot?.record.sha;
	const workdir = explicitWorkdir ?? snapshot?.record.workdir;
	const pluginName = snapshot?.record.pluginName ?? target ?? "the plugin";

	if (!sha || !workdir) {
		const text =
			"No pre-edit snapshot is on record to roll back to. Snapshots are taken automatically when you create or edit a view/plugin; nothing to undo here.";
		await callback?.({ text });
		return { success: false, text };
	}

	if (!isLikelySha(sha)) {
		const text = `"${sha}" is not a valid snapshot id; cannot roll back.`;
		await callback?.({ text });
		return { success: false, text };
	}

	const rollback = await rollbackToSnapshot(workdir, sha, { git });
	if (!rollback.ok) {
		const text = `Could not roll back ${pluginName} at ${workdir}: ${rollback.reason}.`;
		await callback?.({ text });
		logger.warn(
			`[plugin-app-control] VIEWS/rollback failed: ${rollback.reason}`,
		);
		return {
			success: false,
			text,
			values: { mode: "rollback", sha, workdir },
			data: { suppressActionResultClipboard: true },
		};
	}

	// Re-register the restored source via the same path create uses so the
	// running runtime reflects the rollback (views/actions deregister/re-register
	// through the plugin lifecycle hook).
	const reload = await reregister(workdir);

	// Consume the snapshot record so a second "rollback" doesn't reuse a stale SHA.
	if (snapshot) {
		await deleteSnapshotRecord(runtime, snapshot.taskId);
	}

	const restored = reload.pluginName ?? pluginName;
	const text = reload.ok
		? `Rolled ${restored} back to the pre-edit snapshot (${sha.slice(0, 7)}) and reloaded it live.`
		: `Rolled ${restored} back to the pre-edit snapshot (${sha.slice(0, 7)}) at ${workdir}, but live-reload failed: ${reload.error}. Reload the agent to pick up the restored source.`;
	await callback?.({ text });
	logger.info(
		`[plugin-app-control] VIEWS/rollback restored ${restored} to ${sha} reloaded=${reload.ok}`,
	);

	return {
		success: true,
		text,
		values: {
			mode: "rollback",
			sha,
			workdir,
			pluginName: restored,
			reloaded: reload.ok,
		},
		data: {
			sha,
			workdir,
			pluginName: restored,
			reloaded: reload.ok,
			suppressActionResultClipboard: true,
		},
	};
}
