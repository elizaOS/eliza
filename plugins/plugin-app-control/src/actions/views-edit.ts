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
 * Metadata edits (label, description, tags) that don't require UI changes
 * are not yet supported via this handler — those require plugin config surgery
 * which is out of scope for a coding sub-agent dispatch.
 */

import { promises as fs } from "node:path";
import path from "node:path";
import type {
	ActionResult,
	HandlerCallback,
	HandlerOptions,
	IAgentRuntime,
	Memory,
} from "@elizaos/core";
import { logger, spawnWithTrajectoryLink } from "@elizaos/core";
import { readStringOption } from "../params.js";
import type { ViewSummary } from "./views-client.js";
import { scoreView } from "./views-search.js";
import { isRestrictedPlatform } from "./views.js";

const PLUGINS_DIR_CANDIDATES = ["eliza/plugins", "plugins"] as const;

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

function resolveTargetView(
	target: string,
	views: readonly ViewSummary[],
): { kind: "match"; view: ViewSummary } | { kind: "ambiguous"; candidates: ViewSummary[] } | { kind: "none" } {
	const q = target.toLowerCase();

	const byId = views.find((v) => v.id.toLowerCase() === q);
	if (byId) return { kind: "match", view: byId };

	const byLabel = views.find((v) => v.label.toLowerCase() === q);
	if (byLabel) return { kind: "match", view: byLabel };

	const byPlugin = views.find((v) => v.pluginName.toLowerCase() === q || v.pluginName.replace(/^@[^/]+\//, "").toLowerCase() === q);
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
		extractTargetFromText(message.content?.text ?? "")
	);
}

const EDIT_VERBS = ["edit", "update", "modify", "change", "fix", "improve", "rewrite"];
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
// Source dir lookup
// ---------------------------------------------------------------------------

async function locatePluginSourceDir(
	repoRoot: string,
	view: ViewSummary,
): Promise<string | null> {
	const pluginBasename = view.pluginName.replace(/^@[^/]+\//, "").trim();
	const candidates = [
		...PLUGINS_DIR_CANDIDATES.map((d) => path.join(repoRoot, d, pluginBasename)),
		path.join(repoRoot, "eliza", "apps", pluginBasename),
	];
	for (const candidate of candidates) {
		const stat = await (fs as unknown as typeof import("node:fs").promises).stat(candidate).catch(() => null);
		if (stat?.isDirectory()) return candidate;
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
	const agents = result?.data?.agents;
	if (!Array.isArray(agents)) return [];
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
	const createTask =
		runtime.actions?.find((a) => a.name === "START_CODING_TASK") ??
		runtime.actions?.find((a) => a.name === "CREATE_TASK");
	if (!createTask) {
		const text = "START_CODING_TASK action not registered; cannot dispatch a coding agent.";
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
		{ source: "plugin-app-control:views-edit", metadata: { viewId: view.id, label, workdir } },
		async (trajectory) => {
			if (trajectory.parentStepId) {
				const parameters = handlerOptions.parameters as Record<string, unknown>;
				const existingMeta =
					parameters.metadata && typeof parameters.metadata === "object" && !Array.isArray(parameters.metadata)
						? (parameters.metadata as Record<string, unknown>)
						: {};
				parameters.metadata = {
					...existingMeta,
					parentTrajectoryStepId: trajectory.parentStepId,
					trajectoryLinkSource: "plugin-app-control:views-edit",
				};
			}
			const r = await createTask.handler(runtime, fakeMessage, undefined, handlerOptions, callback);
			for (const agent of readTaskAgents(r)) {
				await trajectory.linkChild(agent.sessionId);
			}
			return r;
		},
	);

	if (!result?.success) {
		const text = `Could not dispatch a coding agent to edit ${view.label}: ${result?.text ?? "START_CODING_TASK failed"}.`;
		await callback?.({ text });
		return { success: false, text, data: { suppressActionResultClipboard: true } };
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
	logger.info(`[plugin-app-control] VIEWS/edit viewId=${view.id} workdir=${workdir} session=${task.sessionId}`);

	return {
		success: true,
		text,
		values: { mode: "edit", viewId: view.id, label: view.label, workdir, taskStatus: task.status, taskSessionId: task.sessionId },
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
		const list = resolution.candidates.map((v) => `- ${v.label} (${v.id})`).join("\n");
		const text = `"${targetStr}" matches multiple views:\n${list}\nWhich one did you mean?`;
		await callback?.({ text });
		return { success: false, text, data: { candidates: resolution.candidates } };
	}

	const view = resolution.view;
	const intent = (readStringOption(options, "intent") ?? message.content?.text ?? "").trim();
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

	const roomId = typeof message.roomId === "string" ? message.roomId : runtime.agentId;
	return dispatchEditAgent({ runtime, view, intent, workdir, originRoomId: roomId, callback });
}
