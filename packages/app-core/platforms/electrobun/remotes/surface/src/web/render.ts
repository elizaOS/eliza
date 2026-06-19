import type { SurfaceRuntimeStatus } from "./state.ts";

export type SurfaceElements = {
  mode: HTMLElement;
  pid: HTMLElement;
  apiBase: HTMLElement;
  runtimeError: HTMLElement;
  routeTable: HTMLElement;
  agents: HTMLSelectElement;
  conversations: HTMLSelectElement;
  transcript: HTMLElement;
  timeline: HTMLElement;
  latestSnapshot: HTMLElement;
  logs: HTMLElement;
  output: HTMLElement;
  errors: HTMLElement;
  activeStreamId: HTMLElement;
  plugins: HTMLElement;
  fileRoots: HTMLElement;
  fileList: HTMLElement;
  fileText: HTMLElement;
  fileSearch: HTMLElement;
  ptyStatus: HTMLElement;
  ptySessions: HTMLElement;
  ptyOutput: HTMLElement;
  gitStatus: HTMLElement;
  gitRepo: HTMLElement;
  gitStatusFiles: HTMLElement;
  gitBranches: HTMLElement;
  gitRemotes: HTMLElement;
  gitLog: HTMLElement;
  gitDiff: HTMLElement;
  gitShow: HTMLElement;
  gitOperations: HTMLElement;
  modelHub: HTMLElement;
  modelCatalog: HTMLElement;
  modelTiers: HTMLElement;
  modelVoice: HTMLElement;
  modelRuntime: HTMLElement;
  modelDownloads: HTMLElement;
  modelRouting: HTMLElement;
};

export function collectElements(documentRef: Document): SurfaceElements {
  return {
    mode: required(documentRef, "runtime-mode"),
    pid: required(documentRef, "runtime-pid"),
    apiBase: required(documentRef, "runtime-api-base"),
    runtimeError: required(documentRef, "runtime-error"),
    routeTable: required(documentRef, "route-table"),
    agents: requiredSelect(documentRef, "agent-select"),
    conversations: requiredSelect(documentRef, "conversation-select"),
    transcript: required(documentRef, "chat-transcript"),
    timeline: required(documentRef, "action-timeline"),
    latestSnapshot: required(documentRef, "latest-snapshot"),
    logs: required(documentRef, "log-output"),
    output: required(documentRef, "general-output"),
    errors: required(documentRef, "error-list"),
    activeStreamId: required(documentRef, "active-stream-id"),
    plugins: required(documentRef, "plugin-output"),
    fileRoots: required(documentRef, "file-roots"),
    fileList: required(documentRef, "file-list"),
    fileText: required(documentRef, "file-text"),
    fileSearch: required(documentRef, "file-search"),
    ptyStatus: required(documentRef, "pty-status-output"),
    ptySessions: required(documentRef, "pty-session-list"),
    ptyOutput: required(documentRef, "pty-output"),
    gitStatus: required(documentRef, "git-status-output"),
    gitRepo: required(documentRef, "git-repo-output"),
    gitStatusFiles: required(documentRef, "git-files-output"),
    gitBranches: required(documentRef, "git-branches-output"),
    gitRemotes: required(documentRef, "git-remotes-output"),
    gitLog: required(documentRef, "git-log-output"),
    gitDiff: required(documentRef, "git-diff-output"),
    gitShow: required(documentRef, "git-show-output"),
    gitOperations: required(documentRef, "git-operations-output"),
    modelHub: required(documentRef, "model-hub-output"),
    modelCatalog: required(documentRef, "model-catalog-output"),
    modelTiers: required(documentRef, "model-tiers-output"),
    modelVoice: required(documentRef, "model-voice-output"),
    modelRuntime: required(documentRef, "model-runtime-output"),
    modelDownloads: required(documentRef, "model-downloads-output"),
    modelRouting: required(documentRef, "model-routing-output"),
  };
}

