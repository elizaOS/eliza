import { RuntimeRemoteClient } from "../protocol/runtime-client.ts";
import { collectElements, renderSurface } from "./render.ts";
import {
	addAssistantStreamMessage,
	addError,
	addUserMessage,
	appendPtyOutput,
	applyRuntimeEvent,
	createInitialState,
	selectAgent,
	selectConversation,
	setPtyOutput,
	setPtySession,
	type SurfaceRuntimeStatus,
} from "./state.ts";

const RUNTIME_EVENTS = [
	"runtime.statusChanged",
	"runtime.log",
	"runtime.error",
	"runtime.started",
	"runtime.stopped",
	"agent.message.stream.started",
	"agent.message.stream.delta",
	"agent.message.stream.snapshot",
	"agent.message.stream.action",
	"agent.message.stream.error",
	"agent.message.stream.done",
	"agent.message.stream.cancelled",
] as const;

export function initSurfaceApp(
	client = new RuntimeRemoteClient(),
	documentRef: Document = document,
): SurfaceRuntimeStatus {
	const state = createInitialState();
	const elements = collectElements(documentRef);
	const render = () => renderSurface(state, elements);

	for (const eventName of RUNTIME_EVENTS) {
		client.on(eventName, (payload) => {
			applyRuntimeEvent(state, eventName, payload);
			render();
		});
	}

	const bindAction = (id: string, action: () => Promise<void>) =>
		bind(documentRef, id, () => runAction(state, render, action));

	bindAction("runtime-start", async () => {
		state.runtimeState = await client.start();
	});
	bindAction("runtime-stop", async () => {
		state.runtimeState = await client.stop();
	});
	bindAction("runtime-restart", async () => {
		state.runtimeState = await client.restart();
	});
	bindAction("runtime-status", async () => {
		state.runtimeState = await client.status();
	});
	bindAction("runtime-health", async () => {
		state.health = await client.health();
		state.output = state.health;
	});
	bindAction("runtime-logs", async () => {
		state.logs = await client.logsTail(readNumber(documentRef, "log-limit", 80));
	});
	bindAction("api-discover", async () => {
		state.apiDiscovery = await client.discoverApi();
		state.output = state.apiDiscovery;
	});
	bindAction("api-status", async () => {
		state.output = await client.apiStatus();
	});
	bindAction("agent-list", async () => {
		state.agents = await client.listAgents();
	});
	bindAction("agent-get", async () => {
		state.output = await client.getAgent(readText(documentRef, "agent-id"));
	});
	bindAction("conversation-list", async () => {
		state.conversations = await client.listConversations();
	});
	bindAction("conversation-get", async () => {
		state.output = await client.getConversation(
			readText(documentRef, "conversation-id"),
		);
	});
	bindAction("message-send", async () => {
		const text = readText(documentRef, "message-text");
		addUserMessage(state, text);
		state.output = await client.sendMessage({
			agentId: readOptional(documentRef, "agent-id"),
			conversationId: readOptional(documentRef, "conversation-id"),
			text,
		});
	});
	bindAction("message-stream", async () => {
		const text = readText(documentRef, "message-text");
		addUserMessage(state, text);
		const result = await client.startMessageStream({
			agentId: readOptional(documentRef, "agent-id"),
			conversationId: readOptional(documentRef, "conversation-id"),
			text,
		});
		addAssistantStreamMessage(state, result.streamId);
		state.output = result;
	});
	bindAction("message-cancel", async () => {
		const streamId = state.activeStreamId ?? readText(documentRef, "stream-id");
		state.output = await client.cancelMessageStream(streamId);
	});
	bindAction("message-stream-status", async () => {
		const streamId = state.activeStreamId ?? readText(documentRef, "stream-id");
		state.output = await client.getMessageStreamStatus(streamId);
	});
	bindAction("plugin-list", async () => {
		state.plugins = await client.listPlugins();
	});
	bindAction("memory-search", async () => {
		state.output = await client.searchMemory({
			query: readText(documentRef, "memory-query"),
			limit: readNumber(documentRef, "memory-limit", 10),
			agentId: readOptional(documentRef, "agent-id"),
		});
	});
	bindAction("config-get", async () => {
		state.config = await client.getConfig();
		state.output = state.config;
	});
	bindAction("file-status", async () => {
		state.fileStatus = await client.fsStatus();
		state.output = state.fileStatus;
	});
	bindAction("file-roots-button", async () => {
		state.fileRoots = await client.fsRoots();
	});
	bindAction("file-list-button", async () => {
		state.fileList = await client.fsList({
			path: readOptional(documentRef, "file-path"),
			includeHidden: readCheckbox(documentRef, "file-include-hidden"),
		});
	});
	bindAction("file-read-button", async () => {
		state.fileText = await client.fsReadText({
			path: readText(documentRef, "file-path"),
		});
	});
	bindAction("file-search-button", async () => {
		state.fileSearch = await client.fsSearch({
			path: readOptional(documentRef, "file-path"),
			query: readText(documentRef, "file-search-query"),
			includeHidden: readCheckbox(documentRef, "file-include-hidden"),
		});
	});
	bindAction("file-write-button", async () => {
		if (!readCheckbox(documentRef, "file-enable-write")) {
			throw new Error("Enable write in the File panel before sending writeText.");
		}
		state.output = await client.fsWriteText({
			path: readText(documentRef, "file-path"),
			text: readText(documentRef, "file-write-text"),
			createDirectories: readCheckbox(documentRef, "file-create-directories"),
			overwrite: readCheckbox(documentRef, "file-overwrite"),
		});
	});
	bindAction("pty-status-button", async () => {
		state.ptyStatus = await client.ptyStatus();
		state.output = state.ptyStatus;
	});
	bindAction("pty-create-button", async () => {
		const result = await client.ptyCreateSession({
			command: readOptional(documentRef, "pty-command"),
			cwd: readOptional(documentRef, "pty-cwd"),
			cols: readNumber(documentRef, "pty-cols", 120),
			rows: readNumber(documentRef, "pty-rows", 32),
		});
		setPtySession(state, result.session);
		setInput(documentRef, "pty-session-id", result.session.id);
		const tail = await client.ptyOutputTail({
			sessionId: result.session.id,
			limit: 200,
		});
		setPtyOutput(state, tail.entries, tail.nextSequence);
	});
	bindAction("pty-list-button", async () => {
		state.ptySessions = await client.ptyListSessions();
	});
	bindAction("pty-tail-button", async () => {
		const sessionId = activePtySessionId(state, documentRef);
		const tail = await client.ptyOutputTail({ sessionId, limit: 500 });
		state.activePtySessionId = sessionId;
		setPtyOutput(state, tail.entries, tail.nextSequence);
	});
	bindAction("pty-send-button", async () => {
		const sessionId = activePtySessionId(state, documentRef);
		const session = await client.ptyWrite({
			sessionId,
			data: `${readText(documentRef, "pty-input")}\n`,
		});
		setPtySession(state, session);
		const tail = await client.ptyOutputTail({
			sessionId,
			afterSequence: state.ptyNextSequence - 1,
			limit: 500,
		});
		appendPtyOutput(state, tail.entries, tail.nextSequence);
	});
	bindAction("pty-resize-button", async () => {
		const session = await client.ptyResize({
			sessionId: activePtySessionId(state, documentRef),
			cols: readNumber(documentRef, "pty-cols", 120),
			rows: readNumber(documentRef, "pty-rows", 32),
		});
		setPtySession(state, session);
	});
	bindAction("pty-kill-button", async () => {
		const session = await client.ptyKill({
			sessionId: activePtySessionId(state, documentRef),
		});
		setPtySession(state, session);
	});
	bindAction("pty-clear-button", async () => {
		const sessionId = activePtySessionId(state, documentRef);
		await client.ptyOutputClear(sessionId);
		setPtyOutput(state, [], 0);
	});
	bindAction("git-status-button", async () => {
		state.gitStatus = await client.gitStatus({ cwd: gitCwd(documentRef) });
		state.gitRepoStatus = state.gitStatus;
		state.output = state.gitStatus;
	});
	bindAction("git-repo-button", async () => {
		state.gitRepo = await client.gitRepoInfo({ cwd: gitCwd(documentRef) });
	});
	bindAction("git-worktree-button", async () => {
		state.gitRepoStatus = await client.gitStatus({ cwd: gitCwd(documentRef) });
		state.gitStatus = state.gitRepoStatus;
	});
	bindAction("git-branches-button", async () => {
		state.gitBranches = await client.gitBranches({ cwd: gitCwd(documentRef) });
	});
	bindAction("git-remotes-button", async () => {
		state.gitRemotes = await client.gitRemotes({ cwd: gitCwd(documentRef) });
	});
	bindAction("git-log-button", async () => {
		state.gitLog = await client.gitLog({
			cwd: gitCwd(documentRef),
			ref: readOptional(documentRef, "git-ref"),
			limit: readNumber(documentRef, "git-log-limit", 20),
		});
	});
	bindAction("git-diff-button", async () => {
		const result = await client.gitDiff({
			cwd: gitCwd(documentRef),
			ref: readOptional(documentRef, "git-ref"),
			path: readOptional(documentRef, "git-path"),
			staged: readCheckbox(documentRef, "git-staged"),
		});
		state.gitDiff = result.raw;
	});
	bindAction("git-show-button", async () => {
		const result = await client.gitShow({
			cwd: gitCwd(documentRef),
			ref: readText(documentRef, "git-ref"),
			path: readOptional(documentRef, "git-path"),
		});
		state.gitShow = result.raw;
	});
	bindAction("git-add-button", async () => {
		state.output = await client.gitAdd({
			cwd: gitCwd(documentRef),
			paths: readPathList(documentRef, "git-add-paths"),
		});
		state.gitOperations = await client.gitOperationList(20);
	});
	bindAction("git-restore-button", async () => {
		state.output = await client.gitRestore({
			cwd: gitCwd(documentRef),
			paths: readPathList(documentRef, "git-restore-paths"),
			staged: readCheckbox(documentRef, "git-staged"),
			source: readOptional(documentRef, "git-ref"),
		});
		state.gitOperations = await client.gitOperationList(20);
	});
	bindAction("git-checkout-button", async () => {
		state.output = await client.gitCheckout({
			cwd: gitCwd(documentRef),
			ref: readText(documentRef, "git-checkout-ref"),
		});
		state.gitOperations = await client.gitOperationList(20);
	});
	bindAction("git-branch-create-button", async () => {
		state.output = await client.gitBranchCreate({
			cwd: gitCwd(documentRef),
			name: readText(documentRef, "git-create-branch"),
		});
		state.gitOperations = await client.gitOperationList(20);
	});
	bindAction("git-branch-delete-button", async () => {
		state.output = await client.gitBranchDelete({
			cwd: gitCwd(documentRef),
			name: readText(documentRef, "git-delete-branch"),
		});
		state.gitOperations = await client.gitOperationList(20);
	});
	bindAction("git-commit-button", async () => {
		state.output = await client.gitCommit({
			cwd: gitCwd(documentRef),
			message: readText(documentRef, "git-commit-message"),
		});
		state.gitOperations = await client.gitOperationList(20);
	});
	bindAction("git-fetch-button", async () => {
		state.output = await client.gitFetch(remoteParams(documentRef));
		state.gitOperations = await client.gitOperationList(20);
	});
	bindAction("git-pull-button", async () => {
		state.output = await client.gitPull(remoteParams(documentRef));
		state.gitOperations = await client.gitOperationList(20);
	});
	bindAction("git-push-button", async () => {
		state.output = await client.gitPush(remoteParams(documentRef));
		state.gitOperations = await client.gitOperationList(20);
	});
	bindAction("git-operations-button", async () => {
		state.gitOperations = await client.gitOperationList(30);
	});
	bindAction("model-status-button", async () => {
		state.output = await client.modelStatus();
	});
	bindAction("model-hub-button", async () => {
		state.modelHub = await client.modelHub();
		state.modelCatalog = state.modelHub.catalog;
		state.modelEliza1Tiers = state.modelHub.eliza1Tiers;
		state.modelVoiceComponents = state.modelHub.voiceComponents;
		state.modelInstalled = state.modelHub.installed;
		state.modelActive = state.modelHub.active;
		state.modelDownloads = state.modelHub.downloads;
		state.modelHardware = state.modelHub.hardware ?? null;
		state.modelAssignments = state.modelHub.assignments ?? {};
		state.modelRouting = state.modelHub.routing ?? null;
		state.output = state.modelHub;
	});
	bindAction("model-catalog-button", async () => {
		state.modelCatalog = await client.modelCatalog();
	});
	bindAction("model-eliza1-catalog-button", async () => {
		state.modelCatalog = await client.modelEliza1Catalog();
	});
	bindAction("model-tiers-button", async () => {
		state.modelEliza1Tiers = await client.modelEliza1Tiers();
	});
	bindAction("model-voice-button", async () => {
		state.modelVoiceComponents = await client.modelEliza1Voice();
	});
	bindAction("model-hf-button", async () => {
		state.modelHfMetadata = await client.modelHfMetadata();
		state.output = state.modelHfMetadata;
	});
	bindAction("model-hardware-button", async () => {
		state.modelHardware = await client.modelHardware();
	});
	bindAction("model-providers-button", async () => {
		state.modelProviders = await client.modelProviders();
	});
	bindAction("model-installed-button", async () => {
		state.modelInstalled = await client.modelInstalled();
	});
	bindAction("model-downloads-button", async () => {
		state.modelDownloads = await client.modelDownloads();
	});
	bindAction("model-active-button", async () => {
		state.modelActive = await client.modelActive();
	});
	bindAction("model-activate-button", async () => {
		state.modelActive = await client.modelActivate(readText(documentRef, "model-id"));
	});
	bindAction("model-unload-button", async () => {
		state.modelActive = await client.modelUnload();
	});
	bindAction("model-download-button", async () => {
		state.output = await client.modelStartDownload(readText(documentRef, "model-id"));
		state.modelDownloads = await client.modelDownloads();
	});
	bindAction("model-cancel-download-button", async () => {
		state.output = await client.modelCancelDownload(readText(documentRef, "model-id"));
		state.modelDownloads = await client.modelDownloads();
	});
	bindAction("model-assignments-button", async () => {
		state.modelAssignments = await client.modelAssignments();
	});
	bindAction("model-set-assignment-button", async () => {
		state.modelAssignments = await client.modelSetAssignment({
			slot: readText(documentRef, "model-slot"),
			modelId: readOptional(documentRef, "model-id") ?? null,
		});
	});
	bindAction("model-routing-button", async () => {
		state.modelRouting = await client.modelRouting();
	});
	bindAction("model-use-local-button", async () => {
		state.modelRouting = await client.modelUseLocal();
	});
	bindAction("model-use-cloud-button", async () => {
		state.modelRouting = await client.modelUseCloud();
	});
	bindAction("model-generate-button", async () => {
		state.output = await client.modelGenerate({
			modelId: readOptional(documentRef, "model-id"),
			prompt: readText(documentRef, "model-prompt"),
		});
	});
	bindAction("model-embedding-button", async () => {
		state.output = await client.modelEmbedding({
			modelId: readOptional(documentRef, "model-id"),
			input: readText(documentRef, "model-embedding-input"),
		});
	});
	bindAction("model-capabilities-button", async () => {
		state.output = await client.modelCapabilities();
	});

	elements.agents.addEventListener("change", () => {
		selectAgent(state, elements.agents.value);
		setInput(documentRef, "agent-id", elements.agents.value);
		render();
	});
	elements.conversations.addEventListener("change", () => {
		selectConversation(state, elements.conversations.value);
		setInput(documentRef, "conversation-id", elements.conversations.value);
		render();
	});
	const writeToggle = documentRef.getElementById("file-enable-write");
	const writeButton = documentRef.getElementById("file-write-button");
	if (writeToggle instanceof HTMLInputElement && writeButton instanceof HTMLButtonElement) {
		writeButton.disabled = !writeToggle.checked;
		writeToggle.addEventListener("change", () => {
			writeButton.disabled = !writeToggle.checked;
		});
	}

	void runAction(state, render, async () => {
		state.runtimeState = await client.status();
	});

	setInterval(() => {
		void runAction(
			state,
			render,
			async () => {
				state.runtimeState = await client.status();
				state.logs = await client.logsTail(80);
				if (state.activePtySessionId) {
					const tail = await client.ptyOutputTail({
						sessionId: state.activePtySessionId,
						afterSequence: state.ptyNextSequence - 1,
						limit: 500,
					});
					appendPtyOutput(state, tail.entries, tail.nextSequence);
				}
			},
			false,
		);
	}, 3500);

	render();
	return state;
}

