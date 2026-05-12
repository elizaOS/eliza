import { promises as fs } from "node:fs";
import path from "node:path";
import { logger } from "../../../../logger.ts";
import type {
	ActionResult,
	HandlerCallback,
	HandlerOptions,
} from "../../../../types/components.ts";
import type { Memory } from "../../../../types/memory.ts";
import type { IAgentRuntime } from "../../../../types/runtime.ts";
import type { PluginManagerService } from "../../services/pluginManagerService.ts";
import type { EjectedPluginInfo } from "../../types.ts";

export const PLUGIN_CREATE_INTENT_TAG = "plugin-create-intent";

const TEMPLATE_CANDIDATES = [
	"packages/elizaos/templates/min-plugin",
	"eliza/packages/elizaos/templates/min-plugin",
] as const;
const PLUGINS_DIR_CANDIDATES = ["eliza/plugins", "plugins"] as const;
const NAME_PLACEHOLDER = "__PLUGIN_NAME__";
const DISPLAY_NAME_PLACEHOLDER = "__PLUGIN_DISPLAY_NAME__";
const CHOICE_RE = /^(new|edit-\d+|cancel)$/i;
const STOP_WORDS = new Set([
	"a",
	"an",
	"the",
	"to",
	"for",
	"of",
	"and",
	"or",
	"plugin",
	"plugins",
	"that",
	"this",
	"my",
	"new",
	"please",
	"create",
	"build",
	"make",
	"i",
	"want",
	"need",
]);
const KEBAB_RE = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;

export interface PluginCreateInput {
	runtime: IAgentRuntime;
	message: Memory;
	options?: Record<string, unknown>;
	callback?: HandlerCallback;
	intent?: string;
	choice?: string;
	editTarget?: string;
	repoRoot: string;
}

interface PluginChoice {
	key: string;
	label: string;
	pluginName?: string;
	pluginPath?: string;
}

export interface PluginCreateIntentMetadata {
	roomId: string;
	intent: string;
	choices: PluginChoice[];
	intentCreatedAt: string;
	[key: string]: object | string | number | boolean | null | undefined;
}

interface PluginMatch {
	plugin: EjectedPluginInfo;
	score: number;
}

interface TaskAgentStatus {
	sessionId: string;
	agentType: string;
	workdir: string;
	label: string;
	status: string;
	workspaceId?: string;
	branch?: string;
	error?: string;
}

type DispatchResult =
	| { dispatched: true; agents: TaskAgentStatus[] }
	| { dispatched: false; reason: string };

function tokenize(value: string): string[] {
	return value
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.map((token) => token.trim())
		.filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function deriveNames(intent: string): {
	packageName: string;
	displayName: string;
} {
	const tokens = tokenize(intent).slice(0, 4);
	const rawSlug = tokens.join("-") || "runtime-plugin";
	const slug = KEBAB_RE.test(rawSlug) ? rawSlug : "runtime-plugin";
	const bareName = slug.startsWith("plugin-") ? slug : `plugin-${slug}`;
	const displayName = tokens.length
		? tokens
				.map((token) => token.charAt(0).toUpperCase() + token.slice(1))
				.join(" ")
		: "Runtime Plugin";
	return { packageName: `@elizaos/${bareName}`, displayName };
}

function readStringOption(
	options: Record<string, unknown> | undefined,
	key: string,
): string | undefined {
	const direct = options?.[key];
	if (typeof direct === "string" && direct.trim()) return direct.trim();
	const parameters = options?.parameters;
	if (
		typeof parameters === "object" &&
		parameters !== null &&
		!Array.isArray(parameters)
	) {
		const nested = (parameters as Record<string, unknown>)[key];
		if (typeof nested === "string" && nested.trim()) return nested.trim();
	}
	return undefined;
}

function isDirectory(file: string): Promise<boolean> {
	return fs.stat(file).then(
		(stat) => stat.isDirectory(),
		() => false,
	);
}

async function resolveExistingDirectory(
	repoRoot: string,
	candidates: readonly string[],
	label: string,
): Promise<string> {
	for (const rel of candidates) {
		const candidate = path.join(repoRoot, rel);
		if (await isDirectory(candidate)) return candidate;
	}
	throw new Error(
		`Cannot find ${label}. Tried: ${candidates.map((rel) => path.join(repoRoot, rel)).join(", ")}`,
	);
}

async function findFreePluginDir(
	repoRoot: string,
	packageName: string,
): Promise<string> {
	const pluginsDir = await resolveExistingDirectory(
		repoRoot,
		PLUGINS_DIR_CANDIDATES,
		"plugins directory",
	);
	const baseName = packageName.replace(/^@[^/]+\//, "");
	let candidate = path.join(pluginsDir, baseName);
	let suffix = 2;
	while (await isDirectory(candidate)) {
		candidate = path.join(pluginsDir, `${baseName}-${suffix}`);
		suffix += 1;
		if (suffix > 50) {
			throw new Error(
				`Could not find a free plugin directory for ${packageName}`,
			);
		}
	}
	return candidate;
}

async function copyTemplate(
	src: string,
	dest: string,
	replacements: Record<string, string>,
): Promise<void> {
	const stack: Array<{ from: string; to: string }> = [{ from: src, to: dest }];
	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) break;
		const stat = await fs.stat(current.from);
		if (stat.isDirectory()) {
			await fs.mkdir(current.to, { recursive: true });
			for (const entry of await fs.readdir(current.from)) {
				stack.push({
					from: path.join(current.from, entry),
					to: path.join(current.to, entry),
				});
			}
			continue;
		}
		if (!stat.isFile()) continue;
		const raw = await fs.readFile(current.from);
		const text = raw.toString("utf8");
		if (Buffer.byteLength(text, "utf8") === raw.length) {
			let rewritten = text;
			for (const [token, value] of Object.entries(replacements)) {
				rewritten = rewritten.split(token).join(value);
			}
			await fs.writeFile(current.to, rewritten, "utf8");
		} else {
			await fs.writeFile(current.to, raw);
		}
	}
}

