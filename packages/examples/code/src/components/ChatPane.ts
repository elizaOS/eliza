import {
  type AutocompleteProvider,
  type Component,
  Editor,
  type Focusable,
  type TUI,
} from "@elizaos/tui";
import chalk from "chalk";
import { useStore } from "../lib/store.js";
import type { Message } from "../types.js";

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

function toRenderLines(messages: Message[], maxWidth: number): RenderLine[] {
  const lines: RenderLine[] = [];

  for (const msg of messages) {
    const timeStr = formatTime(msg.timestamp);

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
    const wrapped = wrapText(msg.content, contentWidth);
    for (const line of wrapped) {
      lines.push({ text: indent + line });
    }
  }

  return lines;
}

export class ChatPane implements Component, Focusable {
  private props: ChatPaneProps;
  private editor: Editor;
  private scrollOffset = 0;
  private width = 80;
  private height = 24;
  private focused = false;

  constructor(props: ChatPaneProps) {
    this.props = props;
    this.editor = new Editor({
      width: this.width - 4,
      maxHeight: 5,
      placeholder: "Message (or /command)…",
      autocompleteProvider: props.autocompleteProvider,
      onSubmit: async (text: string) => {
        if (text.trim()) {
          this.editor.clear();
          await props.onSubmit(text.trim());
        }
      },
    });
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.editor.setWidth(Math.max(1, width - 4));
  }

  setFocused(focused: boolean): void {
    this.focused = focused;
    this.editor.setFocused(focused);
  }

  isFocused(): boolean {
    return this.focused;
  }

  handleInput(char: string): void {
    if (!this.focused) return;

    // Ctrl+Up/Down to scroll
    if (char === "\x1b[1;5A") {
      // Ctrl+Up
      this.scrollUp();
      return;
    }
    if (char === "\x1b[1;5B") {
      // Ctrl+Down
      this.scrollDown();
      return;
    }

    // Escape to clear input
    if (char === "\x1b") {
      useStore.getState().setInputValue("");
      this.editor.clear();
      this.props.tui.requestRender();
      return;
    }

    // Pass to editor
    this.editor.handleInput(char);

    // Sync input value with store
    const inputValue = this.editor.getText();
    useStore.getState().setInputValue(inputValue);
    this.props.tui.requestRender();
  }

  private scrollUp(): void {
    const state = useStore.getState();
    const room = state.rooms.find((r) => r.id === state.currentRoomId);
    const messages = room?.messages ?? [];
    const innerWidth = Math.max(1, this.width - 4);
    const allLines = toRenderLines(messages, innerWidth);
    const messageAreaHeight = Math.max(1, this.height - 6);
    const maxScroll = Math.max(0, allLines.length - messageAreaHeight);
    this.scrollOffset = Math.min(this.scrollOffset + 1, maxScroll);
    this.props.tui.requestRender();
  }

  private scrollDown(): void {
    this.scrollOffset = Math.max(0, this.scrollOffset - 1);
    this.props.tui.requestRender();
  }

  render(width: number, height: number): string[] {
    this.width = width;
    this.height = height;
    this.editor.setWidth(Math.max(1, width - 4));

    const state = useStore.getState();
    const room = state.rooms.find((r) => r.id === state.currentRoomId);
    const messages = room?.messages ?? [];
    const isAgentTyping = state.isAgentTyping;

    const innerWidth = Math.max(1, width - 4);
    const paddingX = 1;

    // Calculate layout
    const headerHeight = 1;
    const inputHeight = 3;
    const helpHeight = 1;
    const messageAreaHeight = Math.max(
      1,
      height - headerHeight - inputHeight - helpHeight,
    );

    // Build all render lines
    const allLines = toRenderLines(messages, innerWidth);
    if (isAgentTyping) {
      allLines.push({ text: "Eliza typing…", color: "green", dim: true });
    }

    // Calculate visible lines with scroll
    const maxScroll = Math.max(0, allLines.length - messageAreaHeight);
    const clampedScroll = Math.min(this.scrollOffset, maxScroll);
    const startIndex = Math.max(
      0,
      allLines.length - messageAreaHeight - clampedScroll,
    );
    const endIndex = Math.max(0, allLines.length - clampedScroll);
    const visibleLines = allLines.slice(startIndex, endIndex);

    const output: string[] = [];

    // Header
    const headerColor = this.focused ? chalk.bold.cyan : chalk.white;
    const scrollIndicator =
      clampedScroll > 0 ? chalk.dim(` [↑ ${clampedScroll}]`) : "";
    const header = `${headerColor(`Chat: ${room?.name ?? "Unknown"}`)} ${chalk.dim(`(${messages.length})`)}${scrollIndicator}`;
    output.push(" ".repeat(paddingX) + header);

    // Messages
    if (visibleLines.length === 0) {
      output.push(" ".repeat(paddingX) + chalk.dim.italic("No messages."));
      // Fill remaining space
      for (let i = 1; i < messageAreaHeight; i++) {
        output.push("");
      }
    } else {
      for (const line of visibleLines) {
        let styled = line.text;
        if (line.bold) styled = chalk.bold(styled);
        if (line.italic) styled = chalk.italic(styled);
        if (line.dim) styled = chalk.dim(styled);
        if (line.color === "cyan") styled = chalk.cyan(styled);
        else if (line.color === "green") styled = chalk.green(styled);
        output.push(" ".repeat(paddingX) + styled);
      }
      // Fill remaining space
      const remaining = messageAreaHeight - visibleLines.length;
      for (let i = 0; i < remaining; i++) {
        output.push("");
      }
    }

    // Input area
    const borderColor = this.focused ? chalk.cyan : chalk.gray;
    const topBorder = borderColor(`┌${"─".repeat(innerWidth)}┐`);
    const bottomBorder = borderColor(`└${"─".repeat(innerWidth)}┘`);

    output.push(topBorder);

    if (state.isLoading) {
      output.push(
        `${borderColor("│")} ${chalk.dim("Processing...")}${" ".repeat(Math.max(0, innerWidth - 14))}${borderColor("│")}`,
      );
    } else {
      const editorLines = this.editor.render(innerWidth, 1);
      const promptLine = chalk.cyan("> ") + (editorLines[0] || "");
      output.push(
        `${borderColor("│")} ${promptLine.padEnd(innerWidth - 1)}${borderColor("│")}`,
      );
    }

    output.push(bottomBorder);

    // Help text
    const helpText = !this.focused
      ? "Tab: focus"
      : state.inputValue.startsWith("/")
        ? "Enter: run • Tab: complete • Esc: clear • ?: help"
        : "Enter: send • Tab: tasks • Esc: clear • ?: help";
    output.push(chalk.dim(helpText));

    return output;
  }
}