export function renderSurface(
  state: SurfaceRuntimeStatus,
  elements: SurfaceElements,
): void {
  const runtime = state.runtimeState;
  elements.mode.textContent = runtime?.mode ?? "unknown";
  elements.pid.textContent = runtime?.pid ? String(runtime.pid) : "none";
  elements.apiBase.textContent = runtime?.apiBase ?? "not set";
  elements.runtimeError.textContent = runtime?.error ?? "";
  elements.activeStreamId.textContent = state.activeStreamId ?? "none";

  renderRoutes(state, elements.routeTable);
  renderSelect(
    elements.agents,
    state.agents.map((agent) => ({
      value: agent.id,
      label: agent.name ? `${agent.name} (${agent.id})` : agent.id,
    })),
    state.selectedAgentId,
  );
  renderSelect(
    elements.conversations,
    state.conversations.map((conversation) => ({
      value: conversation.id,
      label: conversation.title
        ? `${conversation.title} (${conversation.id})`
        : conversation.id,
    })),
    state.selectedConversationId,
  );
  renderTranscript(state, elements.transcript);
  renderTimeline(state, elements.timeline, elements.latestSnapshot);
  renderLogs(state, elements.logs);
  elements.output.textContent = format(state.output);
  elements.plugins.textContent = format(state.plugins);
  renderFilePanel(state, elements);
  renderTerminalPanel(state, elements);
  renderGitPanel(state, elements);
  renderModelPanel(state, elements);
  renderErrors(state, elements.errors);
}

function renderRoutes(state: SurfaceRuntimeStatus, element: HTMLElement): void {
  const discovery = state.apiDiscovery;
  if (!discovery) {
    element.textContent = "No discovery result yet.";
    return;
  }

  const routes = [...discovery.routes, ...discovery.streamingRoutes];
  element.replaceChildren(
    ...routes.map((route) => {
      const row = document.createElement("div");
      row.className = `route-row ${route.available ? "available" : ""}`;
      row.append(
        cell(route.method),
        cell(route.name),
        cell(route.path),
        cell(
          route.available
            ? `available ${route.status ?? ""}`
            : (route.error ?? "unavailable"),
        ),
      );
      return row;
    }),
  );
}

function renderSelect(
  select: HTMLSelectElement,
  items: Array<{ value: string; label: string }>,
  selected: string | null,
): void {
  select.replaceChildren(
    option("", "Manual / none"),
    ...items.map((item) => option(item.value, item.label)),
  );
  select.value = selected ?? "";
}

function renderTranscript(
  state: SurfaceRuntimeStatus,
  element: HTMLElement,
): void {
  if (state.chatMessages.length === 0) {
    element.textContent = "No messages yet.";
    return;
  }

  element.replaceChildren(
    ...state.chatMessages.map((message) => {
      const row = document.createElement("article");
      row.className = `chat-message ${message.role}`;
      const meta = document.createElement("div");
      meta.className = "chat-meta";
      meta.textContent = `${message.role}${message.status ? ` · ${message.status}` : ""}`;
      const text = document.createElement("div");
      text.className = "chat-text";
      text.textContent = message.text || " ";
      row.append(meta, text);
      return row;
    }),
  );
}

function renderTimeline(
  state: SurfaceRuntimeStatus,
  timeline: HTMLElement,
  latestSnapshot: HTMLElement,
): void {
  const latest = state.actionTimeline.find(
    (event) => event.kind === "snapshot",
  );
  latestSnapshot.textContent = latest
    ? (latest.text ?? format(latest.payload))
    : "No callback snapshot yet.";

  if (state.actionTimeline.length === 0) {
    timeline.textContent = "No stream events yet.";
    return;
  }

  timeline.replaceChildren(
    ...state.actionTimeline.map((event) => {
      const row = document.createElement("article");
      row.className = `timeline-event ${event.kind}`;
      const title = document.createElement("div");
      title.className = "timeline-title";
      title.textContent = `${event.kind}${event.title ? ` · ${event.title}` : ""}`;
      const body = document.createElement("pre");
      body.textContent = event.text ?? format(event.payload);
      row.append(title, body);
      return row;
    }),
  );
}

