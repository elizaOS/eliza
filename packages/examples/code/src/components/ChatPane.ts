// Renders a reusable UI component for the Code example.
import {
  type AutocompleteProvider,
  CURSOR_MARKER,
  Editor,
  type Focusable,
  Loader,
  Markdown,
  matchesKey,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@elizaos/tui";
import chalk from "chalk";
import { createEditorTheme } from "../lib/editor-theme.js";
import { createChatMarkdownTheme } from "../lib/markdown-theme.js";
import { useStore } from "../lib/store.js";
import type { Message } from "../types.js";

// Rendering markdown below ~40 cols is cramped (code fences + gutters eat the
// line); fall back to the plain wrapper there. This also keeps the #11043
// narrow-terminal guarantee simple on the cockpit's ~43-col phone xterm.
const MARKDOWN_MIN_WIDTH = 40;
const COMPOSER_MAX_LINES = 6;
const COMPOSER_PROMPT = "> ";
const ANSI_SGR_PATTERN = new RegExp(
  `${String.fromCharCode(27)}\\[[0-9;]*m`,
  "g",
);
// One shared theme instance (chalk style fns; cheap, but no need to rebuild).
const chatMarkdownTheme = createChatMarkdownTheme();

interface ChatPaneProps {
  onSubmit: (text: string) => Promise<void>;
  autocompleteProvider?: AutocompleteProvider;
  tui: TUI;
}

interface RenderLine {
  text: string;
  color?: string;
  dim?: boolean;
  italic?: boolean;
  bold?: boolean;
  /** `text` is already ANSI-styled (e.g. Markdown output) — render verbatim,
   *  do not re-apply chalk. */
  raw?: boolean;
}

function formatTime(timestamp: Date | number | string | undefined): string {
  if (!timestamp) return "";

  try {
    let date: Date;
    if (timestamp instanceof Date) {
      date = timestamp;
    } else if (typeof timestamp === "number") {
      date = new Date(timestamp);
    } else if (typeof timestamp === "string") {
      date = new Date(timestamp);
    } else {
      return "";
    }

    if (Number.isNaN(date.getTime())) {
      return "";
    }

    return date.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return "";
  }
}

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
    let currentLine = "";

    for (const word of words) {
      if (currentLine.length + word.length + 1 <= maxWidth) {
        currentLine += (currentLine ? " " : "") + word;
      } else {
        if (currentLine) {
          lines.push(currentLine);
        }
        if (word.length > maxWidth) {
          let remaining = word;
          while (remaining.length > maxWidth) {
            lines.push(remaining.substring(0, maxWidth));
            remaining = remaining.substring(maxWidth);
          }
          currentLine = remaining;
        } else {
          currentLine = word;
        }
      }
    }
    if (currentLine) {
      lines.push(currentLine);
    }
  }

  return lines.length > 0 ? lines : [""];
}

function padToVisibleWidth(text: string, maxWidth: number): string {
  const clipped = truncateToWidth(text, maxWidth, "");
  const padding = Math.max(0, maxWidth - visibleWidth(clipped));
  return `${clipped}${" ".repeat(padding)}`;
}

function isEditorRule(line: string, width: number): boolean {
  if (visibleWidth(line) !== width) return false;
  const plain = line
    .replaceAll(CURSOR_MARKER, "")
    .replace(ANSI_SGR_PATTERN, "");
  return plain.length > 0 && [...plain].every((char) => char === "─");
}

function windowAroundCursor(lines: string[], maxLines: number): string[] {
  if (lines.length <= maxLines) return lines;

  const cursorIndex = lines.findIndex(
    (line) => line.includes(CURSOR_MARKER) || line.includes("\x1b[7m"),
  );
  if (cursorIndex === -1) {
    return lines.slice(-maxLines);
  }

  const start = Math.min(
    Math.max(0, cursorIndex - maxLines + 1),
    Math.max(0, lines.length - maxLines),
  );
  return lines.slice(start, start + maxLines);
}

