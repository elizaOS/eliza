/**
 * @module plugin-app-control/actions/views-delete
 *
 * delete sub-mode of the VIEWS action.
 *
 * Resolves the target view plugin, checks it against the protected-apps list,
 * requires a multi-turn confirmation ("yes" reply), then unloads the plugin
 * via POST /api/apps/stop (which triggers plugin uninstall when the stopScope
 * supports it). The view registry entry is cleaned up by the plugin lifecycle
 * hook.
 *
 * Two-turn flow:
 *  1. First turn  — match view, check protection, render confirmation prompt,
 *     store pending-delete Task tagged "views-delete-confirm" keyed by roomId.
 *  2. Second turn — user replies "yes"; delete task is consumed, plugin
 *     unloaded, confirmation emitted.
 */

import type {
	ActionResult,
	HandlerCallback,
	IAgentRuntime,
	Memory,
} from "@elizaos/core";
import { logger, resolveServerOnlyPort } from "@elizaos/core";
import { readStringOption } from "../params.js";
import { isProtected, resolveProtectedApps } from "../protected-apps.js";
import type { ViewSummary } from "./views-client.js";
import { scoreView } from "./views-search.js";

/** Core first-party plugins that must never be deleted via the VIEWS action. */
const CORE_PROTECTED_PLUGIN_NAMES = new Set([
	"@elizaos/app-core",
	"@elizaos/plugin-app-control",
	"@elizaos/agent",
	"@elizaos/builtin",
]);

const DELETE_CONFIRM_TAG = "views-delete-confirm";

export interface ViewsDeleteInput {
	runtime: IAgentRuntime;
	message: Memory;
	options?: Record<string, unknown>;
	views: ViewSummary[];
	callback?: HandlerCallback;
	repoRoot: string;
}

interface DeleteConfirmMetadata {
	roomId: string;
	viewId: string;
	viewLabel: string;
	pluginName: string;
	confirmedAt?: string;
}

// ---------------------------------------------------------------------------
// View resolution helpers
// ---------------------------------------------------------------------------

