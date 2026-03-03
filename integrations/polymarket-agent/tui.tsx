import type { ReactNode } from "react";
import { Box, Text, render, useApp, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// Global error state for fatal errors that need to be displayed
let globalFatalError: string | null = null;
let fatalErrorCallbacks: Array<(error: string) => void> = [];

/**
 * Set a fatal error to be displayed in the TUI.
 * This is called from error handlers when a crash occurs.
 */
export function setFatalError(message: string): void {
  globalFatalError = message;
  fatalErrorCallbacks.forEach((cb) => cb(message));
}

/**
 * Hook to subscribe to fatal errors in the TUI.
 */
function useFatalError(): string | null {
  const [error, setError] = useState<string | null>(globalFatalError);
  
  useEffect(() => {
    const callback = (msg: string) => setError(msg);
    fatalErrorCallbacks.push(callback);
    // Check if there's already an error
    if (globalFatalError) {
      setError(globalFatalError);
    }
    return () => {
      fatalErrorCallbacks = fatalErrorCallbacks.filter((cb) => cb !== callback);
    };
  }, []);
  
  return error;
}
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

// Type for ink's useInput key parameter (extended with name for compatibility)
type InkKey = {
  upArrow: boolean;
  downArrow: boolean;
  leftArrow: boolean;
  rightArrow: boolean;
  pageDown: boolean;
  pageUp: boolean;
  return: boolean;
  escape: boolean;
  ctrl: boolean;
  shift: boolean;
  tab: boolean;
  backspace: boolean;
  delete: boolean;
  meta: boolean;
  name?: string;
};
import { v4 as uuidv4 } from "uuid";
import POLYMARKET_SERVICE_NAME from "@elizaos/plugin-polymarket";
import type PolymarketService from "@elizaos/plugin-polymarket";
import type Market from "@elizaos/plugin-polymarket";
import type MarketsResponse from "@elizaos/plugin-polymarket";

type ChatRole = "user" | "assistant" | "system";

type ChatMessage = {
  readonly id: string;
  readonly role: ChatRole;
  readonly content: string;
  readonly timestamp: number;
};

type SidebarView = "positions" | "markets" | "logs";

type FocusPanel = "chat" | "sidebar";

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

function truncateText(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (text.length <= maxWidth) return text;
  if (maxWidth <= 3) return text.slice(0, maxWidth);
  return text.slice(0, Math.max(0, maxWidth - 3)) + "...";
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

function wrapCardLines(text: string, maxWidth: number): string[] {
  if (text.length <= maxWidth) return [text];
  const words = text.split(" ");
  const lines: string[] = [];
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
  if (current.length > 0) lines.push(current);
  return lines.length > 0 ? lines : [""];
}

function buildSidebarCard(title: string, lines: string[], maxInnerWidth: number): string {
  const titleLines = wrapCardLines(title, maxInnerWidth);
  const bodyLines = lines.flatMap((line) => wrapCardLines(line, maxInnerWidth));
  const allLines = [...titleLines, ...bodyLines];
  const widest = Math.max(12, ...allLines.map((line) => line.length));
  const contentWidth = Math.min(maxInnerWidth, widest);
  const border = "-".repeat(contentWidth);
  const divider = "=".repeat(contentWidth);
  const renderLine = (line: string) => line.padEnd(contentWidth);
  const rows = [
    border,
    ...titleLines.map(renderLine),
    divider,
    ...bodyLines.map(renderLine),
    border,
  ];
  return rows.join("\n");
}

function getSidebarCardInnerWidth(panelWidth: number): number {
  const contentWidth = Math.max(10, panelWidth - 2);
  return Math.max(12, contentWidth - 4);
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

function isCardBorderLine(line: string): boolean {
  const trimmed = line.trimEnd();
  return trimmed.length > 0 && /^-+$/.test(trimmed);
}

function isCardDividerLine(line: string): boolean {
  const trimmed = line.trimEnd();
  return trimmed.length > 0 && /^=+$/.test(trimmed);
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
    const header = `${speaker}: ${formatTime(msg.timestamp)}`;
    lines.push({
      key: `${msg.id}:header`,
      text: sanitizeLine(header),
      color,
      bold: true,
    });
    const indent = "  ";
    const contentLines = msg.content.split("\n");
    let lineIndex = 0;
    for (const rawLine of contentLines) {
      // Card border/divider lines don't get wrapped or indented
      if (isCardBorderLine(rawLine) || isCardDividerLine(rawLine)) {
        lines.push({
          key: `${msg.id}:card:${lineIndex}`,
          text: sanitizeLine(rawLine),
        });
        lineIndex += 1;
        continue;
      }
      const wrapped = wrapText(rawLine, Math.max(1, maxWidth - indent.length));
      wrapped.forEach((line) => {
        lines.push({
          key: `${msg.id}:body:${lineIndex}`,
          text: sanitizeLine(`${indent}${line}`),
        });
        lineIndex += 1;
      });
    }
  }
  return lines;
}

function hasMouseSequence(value: string): boolean {
  return (
    /\x1b\[<\d+;\d+;\d+[mM]/.test(value) ||
    /\x1b\[\d+;\d+;\d+M/.test(value) ||
    /\x1b\[M[\s\S]{3}/.test(value) ||
    /\[<?\d+;\d+;\d+[mM]/.test(value) ||
    /\[M[\s\S]{3}/.test(value)
  );
}

function consumeMouseScroll(
  buffer: string
): { remaining: string; delta: number } {
  let delta = 0;
  let lastIndex = 0;
  const sgrPattern = /\x1b\[<(64|65|96|97);(\d+);(\d+)[mM]/g;
  let match = sgrPattern.exec(buffer);
  while (match) {
    // Terminal mouse: 64/96=wheel up, 65/97=wheel down
    delta += match[1] === "64" || match[1] === "96" ? 1 : -1;
    lastIndex = sgrPattern.lastIndex;
    match = sgrPattern.exec(buffer);
  }

  let remaining = buffer;
  if (lastIndex > 0) {
    remaining = buffer.slice(lastIndex);
  }
  const lastEsc = remaining.lastIndexOf("\x1b[<");
  if (lastEsc > 0) {
    remaining = remaining.slice(lastEsc);
  }
  return { remaining, delta };
}

function stripInputArtifacts(value: string): string {
  let cleaned = value;
  cleaned = cleaned.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  // SGR mouse mode: \x1b[<button;col;row[mM]
  cleaned = cleaned.replace(/\x1b\[<\d+;\d+;\d+[mM]/g, "");
  // urxvt mouse mode: \x1b[button;col;rowM
  cleaned = cleaned.replace(/\x1b\[\d+;\d+;\d+M/g, "");
  // Partial sequences (escape already stripped)
  cleaned = cleaned.replace(/\[<?\d+;\d+;\d+[mM]/g, "");
  // X10 mouse mode: \x1b[M + 3 bytes
  cleaned = cleaned.replace(/\x1b\[M[\s\S]{3}/g, "");
  cleaned = cleaned.replace(/\[M[\s\S]{3}/g, "");
  // General CSI sequences
  cleaned = cleaned.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
  // OSC sequences
  cleaned = cleaned.replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "");
  // Stray escapes
  cleaned = cleaned.replace(/\x1b/g, "");
  // Allow newlines and tabs for multi-paragraph input.
  cleaned = cleaned.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  return cleaned;
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
  type AutonomyMemory = Memory & { createdAt: number };
  const fresh = memories
    .filter(isAutonomyResponse)
    .filter((memory: AutonomyMemory) => memory.createdAt > lastSeen.value)
    .sort((a: AutonomyMemory, b: AutonomyMemory) => a.createdAt - b.createdAt);

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
    return "Autonomy service not available. The agent may still be initializing.";
  }
  try {
    if (enabled) {
      await svc.enableAutonomy();
      const status = svc.getStatus?.() ?? { running: false, interval: 0 };
      const intervalSec = Math.round((status.interval ?? 5000) / 1000);
      return `Autonomy enabled. Loop running: ${status.running ? "yes" : "starting..."}, interval: ${intervalSec}s`;
    }
    await svc.disableAutonomy();
    return "Autonomy disabled. Agent will only respond to direct messages.";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Failed to ${enabled ? "enable" : "disable"} autonomy: ${msg}`;
  }
}

function getAutonomyStatus(runtime: AgentRuntime): { enabled: boolean; running: boolean; interval: number } | null {
  const svc = runtime.getService<AutonomyService>("AUTONOMY");
  if (!svc || typeof svc.getStatus !== "function") {
    return null;
  }
  const status = svc.getStatus();
  return {
    enabled: status.enabled ?? false,
    running: status.running ?? false,
    interval: status.interval ?? 5000,
  };
}

function ChatPanel(props: {
  readonly messages: ChatMessage[];
  readonly input: string;
  readonly onInputChange: (value: string) => void;
  readonly onSubmit: (value: string) => void;
  readonly width: number;
  readonly height: number;
  readonly scrollOffset: number;
  readonly onMaxScrollChange?: (maxScroll: number) => void;
  readonly isActive: boolean;
}): ReactNode {
  const { messages, input, onInputChange, onSubmit, width, height, scrollOffset, onMaxScrollChange, isActive } = props;
  if (height <= 0) return null;
  const contentWidth = Math.max(10, width - 2);
  const renderLines = toRenderLines(messages, contentWidth);
  // Reserve 1 line for input prompt at bottom
  const messagesHeight = Math.max(0, height - 1);
  
  // Calculate visible window with scroll offset (array slicing approach)
  const totalLines = renderLines.length;
  const maxScroll = Math.max(0, totalLines - messagesHeight);
  
  // Report maxScroll to parent
  useEffect(() => {
    onMaxScrollChange?.(maxScroll);
  }, [maxScroll, onMaxScrollChange]);
  
  const effectiveOffset = Math.min(scrollOffset, maxScroll);
  const startIdx = Math.max(0, totalLines - messagesHeight - effectiveOffset);
  const endIdx = Math.min(totalLines, startIdx + messagesHeight);
  const visibleLines = renderLines.slice(startIdx, endIdx);
  
  // Explicitly limit rendered lines to fit in messagesHeight
  const linesToRender = visibleLines.slice(0, messagesHeight);
  
  return (
    <Box width={width} height={height} flexDirection="column" overflow="hidden">
      <Box flexDirection="column" paddingX={1} height={messagesHeight} overflow="hidden">
        {linesToRender.map((line) => (
          <Text
            key={line.key}
            {...(line.color ? { color: line.color } : {})}
            dimColor={!isActive || line.dim === true}
            bold={line.bold === true}
            italic={line.italic === true}
            wrap="truncate"
          >
            {sanitizeLine(line.text)}
          </Text>
        ))}
      </Box>
      <Box paddingX={1} height={1} flexShrink={0}>
        <Text color="cyan" dimColor={!isActive}>
          {">"}{" "}
        </Text>
        <Box flexGrow={1}>
          <TextInput
            value={input}
            onChange={onInputChange}
            onSubmit={onSubmit}
            focus={isActive}
            showCursor={isActive}
          />
        </Box>
      </Box>
    </Box>
  );
}

function getSidebarBodyLines(
  view: SidebarView,
  content: string,
  loading: boolean,
  logs: string[],
  contentWidth: number
): string[] {
  const bodyLines: string[] = [];
  if (view === "logs") {
    const logLines = logs.length > 0 ? logs : ["No logs yet."];
    logLines.forEach((line) => wrapText(line, contentWidth).forEach((l) => bodyLines.push(l)));
  } else if (loading) {
    wrapText("Loading...", contentWidth).forEach((line) => bodyLines.push(line));
  } else if (view === "markets") {
    const c = content.length > 0 ? content : "No data.";
    c.split("\n").forEach((line) => bodyLines.push(line));
  } else {
    const c = content.length > 0 ? content : "No data.";
    wrapText(c, contentWidth).forEach((line) => bodyLines.push(line));
  }
  return bodyLines;
}

function SidebarPanel(props: {
  readonly view: SidebarView;
  readonly content: string;
  readonly loading: boolean;
  readonly updatedAt?: string;
  readonly width: number;
  readonly height: number;
  readonly logs: string[];
  readonly scrollOffset: number;
  readonly onMaxScrollChange?: (maxScroll: number) => void;
  readonly isActive: boolean;
}): ReactNode {
  const { view, content, loading, updatedAt, width, height, logs, scrollOffset, onMaxScrollChange, isActive } = props;
  if (height <= 0) return null;
  const title = view === "positions" ? "Account" : view === "markets" ? "Active Markets" : "Agent Logs";
  // Account for left border (1 char) + padding (1 char)
  const contentWidth = Math.max(10, width - 2);
  const bodyLines = getSidebarBodyLines(view, content, loading, logs, contentWidth);
  
  // Reserve 1 line for header
  const bodyHeight = Math.max(0, height - 1);
  
  // Calculate visible window with scroll offset
  const totalLines = bodyLines.length;
  const maxScroll = Math.max(0, totalLines - bodyHeight);
  
  // Report maxScroll to parent
  useEffect(() => {
    onMaxScrollChange?.(maxScroll);
  }, [maxScroll, onMaxScrollChange]);
  
  const effectiveOffset = Math.min(scrollOffset, maxScroll);
  const startIdx = Math.max(0, totalLines - bodyHeight - effectiveOffset);
  const endIdx = Math.min(totalLines, startIdx + bodyHeight);
  const visibleBody = bodyLines.slice(startIdx, endIdx);
  
  const scrollIndicator = effectiveOffset > 0 ? ` ↑${effectiveOffset}` : "";
  const header = updatedAt ? `${title} (${updatedAt})${scrollIndicator}` : `${title}${scrollIndicator}`;

  // Build render lines with coloring for markets view
  const renderLines: Array<{ key: string; text: string; color?: string; dim?: boolean }> = [];
  if (view === "markets") {
    let inCard = false;
    let inTitle = false;
    visibleBody.forEach((line, idx) => {
      const trimmed = line.trimEnd();
      if (isCardBorderLine(trimmed)) {
        if (!inCard) {
          inCard = true;
          inTitle = true;
        } else {
          inCard = false;
          inTitle = false;
        }
      } else if (isCardDividerLine(trimmed)) {
        inTitle = false;
      }
      let color: string | undefined;
      if (isCardBorderLine(trimmed) || isCardDividerLine(trimmed)) {
        color = "gray";
      } else if (inTitle && trimmed.length > 0) {
        color = "yellow";
      } else if (/https?:\/\//.test(trimmed)) {
        color = "blue";
      } else {
        color = "white";
      }
      renderLines.push({
        key: `body:${idx}`,
        text: line,
        color,
        dim: !isActive || isCardBorderLine(trimmed) || isCardDividerLine(trimmed),
      });
    });
  } else {
    visibleBody.forEach((line, idx) => {
      renderLines.push({
        key: `body:${idx}`,
        text: line,
        dim: !isActive,
      });
    });
  }

  // Explicitly limit rendered lines to fit in bodyHeight
  const linesToRender = renderLines.slice(0, bodyHeight);
  
  return (
    <Box
      width={width}
      height={height}
      borderStyle="single"
      borderColor="gray"
      borderLeft
      borderRight={false}
      borderTop={false}
      borderBottom={false}
      flexDirection="column"
      paddingLeft={1}
      overflow="hidden"
    >
      <Box height={1} flexShrink={0}>
        <Text bold dimColor={!isActive}>{header}</Text>
      </Box>
      <Box flexDirection="column" height={bodyHeight} overflow="hidden">
        {linesToRender.map((line) => (
          <Text
            key={line.key}
            wrap="truncate"
            dimColor={line.dim === true}
            {...(line.color ? { color: line.color } : {})}
          >
            {sanitizeLine(line.text)}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

// Layout modes: chat-only, split view, sidebar-only
type LayoutMode = "chat" | "split" | "sidebar";

function FatalErrorDisplay({ error, columns, rows }: { error: string; columns: number; rows: number }): ReactNode {
  const { exit } = useApp();
  
  useInput((_, rawKey) => {
    const key = rawKey as InkKey;
    if (key.return || key.escape || (key.ctrl && key.name === "c")) {
      exit();
    }
  });
  
  // Provide helpful context for common errors
  let helpText = "";
  if (error.includes("No output generated") || error.includes("AI_NoOutputGeneratedError")) {
    helpText = "This usually means your API key is missing, invalid, or rate-limited. Check your .env file.";
  } else if (error.includes("API key") || error.includes("api_key") || error.includes("Unauthorized")) {
    helpText = "Check that your API key is set correctly in .env (OPENAI_API_KEY, ANTHROPIC_API_KEY, etc.)";
  } else if (error.includes("ECONNREFUSED") || error.includes("network")) {
    helpText = "Network error - check your internet connection and API endpoint URLs.";
  }
  
  const lines = error.split("\n");
  const maxLines = Math.max(1, rows - (helpText ? 12 : 10));
  const displayLines = lines.slice(0, maxLines);
  
  return (
    <Box flexDirection="column" width={columns} height={rows} padding={1}>
      <Box marginBottom={1}>
        <Text color="red" bold>{"═".repeat(Math.min(50, columns - 4))}</Text>
      </Box>
      <Box marginBottom={1}>
        <Text color="red" bold>❌ FATAL ERROR</Text>
      </Box>
      <Box marginBottom={1}>
        <Text color="red" bold>{"═".repeat(Math.min(50, columns - 4))}</Text>
      </Box>
      <Box flexDirection="column" marginBottom={1}>
        {displayLines.map((line, idx) => (
          <Text key={idx} color="white" wrap="truncate">{line}</Text>
        ))}
        {lines.length > maxLines && (
          <Text color="gray" italic>... {lines.length - maxLines} more lines</Text>
        )}
      </Box>
      {helpText && (
        <Box marginBottom={1}>
          <Text color="yellow">💡 {helpText}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text color="red" bold>{"═".repeat(Math.min(50, columns - 4))}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color="cyan">📄 Full log: polymarket-error.log</Text>
        <Text color="gray">Press Enter or Escape to exit</Text>
      </Box>
    </Box>
  );
}

function PolymarketTuiApp({ runtime, roomId, userId, messageService }: TuiSession): ReactNode {
  const { exit } = useApp();
  const { stdout } = useStdout();
  
  // Fatal error state
  const fatalError = useFatalError();
  
  // Core state - simplified
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  
  // Layout: "chat" = chat only, "split" = both, "sidebar" = sidebar only
  const [layout, setLayout] = useState<LayoutMode>("chat");
  const [sidebarView, setSidebarView] = useState<SidebarView>("positions");
  const [focusPanel, setFocusPanel] = useState<FocusPanel>("chat");
  
  // Scroll
  const [scrollOffset, setScrollOffset] = useState(0);
  const [sidebarScrollOffset, setSidebarScrollOffset] = useState(0);
  const [chatMaxScroll, setChatMaxScroll] = useState(0);
  const [sidebarMaxScroll, setSidebarMaxScroll] = useState(0);
  
  // Sidebar content
  const [sidebarContent, setSidebarContent] = useState("Loading...");
  const [sidebarLoading, setSidebarLoading] = useState(true);
  const [sidebarUpdatedAt, setSidebarUpdatedAt] = useState<string>("");
  
  // Logs and balance
  const [logs, setLogs] = useState<string[]>([]);
  const [balanceText, setBalanceText] = useState("USDC: --");
  
  // Refs
  const marketNameCacheRef = useRef<Map<string, string>>(new Map());
  const lastAutonomyRef = useRef<{ value: number }>({ value: 0 });
  const actionMessageIdsRef = useRef<Map<string, string>>(new Map());
  const greetedRef = useRef(false);

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
  // Reserve one row at the bottom (when possible) to keep input visible.
  const headerHeight = rows >= 2 ? 1 : 0;
  const bottomReserve = rows >= 3 ? 1 : 0;
  const bodyHeight = Math.max(0, rows - headerHeight - bottomReserve);
  const isWide = columns >= 110;
  
  // Derive layout visibility from single layout state
  const showChat = layout === "chat" || layout === "split";
  const showSidebar = layout === "sidebar" || layout === "split";
  
  // Calculate widths based on layout
  const targetSidebarWidth = Math.min(42, Math.max(28, Math.floor(columns * 0.35)));
  const sidebarWidth = showSidebar ? (showChat && isWide ? targetSidebarWidth : columns) : 0;
  const gap = showChat && showSidebar && isWide ? 1 : 0;
  const chatWidth = showChat ? Math.max(20, columns - sidebarWidth - gap) : 0;
  
  // On narrow screens, only show one panel at a time
  const showChatPanel = isWide ? showChat : layout !== "sidebar";
  const showSidebarPanel = isWide ? showSidebar : layout === "sidebar";
  
  const appendLog = useCallback((line: string) => {
    setLogs((prev) => {
      const next = [...prev, line];
      return next.length > 200 ? next.slice(next.length - 200) : next;
    });
  }, []);

  const appendMessage = useCallback((msg: ChatMessage) => {
    setMessages((prev) => [...prev, msg]);
    setScrollOffset(0);
  }, []);

  const handleInputChange = useCallback((value: string) => {
    if (hasMouseSequence(value)) {
      setInput((prev) => stripInputArtifacts(prev));
      return;
    }
    const cleaned = stripInputArtifacts(value);
    const singleLine = cleaned.replace(/\s*\n\s*/g, " ");
    setInput(singleLine);
  }, []);

  const cycleSidebarView = useCallback(() => {
    setSidebarView((prev) => {
      const order: SidebarView[] = ["positions", "markets", "logs"];
      const current = order.indexOf(prev);
      return order[(current + 1) % order.length] ?? "positions";
    });
    setSidebarScrollOffset(0);
  }, []);

  // Keep focus aligned with single-panel layouts
  useEffect(() => {
    if (layout === "chat") {
      setFocusPanel("chat");
      return;
    }
    if (layout === "sidebar") {
      setFocusPanel("sidebar");
    }
  }, [layout]);

  useEffect(() => {
    if (isWide) return;
    if (layout === "split") {
      setLayout(focusPanel === "sidebar" ? "sidebar" : "chat");
    }
  }, [focusPanel, isWide, layout]);

  // Show greeting on mount
  useEffect(() => {
    if (greetedRef.current) return;
    if (messages.length > 0) return;
    greetedRef.current = true;
    appendMessage({
      id: uuidv4(),
      role: "assistant",
      content:
        "Hello! I'm the Polymarket trading agent. I can scan markets, summarize positions, and place orders when enabled. Type /help for commands.",
      timestamp: Date.now(),
    });
  }, [appendMessage, messages.length]);

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

  useEffect(() => {
    if (!stdout) return;
    // Enable mouse tracking for scroll events.
    stdout.write("\x1b[?1000h\x1b[?1006h\x1b[?1015h\x1b[?1007l");
    return () => {
      stdout.write("\x1b[?1000l\x1b[?1006l\x1b[?1015l\x1b[?1007l");
    };
  }, [stdout]);

  useEffect(() => {
    const stdin = process.stdin;
    if (!stdin || typeof stdin.on !== "function") return;
    let buffer = "";

    const onData = (data: Buffer) => {
      const chunk = data.toString("utf8");
      buffer += chunk;
      const scroll = consumeMouseScroll(buffer);
      buffer = scroll.remaining;
      if (scroll.delta === 0) return;

      setInput((prev) => stripInputArtifacts(prev));
      if (focusPanel === "chat") {
        setScrollOffset((prev) =>
          Math.max(0, Math.min(chatMaxScroll, prev + scroll.delta))
        );
        return;
      }
      setSidebarScrollOffset((prev) =>
        Math.max(0, Math.min(sidebarMaxScroll, prev + scroll.delta))
      );
    };

    stdin.on("data", onData);
    return () => {
      stdin.off("data", onData);
    };
  }, [chatMaxScroll, focusPanel, sidebarMaxScroll]);

  // Mouse wheel handled via raw stdin (mouse tracking enabled).

  const updateMessage = useCallback((id: string, content: string) => {
    setMessages((prev) =>
      prev.map((msg) => (msg.id === id ? { ...msg, content } : msg))
    );
  }, []);

  // Reset sidebar scroll when view changes
  useEffect(() => {
    setSidebarScrollOffset(0);
  }, [sidebarView]);

  // Fetch sidebar data when view changes
  useEffect(() => {
    if (sidebarView === "logs") {
      setSidebarLoading(false);
      return;
    }
    let isActive = true;
    const update = async () => {
      setSidebarLoading(true);
      setSidebarContent("Starting up...");
      
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
            setSidebarContent(`Starting up... (attempt ${attempt + 2}/6)`);
          }
        }
      }
      
      if (!service) {
        if (isActive) {
          setSidebarLoading(false);
          setSidebarContent("Polymarket service failed to start.");
          setSidebarUpdatedAt(formatTimestamp(new Date()));
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
          lines.push(`Account: ${accountLabel}`);

          const balance = state?.balances?.collateral?.balance;
          const allowance = state?.balances?.collateral?.allowance;
          if (balance !== undefined) {
            setBalanceText(`USDC: $${balance}`);
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
                const entries = await Promise.all(
                  positions.slice(0, 10).map(async (pos: { size: string; average_price: string; market?: string }, idx: number) => {
                const size = Number.parseFloat(pos.size);
                const avg = Number.parseFloat(pos.average_price);
                const odds = Number.isFinite(avg) ? avg.toFixed(4) : "N/A";
                const side = size >= 0 ? "LONG" : "SHORT";
                const marketIdRaw = pos.market || "";
                let marketName = pos.market || "Unknown market";

                if (marketIdRaw.startsWith("0x")) {
                  const cachedName = marketNameCacheRef.current.get(marketIdRaw);
                  if (cachedName) {
                    marketName = cachedName;
                  } else {
                    try {
                      const market = (await service.getClobClient().getMarket(marketIdRaw)) as Market;
                      if (market?.question) {
                        marketName = market.question;
                        marketNameCacheRef.current.set(marketIdRaw, market.question);
                      }
                    } catch {
                      // Lookup failed
                    }
                  }
                }
                return `${idx + 1}. ${marketName}\n   ${side} ${Math.abs(size).toFixed(4)} @ ${odds}`;
              })
            );
            lines.push(...entries);
          }
          
          if (isActive) {
            setSidebarLoading(false);
            setSidebarContent(lines.join("\n"));
            setSidebarUpdatedAt(formatTimestamp(new Date()));
          }
        } else if (sidebarView === "markets") {
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
            interface ClobMarket {
              condition_id: string;
              question?: string;
              active?: boolean;
              closed?: boolean;
              end_date_iso?: string;
            }
            return (response?.data ?? [])
              .filter((m: ClobMarket) => {
                if (!m.active) return false;
                if (m.closed) return false;
                if (m.end_date_iso) {
                  const endDate = new Date(m.end_date_iso).getTime();
                  if (!Number.isNaN(endDate) && endDate < now) return false;
                }
                return true;
              })
              .map((m: ClobMarket): MarketItem => ({
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
          const panelWidth = isWide ? sidebarWidth : chatWidth;
          const cardInnerWidth = getSidebarCardInnerWidth(panelWidth);
          const content = trimmed.length === 0
            ? "No active markets found."
            : trimmed.map((m) => {
                const lines: string[] = [];
                if (m.volume > 0) lines.push(`Volume: $${Math.round(m.volume).toLocaleString()}`);
                if (m.endDate) lines.push(`Ends: ${new Date(m.endDate).toLocaleDateString()}`);
                const url = m.source === "gamma"
                  ? `https://polymarket.com/event/${m.id}`
                  : `https://polymarket.com/market/${m.id}`;
                lines.push(url);
                return buildSidebarCard(m.title, lines, cardInnerWidth);
              }).join("\n\n");
          
          if (isActive) {
            setSidebarLoading(false);
            setSidebarContent(content);
            setSidebarUpdatedAt(formatTimestamp(new Date()));
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isActive) {
          setSidebarLoading(false);
          setSidebarContent(`Error: ${message}`);
          setSidebarUpdatedAt(formatTimestamp(new Date()));
        }
      }
    };
    update().catch(() => undefined);
    return () => {
      isActive = false;
    };
  }, [runtime, sidebarView, chatWidth, isWide, sidebarWidth]);

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
      if (originalInfo) logger.info = originalInfo;
      if (originalWarn) logger.warn = originalWarn;
      if (originalError) logger.error = originalError;
      if (originalDebug) logger.debug = originalDebug;
    };
  }, [appendLog, runtime]);

  useEffect(() => {
    const onActionStarted = (payload: unknown) => {
      const typed = payload as ActionPayload;
      const content = typed.content;
      if (!content) return;
      const actionName = content.actions?.[0] ?? "action";
      const actionId =
        typeof content.actionId === "string" ? content.actionId : `${actionName}:${Date.now()}`;
      const messageId = uuidv4();
      actionMessageIdsRef.current.set(actionId, messageId);
      appendMessage({
        id: messageId,
        role: "system",
        content: `calling ${actionName}...`,
        timestamp: Date.now(),
      });
      appendLog(`calling ${actionName}...`);
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
      const messageId = actionMessageIdsRef.current.get(actionId);
      if (messageId) {
        updateMessage(messageId, `action ${actionName} ${status}`);
        actionMessageIdsRef.current.delete(actionId);
      } else {
        appendMessage({
          id: uuidv4(),
          role: "system",
          content: `action ${actionName} ${status}`,
          timestamp: Date.now(),
        });
      }
      appendLog(`action ${actionName} ${status}`);
    };

    runtime.on(EventType.ACTION_STARTED, onActionStarted as never);
    runtime.on(EventType.ACTION_COMPLETED, onActionCompleted as never);
    return () => {
      runtime.off(EventType.ACTION_STARTED, onActionStarted as never);
      runtime.off(EventType.ACTION_COMPLETED, onActionCompleted as never);
    };
  }, [appendLog, appendMessage, updateMessage, runtime]);

  const handleSubmit = useCallback(
    async (value: string) => {
      const cleaned = stripInputArtifacts(value);
      const trimmed = cleaned.trim();
      if (!trimmed) return;
      setInput("");
      setIsProcessing(true);
      try {
        // Handle commands
        if (trimmed === "/exit" || trimmed === "/quit") {
          exit();
          return;
        }
        if (trimmed === "/help") {
          appendMessage({
            id: uuidv4(),
            role: "system",
            content: [
              "Commands:",
              "  /autonomy [true|false] - Show status or toggle autonomous mode",
              "  /think - Trigger autonomous thinking immediately",
              "  /interval <seconds> - Set autonomy loop interval (5-600s)",
              "  /account - Show wallet and positions",
              "  /markets - Show active markets",
              "  /logs - Show agent logs",
              "  /error - Show recent errors",
              "  /clear - Clear chat history",
              "  /help - Show this help",
              "  /exit - Exit the application",
            ].join("\n"),
            timestamp: Date.now(),
          });
          return;
        }
        if (trimmed === "/error") {
          // Show recent errors from logs
          const errorLogs = logs.filter((log) => 
            log.includes("ERROR") || log.includes("Error") || log.includes("error")
          ).slice(-10);
          if (errorLogs.length === 0) {
            appendMessage({
              id: uuidv4(),
              role: "system",
              content: "No recent errors found. Check polymarket-error.log for crash logs.",
              timestamp: Date.now(),
            });
          } else {
            appendMessage({
              id: uuidv4(),
              role: "system",
              content: `Recent errors (${errorLogs.length}):\n${errorLogs.join("\n")}`,
              timestamp: Date.now(),
            });
          }
          return;
        }
        if (trimmed === "/clear") {
          setMessages([]);
          return;
        }
        if (trimmed === "/account") {
          setSidebarView("positions");
          setLayout("split");
          return;
        }
        if (trimmed === "/markets") {
          setSidebarView("markets");
          setLayout("split");
          return;
        }
        if (trimmed === "/logs") {
          setSidebarView("logs");
          setLayout("split");
          return;
        }
        if (trimmed.startsWith("/autonomy")) {
          const parts = trimmed.split(/\s+/);
          const valueArg = parts[1];
          // Allow /autonomy with no arg to show current status
          if (!valueArg) {
            const currentStatus = getAutonomyStatus(runtime);
            if (!currentStatus) {
              appendMessage({
                id: uuidv4(),
                role: "system",
                content: "Autonomy service not available.",
                timestamp: Date.now(),
              });
            } else {
              const intervalSec = Math.round(currentStatus.interval / 1000);
              appendMessage({
                id: uuidv4(),
                role: "system",
                content: `Autonomy status: ${currentStatus.enabled ? "enabled" : "disabled"}, running: ${currentStatus.running ? "yes" : "no"}, interval: ${intervalSec}s`,
                timestamp: Date.now(),
              });
            }
            return;
          }
          if (valueArg !== "true" && valueArg !== "false") {
            appendMessage({
              id: uuidv4(),
              role: "system",
              content: "Usage: /autonomy [true|false] - show status or enable/disable autonomy",
              timestamp: Date.now(),
            });
            return;
          }
          const enabled = valueArg === "true";
          const status = await setAutonomy(runtime, enabled);
          setAutonomyEnabled(enabled); // Update local state immediately
          appendMessage({
            id: uuidv4(),
            role: "system",
            content: status,
            timestamp: Date.now(),
          });
          appendLog(`[Autonomy] ${status}`);
          return;
        }
        if (trimmed === "/think") {
          const svc = runtime.getService<AutonomyService>("AUTONOMY");
          if (!svc) {
            appendMessage({
              id: uuidv4(),
              role: "system",
              content: "Autonomy service not available.",
              timestamp: Date.now(),
            });
            return;
          }
          const status = svc.getStatus?.();
          if (status?.thinking) {
            appendMessage({
              id: uuidv4(),
              role: "system",
              content: "Already thinking... please wait.",
              timestamp: Date.now(),
            });
            return;
          }
          
          // Check if triggerThinkNow is available (newer core versions)
          if (typeof svc.triggerThinkNow === "function") {
            appendMessage({
              id: uuidv4(),
              role: "system",
              content: "Triggering autonomous thinking...",
              timestamp: Date.now(),
            });
            appendLog("[Autonomy] Manual think triggered");
            try {
              const success = await svc.triggerThinkNow();
              if (success === false) {
                appendMessage({
                  id: uuidv4(),
                  role: "system",
                  content: "Think cycle skipped (already in progress or error occurred).",
                  timestamp: Date.now(),
                });
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              appendMessage({
                id: uuidv4(),
                role: "system",
                content: `Think error: ${msg}`,
                timestamp: Date.now(),
              });
              appendLog(`[Autonomy] Think error: ${msg}`);
            }
            return;
          }
          
          // Fallback: Send autonomous prompt directly through message service
          const autonomousRoomId = svc.getAutonomousRoomId?.();
          if (!autonomousRoomId) {
            appendMessage({
              id: uuidv4(),
              role: "system",
              content: "Could not get autonomous room ID.",
              timestamp: Date.now(),
            });
            return;
          }
          
          const thinkMsgId = uuidv4();
          appendMessage({
            id: thinkMsgId,
            role: "system",
            content: "Triggering autonomous thinking...",
            timestamp: Date.now(),
          });
          appendLog("[Autonomy] Manual think triggered (fallback mode)");
          
          try {
            const autonomousPrompt = `AUTONOMOUS TASK MODE - You have been manually triggered to think and act.

Review your current context:
- Check available Polymarket markets
- Review any pending tasks or goals
- Consider what actions would be most valuable right now

Decide on your next action and execute it. You have access to all your tools and actions.`;

            // Use the user's entity ID, not the agent's, to avoid "skipping message from self"
            const autonomousMessage = createMessageMemory({
              id: uuidv4() as UUID,
              entityId: userId, // Use user ID so agent will respond
              roomId: roomId, // Use the chat room, not autonomous room, so we see the response
              content: {
                text: autonomousPrompt,
                source: "manual-trigger",
                channelType: ChannelType.DM,
                metadata: {
                  type: "autonomous-prompt",
                  isAutonomous: true,
                  isManualTrigger: true,
                },
              },
            });

            const result = await messageService.handleMessage(
              runtime,
              autonomousMessage,
              async (content: Content) => {
                if (typeof content.text === "string" && content.text.trim()) {
                  appendMessage({
                    id: uuidv4(),
                    role: "assistant",
                    content: `[Autonomous] ${content.text}`,
                    timestamp: Date.now(),
                  });
                  appendLog(`[Autonomy] Response: ${content.text.slice(0, 100)}...`);
                }
                return [];
              }
            );
            
            updateMessage(thinkMsgId, `Autonomous thinking complete. Responded: ${result.didRespond ? "yes" : "no"}`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            updateMessage(thinkMsgId, `Think error: ${msg}`);
            appendLog(`[Autonomy] Think error: ${msg}`);
          }
          return;
        }
        if (trimmed.startsWith("/interval")) {
          const parts = trimmed.split(/\s+/);
          const valueArg = parts[1];
          if (!valueArg) {
            const currentStatus = getAutonomyStatus(runtime);
            const intervalSec = currentStatus ? Math.round(currentStatus.interval / 1000) : "unknown";
            appendMessage({
              id: uuidv4(),
              role: "system",
              content: `Current autonomy interval: ${intervalSec}s. Usage: /interval <seconds> (5-600)`,
              timestamp: Date.now(),
            });
            return;
          }
          const seconds = Number.parseInt(valueArg, 10);
          if (Number.isNaN(seconds) || seconds < 5 || seconds > 600) {
            appendMessage({
              id: uuidv4(),
              role: "system",
              content: "Invalid interval. Must be between 5 and 600 seconds.",
              timestamp: Date.now(),
            });
            return;
          }
          const svc = runtime.getService<AutonomyService>("AUTONOMY");
          if (!svc || typeof svc.setLoopInterval !== "function") {
            appendMessage({
              id: uuidv4(),
              role: "system",
              content: "Autonomy service not available or setLoopInterval not supported.",
              timestamp: Date.now(),
            });
            return;
          }
          svc.setLoopInterval(seconds * 1000);
          appendMessage({
            id: uuidv4(),
            role: "system",
            content: `Autonomy interval set to ${seconds} seconds.`,
            timestamp: Date.now(),
          });
          appendLog(`[Autonomy] Interval set to ${seconds}s`);
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
      const thinkingState: StreamTagState = { opened: false, done: false, text: "" };
      const actionsState: StreamTagState = { opened: false, done: false, text: "" };
      const buffer = { value: "" };
      let streamedText = "";
      let callbackText = "";
      let respondingShown = false;

      const markResponding = () => {
        if (respondingShown) return;
        respondingShown = true;
      };

      const showThought = (value: string) => {
        const text = value.trim();
        if (!text) return;
        if (!thoughtShown) {
          appendMessage({
            id: thoughtId,
            role: "system",
            content: `Thinking: ${text}`,
            timestamp: Date.now(),
          });
          thoughtShown = true;
        } else {
          updateMessage(thoughtId, `Thinking: ${text}`);
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
            markResponding();
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
            markResponding();
            extractTagFromBuffer(buffer, "thought", thoughtState);
            extractTagFromBuffer(buffer, "thinking", thinkingState);
            extractTagFromBuffer(buffer, "actions", actionsState);
            if (thoughtState.text.length > 0) {
              showThought(thoughtState.text);
            }
            if (thinkingState.text.length > 0) {
              showThought(thinkingState.text);
            }
            if (actionsState.text.length > 0) {
              showActions(actionsState.text);
            }
            updateMessage(assistantId, streamedText);
          },
        } as never
      );

        const finalText = (streamedText || callbackText).trim();
        if (!finalText) {
          updateMessage(assistantId, "(no response)");
          appendLog("Eliza: (no response)");
        } else {
          updateMessage(assistantId, finalText);
          appendLog(`Eliza: ${finalText}`);
        }
      } catch (error) {
        // Display errors in the chat so they're visible
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorStack = error instanceof Error ? error.stack : undefined;
        appendMessage({
          id: uuidv4(),
          role: "system",
          content: `❌ Error: ${errorMessage}`,
          timestamp: Date.now(),
        });
        appendLog(`ERROR: ${errorMessage}`);
        if (errorStack) {
          appendLog(`Stack: ${errorStack}`);
        }
        // Re-throw if it's a fatal error that should crash the app
        if (errorMessage.includes("FATAL") || errorMessage.includes("Cannot read") || 
            errorMessage.includes("undefined is not") || errorMessage.includes("null is not")) {
          throw error;
        }
      } finally {
        setIsProcessing(false);
      }
    },
    [appendLog, appendMessage, exit, messageService, roomId, runtime, updateMessage, userId]
  );

  useInput((input, rawKey) => {
    const key = rawKey as InkKey;
    
    // Ctrl+C: clear messages first, then exit
    if (key.ctrl && key.name === "c") {
      if (messages.length > 0) {
        setInput("");
        setScrollOffset(0);
        setMessages([]);
        return;
      }
      void runtime.stop().finally(() => process.exit(0));
      exit();
      return;
    }
    
    // Escape: clear input
    if (key.escape) {
      setInput("");
      return;
    }
    
    // Ignore mouse sequences
    if (hasMouseSequence(input)) return;
    
    // Shift+Tab (or backtab sequence \x1b[Z): toggle sidebar visibility
    if ((key.shift && key.tab) || input === "\x1b[Z") {
      if (layout === "split" || layout === "chat") {
        // Hide sidebar by going to chat-only
        setLayout("chat");
        setFocusPanel("chat");
      } else {
        // Show sidebar in split mode (or chat if narrow)
        setLayout(isWide ? "split" : "chat");
        setFocusPanel("chat");
      }
      return;
    }
    
    // Tab alone: toggle focus between chat and sidebar
    if (key.tab && !key.ctrl && !key.meta) {
      if (layout === "split") {
        // In split mode, just toggle focus
        setFocusPanel((prev) => (prev === "chat" ? "sidebar" : "chat"));
      } else if (layout === "chat") {
        // In chat-only, switch to sidebar
        setLayout(isWide ? "split" : "sidebar");
        setFocusPanel("sidebar");
      } else {
        // In sidebar-only, switch to chat
        setLayout(isWide ? "split" : "chat");
        setFocusPanel("chat");
      }
      return;
    }
    
    // Enter when sidebar is focused: cycle sidebar views
    if (key.return && focusPanel === "sidebar") {
      cycleSidebarView();
      return;
    }
    
    // Scrolling for chat panel
    if (focusPanel === "chat") {
      if (key.pageUp) {
        setScrollOffset((prev) => Math.min(chatMaxScroll, prev + 10));
        return;
      }
      if (key.pageDown) {
        setScrollOffset((prev) => Math.max(0, prev - 10));
        return;
      }
      if (key.upArrow || key.downArrow) {
        const delta = key.upArrow ? 1 : -1;
        setScrollOffset((prev) => Math.max(0, Math.min(chatMaxScroll, prev + delta)));
        return;
      }
    }
    
    // Scrolling for sidebar panel
    if (focusPanel === "sidebar") {
      if (key.pageUp) {
        setSidebarScrollOffset((prev) => Math.min(sidebarMaxScroll, prev + 10));
        return;
      }
      if (key.pageDown) {
        setSidebarScrollOffset((prev) => Math.max(0, prev - 10));
        return;
      }
      if (key.upArrow || key.downArrow) {
        const delta = key.upArrow ? 1 : -1;
        setSidebarScrollOffset((prev) => Math.max(0, Math.min(sidebarMaxScroll, prev + delta)));
        return;
      }
    }
  });

  // Track autonomy status
  const [autonomyEnabled, setAutonomyEnabled] = useState(false);
  
  // Poll autonomy status periodically
  useEffect(() => {
    const checkAutonomy = () => {
      const status = getAutonomyStatus(runtime);
      if (status) {
        setAutonomyEnabled(status.running);
      }
    };
    checkAutonomy();
    const timer = setInterval(checkAutonomy, 2000);
    return () => clearInterval(timer);
  }, [runtime]);

  const statusText = useMemo(
    () => {
      const autonomyIndicator = autonomyEnabled ? "🤖 Auto" : "💤 Manual";
      const processingIndicator = isProcessing ? "..." : "Idle";
      return `Eliza Polymarket | ${balanceText} | ${autonomyIndicator} | ${processingIndicator} | Tab: Focus | /autonomy true|false`;
    },
    [balanceText, isProcessing, autonomyEnabled]
  );
  const headerText = truncateText(statusText, Math.max(0, columns - 2));

  // Show fatal error display if there's an unrecoverable error
  if (fatalError) {
    return <FatalErrorDisplay error={fatalError} columns={columns} rows={rows} />;
  }

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      {headerHeight > 0 ? (
        <Box paddingX={1} height={headerHeight} flexShrink={0}>
          <Text color="#FFA500">{headerText}</Text>
        </Box>
      ) : null}
      <Box flexDirection="row" gap={gap} height={bodyHeight} overflow="hidden">
        <Box display={showChatPanel ? "flex" : "none"} width={chatWidth} height={bodyHeight}>
          <ChatPanel
            messages={messages}
            input={input}
            onInputChange={handleInputChange}
            onSubmit={handleSubmit}
            width={chatWidth}
            height={bodyHeight}
            scrollOffset={scrollOffset}
            onMaxScrollChange={setChatMaxScroll}
            isActive={focusPanel === "chat"}
          />
        </Box>
        <Box
          display={showSidebarPanel ? "flex" : "none"}
          width={isWide ? sidebarWidth : chatWidth}
          height={bodyHeight}
        >
          <SidebarPanel
            view={sidebarView}
            content={sidebarContent}
            loading={sidebarLoading}
            updatedAt={sidebarUpdatedAt}
            width={isWide ? sidebarWidth : chatWidth}
            height={bodyHeight}
            logs={logs}
            scrollOffset={sidebarScrollOffset}
            onMaxScrollChange={setSidebarMaxScroll}
            isActive={focusPanel === "sidebar"}
          />
        </Box>
      </Box>
    </Box>
  );
}

export async function runPolymarketTui(session: TuiSession): Promise<void> {
  let instance: ReturnType<typeof render> | null = null;
  
  try {
    instance = render(<PolymarketTuiApp {...session} />);
    await instance.waitUntilExit();
  } catch (error) {
    // Unmount the TUI if it's still running
    if (instance) {
      try {
        instance.unmount();
      } catch {
        // Ignore unmount errors
      }
    }
    // Re-throw to be handled by global error handlers
    throw error;
  } finally {
    // Always clean up terminal state
    if (process.stdout?.write) {
      process.stdout.write("\x1b[?1000l\x1b[?1006l\x1b[?1015l\x1b[?1007l");
    }
  }
}

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

function formatFieldValue(field: SettingsField, value: string): string {
  if (field.secret) {
    return value.length > 0 ? "•".repeat(Math.min(12, value.length)) : "";
  }
  return value;
}

function SettingsWizardApp({
  config,
  onDone,
}: {
  readonly config: SettingsWizardConfig;
  readonly onDone: (result: SettingsWizardResult) => void;
}): ReactNode {
  const { exit } = useApp();
  const [index, setIndex] = useState(0);
  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    config.fields.forEach((field) => {
      initial[field.key] = field.value ?? "";
    });
    return initial;
  });

  const fields = config.fields;
  const isReview = index >= fields.length;
  const currentField = fields[Math.min(index, fields.length - 1)];

  const currentValue = useMemo(() => {
    if (!currentField) return "";
    const raw = values[currentField.key] ?? "";
    if (currentField.type === "select") {
      const options = currentField.options ?? [];
      if (options.includes(raw)) return raw;
      return options[0] ?? raw;
    }
    return raw;
  }, [currentField, values]);

  const updateValue = useCallback(
    (value: string) => {
      if (!currentField) return;
      setValues((prev) => ({
        ...prev,
        [currentField.key]: value,
      }));
    },
    [currentField]
  );

  const moveNext = useCallback(() => {
    setIndex((prev) => Math.min(prev + 1, fields.length));
  }, [fields.length]);

  const movePrev = useCallback(() => {
    setIndex((prev) => Math.max(0, prev - 1));
  }, []);

  const save = useCallback(() => {
    onDone({ status: "saved", values });
    exit();
  }, [exit, onDone, values]);

  const cancel = useCallback(() => {
    onDone({ status: "cancelled" });
    exit();
  }, [exit, onDone]);

  useInput((input, rawKey) => {
    const key = rawKey as InkKey;
    const keyName = (rawKey as { name?: string }).name;
    if (key.ctrl && keyName === "c") {
      cancel();
      return;
    }
    if (key.escape) {
      cancel();
      return;
    }
    if (isReview) {
      if (key.return) {
        save();
      }
      if (key.upArrow) {
        movePrev();
      }
      return;
    }
    if (!currentField) return;
    if (currentField.type === "select") {
      const options = currentField.options ?? [];
      if (options.length === 0) return;
      const currentIdx = Math.max(0, options.indexOf(currentValue));
      if (key.leftArrow) {
        const nextIdx = (currentIdx - 1 + options.length) % options.length;
        updateValue(options[nextIdx] ?? currentValue);
        return;
      }
      if (key.rightArrow) {
        const nextIdx = (currentIdx + 1) % options.length;
        updateValue(options[nextIdx] ?? currentValue);
        return;
      }
      if (key.return) {
        moveNext();
        return;
      }
    }
    if (key.upArrow) {
      movePrev();
      return;
    }
    if (key.downArrow) {
      moveNext();
    }
  });

  const summaryLines = useMemo(() => {
    return fields.map((field) => {
      const value = values[field.key] ?? "";
      const pretty = formatFieldValue(field, value);
      const requiredMark = field.required ? "*" : "";
      const display = pretty.length > 0 ? pretty : "(empty)";
      return `${field.label}${requiredMark}: ${display}`;
    });
  }, [fields, values]);

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>{config.title}</Text>
      {config.subtitle ? <Text dimColor>{config.subtitle}</Text> : null}
      <Box marginTop={1} flexDirection="column">
        {isReview ? (
          <Box flexDirection="column">
            <Text>Review settings:</Text>
            {summaryLines.map((line) => (
              <Text key={line}>{line}</Text>
            ))}
            <Box marginTop={1}>
              <Text dimColor>Press Enter to save, Esc to cancel, Up to edit.</Text>
            </Box>
          </Box>
        ) : currentField ? (
          <Box flexDirection="column">
            <Text>
              {currentField.label}
              {currentField.required ? "*" : ""} ({index + 1}/{fields.length})
            </Text>
            {currentField.type === "select" ? (
              <Box>
                <Text dimColor>Use ← → to change, Enter to confirm. </Text>
                <Text color="cyan">{currentValue}</Text>
              </Box>
            ) : (
              <TextInput
                value={currentValue}
                onChange={updateValue}
                onSubmit={moveNext}
                placeholder={currentField.secret ? "(hidden)" : ""}
              />
            )}
            <Box marginTop={1}>
              <Text dimColor>Enter to continue, Esc to cancel, Up/Down to move.</Text>
            </Box>
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}

export async function runSettingsWizard(
  config: SettingsWizardConfig
): Promise<SettingsWizardResult> {
  return new Promise((resolve) => {
    let result: SettingsWizardResult = { status: "cancelled" };
    const { waitUntilExit, unmount } = render(
      <SettingsWizardApp
        config={config}
        onDone={(next) => {
          result = next;
        }}
      />
    );
    void waitUntilExit().then(() => {
      unmount();
      resolve(result);
    });
  });
}