function toRenderLines(messages: Message[], maxWidth: number): RenderLine[] {
  const lines: RenderLine[] = [];

  for (const msg of messages) {
    const timeStr = formatTime(msg.timestamp);

    if (msg.kind === "tool") {
      const wrapped = wrapText(msg.content, maxWidth);
      for (const line of wrapped) {
        lines.push({ text: line, dim: true });
      }
      continue;
    }

    if (msg.role === "system") {
      const wrapped = wrapText(msg.content, maxWidth);
      for (const line of wrapped) {
        lines.push({ text: line, dim: true, italic: true });
      }
      continue;
    }

    const speaker = msg.role === "user" ? "You" : "Eliza";
    const color = msg.role === "user" ? "cyan" : "green";
    const header = `${speaker}${timeStr ? ` ${timeStr}` : ""}`;

    lines.push({ text: header, color, bold: true });

    const indent = "  ";
    const contentWidth = Math.max(1, maxWidth - indent.length);
    if (contentWidth >= MARKDOWN_MIN_WIDTH) {
      // Render the body as markdown (headings, lists, fenced code, inline
      // styles) into pre-styled lines. Markdown wraps to contentWidth, so
      // `indent + line` never exceeds maxWidth; MainScreen's truncateToWidth is
      // the final overflow backstop.
      const md = new Markdown(msg.content, 0, 0, chatMarkdownTheme).render(
        contentWidth,
      );
      const body = md.length > 0 ? md : [""];
      for (const line of body) {
        lines.push({ text: indent + line, raw: true });
      }
    } else {
      // Narrow terminal (e.g. the ~43-col cockpit xterm): plain wrap.
      const wrapped = wrapText(msg.content, contentWidth);
      for (const line of wrapped) {
        lines.push({ text: indent + line });
      }
    }
  }

  return lines;
}

export class ChatPane implements Focusable {
  focused = false;
  private props: ChatPaneProps;
  private editor: Editor;
  private typingLoader: Loader | null = null;
  private typingLoaderRunning = false;
  private scrollOffset = 0;
  private lastMessageAreaHeight = 1;
  private lastMaxScroll = 0;
  private lastRenderedLineCount = 0;
  private lastRenderedRoomId: string | null = null;

  constructor(props: ChatPaneProps) {
    this.props = props;
    const theme = createEditorTheme();
    this.editor = new Editor(props.tui, theme, { paddingX: 0 });
    if (props.autocompleteProvider) {
      this.editor.setAutocompleteProvider(props.autocompleteProvider);
    }
    this.editor.onSubmit = async (text: string) => {
      const trimmed = text.trim();
      if (trimmed.length > 0) {
        // Record the prompt so ↑/↓ recalls it — the Editor implements history
        // browsing but never had anything added to it, so up-arrow did nothing.
        this.editor.addToHistory(trimmed);
        this.editor.setText("");
        this.scrollOffset = 0;
        await props.onSubmit(trimmed);
      }
    };
    this.editor.onChange = (text: string) => {
      useStore.getState().setInputValue(text);
    };
  }

  dispose(): void {
    this.stopTypingLoader();
  }

  syncFocus(isFocused: boolean): void {
    this.focused = isFocused;
    this.editor.focused = isFocused;
  }

  invalidate(): void {
    this.editor.invalidate();
  }

  handleInput(char: string): void {
    if (!this.focused) return;

    // Transcript scrollback. Page keys always control history; Home/End do so
    // when the composer is empty or the user is already reading scrollback.
    if (matchesKey(char, "ctrl+up")) {
      this.scrollBy(1);
      return;
    }
    if (matchesKey(char, "ctrl+down")) {
      this.scrollBy(-1);
      return;
    }
    if (matchesKey(char, "pageUp")) {
      this.scrollBy(this.getPageScrollAmount());
      return;
    }
    if (matchesKey(char, "pageDown")) {
      this.scrollBy(-this.getPageScrollAmount());
      return;
    }
    const shouldRouteHomeEndToScroll =
      this.editor.getText().length === 0 || this.scrollOffset > 0;
    if (shouldRouteHomeEndToScroll && matchesKey(char, "home")) {
      this.scrollToTop();
      return;
    }
    if (shouldRouteHomeEndToScroll && matchesKey(char, "end")) {
      this.scrollToBottom();
      return;
    }

    // Escape to clear input
    if (char === "\x1b") {
      useStore.getState().setInputValue("");
      this.editor.setText("");
      this.props.tui.requestRender();
      return;
    }

    this.editor.handleInput(char);

    const inputValue = this.editor.getText();
    useStore.getState().setInputValue(inputValue);
    this.props.tui.requestRender();
  }

