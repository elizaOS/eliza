/**
 * @module plugin-app-control/actions/views-edit
 *
 * edit sub-mode of the VIEWS action.
 *
 * Resolves the target view by id/label/plugin, locates its source directory,
 * and dispatches a coding sub-agent (START_CODING_TASK) to perform the
 * requested edit. After the agent completes and emits PLUGIN_CREATE_DONE the
 * view registry picks up bundle changes automatically on the next request.
 *
 * Metadata-only edits (label, description, tags) require plugin config
 * changes, which are outside this coding sub-agent dispatch path.
 */

import type {
	ActionResult,
	HandlerCallback,
	HandlerOptions,
	IAgentRuntime,
	Memory,
} from "@elizaos/core";
import { logger, spawnWithTrajectoryLink } from "@elizaos/core";
import { readStringOption } from "../params.js";
import { findAsyncCodingDelegationActionName } from "./scaffold-env.js";
import type { ViewSummary } from "./views-client.js";
import { isRestrictedPlatform } from "./views-platform.js";
import { locatePluginSourceDir } from "./views-plugin-source.js";
import { scoreView } from "./views-search.js";
import {
	createPreEditSnapshot,
	persistSnapshotRecord,
} from "./views-snapshot.js";

export interface ViewsEditInput {
	runtime: IAgentRuntime;
	message: Memory;
	options?: Record<string, unknown>;
	views: ViewSummary[];
	callback?: HandlerCallback;
	repoRoot: string;
}

// ---------------------------------------------------------------------------
// View resolution
// ---------------------------------------------------------------------------