function bind(
	documentRef: Document,
	id: string,
	action: () => Promise<void>,
): void {
	const element = documentRef.getElementById(id);
	if (!element) throw new Error(`Missing element #${id}`);
	element.addEventListener("click", () => {
		void action();
	});
}

async function runAction(
	state: SurfaceRuntimeStatus,
	render: () => void,
	action: () => Promise<void>,
	reportErrors = true,
): Promise<void> {
	try {
		await action();
	} catch (error) {
		if (reportErrors) addError(state, formatError(error), error);
	}
	render();
}

function readText(documentRef: Document, id: string): string {
	const value = readInput(documentRef, id).value.trim();
	if (value.length === 0) throw new Error(`${id} is required.`);
	return value;
}

function readOptional(documentRef: Document, id: string): string | undefined {
	const value = readInput(documentRef, id).value.trim();
	return value.length > 0 ? value : undefined;
}

function readNumber(
	documentRef: Document,
	id: string,
	fallback: number,
): number {
	const raw = readInput(documentRef, id).value.trim();
	if (raw.length === 0) return fallback;
	const value = Number(raw);
	return Number.isFinite(value) ? value : fallback;
}

function readInput(
	documentRef: Document,
	id: string,
): HTMLInputElement | HTMLTextAreaElement {
	const element = documentRef.getElementById(id);
	if (element instanceof HTMLInputElement) return element;
	if (element instanceof HTMLTextAreaElement) return element;
	throw new Error(`Element #${id} must be an input`);
}

