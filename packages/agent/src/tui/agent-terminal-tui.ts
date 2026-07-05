/**
 * Terminal UI for driving a running agent over its local HTTP API. Renders a
 * shell with a mounted view block on top and a pinned chat composer below:
 * lists and opens registered `viewType: "tui"` views (rendering plugin views
 * inline when a terminal factory is registered), routes keyboard focus between
 * the view and the composer, sends chat + slash commands to the conversations
 * API, and posts view navigate/activate events back to the runtime. Resolves
 * the API base URL and an optional bearer token for non-loopback (tunneled)
 * sessions.
 */
import {
  readAliasedEnv,
  resolveApiBindHost,
  resolveDesktopApiPort,
  resolveServerOnlyPort,
} from "@elizaos/shared";
import {
  ansi,
  CombinedAutocompleteProvider,
  type Component,
  darkTheme,
  Editor,
  type EditorTheme,
  getTerminalView,
  getTerminalViewFactory,
  hasTerminalView,
  ProcessTerminal,
  type SelectItem,
  SelectList,
  type Terminal,
  TUI,
  truncateToWidth,
} from "@elizaos/tui";
import {
  type CommandsCatalogResponse,
  matchSlashInput,
  resolveSlashDispatch,
  type SerializedCommand,
  toSlashCommands,
} from "./slash-commands";
import { isTerminalTuiEnabled } from "./tui-enabled";

interface ViewEntry {
  id: string;
  label: string;
  path?: string;
  viewType?: "gui" | "tui";
}

interface AgentTerminalTuiOptions {
  apiBaseUrl?: string;
  terminal?: Terminal;
  fetchImpl?: typeof fetch;
  onExit?: () => void;
}

const selectTheme = {
  selectedPrefix: ansi.cyan,
  selectedText: ansi.cyan,
  description: ansi.dim,
  scrollInfo: ansi.dim,
  noMatch: ansi.dim,
};

const editorTheme: EditorTheme = {
  borderColor: darkTheme.colors.border,
  selectList: selectTheme,
};

function resolveDefaultApiBaseUrl(): string {
  const host = resolveApiBindHost(process.env);
  const port = readAliasedEnv("ELIZA_API_PORT")
    ? resolveDesktopApiPort(process.env)
    : resolveServerOnlyPort(process.env);
  const displayHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return `http://${displayHost}:${port}`;
}

/**
 * The TUI talks to the agent over HTTP. On the same host it rides the backend's
 * loopback-trust gate, but a tunnel/reverse-proxy injects `X-Forwarded-For`,
 * which disables that gate — so a remote terminal needs a real credential.
 * `ELIZA_API_TOKEN` is the exact key `isAuthorized` validates; when set we send
 * it as a Bearer token, otherwise nothing changes for loopback sessions.
 */
export function resolveTuiApiToken(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const token = env.ELIZA_API_TOKEN?.trim();
  return token ? token : null;
}