function readStringField(
	source: Record<string, unknown>,
	key: string,
): string | undefined {
	const value = source[key];
	return typeof value === "string" && value.trim().length > 0
		? value
		: undefined;
}

function readTaskAgents(result: ActionResult | undefined): TaskAgentStatus[] {
	const agents = result?.data?.agents;
	if (!Array.isArray(agents)) return [];
	return agents.flatMap((agent): TaskAgentStatus[] => {
		if (!agent || typeof agent !== "object" || Array.isArray(agent)) return [];
		const record = agent as Record<string, unknown>;
		const sessionId = readStringField(record, "sessionId");
		const agentType = readStringField(record, "agentType");
		const workdir = readStringField(record, "workdir");
		const label = readStringField(record, "label");
		const status = readStringField(record, "status");
		if (!sessionId || !agentType || !workdir || !label || !status) return [];
		return [
			{
				sessionId,
				agentType,
				workdir,
				label,
				status,
				workspaceId: readStringField(record, "workspaceId"),
				branch: readStringField(record, "branch"),
				error: readStringField(record, "error"),
			},
		];
	});
}

async function dispatchCodingAgent({
	runtime,
	prompt,
	label,
	workdir,
	pluginName,
	callback,
}: {
	runtime: IAgentRuntime;
	prompt: string;
	label: string;
	workdir: string;
	pluginName: string;
	callback?: HandlerCallback;
}): Promise<DispatchResult> {
	const createTask =
		runtime.actions?.find((action) => action.name === "START_CODING_TASK") ??
		runtime.actions?.find((action) => action.name === "CREATE_TASK");
	if (!createTask) {
		return {
			dispatched: false,
			reason: "START_CODING_TASK action not registered",
		};
	}

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
			validator: {
				service: "app-verification",
				method: "verifyPlugin",
				params: { workdir, pluginName },
			},
			onVerificationFail: "retry",
		},
	};

	const result = await createTask.handler(
		runtime,
		fakeMessage,
		undefined,
		handlerOptions,
		callback,
	);
	if (!result?.success) {
		return {
			dispatched: false,
			reason:
				result?.text ??
				(typeof result?.error === "string"
					? result.error
					: "START_CODING_TASK failed to start"),
		};
	}

	const agents = readTaskAgents(result);
	if (agents.length === 0) {
		return {
			dispatched: false,
			reason: "START_CODING_TASK did not return a tracked task status",
		};
	}
	return { dispatched: true, agents };
}