function setInput(documentRef: Document, id: string, value: string): void {
	const element = documentRef.getElementById(id);
	if (element instanceof HTMLInputElement) element.value = value;
}

function readCheckbox(documentRef: Document, id: string): boolean {
	const element = documentRef.getElementById(id);
	if (!(element instanceof HTMLInputElement)) return false;
	return element.checked;
}

function activePtySessionId(
	state: SurfaceRuntimeStatus,
	documentRef: Document,
): string {
	const sessionId = state.activePtySessionId ?? readText(documentRef, "pty-session-id");
	state.activePtySessionId = sessionId;
	return sessionId;
}

function gitCwd(documentRef: Document): string | undefined {
	return readOptional(documentRef, "git-cwd");
}

function readPathList(documentRef: Document, id: string): string[] {
	const raw = readText(documentRef, id);
	return raw
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

function remoteParams(documentRef: Document): {
	cwd?: string;
	remote?: string;
	branch?: string;
} {
	return {
		cwd: gitCwd(documentRef),
		remote: readOptional(documentRef, "git-remote"),
		branch: readOptional(documentRef, "git-remote-branch"),
	};
}

function formatError(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "object" && error !== null && "message" in error) {
		const message = (error as { message?: unknown }).message;
		if (typeof message === "string") return message;
	}
	return "Surface request failed.";
}