  private getPageScrollAmount(): number {
    return Math.max(1, this.lastMessageAreaHeight - 1);
  }

  private scrollBy(deltaLines: number): void {
    this.scrollOffset = Math.max(
      0,
      Math.min(this.scrollOffset + deltaLines, this.lastMaxScroll),
    );
    this.props.tui.requestRender();
  }

  private scrollToTop(): void {
    this.scrollOffset = this.lastMaxScroll;
    this.props.tui.requestRender();
  }

  private scrollToBottom(): void {
    this.scrollOffset = 0;
    this.props.tui.requestRender();
  }

  private ensureTypingLoader(): Loader {
    if (!this.typingLoader) {
      this.typingLoader = new Loader(
        this.props.tui,
        chalk.green,
        chalk.dim,
        "Processing (Esc/Ctrl+C abort)",
      );
      this.typingLoaderRunning = true;
      return this.typingLoader;
    }

    if (!this.typingLoaderRunning) {
      this.typingLoader.start();
      this.typingLoaderRunning = true;
    }

    return this.typingLoader;
  }

  private stopTypingLoader(): void {
    if (!this.typingLoaderRunning) return;
    this.typingLoader?.stop();
    this.typingLoaderRunning = false;
  }

  private renderTypingLoader(width: number): RenderLine[] {
    return this.ensureTypingLoader()
      .render(width)
      .filter((line) => line.trim().length > 0)
      .map((line) => ({ text: line, raw: true }));
  }

  private renderComposerLines(editorWidth: number, maxLines: number): string[] {
    const editorLines = this.editor.render(editorWidth);
    const bodyLines = editorLines.filter(
      (line) => !isEditorRule(line, editorWidth),
    );
    const visibleBody = bodyLines.length > 0 ? bodyLines : [""];
    return windowAroundCursor(visibleBody, maxLines);
  }