export function buildTuiAuthHeaders(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const token = resolveTuiApiToken(env);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function readJson<T>(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetchImpl(new URL(path, apiBaseUrl), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...buildTuiAuthHeaders(),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    throw new Error(`${path} returned HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

/**
 * The persistent shell layout: a mounted spatial-view block on top with a
 * fixed chat composer pinned to the bottom rows, both always visible.
 *
 * Mode collapses to where the *view block* is: the default `list` (registered
 * tui views to pick from), `view` (a mounted spatial/registered view rendering
 * inline), or `search` (filter the list). Chat is never a mode — the composer
 * is always rendered last.
 *
 * Focus has two targets: `view` routes Tab/arrows/Enter to the mounted view's
 * controls (and the top-level keybindings `/ r 1-9 q`), while `composer` sends
 * every printable char + Enter to the chat input. Ctrl+L toggles between them;
 * Esc from the composer returns focus to the view block.
 */
class AgentTerminalView implements Component {
  private views: ViewEntry[] = [];
  private selectedView: ViewEntry | null = null;
  private status = "starting terminal tui";
  private mode: "list" | "search" | "view" = "list";
  /** The registered terminal view rendered inline in `view` mode. */
  private mountedView: Component | null = null;
  /** Which surface receives keyboard input: the view block or the composer. */
  private focusTarget: "view" | "composer" = "composer";
  private searchQuery = "";
  private readonly viewList = new SelectList([], 12, selectTheme);
  private readonly chatInput: Editor;
  private commands: SerializedCommand[] = [];
  private conversationId: string | null = null;
  private lastChatLine = "No terminal chat sent yet.";

  constructor(
    private readonly tui: TUI,
    private readonly apiBaseUrl: string,
    private readonly fetchImpl: typeof fetch,
    private readonly onExit?: () => void,
  ) {
    this.chatInput = new Editor(tui, editorTheme, { paddingX: 0 });
    // The composer owns input by default so a user can type immediately.
    this.chatInput.focused = true;
    this.viewList.onSelect = (item) => {
      const view = this.views.find((candidate) => candidate.id === item.value);
      if (view) void this.openView(view);
    };
    this.viewList.onSelectionChange = (item) => {
      this.selectedView =
        this.views.find((candidate) => candidate.id === item.value) ?? null;
      this.tui.requestRender();
    };
    this.chatInput.onSubmit = (value) => {
      void this.sendChat(value);
    };
  }

  async start(): Promise<void> {
    await Promise.all([this.refreshViews(), this.refreshCommands()]);
  }

  async refreshCommands(): Promise<void> {
    try {
      const data = await readJson<CommandsCatalogResponse>(
        this.fetchImpl,
        this.apiBaseUrl,
        "/api/commands?surface=tui",
      );
      this.commands = data.commands ?? [];
      this.chatInput.setAutocompleteProvider(
        new CombinedAutocompleteProvider(toSlashCommands(this.commands)),
      );
    } catch {
      // A missing catalog (older backend, command plugin disabled) leaves the
      // composer working as a plain message input — slash text is still sent
      // to the agent verbatim by sendChat.
      this.commands = [];
    }
  }

  async refreshViews(): Promise<void> {
    this.status = "refreshing tui views";
    this.tui.requestRender();
    try {
      const data = await readJson<{ views?: ViewEntry[] }>(
        this.fetchImpl,
        this.apiBaseUrl,
        "/api/views?viewType=tui",
      );
      this.views = (data.views ?? []).filter((view) => view.viewType === "tui");
      const items: SelectItem[] = this.views.map((view, index) => {
        // A registered terminal view renders its real content inline here;
        // others can only navigate the GUI shell.
        const renderable = hasTerminalView(view.id);
        return {
          value: view.id,
          label: `${index + 1}. ${view.label}${renderable ? " ▣" : ""}`,
          description: renderable
            ? "renders inline · enter to open"
            : (view.path ?? `/${view.id}/tui`),
        };
      });
      this.viewList.setItems(items);
      this.selectedView = this.views[0] ?? null;
      this.status =
        this.views.length > 0
          ? `${this.views.length} tui views ready`
          : "no tui views registered";
    } catch (error) {
      this.status =
        error instanceof Error ? error.message : "failed to refresh tui views";
    } finally {
      this.tui.requestRender();
    }
  }

  /** Lines for the view block (everything above the pinned composer). */
  private renderViewBlock(width: number): string[] {
    if (this.mode === "view" && this.mountedView) {
      const header = [
        ansi.bold(
          `elizaOS terminal tui · ${this.selectedView?.label ?? "view"}`,
        ),
        ansi.dim(
          `${this.focusTarget === "view" ? "tab/↑↓ focus · enter activates" : "ctrl+l focuses the view"} · esc/q closes`,
        ),
        "",
      ];
      return [...header, ...this.mountedView.render(width)];
    }

    const selected = this.selectedView
      ? `${this.selectedView.label} (${this.selectedView.path ?? this.selectedView.id})`
      : "none";
    const lines = [
      ansi.bold("elizaOS terminal tui"),
      ansi.dim(`api ${this.apiBaseUrl}`),
      `status: ${this.status}`,
      `selected: ${selected}`,
      "",
      "shortcuts: ↑/↓ select  enter open  1-9 quick-open  r refresh  / search  ctrl+l focus  q quit",
      "",
    ];
    if (this.mode === "search") {
      lines.push(
        ansi.cyan("search views"),
        `filter: ${this.searchQuery || ansi.dim("(type to filter)")}`,
        ansi.dim("enter opens highlighted view; esc clears search"),
        "",
      );
    }
    lines.push(ansi.cyan("registered tui views"));
    lines.push(...this.viewList.render(width));
    return lines;
  }

  /** The chat composer block, always pinned to the bottom rows. */
  private renderComposer(width: number): string[] {
    const focusedComposer = this.focusTarget === "composer";
    const hint =
      this.commands.length > 0
        ? "type / for commands · enter sends · ctrl+l focuses the view"
        : "enter sends · ctrl+l focuses the view";
    const label = focusedComposer
      ? ansi.cyan("chat")
      : ansi.dim("chat (ctrl+l to type)");
    return [
      ansi.dim("─".repeat(Math.max(1, width))),
      label,
      this.lastChatLine,
      ansi.dim(hint),
      ...this.chatInput.render(width),
    ];
  }

  render(width: number): string[] {
    const composer = this.renderComposer(width);
    // Reserve the bottom rows for the composer; the view block fills the rest of
    // the visible viewport so the composer is pinned to the last rows. Falls
    // back to a generous default height when the terminal size is unknown.
    const height = this.tui.terminal.rows || 24;
    const viewHeight = Math.max(1, height - composer.length);
    let viewBlock = this.renderViewBlock(width);
    if (viewBlock.length > viewHeight) {
      // Keep the most recent / focused content visible by trimming the top.
      viewBlock = viewBlock.slice(viewBlock.length - viewHeight);
    } else {
      while (viewBlock.length < viewHeight) viewBlock.push("");
    }
    return [...viewBlock, ...composer].map((line) =>
      truncateToWidth(line, width),
    );
  }

  handleInput(data: string): void {
    // Ctrl+L toggles which surface owns the keyboard (view block <-> composer).
    if (data === "") {
      this.setFocus(this.focusTarget === "composer" ? "view" : "composer");
      return;
    }
    // Ctrl+C always exits the whole TUI regardless of focus.
    if (data === "") {
      this.onExit?.();
      return;
    }

    if (this.focusTarget === "composer") {
      this.handleComposerInput(data);
      return;
    }

    // -- view-focused: top-level keybindings + the mounted view / list --------
    if (this.mode === "search") {
      this.handleSearchInput(data);
      return;
    }
    if (this.mode === "view" && this.mountedView) {
      // Esc / q close the mounted view back to the list; everything else drives
      // the inline view so it stays interactive (tab/arrows/enter activate).
      if (data === "" || data === "q") {
        this.closeMountedView();
        return;
      }
      this.mountedView.handleInput?.(data);
      this.tui.requestRender();
      return;
    }
    // List mode, view-focused.
    if (data === "q") {
      this.onExit?.();
      return;
    }
    if (data === "r") {
      void this.refreshViews();
      return;
    }
    // Bare slash enters view-search mode (a top-level keybinding while the view
    // block is focused). The composer slash menu is unaffected -- it only fires
    // once the composer owns the input.
    if (data === "/") {
      this.mode = "search";
      this.status = "filtering tui views";
      this.tui.requestRender();
      return;
    }
    if (/^[1-9]$/u.test(data)) {
      const index = Number.parseInt(data, 10) - 1;
      const view = this.views[index];
      if (view) void this.openView(view);
      return;
    }
    this.viewList.handleInput(data);
  }

  /** Route a keystroke into the always-on composer. */
  private handleComposerInput(data: string): void {
    // Escape with an open dropdown closes the dropdown (handled by the Editor)
    // rather than moving focus, so one Escape does not do two things.
    if (data === "" && this.chatInput.isShowingAutocomplete()) {
      this.chatInput.handleInput(data);
      this.tui.requestRender();
      return;
    }
    // Escape (no dropdown) hands focus back to the view block.
    if (data === "") {
      this.setFocus("view");
      return;
    }
    this.chatInput.handleInput(data);
    this.tui.requestRender();
  }

  /** Move keyboard focus between the view block and the composer. */
  private setFocus(target: "view" | "composer"): void {
    this.focusTarget = target;
    this.chatInput.focused = target === "composer";
    this.tui.requestRender();
  }

  /** Unmount the active view and return to the list (view block stays focused). */
  private closeMountedView(): void {
    this.mode = "list";
    this.mountedView = null;
    this.status = `${this.views.length} tui views ready`;
    this.tui.requestRender();
  }

  invalidate(): void {
    this.viewList.invalidate();
    this.mountedView?.invalidate?.();
  }

  private async openView(view: ViewEntry): Promise<void> {
    this.selectedView = view;
    this.mode = this.mode === "search" ? "list" : this.mode;
    // A plugin-registered terminal view renders its real content inline — the
    // first time a `viewType: "tui"` view actually renders in the terminal,
    // rather than only navigating the GUI shell. Mount via the view's factory
    // (when one is registered) so we can supply `onActivate`: a focused button
    // activation in the view dispatches the view-scoped action to the agent.
    // Fall back to the cached default component for legacy registrations.
    const factory = getTerminalViewFactory(view.id);
    const mounted = factory
      ? factory({ onActivate: (elementId) => this.activateElement(elementId) })
      : getTerminalView(view.id);
    if (mounted) {
      this.mountedView = mounted;
      this.mode = "view";
      // Surface focus to the view block so its controls are immediately
      // tab/enter-drivable; the composer stays one Ctrl+L away.
      this.setFocus("view");
      this.status = `viewing ${view.label}`;
      // Tell the runtime which view is active so the activate endpoint can
      // resolve elements and the planner upweights its scoped actions. Best
      // effort; the inline render does not depend on it.
      void this.navigateView(view, { silent: true });
      this.tui.requestRender();
      return;
    }
    this.status = `opening ${view.label}`;
    this.tui.requestRender();
    await this.navigateView(view, { silent: false });
  }

  /** POST the navigate event so the runtime marks this view active. */
  private async navigateView(
    view: ViewEntry,
    { silent }: { silent: boolean },
  ): Promise<void> {
    try {
      await readJson<{ ok?: boolean }>(
        this.fetchImpl,
        this.apiBaseUrl,
        `/api/views/${encodeURIComponent(view.id)}/navigate?viewType=tui`,
        { method: "POST", body: JSON.stringify({ viewType: "tui" }) },
      );
      if (!silent) this.status = `opened ${view.label}`;
    } catch (error) {
      if (!silent) {
        this.status =
          error instanceof Error
            ? error.message
            : `failed to open ${view.label}`;
      }
    } finally {
      this.tui.requestRender();
    }
  }

  /**
   * A focused control in the mounted view was activated — dispatch it to the
   * agent via POST /api/views/:id/activate, which resolves the element to its
   * view-scoped action (CLICK_ELEMENT semantics) and runs it. The view's local
   * onPress already fired (state change) inside the spatial component; this is
   * the agent-facing half. Fire-and-forget; surfaced in the status line.
   */
  private async activateElement(elementId: string): Promise<void> {
    const view = this.selectedView;
    if (!view) return;
    this.status = `activating ${elementId}…`;
    this.tui.requestRender();
    try {
      await readJson<{ ok?: boolean }>(
        this.fetchImpl,
        this.apiBaseUrl,
        `/api/views/${encodeURIComponent(view.id)}/activate?viewType=tui`,
        {
          method: "POST",
          body: JSON.stringify({ elementId, viewType: "tui" }),
        },
      );
      this.status = `activated ${elementId}`;
    } catch (error) {
      this.status =
        error instanceof Error
          ? `activate failed: ${error.message}`
          : `activate failed: ${elementId}`;
    } finally {
      this.tui.requestRender();
    }
  }

  private handleSearchInput(data: string): void {
    if (data === "\u001b") {
      this.mode = "list";
      this.searchQuery = "";
      this.viewList.setFilter("");
      this.status = `${this.views.length} tui views ready`;
      this.tui.requestRender();
      return;
    }
    if (data === "\r" || data === "\n") {
      const selected = this.viewList.getSelectedItem();
      const view = selected
        ? this.views.find((candidate) => candidate.id === selected.value)
        : null;
      this.mode = "list";
      if (view) void this.openView(view);
      return;
    }
    if (data === "\u007f" || data === "\b") {
      this.searchQuery = this.searchQuery.slice(0, -1);
      this.viewList.setFilter(this.searchQuery);
      this.tui.requestRender();
      return;
    }
    if (data === "\u0003") {
      this.onExit?.();
      return;
    }
    if (/^[ -~]+$/u.test(data)) {
      this.searchQuery += data;
      this.viewList.setFilter(this.searchQuery);
      this.tui.requestRender();
      return;
    }
    this.viewList.handleInput(data);
  }

  private async ensureConversation(): Promise<string> {
    if (this.conversationId) return this.conversationId;
    const data = await readJson<{
      conversation?: { id?: string };
    }>(this.fetchImpl, this.apiBaseUrl, "/api/conversations", {
      method: "POST",
      body: JSON.stringify({
        title: "Terminal session",
        metadata: { source: "terminal-tui" },
      }),
    });
    const id = data.conversation?.id;
    if (!id) throw new Error("conversation create returned no id");
    this.conversationId = id;
    return id;
  }

  private async sendChat(value: string): Promise<void> {
    const text = value.trim();
    // The Editor self-clears on submit; this guards the rare empty submit.
    if (!text) return;

    const match = matchSlashInput(this.commands, text);
    if (match) {
      const dispatch = resolveSlashDispatch(match, text);
      switch (dispatch.kind) {
        case "clear":
          this.lastChatLine = "No terminal chat sent yet.";
          this.conversationId = null;
          this.tui.requestRender();
          return;
        case "new":
          this.conversationId = null;
          this.lastChatLine = "started a new conversation";
          this.tui.requestRender();
          return;
        case "navigate-view": {
          const view = this.views.find((v) => v.id === dispatch.viewId);
          if (view) {
            this.lastChatLine = `you: ${text}`;
            await this.openView(view);
          } else {
            this.lastChatLine = `unknown view: ${dispatch.viewId}`;
            this.tui.requestRender();
          }
          return;
        }
        case "send":
          await this.sendMessage(dispatch.text);
          return;
      }
    }

    await this.sendMessage(text);
  }

  private async sendMessage(text: string): Promise<void> {
    this.lastChatLine = `you: ${text}`;
    this.tui.requestRender();
    try {
      const conversationId = await this.ensureConversation();
      await readJson(
        this.fetchImpl,
        this.apiBaseUrl,
        `/api/conversations/${conversationId}/messages`,
        {
          method: "POST",
          body: JSON.stringify({
            text,
            channelType: "DM",
            source: "terminal-tui",
            metadata: {
              viewId: this.selectedView?.id,
              viewType: "tui",
            },
          }),
        },
      );
      this.lastChatLine = `sent: ${text}`;
    } catch (error) {
      this.lastChatLine =
        error instanceof Error
          ? `chat failed: ${error.message}`
          : "chat failed";
    } finally {
      this.tui.requestRender();
    }
  }
}

export interface AgentTerminalTuiHandle {
  stop: () => void;
  ready: Promise<void>;
}

export function startAgentTerminalTui(
  options: AgentTerminalTuiOptions = {},
): AgentTerminalTuiHandle | null {
  if (!options.terminal && !isTerminalTuiEnabled()) return null;

  const terminal = options.terminal ?? new ProcessTerminal();
  const tui = new TUI(terminal);
  const view = new AgentTerminalView(
    tui,
    options.apiBaseUrl ?? resolveDefaultApiBaseUrl(),
    options.fetchImpl ?? fetch,
    () => handle.stop(),
  );
  const handle: AgentTerminalTuiHandle = {
    stop: () => {
      tui.stop();
      options.onExit?.();
    },
    ready: view.start(),
  };

  tui.addChild(view);
  tui.setFocus(view);
  tui.start();
  handle.ready.catch(() => {
    tui.requestRender();
  });

  return handle;
}