function renderLogs(state: SurfaceRuntimeStatus, element: HTMLElement): void {
  element.textContent =
    state.logs.length === 0
      ? "No logs loaded."
      : state.logs
          .map((log) => `[${log.timestamp}] ${log.stream}: ${log.line}`)
          .join("\n");
}

function renderFilePanel(
  state: SurfaceRuntimeStatus,
  elements: SurfaceElements,
): void {
  elements.fileRoots.textContent =
    state.fileRoots.length === 0
      ? "No roots loaded."
      : state.fileRoots
          .map(
            (root) =>
              `${root.id}: ${root.path}${root.label ? ` (${root.label})` : ""}`,
          )
          .join("\n");
  elements.fileList.textContent = state.fileList
    ? state.fileList.entries
        .map(
          (entry) =>
            `${entry.kind.padEnd(9)} ${String(entry.size).padStart(8)} ${entry.path}`,
        )
        .join("\n")
    : "No directory listing loaded.";
  elements.fileText.textContent = state.fileText
    ? `${state.fileText.truncated ? "[truncated]\n" : ""}${state.fileText.text}`
    : "No file loaded.";
  elements.fileSearch.textContent = state.fileSearch
    ? state.fileSearch.matches
        .map(
          (match) =>
            `${match.path}:${match.line}:${match.column ?? 1} ${match.preview}`,
        )
        .join("\n")
    : "No search results.";
}

function renderTerminalPanel(
  state: SurfaceRuntimeStatus,
  elements: SurfaceElements,
): void {
  elements.ptyStatus.textContent = state.ptyStatus
    ? format(state.ptyStatus)
    : "No terminal status loaded.";
  elements.ptySessions.textContent =
    state.ptySessions.length === 0
      ? "No terminal sessions."
      : state.ptySessions
          .map(
            (session) =>
              `${session.id} ${session.status} pid=${session.pid ?? "none"} ${session.command} ${session.args.join(" ")}`,
          )
          .join("\n");
  elements.ptyOutput.textContent =
    state.ptyOutput.length === 0
      ? "No terminal output loaded."
      : state.ptyOutput.map((entry) => entry.data).join("");
}

function renderGitPanel(
  state: SurfaceRuntimeStatus,
  elements: SurfaceElements,
): void {
  const repoStatus = state.gitRepoStatus ?? state.gitStatus;
  elements.gitStatus.textContent = state.gitStatus
    ? format(state.gitStatus)
    : "No Git status loaded.";
  elements.gitRepo.textContent = state.gitRepo
    ? format(state.gitRepo)
    : "No repo info loaded.";
  elements.gitStatusFiles.textContent = repoStatus
    ? repoStatus.files
        .map((file) => `${file.index}${file.workingTree} ${file.path}`)
        .join("\n") || "Working tree clean."
    : "No repo status loaded.";
  elements.gitBranches.textContent =
    state.gitBranches.length === 0
      ? "No branches loaded."
      : state.gitBranches
          .map(
            (branch) =>
              `${branch.current ? "*" : " "} ${branch.remote ? "remote" : "local "} ${branch.name}${branch.upstream ? ` -> ${branch.upstream}` : ""}`,
          )
          .join("\n");
  elements.gitRemotes.textContent =
    state.gitRemotes.length === 0
      ? "No remotes loaded."
      : state.gitRemotes
          .map(
            (remote) =>
              `${remote.name} fetch=${remote.fetchUrl ?? ""} push=${remote.pushUrl ?? ""}`,
          )
          .join("\n");
  elements.gitLog.textContent =
    state.gitLog.length === 0
      ? "No log loaded."
      : state.gitLog
          .map((entry) => `${entry.shortHash} ${entry.subject}`)
          .join("\n");
  elements.gitDiff.textContent = state.gitDiff || "No diff loaded.";
  elements.gitShow.textContent = state.gitShow || "No show output loaded.";
  elements.gitOperations.textContent =
    state.gitOperations.length === 0
      ? "No operations loaded."
      : state.gitOperations
          .map(
            (operation) =>
              `${operation.id} ${operation.status} exit=${operation.exitCode ?? "none"} ${operation.command.join(" ")}\n${operation.stdout}${operation.stderr}`,
          )
          .join("\n\n");
}