function buildCreatePrompt(
	intent: string,
	pluginName: string,
	displayName: string,
	workdir: string,
): string {
	return [
		`You are building a new Eliza plugin called "${displayName}".`,
		`The user's intent: ${intent}`,
		`The plugin source directory is ${workdir}. It has already been scaffolded from the min-plugin template.`,
		"Work in that source directory.",
		"Read SCAFFOLD.md before editing.",
		"Before signaling completion, run from the plugin directory: bun run typecheck, then bun run lint, then bun run test.",
		"After all three commands pass, emit exactly one completion line in this canonical schema:",
		`PLUGIN_CREATE_DONE {"pluginName":"${pluginName}","files":["src/index.ts"],"tests":{"passed":1,"failed":0},"lint":"ok","typecheck":"ok"}`,
		"Use files changed or added relative to the source directory.",
	].join("\n");
}

function buildEditPrompt(
	intent: string,
	plugin: EjectedPluginInfo,
	workdir: string,
): string {
	return [
		`You are modifying the existing Eliza plugin "${plugin.name}".`,
		`Source lives in ${workdir}.`,
		`User's request: ${intent}`,
		"Implement the requested change without refactoring unrelated code.",
		"Before signaling completion, run from the plugin directory: bun run typecheck, then bun run lint, then bun run test.",
		"After all three commands pass, emit exactly one completion line in this canonical schema:",
		`PLUGIN_CREATE_DONE {"pluginName":"${plugin.name}","files":["src/index.ts"],"tests":{"passed":1,"failed":0},"lint":"ok","typecheck":"ok"}`,
	].join("\n");
}

function rankMatches(
	intent: string,
	plugins: readonly EjectedPluginInfo[],
): PluginMatch[] {
	const intentTokens = new Set(tokenize(intent));
	if (intentTokens.size === 0) return [];
	const ranked: PluginMatch[] = [];
	for (const plugin of plugins) {
		const haystack = tokenize(`${plugin.name} ${plugin.path}`);
		let score = 0;
		for (const token of haystack) {
			if (intentTokens.has(token)) score += 1;
		}
		if (score > 0) ranked.push({ plugin, score });
	}
	return ranked.sort((a, b) => b.score - a.score).slice(0, 5);
}

function renderChoiceBlock(
	choiceId: string,
	matches: readonly PluginMatch[],
): string {
	const lines = [
		`[CHOICE:plugin-create id=${choiceId}]`,
		"new = Create new plugin",
	];
	matches.forEach((match, idx) => {
		lines.push(`edit-${idx + 1} = Edit existing: ${match.plugin.name}`);
	});
	lines.push("cancel = Cancel", "[/CHOICE]");
	return lines.join("\n");
}

async function listKnownPlugins(
	runtime: IAgentRuntime,
): Promise<EjectedPluginInfo[]> {
	const service = runtime.getService(
		"plugin_manager",
	) as PluginManagerService | null;
	if (!service) return [];
	const loaded = service.getAllPlugins().map((plugin) => ({
		name: plugin.name,
		path: "",
		version: "loaded",
		upstream: null,
	}));
	const installed = await service.listInstalledPlugins();
	const ejected = await service.listEjectedPlugins();
	const byName = new Map<string, EjectedPluginInfo>();
	for (const plugin of [...loaded, ...installed, ...ejected]) {
		byName.set(plugin.name, plugin);
	}
	return Array.from(byName.values());
}

async function findExistingIntentTask(
	runtime: IAgentRuntime,
	roomId: string,
): Promise<{ taskId: string; metadata: PluginCreateIntentMetadata } | null> {
	const tasks = await runtime.getTasks({
		agentIds: [runtime.agentId],
		tags: [PLUGIN_CREATE_INTENT_TAG],
	});
	const matching = tasks
		.filter((task) => {
			const meta = task.metadata as Record<string, unknown> | undefined;
			return meta?.roomId === roomId;
		})
		.sort((a, b) => {
			const aMeta = a.metadata as Record<string, unknown> | undefined;
			const bMeta = b.metadata as Record<string, unknown> | undefined;
			const aAt =
				typeof aMeta?.intentCreatedAt === "string"
					? Date.parse(aMeta.intentCreatedAt)
					: 0;
			const bAt =
				typeof bMeta?.intentCreatedAt === "string"
					? Date.parse(bMeta.intentCreatedAt)
					: 0;
			return bAt - aAt;
		});
	const top = matching[0];
	if (!top?.id) return null;
	const meta = top.metadata as Record<string, unknown> | undefined;
	if (!meta || typeof meta.intent !== "string") return null;
	const choicesRaw = Array.isArray(meta.choices) ? meta.choices : [];
	const choices: PluginChoice[] = choicesRaw
		.filter(
			(choice): choice is PluginChoice =>
				typeof choice === "object" &&
				choice !== null &&
				typeof (choice as { key?: unknown }).key === "string" &&
				typeof (choice as { label?: unknown }).label === "string",
		)
		.map((choice) => ({
			key: choice.key,
			label: choice.label,
			pluginName:
				typeof choice.pluginName === "string" ? choice.pluginName : undefined,
			pluginPath:
				typeof choice.pluginPath === "string" ? choice.pluginPath : undefined,
		}));
	return {
		taskId: top.id,
		metadata: {
			roomId,
			intent: meta.intent,
			choices,
			intentCreatedAt:
				typeof meta.intentCreatedAt === "string"
					? meta.intentCreatedAt
					: new Date().toISOString(),
		},
	};
}