  /** Region body for the chat column (messages + input chrome). */
  renderContent(width: number, height: number): string[] {
    this.editor.setPaddingX(1);

    const state = useStore.getState();
    const room = state.rooms.find((r) => r.id === state.currentRoomId);
    const messages = room?.messages ?? [];
    const isAgentTyping = state.isAgentTyping;

    const innerWidth = Math.max(1, width - 4);
    const paddingX = 1;

    const headerHeight = 1;
    const helpHeight = 1;
    const inputChromeHeight = 2;
    const editorWidth = Math.max(1, innerWidth - 3);
    const composerMaxLines = Math.max(
      1,
      Math.min(
        COMPOSER_MAX_LINES,
        height - headerHeight - helpHeight - inputChromeHeight - 1,
      ),
    );
    // While a turn is running the input row shows a loading notice — unless
    // the user is typing ahead (queue-and-send), in which case the composer
    // stays visible so they can see what they're about to queue.
    const composerVisible =
      !state.isLoading || this.editor.getText().length > 0;
    const composerLines = composerVisible
      ? this.renderComposerLines(editorWidth, composerMaxLines)
      : [];
    const inputBodyHeight = composerVisible ? composerLines.length : 1;
    const inputHeight = inputChromeHeight + inputBodyHeight;
    const messageAreaHeight = Math.max(
      1,
      height - headerHeight - inputHeight - helpHeight,
    );

    const allLines = toRenderLines(messages, innerWidth);
    if (isAgentTyping) {
      allLines.push(...this.renderTypingLoader(innerWidth));
    } else {
      this.stopTypingLoader();
    }

    if (this.lastRenderedRoomId !== state.currentRoomId) {
      this.scrollOffset = 0;
    } else if (
      this.scrollOffset > 0 &&
      allLines.length > this.lastRenderedLineCount
    ) {
      this.scrollOffset += allLines.length - this.lastRenderedLineCount;
    }

    const maxScroll = Math.max(0, allLines.length - messageAreaHeight);
    const clampedScroll = Math.min(this.scrollOffset, maxScroll);
    this.scrollOffset = clampedScroll;
    this.lastMaxScroll = maxScroll;
    this.lastMessageAreaHeight = messageAreaHeight;
    this.lastRenderedLineCount = allLines.length;
    this.lastRenderedRoomId = state.currentRoomId;

    const startIndex = Math.max(
      0,
      allLines.length - messageAreaHeight - clampedScroll,
    );
    const endIndex = Math.max(0, allLines.length - clampedScroll);
    const visibleLines = allLines.slice(startIndex, endIndex);

    const output: string[] = [];

    const headerColor = this.focused ? chalk.bold.cyan : chalk.white;
    const scrollIndicator =
      clampedScroll > 0 ? chalk.dim(` [↑ ${clampedScroll}]`) : "";
    const header = `${headerColor(`Chat: ${room?.name ?? "Unknown"}`)} ${chalk.dim(`(${messages.length})`)}${scrollIndicator}`;
    output.push(" ".repeat(paddingX) + header);

    if (visibleLines.length === 0) {
      output.push(" ".repeat(paddingX) + chalk.dim.italic("No messages."));
      for (let i = 1; i < messageAreaHeight; i++) {
        output.push("");
      }
    } else {
      for (const line of visibleLines) {
        if (line.raw) {
          // Already ANSI-styled (Markdown output) — don't re-chalk.
          output.push(" ".repeat(paddingX) + line.text);
          continue;
        }
        let styled = line.text;
        if (line.bold) styled = chalk.bold(styled);
        if (line.italic) styled = chalk.italic(styled);
        if (line.dim) styled = chalk.dim(styled);
        if (line.color === "cyan") styled = chalk.cyan(styled);
        else if (line.color === "green") styled = chalk.green(styled);
        output.push(" ".repeat(paddingX) + styled);
      }
      const remaining = messageAreaHeight - visibleLines.length;
      for (let i = 0; i < remaining; i++) {
        output.push("");
      }
    }

    const borderColor = this.focused ? chalk.cyan : chalk.gray;
    const topBorder = borderColor(`┌${"─".repeat(innerWidth)}┐`);
    const bottomBorder = borderColor(`└${"─".repeat(innerWidth)}┘`);

    output.push(topBorder);

    if (!composerVisible) {
      const queuedCount = state.pendingSubmissions.length;
      const queuedSuffix = queuedCount > 0 ? ` • ${queuedCount} queued` : "";
      const loadingText = `Processing... Esc/Ctrl+C abort${queuedSuffix}`;
      const available = Math.max(1, innerWidth - 1);
      const visibleText =
        loadingText.length > available
          ? loadingText.slice(0, available)
          : loadingText;
      output.push(
        `${borderColor("│")} ${chalk.dim(visibleText)}${" ".repeat(Math.max(0, innerWidth - visibleText.length - 1))}${borderColor("│")}`,
      );
    } else {
      for (let i = 0; i < composerLines.length; i++) {
        const prompt =
          i === 0
            ? chalk.cyan(COMPOSER_PROMPT)
            : " ".repeat(COMPOSER_PROMPT.length);
        const content = ` ${prompt}${composerLines[i] ?? ""}`;
        output.push(
          `${borderColor("│")}${padToVisibleWidth(content, innerWidth)}${borderColor("│")}`,
        );
      }
    }

    output.push(bottomBorder);

    const helpText = !this.focused
      ? "Tab: focus"
      : state.isLoading
        ? "Enter: queue • Esc/Ctrl+C: abort • PgUp/PgDn: scroll"
        : state.inputValue.startsWith("/")
          ? "Enter: run • Tab: complete • Esc: clear • ?: help"
          : "Enter: send • PgUp/PgDn: scroll • Esc: clear • ?: help";
    output.push(truncateToWidth(chalk.dim(helpText), width));

    return output;
  }
}
