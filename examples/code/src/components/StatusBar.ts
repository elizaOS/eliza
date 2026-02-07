import type { Component } from "@elizaos/tui";
import chalk from "chalk";
import { getCwd } from "../lib/cwd.js";
import { useStore } from "../lib/store.js";

export class StatusBar implements Component {
  private cwd = getCwd();
  private lastCwdCheck = Date.now();

  render(width: number, _height: number): string[] {
    this.width = width;

    // Periodically update CWD
    const now = Date.now();
    if (now - this.lastCwdCheck > 500) {
      this.cwd = getCwd();
      this.lastCwdCheck = now;
    }

    const state = useStore.getState();
    const isLoading = state.isLoading;
    const tasks = state.tasks;
    const rooms = state.rooms;
    const currentRoomId = state.currentRoomId;

    const currentRoom = rooms.find((r) => r.id === currentRoomId);
    const roomIndex = rooms.findIndex((r) => r.id === currentRoomId) + 1;

    const taskCounts = {
      running: tasks.filter((t) => t.metadata?.status === "running").length,
      completed: tasks.filter((t) => t.metadata?.status === "completed").length,
      failed: tasks.filter((t) => t.metadata?.status === "failed").length,
      cancelled: tasks.filter((t) => t.metadata?.status === "cancelled").length,
    };

    const showFullRight = width >= 80;
    const showMediumRight = width >= 60;

    const rightTextPlain = showFullRight
      ? `Tasks r${taskCounts.running} c${taskCounts.completed} f${taskCounts.failed} x${taskCounts.cancelled}${isLoading ? " …" : ""} | ?`
      : showMediumRight
        ? `Tasks r${taskCounts.running} f${taskCounts.failed}${isLoading ? " …" : ""} | ?`
        : `Tasks r${taskCounts.running}${isLoading ? " …" : ""} | ?`;

    const maxCwdLen = Math.max(10, width - rightTextPlain.length - 24);
    const shortCwd =
      this.cwd.length > maxCwdLen
        ? `...${this.cwd.slice(-(maxCwdLen - 3))}`
        : this.cwd;

    const maxRoomNameLen = 20;
    const roomName = currentRoom?.name ?? "Chat";
    const shortRoomName =
      roomName.length > maxRoomNameLen
        ? `${roomName.slice(0, maxRoomNameLen - 1)}…`
        : roomName;

    // Build the status bar
    const innerWidth = Math.max(1, width - 4);

    const leftText = `${chalk.bold.magenta(shortRoomName)} ${chalk.dim(`(${roomIndex}/${rooms.length})`)} ${chalk.dim("|")} ${chalk.cyan(shortCwd)}`;
    const rightText = chalk.dim(rightTextPlain);

    // Calculate padding to right-align the right text
    const leftLen =
      shortRoomName.length +
      ` (${roomIndex}/${rooms.length}) | `.length +
      shortCwd.length;
    const rightLen = rightTextPlain.length;
    const padding = Math.max(0, innerWidth - leftLen - rightLen);

    const borderColor = chalk.gray;
    const topBorder = borderColor(`┌${"─".repeat(innerWidth)}┐`);
    const bottomBorder = borderColor(`└${"─".repeat(innerWidth)}┘`);
    const content = `${borderColor("│")} ${leftText}${" ".repeat(padding)}${rightText} ${borderColor("│")}`;

    return [topBorder, content, bottomBorder];
  }
}
