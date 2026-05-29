import {
  resolveApiBindHost,
  resolveDesktopApiPort,
  resolveServerOnlyPort,
} from "@elizaos/shared";
import {
  ansi,
  type Component,
  Input,
  ProcessTerminal,
  type SelectItem,
  SelectList,
  type Terminal,
  TUI,
} from "@elizaos/tui";
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

function resolveDefaultApiBaseUrl(): string {
  const host = resolveApiBindHost(process.env);
  const port = process.env.ELIZA_API_PORT
    ? resolveDesktopApiPort(process.env)
    : resolveServerOnlyPort(process.env);
  const displayHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return `http://${displayHost}:${port}`;
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
      ...init?.headers,
    },
  });
  if (!response.ok) {
    throw new Error(`${path} returned HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

class AgentTerminalView implements Component {
  private views: ViewEntry[] = [];
  private selectedView: ViewEntry | null = null;
  private status = "starting terminal tui";
  private mode: "views" | "search" | "chat" = "views";
  private searchQuery = "";
  private readonly viewList = new SelectList([], 12, selectTheme);
  private readonly chatInput = new Input();
  private conversationId: string | null = null;
  private lastChatLine = "No terminal chat sent yet.";

  constructor(
    private readonly tui: TUI,
    private readonly apiBaseUrl: string,
    private readonly fetchImpl: typeof fetch,
    private readonly onExit?: () => void,
  ) {
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
    this.chatInput.onEscape = () => {
      this.mode = "views";
      this.tui.setFocus(this);
      this.tui.requestRender();
    };
  }

  async start(): Promise<void> {
    await this.refreshViews();
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
      const items: SelectItem[] = this.views.map((view, index) => ({
        value: view.id,
        label: `${index + 1}. ${view.label}`,
        description: view.path ?? `/${view.id}/tui`,
      }));
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

  render(width: number): string[] {
    const selected = this.selectedView
      ? `${this.selectedView.label} (${this.selectedView.path ?? this.selectedView.id})`
      : "none";
    const lines = [
      ansi.bold("elizaOS terminal tui"),
      ansi.dim(`api ${this.apiBaseUrl}`),
      `status: ${this.status}`,
      `selected: ${selected}`,
      "",
      "shortcuts: ↑/↓ select  enter open  1-9 quick-open  r refresh  / search  c chat  q quit",
      "chat: type after pressing c, enter sends, esc returns to views",
      "",
    ];

    if (this.mode === "chat") {
      lines.push(ansi.cyan("chat composer"), this.lastChatLine, "");
      lines.push(...this.chatInput.render(width));
      return lines;
    }

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

  handleInput(data: string): void {
    if (this.mode === "search") {
      this.handleSearchInput(data);
      return;
    }
    if (data === "\u0003" || data === "q") {
      this.onExit?.();
      return;
    }
    if (data === "r") {
      void this.refreshViews();
      return;
    }
    if (data === "c") {
      this.mode = "chat";
      this.tui.setFocus(this.chatInput);
      this.tui.requestRender();
      return;
    }
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

  invalidate(): void {
    this.viewList.invalidate();
  }

  private async openView(view: ViewEntry): Promise<void> {
    this.selectedView = view;
    this.status = `opening ${view.label}`;
    this.tui.requestRender();
    try {
      await readJson<{ ok?: boolean }>(
        this.fetchImpl,
        this.apiBaseUrl,
        `/api/views/${encodeURIComponent(view.id)}/navigate?viewType=tui`,
        { method: "POST", body: JSON.stringify({ viewType: "tui" }) },
      );
      this.status = `opened ${view.label}`;
    } catch (error) {
      this.status =
        error instanceof Error ? error.message : `failed to open ${view.label}`;
    } finally {
      this.tui.requestRender();
    }
  }

  private handleSearchInput(data: string): void {
    if (data === "\u001b") {
      this.mode = "views";
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
      this.mode = "views";
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
        title: "SSH terminal",
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
    if (!text) return;
    this.lastChatLine = `you: ${text}`;
    this.chatInput.setValue("");
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