async function persistIntentTask(
	runtime: IAgentRuntime,
	metadata: PluginCreateIntentMetadata,
): Promise<void> {
	await runtime.createTask({
		name: "PLUGIN_CREATE intent",
		description: `Awaiting user choice for: ${metadata.intent}`,
		tags: [PLUGIN_CREATE_INTENT_TAG],
		metadata,
	});
}

async function deleteIntentTask(
	runtime: IAgentRuntime,
	taskId: string,
): Promise<void> {
	await runtime.deleteTask(
		taskId as `${string}-${string}-${string}-${string}-${string}`,
	);
}

async function createNewPlugin({
	runtime,
	intent,
	repoRoot,
	callback,
}: {
	runtime: IAgentRuntime;
	intent: string;
	repoRoot: string;
	callback?: HandlerCallback;
}): Promise<ActionResult> {
	const { packageName, displayName } = deriveNames(intent);
	const templateSrc = await resolveExistingDirectory(
		repoRoot,
		TEMPLATE_CANDIDATES,
		"min-plugin template",
	);
	const workdir = await findFreePluginDir(repoRoot, packageName);
	await copyTemplate(templateSrc, workdir, {
		[NAME_PLACEHOLDER]: packageName,
		[DISPLAY_NAME_PLACEHOLDER]: displayName,
	});

	const dispatch = await dispatchCodingAgent({
		runtime,
		prompt: buildCreatePrompt(intent, packageName, displayName, workdir),
		label: `create-plugin:${packageName}`,
		workdir,
		pluginName: packageName,
		callback,
	});
	if (dispatch.dispatched === false) {
		const text = `Scaffolded ${displayName} at ${workdir}, but could not dispatch a coding agent: ${dispatch.reason}.`;
		await callback?.({ text });
		return { success: false, text, values: { mode: "create", workdir } };
	}

	const task = dispatch.agents[0];
	const text = `Started plugin create task for ${displayName} at ${workdir}. Task session ${task.sessionId} is ${task.status}; verification will run when it emits PLUGIN_CREATE_DONE.`;
	await callback?.({ text });
	logger.info(
		`[plugin-manager] PLUGIN/create new name=${packageName} workdir=${workdir} session=${task.sessionId}`,
	);
	return {
		success: true,
		text,
		values: {
			mode: "create",
			subMode: "new",
			name: packageName,
			displayName,
			workdir,
			taskStatus: task.status,
			taskSessionId: task.sessionId,
		},
		data: {
			name: packageName,
			displayName,
			workdir,
			task,
			agents: dispatch.agents,
		},
	};
}

async function editExistingPlugin({
	runtime,
	intent,
	plugin,
	callback,
}: {
	runtime: IAgentRuntime;
	intent: string;
	plugin: EjectedPluginInfo;
	callback?: HandlerCallback;
}): Promise<ActionResult> {
	if (!plugin.path) {
		const text = `Plugin "${plugin.name}" has no local source path. Eject it before editing.`;
		await callback?.({ text });
		return { success: false, text };
	}
	const dispatch = await dispatchCodingAgent({
		runtime,
		prompt: buildEditPrompt(intent, plugin, plugin.path),
		label: `edit-plugin:${plugin.name}`,
		workdir: plugin.path,
		pluginName: plugin.name,
		callback,
	});
	if (dispatch.dispatched === false) {
		const text = `Could not dispatch a coding agent to edit ${plugin.name}: ${dispatch.reason}.`;
		await callback?.({ text });
		return { success: false, text };
	}
	const task = dispatch.agents[0];
	const text = `Started plugin edit task for ${plugin.name} at ${plugin.path}. Task session ${task.sessionId} is ${task.status}; verification will run when it emits PLUGIN_CREATE_DONE.`;
	await callback?.({ text });
	return {
		success: true,
		text,
		values: {
			mode: "create",
			subMode: "edit",
			name: plugin.name,
			workdir: plugin.path,
			taskStatus: task.status,
			taskSessionId: task.sessionId,
		},
		data: { plugin, task, agents: dispatch.agents },
	};
}

