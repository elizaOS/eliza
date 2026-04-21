import {
  TUI,
  Container,
  Editor,
  Text,
  Box,
  type Component,
  type Focusable,
} from "@elizaos/tui";
import chalk from "chalk";
import { v4 as uuidv4 } from "uuid";
import {
  ChannelType,
  type AgentRuntime,
  type AutonomyService,
  type Content,
  type IMessageService,
  type Memory,
  type UUID,
  EventType,
  createMessageMemory,
} from "@elizaos/core";
import { POLYMARKET_SERVICE_NAME } from "../../../plugins/plugin-polymarket/typescript/constants";
import type { PolymarketService } from "../../../plugins/plugin-polymarket/typescript/services/polymarket";
import type {
  Market,
  MarketsResponse,
} from "../../../plugins/plugin-polymarket/typescript/types";

type ChatRole = "user" | "assistant" | "system";

type ChatMessage = {
  readonly id: string;
  readonly role: ChatRole;
  readonly content: string;
  readonly timestamp: number;
};

type SidebarView = "positions" | "markets" | "logs";

type FocusPanel = "chat" | "sidebar";

type LayoutMode = "chat" | "split" | "sidebar";

export type TuiSession = {
  readonly runtime: AgentRuntime;
  readonly roomId: UUID;
  readonly worldId: UUID;
  readonly userId: UUID;
  readonly messageService: IMessageService;
};

type ActionPayload = {
  readonly content?: Content;
};

type LogArg =
  | string
  | number
  | boolean
  | null
  | undefined
  | Error
  | Record<string, string | number | boolean | null | undefined>;

type LoggerMethod = (...args: LogArg[]) => void;
type LoggerLike = {
  info?: LoggerMethod;
  warn?: LoggerMethod;
  error?: LoggerMethod;
  debug?: LoggerMethod;
};