function renderModelPanel(
  state: SurfaceRuntimeStatus,
  elements: SurfaceElements,
): void {
  elements.modelHub.textContent = state.modelHub
    ? format({
        catalog: state.modelHub.catalog.length,
        installed: state.modelHub.installed.length,
        active: state.modelHub.active,
        downloads: state.modelHub.downloads.length,
      })
    : "No model hub snapshot loaded.";
  elements.modelCatalog.textContent =
    state.modelCatalog.length === 0
      ? "No model catalog loaded."
      : state.modelCatalog
          .map(
            (model) =>
              `${model.id} ${model.installed ? "installed" : "remote"} ${model.active ? "active" : ""} ${model.bundlePath ?? ""}`,
          )
          .join("\n");
  elements.modelTiers.textContent =
    state.modelEliza1Tiers.length === 0
      ? "No Eliza-1 tiers loaded."
      : state.modelEliza1Tiers
          .map(
            (tier) =>
              `${tier.tier} ${tier.params ?? ""} ${tier.visibleOnHf ? "HF" : ""} ${tier.activeTier ? "active-tier" : "visible-only"} ${tier.bundlePath}`,
          )
          .join("\n");
  elements.modelVoice.textContent =
    state.modelVoiceComponents.length === 0
      ? "No voice components loaded."
      : state.modelVoiceComponents
          .map(
            (component) =>
              `${component.id} ${component.path} ${component.capabilities.join(", ")}`,
          )
          .join("\n");
  elements.modelRuntime.textContent = format({
    active: state.modelActive,
    hardware: state.modelHardware,
    installed: state.modelInstalled,
    providers: state.modelProviders,
    hf: state.modelHfMetadata,
  });
  elements.modelDownloads.textContent =
    state.modelDownloads.length === 0
      ? "No model downloads loaded."
      : state.modelDownloads
          .map(
            (job) =>
              `${job.jobId} ${job.modelId} ${job.state} ${job.received ?? 0}/${job.total ?? 0} ${job.error ?? ""}`,
          )
          .join("\n");
  elements.modelRouting.textContent = format({
    assignments: state.modelAssignments,
    routing: state.modelRouting,
  });
}

function renderErrors(state: SurfaceRuntimeStatus, element: HTMLElement): void {
  if (state.errors.length === 0) {
    element.textContent = "";
    return;
  }

  element.replaceChildren(
    ...state.errors.map((error) => {
      const row = document.createElement("div");
      row.className = "error-item";
      row.textContent = `${error.message} ${format(error.details)}`;
      return row;
    }),
  );
}

function required(documentRef: Document, id: string): HTMLElement {
  const element = documentRef.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element;
}

function requiredSelect(documentRef: Document, id: string): HTMLSelectElement {
  const element = required(documentRef, id);
  if (!(element instanceof HTMLSelectElement)) {
    throw new Error(`Element #${id} must be a select`);
  }
  return element;
}

function cell(text: string): HTMLElement {
  const element = document.createElement("span");
  element.textContent = text;
  return element;
}

function option(value: string, label: string): HTMLOptionElement {
  const element = document.createElement("option");
  element.value = value;
  element.textContent = label;
  return element;
}

function format(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch (error) {
    return String(error);
  }
}