export function isPluginCreateChoiceReply(text: string): boolean {
	return CHOICE_RE.test(text.trim());
}

export async function runCreate({
	runtime,
	message,
	options,
	callback,
	intent: explicitIntent,
	choice: explicitChoice,
	editTarget,
	repoRoot,
}: PluginCreateInput): Promise<ActionResult> {
	const roomId =
		typeof message.roomId === "string" ? message.roomId : runtime.agentId;
	const userText = (message.content?.text ?? "").trim();
	const optionChoice = readStringOption(options, "choice");
	const optionIntent = readStringOption(options, "intent");
	const optionEditTarget = readStringOption(options, "editTarget");
	const choiceText = explicitChoice ?? optionChoice ?? userText;
	const intent = explicitIntent ?? optionIntent ?? userText;
	const existing = await findExistingIntentTask(runtime, roomId);

	if (existing && isPluginCreateChoiceReply(choiceText)) {
		const normalized = choiceText.toLowerCase().trim();
		await deleteIntentTask(runtime, existing.taskId);
		if (normalized === "cancel") {
			const text = "Canceled. No plugin changes made.";
			await callback?.({ text });
			return {
				success: true,
				text,
				values: { mode: "create", subMode: "cancel" },
			};
		}
		if (normalized === "new") {
			return createNewPlugin({
				runtime,
				intent: existing.metadata.intent,
				repoRoot,
				callback,
			});
		}
		const idxMatch = normalized.match(/^edit-(\d+)$/);
		const idx = idxMatch ? Number(idxMatch[1]) - 1 : -1;
		const choice = existing.metadata.choices.filter((entry) =>
			entry.key.startsWith("edit-"),
		)[idx];
		const plugins = await listKnownPlugins(runtime);
		const target = plugins.find(
			(plugin) =>
				plugin.name === choice?.pluginName ||
				plugin.path === choice?.pluginPath,
		);
		if (!target) {
			const text = `Plugin edit target "${normalized}" is no longer available.`;
			await callback?.({ text });
			return { success: false, text };
		}
		return editExistingPlugin({
			runtime,
			intent: existing.metadata.intent,
			plugin: target,
			callback,
		});
	}

	const targetName = editTarget ?? optionEditTarget;
	if (targetName) {
		const plugins = await listKnownPlugins(runtime);
		const target = plugins.find(
			(plugin) => plugin.name === targetName || plugin.path === targetName,
		);
		if (!target) {
			const text = `Cannot find a local plugin named "${targetName}".`;
			await callback?.({ text });
			return { success: false, text };
		}
		return editExistingPlugin({ runtime, intent, plugin: target, callback });
	}

	if (!intent) {
		const text = "Tell me what plugin you want to build.";
		await callback?.({ text });
		return { success: false, text };
	}

	const plugins = await listKnownPlugins(runtime);
	const matches = rankMatches(intent, plugins).filter(
		(match) => match.plugin.path,
	);
	if (matches.length === 0) {
		return createNewPlugin({ runtime, intent, repoRoot, callback });
	}

	const choices: PluginChoice[] = [
		{ key: "new", label: "Create new plugin" },
		...matches.map((match, idx) => ({
			key: `edit-${idx + 1}`,
			label: `Edit existing: ${match.plugin.name}`,
			pluginName: match.plugin.name,
			pluginPath: match.plugin.path,
		})),
		{ key: "cancel", label: "Cancel" },
	];
	await persistIntentTask(runtime, {
		roomId,
		intent,
		choices,
		intentCreatedAt: new Date().toISOString(),
	});

	const text = renderChoiceBlock(
		`plugin-create-${Date.now().toString(36)}`,
		matches,
	);
	await callback?.({ text });
	return {
		success: true,
		text: "Picking next step...",
		values: { mode: "create", subMode: "choice", matchCount: matches.length },
		data: { choices, intent },
	};
}

export async function hasPendingPluginCreateIntent(
	runtime: IAgentRuntime,
	roomId: string,
): Promise<boolean> {
	return (await findExistingIntentTask(runtime, roomId)) !== null;
}
