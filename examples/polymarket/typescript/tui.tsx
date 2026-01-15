import { Box, Text, render, useApp, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { v4 as uuidv4 } from "uuid";
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

type SidebarView = "chat" | "positions" | "markets" | "logs";

type RenderLine = {
  readonly key: string;
  readonly text: string;
  readonly color?: string;
  readonly dim?: boolean;
  readonly bold?: boolean;
  readonly italic?: boolean;
};

type TuiSession = {
  readonly runtime: AgentRuntime;
  readonly roomId: UUID;
  readonly worldId: UUID;
  readonly userId: UUID;
  readonly messageService: IMessageService;
};

type SidebarState = {
  readonly visible: boolean;
  readonly view: SidebarView;
  readonly loading: boolean;
  readonly content: string;
  readonly updatedAt?: string;
};

type StreamTagState = {
  opened: boolean;
  done: boolean;
  text: string;
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

function sanitizeLine(text: string): string {
  return text
    .replace(/\r/g, " ")
    .replace(/\n/g, " ")
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    .trimEnd();
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

function extractTagFromBuffer(
  buffer: { value: string },
  tag: string,
  state: StreamTagState
): void {
  if (state.done) return;
  const openTag = `<${tag}>`;
  const closeTag = `</${tag}>`;

  if (!state.opened) {
    const openIdx = buffer.value.indexOf(openTag);
    if (openIdx === -1) return;
    buffer.value = buffer.value.slice(openIdx + openTag.length);
    state.opened = true;
  }

  if (!state.opened) return;
  const closeIdx = buffer.value.indexOf(closeTag);
  if (closeIdx !== -1) {
    state.text += buffer.value.slice(0, closeIdx);
    buffer.value = buffer.value.slice(closeIdx + closeTag.length);
    state.done = true;
    return;
  }

  if (buffer.value.length > closeTag.length) {
    state.text += buffer.value.slice(0, buffer.value.length - closeTag.length);
    buffer.value = buffer.value.slice(buffer.value.length - closeTag.length);
  }
}

function toRenderLines(messages: ChatMessage[], maxWidth: number): RenderLine[] {
  const lines: RenderLine[] = [];
  for (const msg of messages) {
    if (msg.role === "system") {
      const wrapped = wrapText(msg.content, maxWidth);
      wrapped.forEach((line, idx) => {
        lines.push({
          key: `${msg.id}:system:${idx}`,
          text: sanitizeLine(line),
          dim: true,
          italic: true,
        });
      });
      continue;
    }
    const speaker = msg.role === "user" ? "You" : "Eliza";
    const color = msg.role === "user" ? "cyan" : "green";
    const header = `${speaker} ${formatTime(msg.timestamp)}`;
    lines.push({
      key: `${msg.id}:header`,
      text: sanitizeLine(header),
      color,
      bold: true,
    });
    const indent = "  ";
    const wrapped = wrapText(msg.content, Math.max(1, maxWidth - indent.length));
    wrapped.forEach((line, idx) => {
      lines.push({
        key: `${msg.id}:body:${idx}`,
        text: sanitizeLine(`${indent}${line}`),
      });
    });
  }
  return lines;
}

function getChatMaxScroll(messages: ChatMessage[], width: number, height: number): number {
  const contentWidth = Math.max(10, width - 4);
  const maxContentLines = Math.max(1, height - 4);
  const renderLines = toRenderLines(messages, contentWidth);
  return Math.max(0, renderLines.length - maxContentLines);
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

function ChatPanel(props: {
  readonly messages: ChatMessage[];
  readonly input: string;
  readonly onInputChange: (value: string) => void;
  readonly onSubmit: (value: string) => void;
  readonly width: number;
  readonly height: number;
  readonly scrollOffset: number;
  readonly isActive: boolean;
}): JSX.Element {
  const { messages, input, onInputChange, onSubmit, width, height, scrollOffset, isActive } = props;
  const contentWidth = Math.max(10, width - 4);
  const inputWidth = Math.max(10, width - 8);
  const renderLines = toRenderLines(messages, contentWidth);
  const maxContentLines = Math.max(1, height - 4);
  
  // Calculate visible window with scroll offset
  const totalLines = renderLines.length;
  const maxScroll = Math.max(0, totalLines - maxContentLines);
  const effectiveOffset = Math.min(scrollOffset, maxScroll);
  const startIdx = Math.max(0, totalLines - maxContentLines - effectiveOffset);
  const endIdx = totalLines - effectiveOffset;
  const visibleLines = renderLines.slice(startIdx, endIdx);
  
  const scrollIndicator = effectiveOffset > 0 ? ` ↑${effectiveOffset}` : "";

  return (
    <Box width={width} height={height} borderStyle="round" flexDirection="column">
      <Box flexDirection="column" paddingX={1} paddingTop={1} flexGrow={1}>
        {visibleLines.map((line) => (
          <Text
            key={line.key}
            color={line.color}
            dimColor={line.dim}
            bold={line.bold}
            italic={line.italic}
            wrap="truncate"
          >
            {sanitizeLine(line.text)}
          </Text>
        ))}
      </Box>
      <Box paddingX={1} paddingBottom={1}>
        <Text color="cyan">You:{scrollIndicator} </Text>
        <Box flexGrow={1}>
          <TextInput
            value={input}
            onChange={onInputChange}
            onSubmit={onSubmit}
            width={inputWidth}
            focus={isActive}
            showCursor={isActive}
          />
        </Box>
      </Box>
    </Box>
  );
}

function SidebarPanel(props: {
  readonly state: SidebarState;
  readonly width: number;
  readonly height: number;
  readonly logs: string[];
}): JSX.Element {
  const { state, width, height, logs } = props;
  const title =
    state.view === "positions"
      ? "Account"
      : state.view === "markets"
        ? "Active Markets"
        : "Agent Logs";
  const header = state.updatedAt ? `${title} (${state.updatedAt})` : title;
  const contentWidth = Math.max(10, width - 2);
  const headerLines = wrapText(header, contentWidth);
  const bodyLines: string[] = [];

  if (state.view === "logs") {
    const logLines = logs.length > 0 ? logs : ["No logs yet."];
    logLines.forEach((line) => wrapText(line, contentWidth).forEach((l) => bodyLines.push(l)));
  } else if (state.loading) {
    wrapText("Loading...", contentWidth).forEach((line) => bodyLines.push(line));
  } else {
    const content = state.content.length > 0 ? state.content : "No data.";
    wrapText(content, contentWidth).forEach((line) => bodyLines.push(line));
  }

  const maxLines = Math.max(1, height - 2);
  const maxBodyLines = Math.max(0, maxLines - headerLines.length);
  const visibleBody =
    bodyLines.length > maxBodyLines ? bodyLines.slice(bodyLines.length - maxBodyLines) : bodyLines;
  const visible = [...headerLines, ...visibleBody].slice(0, maxLines);

  return (
    <Box width={width} height={height} borderStyle="round" flexDirection="column" paddingX={1} paddingTop={1}>
      {visible.map((line, idx) => (
        <Text key={`${header}:${idx}`} wrap="truncate">
          {sanitizeLine(line)}
        </Text>
      ))}
    </Box>
  );
}

function PolymarketTuiApp({ runtime, roomId, userId, messageService }: TuiSession): JSX.Element {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [scrollOffset, setScrollOffset] = useState(0);
  const [sidebarView, setSidebarView] = useState<SidebarView>("chat");
  const [isProcessing, setIsProcessing] = useState(false);
  const [sidebarState, setSidebarState] = useState<SidebarState>({
    visible: true,
    view: "positions",
    loading: true,
    content: "Loading...",
  });
  const [logs, setLogs] = useState<string[]>([]);
  const marketNameCacheRef = useRef<Map<string, string>>(new Map());
  const lastAutonomyRef = useRef<{ value: number }>({ value: 0 });
  const actionMessageIdsRef = useRef<Map<string, string>>(new Map());
  const [balanceText, setBalanceText] = useState("USDC: --");

  // Fetch balance on mount for header display
  useEffect(() => {
    let cancelled = false;
    const fetchBalance = async () => {
      let service = runtime.getService<PolymarketService>(POLYMARKET_SERVICE_NAME);
      if (!service && typeof runtime.getServiceLoadPromise === "function") {
        try {
          service = await runtime.getServiceLoadPromise(POLYMARKET_SERVICE_NAME) as PolymarketService;
        } catch {
          // Service load failed
        }
      }
      // Retry a few times if service not ready
      if (!service) {
        for (let i = 0; i < 10 && !cancelled; i++) {
          await new Promise((r) => setTimeout(r, 500));
          service = runtime.getService<PolymarketService>(POLYMARKET_SERVICE_NAME);
          if (service) break;
        }
      }
      if (service && !cancelled) {
        try {
          const state = await service.refreshAccountState();
          const balance = state?.balances?.collateral?.balance;
          if (balance !== undefined && !cancelled) {
            setBalanceText(`USDC: $${balance}`);
          }
        } catch {
          // Balance fetch failed silently
        }
      }
    };
    fetchBalance();
    return () => { cancelled = true; };
  }, [runtime]);

  const [terminalSize, setTerminalSize] = useState(() => ({
    columns: stdout?.columns ?? 100,
    rows: stdout?.rows ?? 28,
  }));
  const columns = terminalSize.columns;
  const rows = terminalSize.rows;
  const headerHeight = 3;
  const sidebarWidth = 0;
  const chatWidth = columns;
  const bodyHeight = Math.max(10, rows - headerHeight);

  const appendLog = useCallback((line: string) => {
    setLogs((prev) => {
      const next = [...prev, line];
      return next.length > 200 ? next.slice(next.length - 200) : next;
    });
  }, []);

  const appendMessage = useCallback((msg: ChatMessage) => {
    setMessages((prev) => [...prev, msg]);
    setScrollOffset(0); // Reset scroll to show latest
  }, []);

  useEffect(() => {
    if (!stdout) return;
    const update = () => {
      setTerminalSize({
        columns: stdout.columns ?? 100,
        rows: stdout.rows ?? 28,
      });
    };
    stdout.on("resize", update);
    return () => {
      stdout.off("resize", update);
    };
  }, [stdout]);

  const updateMessage = useCallback((id: string, content: string) => {
    setMessages((prev) =>
      prev.map((msg) => (msg.id === id ? { ...msg, content } : msg))
    );
  }, []);

  useEffect(() => {
    setSidebarState((prev) => ({
      ...prev,
      visible: true,
      view: sidebarView === "chat" ? "positions" : sidebarView,
    }));
  }, [sidebarView]);

  useEffect(() => {
    if (sidebarView === "chat" || sidebarView === "logs") {
      setSidebarState((prev) => ({ ...prev, loading: false }));
      return;
    }
    let isActive = true;
    const update = async () => {
      setSidebarState((prev) => ({ ...prev, loading: true, content: "Starting up..." }));
      
      let service = runtime.getService<PolymarketService>(POLYMARKET_SERVICE_NAME);
      if (!service && typeof runtime.getServiceLoadPromise === "function") {
        try {
          service = await runtime.getServiceLoadPromise(POLYMARKET_SERVICE_NAME) as PolymarketService;
        } catch {
          // Service failed to load
        }
      }
      if (!service) {
        for (let attempt = 0; attempt < 5 && isActive; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          service = runtime.getService<PolymarketService>(POLYMARKET_SERVICE_NAME);
          if (service) break;
          if (isActive) {
            setSidebarState((prev) => ({
              ...prev,
              content: `Starting up... (attempt ${attempt + 2}/6)`,
            }));
          }
        }
      }
      
      if (!service) {
        if (isActive) {
          setSidebarState((prev) => ({
            ...prev,
            loading: false,
            content: "Polymarket service failed to start. Check logs for errors.",
            updatedAt: formatTimestamp(new Date()),
          }));
        }
        return;
      }
      try {
        if (sidebarView === "positions") {
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
          lines.push(`🔐 Account: ${accountLabel}`);

          const balance = state?.balances?.collateral?.balance;
          const allowance = state?.balances?.collateral?.allowance;
          if (balance !== undefined) {
            setBalanceText(`USDC: $${balance}`);
          }
          if (balance !== undefined) {
            lines.push(`💰 USDC: $${balance}`);
            if (allowance !== undefined && allowance !== balance) {
              lines.push(`   Allowance: $${allowance}`);
            }
            lines.push("");
          } else {
            lines.push("💰 USDC: Unable to fetch");
            lines.push("");
          }
          
          if (positions.length === 0) {
            lines.push("No positions found.");
          } else {
            lines.push(`📊 Positions (${positions.length}):`);
            const entries = await Promise.all(
              positions.slice(0, 10).map(async (pos, idx) => {
                const size = Number.parseFloat(pos.size);
                const avg = Number.parseFloat(pos.average_price);
                const odds = Number.isFinite(avg) ? avg.toFixed(4) : "N/A";
                const side = size >= 0 ? "LONG" : "SHORT";
                const marketIdRaw = pos.market || "";
                const marketId = shortenId(marketIdRaw);
                let marketName = pos.market || "Unknown market";

                if (marketIdRaw.startsWith("0x")) {
                  const cachedName = marketNameCacheRef.current.get(marketIdRaw);
                  if (cachedName) {
                    marketName = cachedName;
                  } else {
                    try {
                      const market = (await service.getClobClient().getMarket(
                        marketIdRaw
                      )) as Market;
                      if (market?.question) {
                        marketName = market.question;
                        marketNameCacheRef.current.set(marketIdRaw, market.question);
                      }
                    } catch {
                      // Lookup failed, use fallback
                    }
                  }
                }

                return `${idx + 1}. ${marketName}\n   ${side} ${Math.abs(size).toFixed(4)} @ ${odds}`;
              })
            );
            lines.push(...entries);
          }
          
          const content = lines.join("\n");
          if (isActive) {
            setSidebarState((prev) => ({
              ...prev,
              loading: false,
              content,
              updatedAt: formatTimestamp(new Date()),
            }));
          }
        } else if (sidebarView === "markets") {
          // Fetch from both Gamma and CLOB APIs in parallel for best coverage
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
                volume: 0, // CLOB doesn't return volume in basic listing
                endDate: m.end_date_iso || null,
                source: "clob",
              }));
          })().catch(() => [] as MarketItem[]);

          const [gammaMarkets, clobMarkets] = await Promise.all([gammaPromise, clobPromise]);
          
          // Combine and dedupe by title (prefer gamma for volume data)
          const seen = new Set<string>();
          const combined: MarketItem[] = [];
          
          // Add gamma markets first (they have volume)
          for (const m of gammaMarkets) {
            const key = m.title.toLowerCase().slice(0, 50);
            if (!seen.has(key)) {
              seen.add(key);
              combined.push(m);
            }
          }
          
          // Add unique CLOB markets
          for (const m of clobMarkets) {
            const key = m.title.toLowerCase().slice(0, 50);
            if (!seen.has(key)) {
              seen.add(key);
              combined.push(m);
            }
          }
          
          // Sort by volume (highest first), then by end date (soonest first)
          combined.sort((a, b) => {
            if (b.volume !== a.volume) return b.volume - a.volume;
            if (a.endDate && b.endDate) {
              return new Date(a.endDate).getTime() - new Date(b.endDate).getTime();
            }
            return 0;
          });
          
          const trimmed = combined.slice(0, 12);
          const content =
            trimmed.length === 0
              ? "No active markets found."
              : trimmed
                  .map((m, idx) => {
                    const vol = m.volume > 0 ? ` [$${Math.round(m.volume).toLocaleString()}]` : "";
                    const end = m.endDate ? ` (${new Date(m.endDate).toLocaleDateString()})` : "";
                    return `${idx + 1}. ${m.title}${vol}${end}`;
                  })
                  .join("\n");
          if (isActive) {
            setSidebarState((prev) => ({
              ...prev,
              loading: false,
              content,
              updatedAt: formatTimestamp(new Date()),
            }));
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isActive) {
          setSidebarState((prev) => ({
            ...prev,
            loading: false,
            content: `Error: ${message}`,
            updatedAt: formatTimestamp(new Date()),
          }));
        }
      }
    };
    update().catch(() => undefined);
    return () => {
      isActive = false;
    };
  }, [runtime, sidebarView]);

  useEffect(() => {
    const timer = setInterval(() => {
      pollAutonomyLogs(runtime, lastAutonomyRef.current, (text) => {
        const trimmed = text.trim();
        if (!trimmed) return;
        const lines = trimmed.split("\n").map((line) => `[Autonomy] ${line}`);
        const now = Date.now();
        lines.forEach((line) => {
          appendMessage({
            id: uuidv4(),
            role: "system",
            content: line,
            timestamp: now,
          });
          appendLog(line);
        });
      }).catch(() => undefined);
    }, 1500);
    return () => clearInterval(timer);
  }, [appendLog, appendMessage, runtime]);

  useEffect(() => {
    const logger = runtime.logger as LoggerLike;
    const MAX_LOG_LENGTH = 400;

    // Logs only go to the logs page, NOT to the chat
    const wrap =
      (level: "info" | "warn" | "error" | "debug", original?: LoggerMethod) =>
      (...args: LogArg[]) => {
        if (original) original(...args);
        const text = formatLogArgs(args);
        if (!text) return;
        const clipped = text.length > MAX_LOG_LENGTH ? `${text.slice(0, MAX_LOG_LENGTH)}…` : text;
        appendLog(`${level.toUpperCase()}: ${clipped}`);
      };

    const originalInfo = logger.info;
    const originalWarn = logger.warn;
    const originalError = logger.error;
    const originalDebug = logger.debug;

    if (logger.info) logger.info = wrap("info", originalInfo);
    if (logger.warn) logger.warn = wrap("warn", originalWarn);
    if (logger.error) logger.error = wrap("error", originalError);
    if (logger.debug) logger.debug = wrap("debug", originalDebug);

    return () => {
      if (logger.info) logger.info = originalInfo;
      if (logger.warn) logger.warn = originalWarn;
      if (logger.error) logger.error = originalError;
      if (logger.debug) logger.debug = originalDebug;
    };
  }, [appendLog, runtime]);

  useEffect(() => {
    const onActionStarted = (payload: ActionPayload) => {
      const content = payload.content;
      if (!content) return;
      const actionName = content.actions?.[0] ?? "action";
      const actionId =
        typeof content.actionId === "string" ? content.actionId : `${actionName}:${Date.now()}`;
      const messageId = uuidv4();
      actionMessageIdsRef.current.set(actionId, messageId);
      appendMessage({
        id: messageId,
        role: "system",
        content: `Action: ${actionName} (running)`,
        timestamp: Date.now(),
      });
    };

    const onActionCompleted = (payload: ActionPayload) => {
      const content = payload.content;
      if (!content) return;
      const actionName = content.actions?.[0] ?? "action";
      const actionId =
        typeof content.actionId === "string" ? content.actionId : `${actionName}:done`;
      const status =
        typeof content.actionStatus === "string" ? content.actionStatus : "completed";
      const messageId = actionMessageIdsRef.current.get(actionId);
      if (messageId) {
        updateMessage(messageId, `Action: ${actionName} (${status})`);
        actionMessageIdsRef.current.delete(actionId);
      } else {
        appendMessage({
          id: uuidv4(),
          role: "system",
          content: `Action: ${actionName} (${status})`,
          timestamp: Date.now(),
        });
      }
    };

    runtime.on(EventType.ACTION_STARTED, onActionStarted);
    runtime.on(EventType.ACTION_COMPLETED, onActionCompleted);
    return () => {
      runtime.off(EventType.ACTION_STARTED, onActionStarted);
      runtime.off(EventType.ACTION_COMPLETED, onActionCompleted);
    };
  }, [appendMessage, updateMessage, runtime]);

  const handleSubmit = useCallback(
    async (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) return;
      setInput("");
      setIsProcessing(true);
      try {
        if (trimmed === "/exit" || trimmed === "/quit") {
          exit();
          return;
        }
        if (trimmed === "/help") {
          appendMessage({
            id: uuidv4(),
            role: "system",
            content: "Commands: /account, /markets, /logs, /autonomy true|false, /help, /exit",
            timestamp: Date.now(),
          });
          return;
        }
        if (trimmed === "/account") {
          setSidebarView("positions");
          return;
        }
        if (trimmed === "/markets") {
          setSidebarView("markets");
          return;
        }
        if (trimmed === "/logs") {
          setSidebarView("logs");
          return;
        }
        if (trimmed.startsWith("/autonomy")) {
          const parts = trimmed.split(/\s+/);
          const valueArg = parts[1];
          if (valueArg !== "true" && valueArg !== "false") {
            appendMessage({
              id: uuidv4(),
              role: "system",
              content: "Usage: /autonomy true|false",
              timestamp: Date.now(),
            });
            return;
          }
          const enabled = valueArg === "true";
          const status = await setAutonomy(runtime, enabled);
          appendMessage({
            id: uuidv4(),
            role: "system",
            content: status,
            timestamp: Date.now(),
          });
          appendLog(`[Autonomy] ${status}`);
          return;
        }

      const userMsg: ChatMessage = {
        id: uuidv4(),
        role: "user",
        content: trimmed,
        timestamp: Date.now(),
      };
      appendMessage(userMsg);
      appendLog(`User: ${trimmed}`);

      const assistantId = uuidv4();
      appendMessage({
        id: assistantId,
        role: "assistant",
        content: "(processing...)",
        timestamp: Date.now(),
      });
      appendLog("🔄 Processing...");

      const message = createMessageMemory({
        id: uuidv4() as UUID,
        entityId: userId,
        roomId,
        content: {
          text: trimmed,
          source: "polymarket-demo",
          channelType: ChannelType.DM,
        },
      });

      const thoughtId = uuidv4();
      const actionsId = uuidv4();
      let thoughtShown = false;
      let actionsShown = false;
      const thoughtState: StreamTagState = { opened: false, done: false, text: "" };
      const actionsState: StreamTagState = { opened: false, done: false, text: "" };
      const buffer = { value: "" };
      let streamedText = "";
      let callbackText = "";

      const showThought = (value: string) => {
        const text = value.trim();
        if (!text) return;
        if (!thoughtShown) {
          appendMessage({
            id: thoughtId,
            role: "system",
            content: `Thought: ${text}`,
            timestamp: Date.now(),
          });
          thoughtShown = true;
        } else {
          updateMessage(thoughtId, `Thought: ${text}`);
        }
      };

      const showActions = (value: string) => {
        const text = value.trim();
        if (!text) return;
        if (!actionsShown) {
          appendMessage({
            id: actionsId,
            role: "system",
            content: `Actions: ${text}`,
            timestamp: Date.now(),
          });
          actionsShown = true;
        } else {
          updateMessage(actionsId, `Actions: ${text}`);
        }
      };

      // Track action result messages separately
      const actionResultIds: string[] = [];

      await messageService.handleMessage(
        runtime,
        message,
        async (content: Content) => {
          // Show action results immediately as they come in
          if (typeof content.text === "string" && content.text.trim()) {
            const text = content.text.trim();
            // Check if this looks like an action result (has emoji or formatting)
            const isActionResult = text.startsWith("⏳") || text.startsWith("🔍") || 
              text.startsWith("📊") || text.startsWith("❌") || text.startsWith("✅") ||
              text.includes("**");
            
            if (isActionResult) {
              // Create a new message for action results
              const resultId = uuidv4();
              actionResultIds.push(resultId);
              appendMessage({
                id: resultId,
                role: "assistant",
                content: text,
                timestamp: Date.now(),
              });
              appendLog(`Action Result: ${text.slice(0, 100)}...`);
            } else {
              // Regular callback text
              callbackText = text;
            }
          }
          if (Array.isArray(content.actions) && content.actions.length > 0) {
            showActions(content.actions.join(", "));
          }
          return [];
        },
        {
          onStreamChunk: async (chunk: string) => {
            streamedText += chunk;
            buffer.value += chunk;
            extractTagFromBuffer(buffer, "thought", thoughtState);
            extractTagFromBuffer(buffer, "actions", actionsState);
            if (thoughtState.text.length > 0) {
              showThought(thoughtState.text);
            }
            if (actionsState.text.length > 0) {
              showActions(actionsState.text);
            }
            updateMessage(assistantId, streamedText);
          },
        }
      );

        const finalText = (streamedText || callbackText).trim();
        if (!finalText) {
          updateMessage(assistantId, "(no response)");
          appendLog("Eliza: (no response)");
        } else {
          updateMessage(assistantId, finalText);
          appendLog(`Eliza: ${finalText}`);
        }
      } finally {
        setIsProcessing(false);
      }
    },
    [appendLog, appendMessage, exit, messageService, roomId, runtime, updateMessage, userId]
  );

  useInput((_, key) => {
    if (key.ctrl && key.name === "c") {
      exit();
      return;
    }
    if (sidebarView === "chat") {
      const maxScroll = getChatMaxScroll(messages, chatWidth, bodyHeight);
      if (key.pageUp || (key.shift && key.upArrow)) {
        setScrollOffset((prev) => Math.min(maxScroll, prev + (key.pageUp ? 10 : 1)));
        return;
      }
      if (key.pageDown || (key.shift && key.downArrow)) {
        setScrollOffset((prev) => Math.max(0, prev - (key.pageDown ? 10 : 1)));
        return;
      }
      if (key.name === "home") {
        setScrollOffset(maxScroll);
        return;
      }
      if (key.name === "end") {
        setScrollOffset(0);
        return;
      }
    }
    if (key.shift && (key.tab || key.name === "tab")) {
      const order: SidebarView[] = ["chat", "positions", "markets", "logs"];
      const current = order.indexOf(sidebarView);
      const next = current <= 0 ? order.length - 1 : current - 1;
      setSidebarView(order[next] ?? "positions");
      return;
    }
    if (key.tab) {
      const order: SidebarView[] = ["chat", "positions", "markets", "logs"];
      const current = order.indexOf(sidebarView);
      const next = current >= order.length - 1 ? 0 : current + 1;
      setSidebarView(order[next] ?? "positions");
      return;
    }
  });

  const statusText = useMemo(
    () =>
      `Eliza Polymarket | ${balanceText} | ${isProcessing ? "Responding..." : "Idle"} | Tab Next | Shift+Tab Prev`,
    [balanceText, isProcessing]
  );

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Box borderStyle="round" paddingX={1}>
        <Text color="#FFA500">{statusText}</Text>
      </Box>
      <Box flexDirection="row" gap={1}>
        <Box display={sidebarView === "chat" ? "flex" : "none"} width={chatWidth} height={bodyHeight}>
          <ChatPanel
            messages={messages}
            input={input}
            onInputChange={setInput}
            onSubmit={handleSubmit}
            width={chatWidth}
            height={bodyHeight}
            scrollOffset={scrollOffset}
            isActive={sidebarView === "chat"}
          />
        </Box>
        <Box display={sidebarView === "chat" ? "none" : "flex"} width={chatWidth} height={bodyHeight}>
          <SidebarPanel
            state={{ ...sidebarState, visible: true, view: sidebarView }}
            width={chatWidth}
            height={bodyHeight}
            logs={logs}
          />
        </Box>
      </Box>
    </Box>
  );
}

export async function runPolymarketTui(session: TuiSession): Promise<void> {
  const { waitUntilExit } = render(<PolymarketTuiApp {...session} />);
  await waitUntilExit();
}