// Helper functions
function wrapText(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [text];
  const lines: string[] = [];
  const paragraphs = text.split("\n");
  for (const paragraph of paragraphs) {
    if (paragraph.length <= maxWidth) {
      lines.push(paragraph);
      continue;
    }
    const words = paragraph.split(" ");
    let current = "";
    for (const word of words) {
      const next = current.length > 0 ? `${current} ${word}` : word;
      if (next.length <= maxWidth) {
        current = next;
        continue;
      }
      if (current.length > 0) {
        lines.push(current);
      }
      if (word.length > maxWidth) {
        let remaining = word;
        while (remaining.length > maxWidth) {
          lines.push(remaining.slice(0, maxWidth));
          remaining = remaining.slice(maxWidth);
        }
        current = remaining;
      } else {
        current = word;
      }
    }
    if (current.length > 0) {
      lines.push(current);
    }
  }
  return lines.length > 0 ? lines : [""];
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function formatTimestamp(date: Date): string {
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function shortenId(value: string): string {
  if (value.length <= 12) return value;
  return `${value.slice(0, 5)}...${value.slice(-5)}`;
}

function normalizeSetting(value: string | number | boolean | null | undefined): string | null {
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const lowered = trimmed.toLowerCase();
  if (lowered === "null" || lowered === "undefined") return null;
  return trimmed;
}

function formatLogArgs(args: LogArg[]): string {
  const parts = args.map((arg) => {
    if (typeof arg === "string") return arg;
    if (typeof arg === "number" || typeof arg === "boolean") return String(arg);
    if (arg instanceof Error) return arg.message;
    if (arg === null || arg === undefined) return "";
    try {
      return JSON.stringify(arg);
    } catch {
      return "[object]";
    }
  });
  return parts.filter((p) => p.length > 0).join(" ");
}

function buildSidebarCard(title: string, bodyLines: string[], maxInnerWidth: number): string[] {
  const titleLines = wrapText(title, maxInnerWidth);
  const border = "─".repeat(maxInnerWidth);
  const divider = "═".repeat(maxInnerWidth);

  const result: string[] = [];
  result.push(border);
  for (const line of titleLines) {
    result.push(line.padEnd(maxInnerWidth));
  }
  result.push(divider);
  for (const line of bodyLines) {
    const wrapped = wrapText(line, maxInnerWidth);
    for (const w of wrapped) {
      result.push(w.padEnd(maxInnerWidth));
    }
  }
  result.push(border);
  return result;
}

function isAutonomyResponse(memory: Memory): memory is Memory & { createdAt: number } {
  if (typeof memory.createdAt !== "number") return false;
  if (typeof memory.content?.text !== "string") return false;
  const metadata = memory.content?.metadata;
  if (!metadata || typeof metadata !== "object") return false;
  const typed = metadata as { isAutonomous?: boolean; type?: string };
  return typed.isAutonomous === true && typed.type === "autonomous-response";
}

async function pollAutonomyLogs(
  runtime: AgentRuntime,
  lastSeen: { value: number },
  onLog: (text: string) => void
): Promise<void> {
  const svc = runtime.getService<AutonomyService>("AUTONOMY");
  if (!svc) return;
  const roomId = svc.getAutonomousRoomId();
  const memories = await runtime.getMemories({
    roomId,
    count: 20,
    tableName: "memories",
  });
  const fresh = memories
    .filter(isAutonomyResponse)
    .filter((memory) => memory.createdAt > lastSeen.value)
    .sort((a, b) => a.createdAt - b.createdAt);

  for (const memory of fresh) {
    onLog(memory.content?.text ?? "");
  }
  if (fresh.length > 0) {
    const last = fresh[fresh.length - 1];
    if (last) lastSeen.value = last.createdAt;
  }
}

async function setAutonomy(runtime: AgentRuntime, enabled: boolean): Promise<string> {
  const svc = runtime.getService<AutonomyService>("AUTONOMY");
  if (!svc) {
    return "Autonomy service not available.";
  }
  if (enabled) {
    await svc.enableAutonomy();
    return "Autonomy enabled.";
  }
  await svc.disableAutonomy();
  return "Autonomy disabled.";
}

// Chat Panel component
class ChatPanel implements Component, Focusable {
  private messages: ChatMessage[] = [];
  private editor: Editor;
  private scrollOffset = 0;
  private maxScroll = 0;
  private width = 60;
  private height = 24;
  private focused = false;
  private onSubmit: (text: string) => void;
  private onScrollChange: (maxScroll: number) => void;

  constructor(
    onSubmit: (text: string) => void,
    onScrollChange: (maxScroll: number) => void
  ) {
    this.onSubmit = onSubmit;
    this.onScrollChange = onScrollChange;
    this.editor = new Editor({
      width: 50,
      maxHeight: 1,
      placeholder: "",
      onSubmit: (text: string) => {
        if (text.trim()) {
          this.editor.clear();
          this.onSubmit(text.trim());
        }
      },
    });
  }

  setMessages(messages: ChatMessage[]): void {
    this.messages = messages;
  }

  setScrollOffset(offset: number): void {
    this.scrollOffset = offset;
  }

  getMaxScroll(): number {
    return this.maxScroll;
  }

  setFocused(focused: boolean): void {
    this.focused = focused;
    this.editor.setFocused(focused);
  }

  isFocused(): boolean {
    return this.focused;
  }

  handleInput(char: string): void {
    this.editor.handleInput(char);
  }

  render(width: number, height: number): string[] {
    this.width = width;
    this.height = height;
    this.editor.setWidth(Math.max(1, width - 6));

    const contentWidth = Math.max(10, width - 2);
    const messagesHeight = Math.max(0, height - 1);

    // Build render lines
    const renderLines: { text: string; color?: string; dim?: boolean; bold?: boolean; italic?: boolean }[] = [];
    for (const msg of this.messages) {
      if (msg.role === "system") {
        const wrapped = wrapText(msg.content, contentWidth);
        for (const line of wrapped) {
          renderLines.push({ text: line, dim: true, italic: true });
        }
        continue;
      }
      const speaker = msg.role === "user" ? "You" : "Eliza";
      const color = msg.role === "user" ? "cyan" : "green";
      const header = `${speaker}: ${formatTime(msg.timestamp)}`;
      renderLines.push({ text: header, color, bold: true });
      const indent = "  ";
      const contentLines = msg.content.split("\n");
      for (const rawLine of contentLines) {
        const wrapped = wrapText(rawLine, Math.max(1, contentWidth - indent.length));
        for (const line of wrapped) {
          renderLines.push({ text: indent + line });
        }
      }
    }

    // Calculate scroll
    const totalLines = renderLines.length;
    this.maxScroll = Math.max(0, totalLines - messagesHeight);
    this.onScrollChange(this.maxScroll);

    const effectiveOffset = Math.min(this.scrollOffset, this.maxScroll);
    const startIdx = Math.max(0, totalLines - messagesHeight - effectiveOffset);
    const endIdx = Math.min(totalLines, startIdx + messagesHeight);
    const visibleLines = renderLines.slice(startIdx, endIdx);

    const output: string[] = [];

    // Messages
    for (const line of visibleLines) {
      let styled = line.text;
      if (line.bold) styled = chalk.bold(styled);
      if (line.italic) styled = chalk.italic(styled);
      if (line.dim) styled = chalk.dim(styled);
      if (line.color === "cyan") styled = chalk.cyan(styled);
      else if (line.color === "green") styled = chalk.green(styled);
      output.push(" " + styled);
    }

    // Fill remaining space
    const remaining = messagesHeight - visibleLines.length;
    for (let i = 0; i < remaining; i++) {
      output.push("");
    }

    // Input line
    const promptColor = this.focused ? chalk.cyan : chalk.dim;
    const editorLines = this.editor.render(contentWidth - 4, 1);
    output.push(" " + promptColor("> ") + (editorLines[0] || ""));

    return output;
  }
}

// Sidebar Panel component
class SidebarPanel implements Component, Focusable {
  private view: SidebarView = "positions";
  private content = "";
  private loading = true;
  private updatedAt = "";
  private logs: string[] = [];
  private scrollOffset = 0;
  private maxScroll = 0;
  private width = 40;
  private height = 24;
  private focused = false;
  private onScrollChange: (maxScroll: number) => void;

  constructor(onScrollChange: (maxScroll: number) => void) {
    this.onScrollChange = onScrollChange;
  }

  setView(view: SidebarView): void {
    this.view = view;
  }

  setContent(content: string): void {
    this.content = content;
  }

  setLoading(loading: boolean): void {
    this.loading = loading;
  }

  setUpdatedAt(time: string): void {
    this.updatedAt = time;
  }

  setLogs(logs: string[]): void {
    this.logs = logs;
  }

  setScrollOffset(offset: number): void {
    this.scrollOffset = offset;
  }

  getMaxScroll(): number {
    return this.maxScroll;
  }

  setFocused(focused: boolean): void {
    this.focused = focused;
  }

  isFocused(): boolean {
    return this.focused;
  }

  handleInput(_char: string): void {
    // Sidebar doesn't handle text input directly
  }

  render(width: number, height: number): string[] {
    this.width = width;
    this.height = height;

    const title = this.view === "positions" ? "Account" : this.view === "markets" ? "Active Markets" : "Agent Logs";
    const contentWidth = Math.max(10, width - 2);

    // Build body lines
    const bodyLines: string[] = [];
    if (this.view === "logs") {
      const logLines = this.logs.length > 0 ? this.logs : ["No logs yet."];
      for (const line of logLines) {
        const wrapped = wrapText(line, contentWidth);
        for (const w of wrapped) {
          bodyLines.push(w);
        }
      }
    } else if (this.loading) {
      const wrapped = wrapText("Loading...", contentWidth);
      for (const w of wrapped) {
        bodyLines.push(w);
      }
    } else {
      const c = this.content.length > 0 ? this.content : "No data.";
      for (const line of c.split("\n")) {
        bodyLines.push(line);
      }
    }

    // Reserve 1 line for header
    const bodyHeight = Math.max(0, height - 1);
    const totalLines = bodyLines.length;
    this.maxScroll = Math.max(0, totalLines - bodyHeight);
    this.onScrollChange(this.maxScroll);

    const effectiveOffset = Math.min(this.scrollOffset, this.maxScroll);
    const startIdx = Math.max(0, totalLines - bodyHeight - effectiveOffset);
    const endIdx = Math.min(totalLines, startIdx + bodyHeight);
    const visibleBody = bodyLines.slice(startIdx, endIdx);

    const scrollIndicator = effectiveOffset > 0 ? ` ↑${effectiveOffset}` : "";
    const header = this.updatedAt ? `${title} (${this.updatedAt})${scrollIndicator}` : `${title}${scrollIndicator}`;

    const output: string[] = [];

    // Left border
    const borderColor = chalk.gray;

    // Header
    const headerStyle = this.focused ? chalk.bold : chalk.dim;
    output.push(borderColor("│") + " " + headerStyle(header));

    // Body
    for (const line of visibleBody) {
      const dimmed = !this.focused;
      const styled = dimmed ? chalk.dim(line) : line;
      output.push(borderColor("│") + " " + styled);
    }

    // Fill remaining
    const remaining = bodyHeight - visibleBody.length;
    for (let i = 0; i < remaining; i++) {
      output.push(borderColor("│"));
    }

    return output;
  }
}

// Main TUI App
class PolymarketTuiApp {
  private tui: TUI;
  private session: TuiSession;
  private messages: ChatMessage[] = [];
  private input = "";
  private isProcessing = false;

  private layout: LayoutMode = "chat";
  private sidebarView: SidebarView = "positions";
  private focusPanel: FocusPanel = "chat";

  private scrollOffset = 0;
  private sidebarScrollOffset = 0;
  private chatMaxScroll = 0;
  private sidebarMaxScroll = 0;

  private sidebarContent = "Loading...";
  private sidebarLoading = true;
  private sidebarUpdatedAt = "";
  private logs: string[] = [];
  private balanceText = "USDC: --";

  private chatPanel: ChatPanel;
  private sidebarPanel: SidebarPanel;

  private marketNameCache = new Map<string, string>();
  private lastAutonomyTime = { value: 0 };
  private actionMessageIds = new Map<string, string>();
  private greeted = false;

  private autonomyTimer: ReturnType<typeof setInterval> | null = null;

  constructor(session: TuiSession) {
    this.session = session;
    this.tui = new TUI();

    this.chatPanel = new ChatPanel(
      (text) => this.handleSubmit(text),
      (max) => { this.chatMaxScroll = max; }
    );

    this.sidebarPanel = new SidebarPanel(
      (max) => { this.sidebarMaxScroll = max; }
    );
  }

  async run(): Promise<void> {
    // Show greeting
    if (!this.greeted) {
      this.greeted = true;
      this.appendMessage({
        id: uuidv4(),
        role: "assistant",
        content:
          "Hello! I'm the Polymarket trading agent. I can scan markets, summarize positions, and place orders when enabled. Type /help for commands.",
        timestamp: Date.now(),
      });
    }

    // Fetch initial balance
    this.fetchBalance();

    // Fetch sidebar data
    this.updateSidebarContent();

    // Set up autonomy polling
    this.autonomyTimer = setInterval(() => {
      this.pollAutonomyLogs();
    }, 1500);

    // Set up logger wrapping
    this.wrapLogger();

    // Set up event listeners
    this.setupEventListeners();

    // Run TUI
    await this.tui.run((char: string) => this.handleInput(char));

    // Cleanup
    if (this.autonomyTimer) {
      clearInterval(this.autonomyTimer);
    }
  }

  private appendMessage(msg: ChatMessage): void {
    this.messages.push(msg);
    this.chatPanel.setMessages(this.messages);
    this.scrollOffset = 0;
    this.chatPanel.setScrollOffset(0);
    this.tui.requestRender();
  }

  private updateMessage(id: string, content: string): void {
    this.messages = this.messages.map((msg) =>
      msg.id === id ? { ...msg, content } : msg
    );
    this.chatPanel.setMessages(this.messages);
    this.tui.requestRender();
  }

  private appendLog(line: string): void {
    this.logs.push(line);
    if (this.logs.length > 200) {
      this.logs = this.logs.slice(this.logs.length - 200);
    }
    this.sidebarPanel.setLogs(this.logs);
    this.tui.requestRender();
  }

  private async fetchBalance(): Promise<void> {
    const runtime = this.session.runtime;
    let service = runtime.getService<PolymarketService>(POLYMARKET_SERVICE_NAME);
    if (!service && typeof runtime.getServiceLoadPromise === "function") {
      try {
        service = await runtime.getServiceLoadPromise(POLYMARKET_SERVICE_NAME) as PolymarketService;
      } catch {
        // Service load failed
      }
    }
    if (!service) {
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 500));
        service = runtime.getService<PolymarketService>(POLYMARKET_SERVICE_NAME);
        if (service) break;
      }
    }
    if (service) {
      try {
        const state = await service.refreshAccountState();
        const balance = state?.balances?.collateral?.balance;
        if (balance !== undefined) {
          this.balanceText = `USDC: $${balance}`;
          this.tui.requestRender();
        }
      } catch {
        // Balance fetch failed silently
      }
    }
  }

  private async updateSidebarContent(): Promise<void> {
    const runtime = this.session.runtime;

    if (this.sidebarView === "logs") {
      this.sidebarLoading = false;
      this.sidebarPanel.setLoading(false);
      this.tui.requestRender();
      return;
    }

    this.sidebarLoading = true;
    this.sidebarContent = "Starting up...";
    this.sidebarPanel.setLoading(true);
    this.sidebarPanel.setContent(this.sidebarContent);
    this.tui.requestRender();

    let service = runtime.getService<PolymarketService>(POLYMARKET_SERVICE_NAME);
    if (!service && typeof runtime.getServiceLoadPromise === "function") {
      try {
        service = await runtime.getServiceLoadPromise(POLYMARKET_SERVICE_NAME) as PolymarketService;
      } catch {
        // Service failed to load
      }
    }
    if (!service) {
      for (let attempt = 0; attempt < 5; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        service = runtime.getService<PolymarketService>(POLYMARKET_SERVICE_NAME);
        if (service) break;
        this.sidebarContent = `Starting up... (attempt ${attempt + 2}/6)`;
        this.sidebarPanel.setContent(this.sidebarContent);
        this.tui.requestRender();
      }
    }

    if (!service) {
      this.sidebarLoading = false;
      this.sidebarContent = "Polymarket service failed to start.";
      this.sidebarUpdatedAt = formatTimestamp(new Date());
      this.sidebarPanel.setLoading(false);
      this.sidebarPanel.setContent(this.sidebarContent);
      this.sidebarPanel.setUpdatedAt(this.sidebarUpdatedAt);
      this.tui.requestRender();
      return;
    }

    try {
      if (this.sidebarView === "positions") {
        const state = await service.refreshAccountState();
        const positions = state?.positions ?? [];
        const lines: string[] = [];

        const funderSetting =
          runtime.getSetting("POLYMARKET_FUNDER_ADDRESS") ||
          runtime.getSetting("POLYMARKET_FUNDER") ||
          runtime.getSetting("CLOB_FUNDER_ADDRESS");
        const funderAddress = normalizeSetting(funderSetting);
        const walletAddress = state?.walletAddress ?? "unknown";
        const accountLabel = funderAddress
          ? `Proxy ${shortenId(funderAddress)}`
          : `EOA ${shortenId(walletAddress)}`;
        lines.push(`Account: ${accountLabel}`);

        const balance = state?.balances?.collateral?.balance;
        const allowance = state?.balances?.collateral?.allowance;
        if (balance !== undefined) {
          this.balanceText = `USDC: $${balance}`;
          lines.push(`USDC: $${balance}`);
          if (allowance !== undefined && allowance !== balance) {
            lines.push(`Allowance: $${allowance}`);
          }
        } else {
          lines.push("USDC: Unable to fetch");
        }
        lines.push("");

        if (positions.length === 0) {
          lines.push("No positions found.");
        } else {
          lines.push(`Positions (${positions.length}):`);
          for (let idx = 0; idx < Math.min(10, positions.length); idx++) {
            const pos = positions[idx];
            const size = Number.parseFloat(pos.size);
            const avg = Number.parseFloat(pos.average_price);
            const odds = Number.isFinite(avg) ? avg.toFixed(4) : "N/A";
            const side = size >= 0 ? "LONG" : "SHORT";
            const marketIdRaw = pos.market || "";
            let marketName = pos.market || "Unknown market";

            if (marketIdRaw.startsWith("0x")) {
              const cachedName = this.marketNameCache.get(marketIdRaw);
              if (cachedName) {
                marketName = cachedName;
              } else {
                try {
                  const market = (await service.getClobClient().getMarket(marketIdRaw)) as Market;
                  if (market?.question) {
                    marketName = market.question;
                    this.marketNameCache.set(marketIdRaw, market.question);
                  }
                } catch {
                  // Lookup failed
                }
              }
            }
            lines.push(`${idx + 1}. ${marketName}`);
            lines.push(`   ${side} ${Math.abs(size).toFixed(4)} @ ${odds}`);
          }
        }

        this.sidebarContent = lines.join("\n");
      } else if (this.sidebarView === "markets") {
        interface MarketItem {
          id: string;
          title: string;
          volume: number;
          endDate: string | null;
          source: "gamma" | "clob";
        }

        const gammaPromise = fetch(
          "https://gamma-api.polymarket.com/events?closed=false&active=true&limit=20&order=volume&ascending=false"
        ).then(async (res) => {
          if (!res.ok) return [];
          interface GammaEvent {
            id?: string;
            slug?: string;
            title?: string;
            question?: string;
            endDate?: string;
            volume?: number;
            closed?: boolean;
            active?: boolean;
          }
          const events = (await res.json()) as GammaEvent[];
          return events
            .filter((e) => e.active !== false && e.closed !== true)
            .map((e): MarketItem => ({
              id: e.id || e.slug || "",
              title: e.title || e.question || e.slug || "Unknown",
              volume: e.volume ?? 0,
              endDate: e.endDate || null,
              source: "gamma",
            }));
        }).catch(() => [] as MarketItem[]);

        const clobPromise = (async () => {
          const client = service.getClobClient();
          const response = (await client.getMarkets(undefined)) as MarketsResponse;
          const now = Date.now();
          return (response?.data ?? [])
            .filter((m) => {
              if (!m.active) return false;
              if (m.closed) return false;
              if (m.end_date_iso) {
                const endDate = new Date(m.end_date_iso).getTime();
                if (!Number.isNaN(endDate) && endDate < now) return false;
              }
              return true;
            })
            .map((m): MarketItem => ({
              id: m.condition_id,
              title: m.question || m.condition_id,
              volume: 0,
              endDate: m.end_date_iso || null,
              source: "clob",
            }));
        })().catch(() => [] as MarketItem[]);

        const [gammaMarkets, clobMarkets] = await Promise.all([gammaPromise, clobPromise]);

        const seen = new Set<string>();
        const combined: MarketItem[] = [];
        for (const m of gammaMarkets) {
          const key = m.title.toLowerCase().slice(0, 50);
          if (!seen.has(key)) {
            seen.add(key);
            combined.push(m);
          }
        }
        for (const m of clobMarkets) {
          const key = m.title.toLowerCase().slice(0, 50);
          if (!seen.has(key)) {
            seen.add(key);
            combined.push(m);
          }
        }
        combined.sort((a, b) => {
          if (b.volume !== a.volume) return b.volume - a.volume;
          if (a.endDate && b.endDate) {
            return new Date(a.endDate).getTime() - new Date(b.endDate).getTime();
          }
          return 0;
        });

        const trimmed = combined.slice(0, 12);
        const { columns } = this.tui.getSize();
        const cardInnerWidth = Math.max(12, Math.min(60, columns) - 6);

        if (trimmed.length === 0) {
          this.sidebarContent = "No active markets found.";
        } else {
          const cards: string[] = [];
          for (const m of trimmed) {
            const bodyLines: string[] = [];
            if (m.volume > 0) bodyLines.push(`Volume: $${Math.round(m.volume).toLocaleString()}`);
            if (m.endDate) bodyLines.push(`Ends: ${new Date(m.endDate).toLocaleDateString()}`);
            const url = m.source === "gamma"
              ? `https://polymarket.com/event/${m.id}`
              : `https://polymarket.com/market/${m.id}`;
            bodyLines.push(url);
            const cardLines = buildSidebarCard(m.title, bodyLines, cardInnerWidth);
            cards.push(...cardLines, "");
          }
          this.sidebarContent = cards.join("\n");
        }
      }

      this.sidebarLoading = false;
      this.sidebarUpdatedAt = formatTimestamp(new Date());
      this.sidebarPanel.setLoading(false);
      this.sidebarPanel.setContent(this.sidebarContent);
      this.sidebarPanel.setUpdatedAt(this.sidebarUpdatedAt);
      this.tui.requestRender();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.sidebarLoading = false;
      this.sidebarContent = `Error: ${message}`;
      this.sidebarUpdatedAt = formatTimestamp(new Date());
      this.sidebarPanel.setLoading(false);
      this.sidebarPanel.setContent(this.sidebarContent);
      this.sidebarPanel.setUpdatedAt(this.sidebarUpdatedAt);
      this.tui.requestRender();
    }
  }

  private async pollAutonomyLogs(): Promise<void> {
    try {
      await pollAutonomyLogs(this.session.runtime, this.lastAutonomyTime, (text) => {
        const trimmed = text.trim();
        if (!trimmed) return;
        const lines = trimmed.split("\n").map((line) => `[Autonomy] ${line}`);
        const now = Date.now();
        for (const line of lines) {
          this.appendMessage({
            id: uuidv4(),
            role: "system",
            content: line,
            timestamp: now,
          });
          this.appendLog(line);
        }
      });
    } catch {
      // Ignore errors
    }
  }

  private wrapLogger(): void {
    const logger = this.session.runtime.logger as LoggerLike;
    const MAX_LOG_LENGTH = 400;

    const wrap =
      (level: "info" | "warn" | "error" | "debug", original?: LoggerMethod) =>
      (...args: LogArg[]) => {
        if (original) original(...args);
        const text = formatLogArgs(args);
        if (!text) return;
        const clipped = text.length > MAX_LOG_LENGTH ? `${text.slice(0, MAX_LOG_LENGTH)}…` : text;
        this.appendLog(`${level.toUpperCase()}: ${clipped}`);
      };

    if (logger.info) logger.info = wrap("info", logger.info);
    if (logger.warn) logger.warn = wrap("warn", logger.warn);
    if (logger.error) logger.error = wrap("error", logger.error);
    if (logger.debug) logger.debug = wrap("debug", logger.debug);
  }

  private setupEventListeners(): void {
    const runtime = this.session.runtime;

    const onActionStarted = (payload: unknown) => {
      const typed = payload as ActionPayload;
      const content = typed.content;
      if (!content) return;
      const actionName = content.actions?.[0] ?? "action";
      const actionId =
        typeof content.actionId === "string" ? content.actionId : `${actionName}:${Date.now()}`;
      const messageId = uuidv4();
      this.actionMessageIds.set(actionId, messageId);
      this.appendMessage({
        id: messageId,
        role: "system",
        content: `calling ${actionName}...`,
        timestamp: Date.now(),
      });
      this.appendLog(`calling ${actionName}...`);
    };

    const onActionCompleted = (payload: unknown) => {
      const typed = payload as ActionPayload;
      const content = typed.content;
      if (!content) return;
      const actionName = content.actions?.[0] ?? "action";
      const actionId =
        typeof content.actionId === "string" ? content.actionId : `${actionName}:done`;
      const status =
        typeof content.actionStatus === "string" ? content.actionStatus : "completed";
      const messageId = this.actionMessageIds.get(actionId);
      if (messageId) {
        this.updateMessage(messageId, `action ${actionName} ${status}`);
        this.actionMessageIds.delete(actionId);
      } else {
        this.appendMessage({
          id: uuidv4(),
          role: "system",
          content: `action ${actionName} ${status}`,
          timestamp: Date.now(),
        });
      }
      this.appendLog(`action ${actionName} ${status}`);
    };

    runtime.on(EventType.ACTION_STARTED, onActionStarted as never);
    runtime.on(EventType.ACTION_COMPLETED, onActionCompleted as never);
  }

  private handleInput(char: string): void {
    // Ctrl+C: clear messages first, then exit
    if (char === "\x03") {
      if (this.messages.length > 0) {
        this.messages = [];
        this.chatPanel.setMessages(this.messages);
        this.scrollOffset = 0;
        this.chatPanel.setScrollOffset(0);
        this.tui.requestRender();
        return;
      }
      this.session.runtime.stop().finally(() => process.exit(0));
      this.tui.stop();
      return;
    }

    // Escape: clear input
    if (char === "\x1b") {
      this.input = "";
      this.tui.requestRender();
      return;
    }

    // Shift+Tab: toggle sidebar visibility
    if (char === "\x1b[Z") {
      if (this.layout === "split" || this.layout === "chat") {
        this.layout = "chat";
        this.focusPanel = "chat";
      } else {
        const { columns } = this.tui.getSize();
        const isWide = columns >= 110;
        this.layout = isWide ? "split" : "chat";
        this.focusPanel = "chat";
      }
      this.updateFocus();
      this.tui.requestRender();
      return;
    }

    // Tab: toggle focus
    if (char === "\t") {
      const { columns } = this.tui.getSize();
      const isWide = columns >= 110;

      if (this.layout === "split") {
        this.focusPanel = this.focusPanel === "chat" ? "sidebar" : "chat";
      } else if (this.layout === "chat") {
        this.layout = isWide ? "split" : "sidebar";
        this.focusPanel = "sidebar";
      } else {
        this.layout = isWide ? "split" : "chat";
        this.focusPanel = "chat";
      }
      this.updateFocus();
      this.tui.requestRender();
      return;
    }

    // Enter when sidebar is focused: cycle views
    if (char === "\r" && this.focusPanel === "sidebar") {
      const order: SidebarView[] = ["positions", "markets", "logs"];
      const current = order.indexOf(this.sidebarView);
      this.sidebarView = order[(current + 1) % order.length] ?? "positions";
      this.sidebarPanel.setView(this.sidebarView);
      this.sidebarScrollOffset = 0;
      this.sidebarPanel.setScrollOffset(0);
      this.updateSidebarContent();
      return;
    }

    // Scrolling for chat panel
    if (this.focusPanel === "chat") {
      if (char === "\x1b[5~") {
        // Page Up
        this.scrollOffset = Math.min(this.chatMaxScroll, this.scrollOffset + 10);
        this.chatPanel.setScrollOffset(this.scrollOffset);
        this.tui.requestRender();
        return;
      }
      if (char === "\x1b[6~") {
        // Page Down
        this.scrollOffset = Math.max(0, this.scrollOffset - 10);
        this.chatPanel.setScrollOffset(this.scrollOffset);
        this.tui.requestRender();
        return;
      }
      if (char === "\x1b[A" || char === "\x1b[B") {
        // Arrow keys
        const delta = char === "\x1b[A" ? 1 : -1;
        this.scrollOffset = Math.max(0, Math.min(this.chatMaxScroll, this.scrollOffset + delta));
        this.chatPanel.setScrollOffset(this.scrollOffset);
        this.tui.requestRender();
        return;
      }
    }

    // Scrolling for sidebar panel
    if (this.focusPanel === "sidebar") {
      if (char === "\x1b[5~") {
        // Page Up
        this.sidebarScrollOffset = Math.min(this.sidebarMaxScroll, this.sidebarScrollOffset + 10);
        this.sidebarPanel.setScrollOffset(this.sidebarScrollOffset);
        this.tui.requestRender();
        return;
      }
      if (char === "\x1b[6~") {
        // Page Down
        this.sidebarScrollOffset = Math.max(0, this.sidebarScrollOffset - 10);
        this.sidebarPanel.setScrollOffset(this.sidebarScrollOffset);
        this.tui.requestRender();
        return;
      }
      if (char === "\x1b[A" || char === "\x1b[B") {
        // Arrow keys
        const delta = char === "\x1b[A" ? 1 : -1;
        this.sidebarScrollOffset = Math.max(0, Math.min(this.sidebarMaxScroll, this.sidebarScrollOffset + delta));
        this.sidebarPanel.setScrollOffset(this.sidebarScrollOffset);
        this.tui.requestRender();
        return;
      }
    }

    // Pass to chat panel if focused
    if (this.focusPanel === "chat") {
      this.chatPanel.handleInput(char);
    }
  }

  private updateFocus(): void {
    this.chatPanel.setFocused(this.focusPanel === "chat");
    this.sidebarPanel.setFocused(this.focusPanel === "sidebar");
  }

  private async handleSubmit(text: string): Promise<void> {
    // Handle commands
    if (text === "/exit" || text === "/quit") {
      await this.session.runtime.stop();
      this.tui.stop();
      return;
    }

    if (text === "/help") {
      this.appendMessage({
        id: uuidv4(),
        role: "system",
        content: "Commands: /clear, /account, /markets, /logs, /autonomy true|false, /help, /exit",
        timestamp: Date.now(),
      });
      return;
    }

    if (text === "/clear") {
      this.messages = [];
      this.chatPanel.setMessages(this.messages);
      this.tui.requestRender();
      return;
    }

    if (text === "/account") {
      this.sidebarView = "positions";
      this.sidebarPanel.setView(this.sidebarView);
      this.layout = "split";
      this.updateSidebarContent();
      this.tui.requestRender();
      return;
    }

    if (text === "/markets") {
      this.sidebarView = "markets";
      this.sidebarPanel.setView(this.sidebarView);
      this.layout = "split";
      this.updateSidebarContent();
      this.tui.requestRender();
      return;
    }

    if (text === "/logs") {
      this.sidebarView = "logs";
      this.sidebarPanel.setView(this.sidebarView);
      this.layout = "split";
      this.updateSidebarContent();
      this.tui.requestRender();
      return;
    }

    if (text.startsWith("/autonomy")) {
      const parts = text.split(/\s+/);
      const valueArg = parts[1];
      if (valueArg !== "true" && valueArg !== "false") {
        this.appendMessage({
          id: uuidv4(),
          role: "system",
          content: "Usage: /autonomy true|false",
          timestamp: Date.now(),
        });
        return;
      }
      const enabled = valueArg === "true";
      const status = await setAutonomy(this.session.runtime, enabled);
      this.appendMessage({
        id: uuidv4(),
        role: "system",
        content: status,
        timestamp: Date.now(),
      });
      this.appendLog(`[Autonomy] ${status}`);
      return;
    }

    // Regular message
    this.isProcessing = true;
    this.tui.requestRender();

    const userMsg: ChatMessage = {
      id: uuidv4(),
      role: "user",
      content: text,
      timestamp: Date.now(),
    };
    this.appendMessage(userMsg);
    this.appendLog(`User: ${text}`);

    const assistantId = uuidv4();
    this.appendMessage({
      id: assistantId,
      role: "assistant",
      content: "(processing...)",
      timestamp: Date.now(),
    });
    this.appendLog("🔄 Processing...");

    try {
      const message = createMessageMemory({
        id: uuidv4() as UUID,
        entityId: this.session.userId,
        roomId: this.session.roomId,
        content: {
          text,
          source: "polymarket-demo",
          channelType: ChannelType.DM,
        },
      });

      let streamedText = "";
      let callbackText = "";

      await this.session.messageService.handleMessage(
        this.session.runtime,
        message,
        async (content: Content) => {
          if (typeof content.text === "string" && content.text.trim()) {
            const text = content.text.trim();
            const isActionResult = text.startsWith("⏳") || text.startsWith("🔍") ||
              text.startsWith("📊") || text.startsWith("❌") || text.startsWith("✅") ||
              text.includes("**");

            if (isActionResult) {
              const resultId = uuidv4();
              this.appendMessage({
                id: resultId,
                role: "assistant",
                content: text,
                timestamp: Date.now(),
              });
              this.appendLog(`Action Result: ${text.slice(0, 100)}...`);
            } else {
              callbackText = text;
            }
          }
          return [];
        },
        {
          onStreamChunk: async (chunk: string) => {
            streamedText += chunk;
            this.updateMessage(assistantId, streamedText);
          },
        } as never
      );

      const finalText = (streamedText || callbackText).trim();
      if (!finalText) {
        this.updateMessage(assistantId, "(no response)");
        this.appendLog("Eliza: (no response)");
      } else {
        this.updateMessage(assistantId, finalText);
        this.appendLog(`Eliza: ${finalText}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.updateMessage(assistantId, `Error: ${message}`);
      this.appendLog(`Error: ${message}`);
    } finally {
      this.isProcessing = false;
      this.tui.requestRender();
    }
  }

  // Custom render method for the TUI
  getRoot(): Component {
    return {
      render: (width: number, height: number) => {
        const { columns, rows } = this.tui.getSize();
        const isWide = columns >= 110;

        const headerHeight = rows >= 2 ? 1 : 0;
        const bottomReserve = rows >= 3 ? 1 : 0;
        const bodyHeight = Math.max(0, rows - headerHeight - bottomReserve);

        const showChat = this.layout === "chat" || this.layout === "split";
        const showSidebar = this.layout === "sidebar" || this.layout === "split";

        const targetSidebarWidth = Math.min(42, Math.max(28, Math.floor(columns * 0.35)));
        const sidebarWidth = showSidebar ? (showChat && isWide ? targetSidebarWidth : columns) : 0;
        const gap = showChat && showSidebar && isWide ? 1 : 0;
        const chatWidth = showChat ? Math.max(20, columns - sidebarWidth - gap) : 0;

        const showChatPanel = isWide ? showChat : this.layout !== "sidebar";
        const showSidebarPanel = isWide ? showSidebar : this.layout === "sidebar";

        const output: string[] = [];

        // Header
        if (headerHeight > 0) {
          const statusText = `Eliza Polymarket | ${this.balanceText} | ${this.isProcessing ? "..." : "Idle"} | Tab: Focus | Enter: View | Shift+Tab: Hide`;
          const headerText = statusText.length > columns - 2
            ? statusText.slice(0, columns - 5) + "..."
            : statusText;
          output.push(" " + chalk.hex("#FFA500")(headerText));
        }

        // Body
        const chatLines = showChatPanel
          ? this.chatPanel.render(chatWidth, bodyHeight)
          : [];
        const sidebarLines = showSidebarPanel
          ? this.sidebarPanel.render(isWide ? sidebarWidth : chatWidth, bodyHeight)
          : [];

        for (let i = 0; i < bodyHeight; i++) {
          let line = "";
          if (showChatPanel && chatLines[i]) {
            line += chatLines[i].padEnd(chatWidth);
          }
          if (gap > 0) {
            line += " ".repeat(gap);
          }
          if (showSidebarPanel && sidebarLines[i]) {
            line += sidebarLines[i];
          }
          output.push(line);
        }

        return output;
      },
    };
  }
}

export async function runPolymarketTui(session: TuiSession): Promise<void> {
  const app = new PolymarketTuiApp(session);

  // Create a custom root component
  const tui = new TUI();

  // Hijack the tui's run method to use our custom rendering
  const { columns, rows } = tui.getSize();

  // Override tui.setRoot to use our app
  const appRoot = app.getRoot();
  tui.setRoot(appRoot);

  await app.run();

  // Cleanup mouse tracking
  if (process.stdout?.write) {
    process.stdout.write("\x1b[?1000l\x1b[?1006l\x1b[?1015l\x1b[?1007l");
  }
}

// Settings Wizard types and implementation
export type SettingsField = {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly required?: boolean;
  readonly secret?: boolean;
  readonly type?: "text" | "select";
  readonly options?: readonly string[];
};

type SettingsWizardConfig = {
  readonly title: string;
  readonly subtitle?: string;
  readonly fields: SettingsField[];
};

type SettingsWizardResult =
  | { readonly status: "saved"; readonly values: Record<string, string> }
  | { readonly status: "cancelled" };

class SettingsWizardApp {
  private tui: TUI;
  private config: SettingsWizardConfig;
  private onDone: (result: SettingsWizardResult) => void;
  private index = 0;
  private values: Record<string, string>;
  private editor: Editor | null = null;
  private running = true;

  constructor(config: SettingsWizardConfig, onDone: (result: SettingsWizardResult) => void) {
    this.config = config;
    this.onDone = onDone;
    this.tui = new TUI();

    // Initialize values
    this.values = {};
    for (const field of config.fields) {
      this.values[field.key] = field.value ?? "";
    }
  }

  async run(): Promise<void> {
    this.updateEditor();
    await this.tui.run((char: string) => this.handleInput(char));
  }

  private updateEditor(): void {
    const field = this.config.fields[this.index];
    if (field && field.type !== "select") {
      this.editor = new Editor({
        width: 60,
        maxHeight: 1,
        initialText: this.values[field.key] ?? "",
        placeholder: field.secret ? "(hidden)" : "",
      });
      this.editor.setFocused(true);
    } else {
      this.editor = null;
    }
  }

  private handleInput(char: string): void {
    const fields = this.config.fields;
    const isReview = this.index >= fields.length;
    const currentField = fields[Math.min(this.index, fields.length - 1)];

    // Ctrl+C or Escape: cancel
    if (char === "\x03" || char === "\x1b") {
      this.onDone({ status: "cancelled" });
      this.tui.stop();
      return;
    }

    if (isReview) {
      if (char === "\r") {
        // Enter: save
        this.onDone({ status: "saved", values: this.values });
        this.tui.stop();
        return;
      }
      if (char === "\x1b[A") {
        // Up: go back
        this.index = Math.max(0, this.index - 1);
        this.updateEditor();
        this.tui.requestRender();
        return;
      }
      return;
    }

    if (!currentField) return;

    // Select field
    if (currentField.type === "select") {
      const options = currentField.options ?? [];
      if (options.length === 0) return;

      const currentValue = this.values[currentField.key] ?? options[0] ?? "";
      const currentIdx = Math.max(0, options.indexOf(currentValue));

      if (char === "\x1b[D") {
        // Left
        const nextIdx = (currentIdx - 1 + options.length) % options.length;
        this.values[currentField.key] = options[nextIdx] ?? currentValue;
        this.tui.requestRender();
        return;
      }
      if (char === "\x1b[C") {
        // Right
        const nextIdx = (currentIdx + 1) % options.length;
        this.values[currentField.key] = options[nextIdx] ?? currentValue;
        this.tui.requestRender();
        return;
      }
      if (char === "\r") {
        // Enter: next
        this.index++;
        this.updateEditor();
        this.tui.requestRender();
        return;
      }
    }

    // Text field
    if (char === "\x1b[A") {
      // Up: prev
      this.index = Math.max(0, this.index - 1);
      this.updateEditor();
      this.tui.requestRender();
      return;
    }
    if (char === "\x1b[B") {
      // Down: next
      this.index = Math.min(fields.length, this.index + 1);
      this.updateEditor();
      this.tui.requestRender();
      return;
    }
    if (char === "\r" && this.editor) {
      // Enter: save value and move next
      this.values[currentField.key] = this.editor.getText();
      this.index++;
      this.updateEditor();
      this.tui.requestRender();
      return;
    }

    // Pass to editor
    if (this.editor) {
      this.editor.handleInput(char);
      this.tui.requestRender();
    }
  }

  getRoot(): Component {
    return {
      render: (width: number, height: number) => {
        const output: string[] = [];
        const fields = this.config.fields;
        const isReview = this.index >= fields.length;
        const currentField = fields[Math.min(this.index, fields.length - 1)];

        output.push(" " + chalk.bold(this.config.title));
        if (this.config.subtitle) {
          output.push(" " + chalk.dim(this.config.subtitle));
        }
        output.push("");

        if (isReview) {
          output.push(" Review settings:");
          for (const field of fields) {
            const value = this.values[field.key] ?? "";
            const pretty = field.secret && value.length > 0
              ? "•".repeat(Math.min(12, value.length))
              : value || "(empty)";
            const requiredMark = field.required ? "*" : "";
            output.push(` ${field.label}${requiredMark}: ${pretty}`);
          }
          output.push("");
          output.push(" " + chalk.dim("Press Enter to save, Esc to cancel, Up to edit."));
        } else if (currentField) {
          const requiredMark = currentField.required ? "*" : "";
          output.push(` ${currentField.label}${requiredMark} (${this.index + 1}/${fields.length})`);

          if (currentField.type === "select") {
            const options = currentField.options ?? [];
            const currentValue = this.values[currentField.key] ?? options[0] ?? "";
            output.push(" " + chalk.dim("Use ← → to change, Enter to confirm. ") + chalk.cyan(currentValue));
          } else if (this.editor) {
            const editorLines = this.editor.render(60, 1);
            output.push(" " + (editorLines[0] || ""));
          }

          output.push("");
          output.push(" " + chalk.dim("Enter to continue, Esc to cancel, Up/Down to move."));
        }

        return output;
      },
    };
  }
}

export async function runSettingsWizard(
  config: SettingsWizardConfig
): Promise<SettingsWizardResult> {
  return new Promise((resolve) => {
    let result: SettingsWizardResult = { status: "cancelled" };
    const app = new SettingsWizardApp(config, (r) => {
      result = r;
    });

    const tui = new TUI();
    tui.setRoot(app.getRoot());

    app.run().then(() => {
      resolve(result);
    });
  });
}