export function resolveTargetView(
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

function extractEditTarget(
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

const EDIT_VERBS = [
	"edit",
	"update",
	"modify",
	"change",
	"fix",
	"improve",
	"rewrite",
];
const FILLER = new Set(["the", "view", "plugin", "a", "an"]);

function extractTargetFromText(text: string): string | null {
	const lower = text.toLowerCase();
	for (const verb of EDIT_VERBS) {
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
// Coding-agent dispatch
// ---------------------------------------------------------------------------

interface TaskAgentStatus {
	sessionId: string;
	agentType: string;
	workdir: string;
	label: string;
	status: string;
}

function readTaskAgents(result: ActionResult | undefined): TaskAgentStatus[] {
	const data = result?.data;
	const agents = Array.isArray(data?.agents)
		? data.agents
		: data && typeof data === "object" && "sessionId" in data
			? [data]
			: [];
	return agents.flatMap((agent): TaskAgentStatus[] => {
		if (!agent || typeof agent !== "object" || Array.isArray(agent)) return [];
		const r = agent as Record<string, unknown>;
		const sessionId = typeof r.sessionId === "string" ? r.sessionId : undefined;
		const agentType = typeof r.agentType === "string" ? r.agentType : undefined;
		const workdir = typeof r.workdir === "string" ? r.workdir : undefined;
		const label = typeof r.label === "string" ? r.label : undefined;
		const status = typeof r.status === "string" ? r.status : undefined;
		if (!sessionId || !agentType || !workdir || !label || !status) return [];
		return [{ sessionId, agentType, workdir, label, status }];
	});
}

async function dispatchEditAgent({
	runtime,
	view,
	intent,
	workdir,
	originRoomId,
	callback,
}: {
	runtime: IAgentRuntime;
	view: ViewSummary;
	intent: string;
	workdir: string;
	originRoomId: string;
	callback?: HandlerCallback;
}): Promise<ActionResult> {
	const createTaskName = findAsyncCodingDelegationActionName(
		runtime.actions ?? [],
	);
	const createTask = runtime.actions.find((a) => a.name === createTaskName);
	if (!createTask) {
		const text =
			"Coding delegation action not registered; cannot dispatch a coding agent.";
		await callback?.({ text });
		return { success: false, text };
	}

	const prompt = [
		"task: edit_eliza_plugin_view",
		`pluginName: ${view.pluginName}`,
		`viewId: ${view.id}`,
		`viewLabel: ${view.label}`,
		`intent: ${intent}`,
		`sourceDir: ${workdir}`,
		"referenceDocs: read SCAFFOLD.md or AGENTS.md if present, otherwise README.md",
		"implementation: minimal requested change; no unrelated refactors",
		"verificationCommands[3]:",
		"  bun run typecheck",
		"  bun run lint",
		"  bun run test",
		"completionRule: after all commands pass, emit exactly one completion line in this canonical schema",
		`PLUGIN_CREATE_DONE {"pluginName":"${view.pluginName}","files":[],"tests":{"passed":1,"failed":0},"lint":"ok","typecheck":"ok"}`,
	].join("\n");

	const label = `edit-view:${view.id}`;
	const fakeMessage = {
		entityId: runtime.agentId,
		roomId: runtime.agentId,
		agentId: runtime.agentId,
		content: { text: prompt },
	} as Memory;

	const handlerOptions: HandlerOptions = {
		parameters: {
			task: prompt,
			label,
			approvalPreset: "permissive",
			metadata: { originRoomId },
		},
	};

	const result = await spawnWithTrajectoryLink(
		runtime,
		{
			source: "plugin-app-control:views-edit",
			metadata: { viewId: view.id, label, workdir },
		},
		async (trajectory) => {
			if (trajectory.parentStepId) {
				const parameters = handlerOptions.parameters as Record<string, unknown>;
				const existingMeta =
					parameters.metadata &&
					typeof parameters.metadata === "object" &&
					!Array.isArray(parameters.metadata)
						? (parameters.metadata as Record<string, unknown>)
						: {};
				parameters.metadata = {
					...existingMeta,
					parentTrajectoryStepId: trajectory.parentStepId,
					trajectoryLinkSource: "plugin-app-control:views-edit",
				};
			}
			const r = await createTask.handler(
				runtime,
				fakeMessage,
				undefined,
				handlerOptions,
				callback,
			);
			for (const agent of readTaskAgents(r)) {
				await trajectory.linkChild(agent.sessionId);
			}
			return r;
		},
	);

	if (!result?.success) {
		const text = `Could not dispatch a coding agent to edit ${view.label}: ${result?.text ?? "START_CODING_TASK failed"}.`;
		await callback?.({ text });
		return {
			success: false,
			text,
			data: { suppressActionResultClipboard: true },
		};
	}

	const agents = readTaskAgents(result);
	if (agents.length === 0) {
		const text = `Coding agent dispatch did not return a task status for ${view.label}.`;
		await callback?.({ text });
		return { success: false, text };
	}

	const task = agents[0];
	const text = `Started view edit task for ${view.label} at ${workdir}. Task session ${task.sessionId} is ${task.status}.`;
	await callback?.({ text });
	logger.info(
		`[plugin-app-control] VIEWS/edit viewId=${view.id} workdir=${workdir} session=${task.sessionId}`,
	);

	return {
		success: true,
		text,
		values: {
			mode: "edit",
			viewId: view.id,
			label: view.label,
			workdir,
			taskStatus: task.status,
			taskSessionId: task.sessionId,
		},
		data: { view, workdir, task, agents, suppressActionResultClipboard: true },
	};
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export async function runViewsEdit({
	runtime,
	message,
	options,
	views,
	callback,
	repoRoot,
}: ViewsEditInput): Promise<ActionResult> {
	if (isRestrictedPlatform()) {
		const text = "Plugin editing is not available on this platform.";
		await callback?.({ text });
		return { success: false, text };
	}

	const targetStr = extractEditTarget(message, options);
	if (!targetStr) {
		const text =
			'Tell me which view to edit. Try: "edit the wallet view" or "update the LifeOps plugin".';
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
		const text = `"${targetStr}" matches multiple views:\n${list}\nWhich one did you mean?`;
		await callback?.({ text });
		return {
			success: false,
			text,
			data: { candidates: resolution.candidates },
		};
	}

	const view = resolution.view;
	const intent = (
		readStringOption(options, "intent") ??
		message.content.text ??
		""
	).trim();
	if (!intent) {
		const text = `What change should I make to ${view.label}?`;
		await callback?.({ text });
		return { success: false, text };
	}

	const workdir = await locatePluginSourceDir(repoRoot, view);
	if (!workdir) {
		const text = `Could not locate the source directory for ${view.label} (${view.pluginName}). Make sure the plugin is installed from a local source.`;
		await callback?.({ text });
		return { success: false, text };
	}

	const roomId =
		typeof message.roomId === "string" ? message.roomId : runtime.agentId;

	// Pre-edit snapshot so the edit can be rolled back (#8915). Best-effort: a
	// failed snapshot only disables rollback for this edit, never blocks it.
	const snapshot = await createPreEditSnapshot(workdir).catch((err) => ({
		ok: false as const,
		reason: err instanceof Error ? err.message : String(err),
	}));
	if (snapshot.ok) {
		await persistSnapshotRecord(runtime, {
			sha: snapshot.sha,
			workdir,
			pluginName: view.pluginName,
			created: false,
			roomId,
			snapshotCreatedAt: new Date().toISOString(),
		}).catch((err) => {
			logger.warn(
				`[plugin-app-control] VIEWS/edit failed to persist snapshot for ${view.pluginName}: ${err instanceof Error ? err.message : String(err)}`,
			);
		});
	} else {
		logger.warn(
			`[plugin-app-control] VIEWS/edit pre-edit snapshot skipped for ${view.pluginName}: ${snapshot.reason}`,
		);
	}

	return dispatchEditAgent({
		runtime,
		view,
		intent,
		workdir,
		originRoomId: roomId,
		callback,
	});
}
