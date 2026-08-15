// Renders a reusable UI component for the Code example.
import type { Component, Focusable, Terminal } from "@elizaos/tui";
import { truncateToWidth } from "@elizaos/tui";
import { useStore } from "../lib/store.js";
import type { ChatPane } from "./ChatPane.js";
import type { StatusBar } from "./StatusBar.js";
import type { TaskPane } from "./TaskPane.js";

/**
 * Composes status bar + chat / task split into one root {@link Component} for the TUI.
 */
export class MainScreen implements Component, Focusable {
  focused = true;

  constructor(
    private readonly terminal: Terminal,
    private readonly statusBar: StatusBar,
    private readonly chatPane: ChatPane,
    private readonly taskPane: TaskPane,
  ) {}

  invalidate(): void {
    this.statusBar.invalidate();
    this.chatPane.invalidate();
    this.taskPane.invalidate();
  }

  handleInput(data: string): void {
    const pane = useStore.getState().focusedPane;
    if (pane === "tasks") {
      this.taskPane.handleInput(data);
    } else {
      this.chatPane.handleInput(data);
    }
  }

  render(width: number): string[] {
    const height = Math.max(1, this.terminal.rows);
    const state = useStore.getState();
    const showTasks = state.isTaskPaneVisible();

    this.chatPane.syncFocus(state.focusedPane === "chat");
    this.taskPane.syncFocus(state.focusedPane === "tasks");

    const statusLines = this.statusBar.render(width);
    const contentHeight = Math.max(1, height - statusLines.length);

    // Clip every assembled line to the terminal width. Child components are
    // responsible for their own layout, but any visible-width overflow that
    // slips through (fixed-width footers, unpadded chrome on narrow
    // terminals) is a fatal render abort in the TUI — clip here at the one
    // choke point instead of crashing.
    const clip = (lines: string[]): string[] =>
      lines.map((line) => truncateToWidth(line, width));

    if (!showTasks) {
      return clip([
        ...statusLines,
        ...this.chatPane.renderContent(width, contentHeight),
      ]);
    }

    const taskW = Math.max(
      18,
      Math.min(Math.floor(width * state.taskPaneWidthFraction), width - 22),
    );
    const chatW = Math.max(18, width - taskW - 1);
    const chatLines = this.chatPane.renderContent(chatW, contentHeight);
    const taskLines = this.taskPane.renderContent(taskW, contentHeight);
    const maxRows = Math.max(chatLines.length, taskLines.length);
    const sep = "│";
    const body: string[] = [];
    for (let r = 0; r < maxRows; r++) {
      const left = chatLines[r] ?? "";
      const right = taskLines[r] ?? "";
      body.push(`${left}${sep}${right}`);
    }
    return clip([...statusLines, ...body]);
  }
}