function resolveTargetView(
	target: string,
	views: readonly ViewSummary[],
):
	| { kind: "match"; view: ViewSummary }
	| { kind: "ambiguous"; candidates: ViewSummary[] }
	| { kind: "none" } {
	const q = target.toLowerCase();

	const byId = views.find((v) => v.id.toLowerCase() === q);
	if (byId) return { kind: "match", view: byId };

	const byLabel = views.find((v) => v.label.toLowerCase() === q);
	if (byLabel) return { kind: "match", view: byLabel };

	const byPlugin = views.find(
		(v) =>
			v.pluginName.toLowerCase() === q ||
			v.pluginName.replace(/^@[^/]+\//, "").toLowerCase() === q,
	);
	if (byPlugin) return { kind: "match", view: byPlugin };

	const scored = views
		.map((v) => ({ view: v, score: scoreView(v, target) }))
		.filter(({ score }) => score > 0)
		.sort((a, b) => b.score - a.score);

	if (scored.length === 0) return { kind: "none" };
	if (scored.length === 1) return { kind: "match", view: scored[0].view };

	const topScore = scored[0].score;
	const topTied = scored.filter(({ score }) => score === topScore);
	if (topTied.length === 1) return { kind: "match", view: topTied[0].view };

	return { kind: "ambiguous", candidates: topTied.map(({ view }) => view) };
}

function extractDeleteTarget(
	message: Memory,
	options: Record<string, unknown> | undefined,
): string | null {
	return (
		readStringOption(options, "view") ??
		readStringOption(options, "viewId") ??
		readStringOption(options, "id") ??
		readStringOption(options, "name") ??
		extractTargetFromText(message.content.text ?? "")
	);
}

const DELETE_VERBS = ["delete", "remove", "uninstall", "destroy", "drop"];
const FILLER = new Set(["the", "view", "plugin", "a", "an"]);

function extractTargetFromText(text: string): string | null {
	const lower = text.toLowerCase();
	for (const verb of DELETE_VERBS) {
		const idx = lower.indexOf(verb);
		if (idx === -1) continue;
		const rest = text.slice(idx + verb.length).trim();
		if (!rest) continue;
		const tokens = rest
			.split(/[\s,!.?]+/)
			.map((t) => t.trim())
			.filter((t) => t.length > 0);
		let i = 0;
		while (i < tokens.length && FILLER.has(tokens[i].toLowerCase())) i++;
		const candidate = tokens.slice(i).join(" ").toLowerCase();
		if (candidate && !FILLER.has(candidate)) return candidate;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Protection check
// ---------------------------------------------------------------------------

async function checkProtection(
	pluginName: string,
	repoRoot: string,
): Promise<string | null> {
	// Fast path: hardcoded core set.
	for (const name of CORE_PROTECTED_PLUGIN_NAMES) {
		if (
			pluginName === name ||
			pluginName.replace(/^@[^/]+\//, "") === name.replace(/^@[^/]+\//, "")
		) {
			return name;
		}
	}

	// Also check ELIZA_PROTECTED_APPS env + first-party dir scan.
	const resolution = await resolveProtectedApps(repoRoot);
	if (isProtected(pluginName, resolution)) {
		return pluginName;
	}

	return null;
}

// ---------------------------------------------------------------------------
// Confirmation task persistence
// ---------------------------------------------------------------------------

async function findConfirmTask(
	runtime: IAgentRuntime,
	roomId: string,
): Promise<{ taskId: string; metadata: DeleteConfirmMetadata } | null> {
	const tasks = await runtime.getTasks({
		agentIds: [runtime.agentId],
		tags: [DELETE_CONFIRM_TAG],
	});
	const matching = tasks
		.filter((t) => {
			const meta = t.metadata as Record<string, unknown> | undefined;
			return meta?.roomId === roomId;
		})
		.sort((a, b) => {
			const aMeta = a.metadata as Record<string, unknown> | undefined;
			const bMeta = b.metadata as Record<string, unknown> | undefined;
			const aAt =
				typeof aMeta?.confirmedAt === "string"
					? 0
					: Date.parse(String(aMeta?.roomId ?? "")) || 0;
			const bAt =
				typeof bMeta?.confirmedAt === "string"
					? 0
					: Date.parse(String(bMeta?.roomId ?? "")) || 0;
			return bAt - aAt;
		});

	const top = matching[0];
	if (!top?.id) return null;
	const meta = top.metadata as Record<string, unknown> | undefined;
	if (
		!meta ||
		typeof meta.viewId !== "string" ||
		typeof meta.viewLabel !== "string" ||
		typeof meta.pluginName !== "string"
	) {
		return null;
	}
	return {
		taskId: top.id,
		metadata: {
			roomId,
			viewId: meta.viewId,
			viewLabel: meta.viewLabel,
			pluginName: meta.pluginName,
		},
	};
}

async function persistConfirmTask(
	runtime: IAgentRuntime,
	metadata: DeleteConfirmMetadata,
): Promise<void> {
	await runtime.createTask({
		name: "VIEWS_DELETE confirm",
		description: `Awaiting user confirmation to delete: ${metadata.viewLabel}`,
		tags: [DELETE_CONFIRM_TAG],
		metadata: {
			roomId: metadata.roomId,
			viewId: metadata.viewId,
			viewLabel: metadata.viewLabel,
			pluginName: metadata.pluginName,
		},
	});
}

async function deleteConfirmTask(
	runtime: IAgentRuntime,
	taskId: string,
): Promise<void> {
	await runtime
		.deleteTask(taskId as `${string}-${string}-${string}-${string}-${string}`)
		.catch((err) => {
			logger.warn(
				`[plugin-app-control] VIEWS/delete failed to delete confirm task ${taskId}: ${err instanceof Error ? err.message : String(err)}`,
			);
		});
}

// ---------------------------------------------------------------------------
// Plugin unload
// ---------------------------------------------------------------------------

async function unloadPlugin(
	pluginName: string,
): Promise<{ ok: boolean; message: string }> {
	const port = resolveServerOnlyPort(process.env);
	const base = `http://127.0.0.1:${port}`;

	// Attempt plugin uninstall via the apps/stop endpoint — this is the canonical
	// way to signal plugin-level teardown. The view registry deregisters on plugin
	// unload via its lifecycle hook.
	try {
		const resp = await fetch(`${base}/api/apps/stop`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: pluginName }),
			signal: AbortSignal.timeout(15_000),
		});

		if (resp.ok) {
			const body = (await resp.json().catch(() => ({}))) as Record<
				string,
				unknown
			>;
			const msg =
				typeof body.message === "string"
					? body.message
					: `Plugin ${pluginName} unloaded.`;
			return { ok: true, message: msg };
		}

		// 404 means the plugin isn't tracked as an installed app — may just be a
		// runtime-loaded plugin. Treat as a soft success.
		if (resp.status === 404) {
			return {
				ok: true,
				message: `Plugin ${pluginName} was not tracked as an installed app; no uninstall performed.`,
			};
		}

		const errBody = await resp.text().catch(() => "");
		return {
			ok: false,
			message: `Unload failed (HTTP ${resp.status}): ${errBody}`,
		};
	} catch (err) {
		return {
			ok: false,
			message: `Unload request failed: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}

// ---------------------------------------------------------------------------
// Confirmation reply detection
// ---------------------------------------------------------------------------

const YES_RE = /^\s*yes\s*\.?\s*$/i;
const NO_RE = /^\s*(no|cancel|abort|nope|n)\s*\.?\s*$/i;

export function isDeleteConfirmation(text: string): boolean {
	return YES_RE.test(text);
}

export function isDeleteCancellation(text: string): boolean {
	return NO_RE.test(text);
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export async function runViewsDelete({
	runtime,
	message,
	options,
	views,
	callback,
	repoRoot,
}: ViewsDeleteInput): Promise<ActionResult> {
	const roomId =
		typeof message.roomId === "string" ? message.roomId : runtime.agentId;
	const userText = (message.content.text ?? "").trim();

	// Follow-up turn: user replied "yes" / "no" to a pending confirmation.
	const existingConfirm = await findConfirmTask(runtime, roomId);
	if (existingConfirm) {
		if (isDeleteConfirmation(userText)) {
			await deleteConfirmTask(runtime, existingConfirm.taskId);

			const { metadata } = existingConfirm;
			logger.info(
				`[plugin-app-control] VIEWS/delete confirmed viewId=${metadata.viewId} pluginName=${metadata.pluginName}`,
			);

			const unload = await unloadPlugin(metadata.pluginName);
			const text = unload.ok
				? `Deleted ${metadata.viewLabel} (${metadata.pluginName}). ${unload.message}`
				: `Deletion partially failed for ${metadata.viewLabel}: ${unload.message}`;

			await callback?.({ text });
			return {
				success: unload.ok,
				text,
				values: {
					mode: "delete",
					viewId: metadata.viewId,
					pluginName: metadata.pluginName,
				},
				data: {
					viewId: metadata.viewId,
					pluginName: metadata.pluginName,
					unloadResult: unload,
				},
			};
		}

		if (isDeleteCancellation(userText)) {
			await deleteConfirmTask(runtime, existingConfirm.taskId);
			const text = "Canceled. No views were deleted.";
			await callback?.({ text });
			return {
				success: true,
				text,
				values: { mode: "delete", subMode: "cancel" },
			};
		}

		// Unrecognised reply — re-prompt.
		const text = `Reply "yes" to confirm deletion of ${existingConfirm.metadata.viewLabel}, or "cancel" to abort.`;
		await callback?.({ text });
		return { success: false, text };
	}

	// First turn: resolve the view the user wants to delete.
	const targetStr =
		readStringOption(options, "confirm") === "true"
			? (readStringOption(options, "view") ??
				readStringOption(options, "viewId") ??
				userText)
			: extractDeleteTarget(message, options);

	if (!targetStr) {
		const text =
			'Tell me which view to delete. Try: "delete the wallet view" or "remove the LifeOps plugin".';
		await callback?.({ text });
		return { success: false, text };
	}

	const resolution = resolveTargetView(targetStr, views);

	if (resolution.kind === "none") {
		const text = `No view matches "${targetStr}". Try \`action=list\` to see available views.`;
		await callback?.({ text });
		return { success: false, text, data: { target: targetStr } };
	}

	if (resolution.kind === "ambiguous") {
		const list = resolution.candidates
			.map((v) => `- ${v.label} (${v.id})`)
			.join("\n");
		const text = `"${targetStr}" matches multiple views:\n${list}\nWhich one did you want to delete?`;
		await callback?.({ text });
		return {
			success: false,
			text,
			data: { candidates: resolution.candidates },
		};
	}

	const view = resolution.view;

	// Protection check.
	const protectedMatch = await checkProtection(view.pluginName, repoRoot);
	if (protectedMatch !== null) {
		const text = `Cannot delete ${view.label} — it is a protected first-party plugin (${protectedMatch}).`;
		await callback?.({ text });
		return { success: false, text, data: { viewId: view.id, protectedMatch } };
	}

	// Explicit confirm=true in options short-circuits the multi-turn flow.
	const explicitConfirm = readStringOption(options, "confirm");
	if (explicitConfirm === "true" || explicitConfirm === "yes") {
		logger.info(
			`[plugin-app-control] VIEWS/delete explicit-confirm viewId=${view.id} pluginName=${view.pluginName}`,
		);
		const unload = await unloadPlugin(view.pluginName);
		const text = unload.ok
			? `Deleted ${view.label} (${view.pluginName}). ${unload.message}`
			: `Deletion partially failed for ${view.label}: ${unload.message}`;
		await callback?.({ text });
		return {
			success: unload.ok,
			text,
			values: { mode: "delete", viewId: view.id, pluginName: view.pluginName },
			data: {
				viewId: view.id,
				pluginName: view.pluginName,
				unloadResult: unload,
			},
		};
	}

	// Persist confirmation task and prompt user.
	await persistConfirmTask(runtime, {
		roomId,
		viewId: view.id,
		viewLabel: view.label,
		pluginName: view.pluginName,
	});

	const text = `Are you sure you want to delete the ${view.label} view (${view.pluginName})? Reply "yes" to confirm or "cancel" to abort.`;
	await callback?.({ text });
	logger.info(
		`[plugin-app-control] VIEWS/delete awaiting confirmation viewId=${view.id} pluginName=${view.pluginName} room=${roomId}`,
	);

	return {
		success: true,
		text,
		values: {
			mode: "delete",
			subMode: "confirm",
			viewId: view.id,
			pluginName: view.pluginName,
		},
		data: { view },
	};
}

export async function hasPendingDeleteConfirm(
	runtime: IAgentRuntime,
	roomId: string,
): Promise<boolean> {
	const existing = await findConfirmTask(runtime, roomId);
	return existing !== null;
}
