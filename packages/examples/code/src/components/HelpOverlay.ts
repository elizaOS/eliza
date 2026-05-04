import type { Component } from "@elizaos/tui";
import chalk from "chalk";

export class HelpOverlay implements Component {
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  render(width: number, height: number): string[] {
    this.width = width;
    this.height = height;

    const output: string[] = [];
    const innerWidth = Math.max(1, width - 4);

    // Border
    const borderColor = chalk.cyan;
    const topBorder = ` ${borderColor(`╭${"─".repeat(innerWidth)}╮`)}`;
    const bottomBorder = ` ${borderColor(`╰${"─".repeat(innerWidth)}╯`)}`;
    const emptyLine = ` ${borderColor("│")}${" ".repeat(innerWidth)}${borderColor("│")}`;

    output.push(topBorder);
    output.push(emptyLine);

    // Title
    output.push(
      ` ${borderColor("│")} ${chalk.bold.cyan("Help")}${" ".repeat(innerWidth - 5)}${borderColor("│")}`,
    );
    output.push(emptyLine);

    // Navigation section
    output.push(
      ` ${borderColor("│")} ${chalk.bold("Navigation")}${" ".repeat(innerWidth - 11)}${borderColor("│")}`,
    );
    output.push(
      ` ${borderColor("│")} ${chalk.dim("Tab: switch panes (except while typing /command)")}${" ".repeat(Math.max(0, innerWidth - 49))}${borderColor("│")}`,
    );
    output.push(
      ` ${borderColor("│")} ${chalk.dim("Ctrl+< / Ctrl+> (or Ctrl+, / Ctrl+.): resize tasks pane")}${" ".repeat(Math.max(0, innerWidth - 56))}${borderColor("│")}`,
    );
    output.push(
      ` ${borderColor("│")} ${chalk.dim("?: toggle help")}${" ".repeat(Math.max(0, innerWidth - 15))}${borderColor("│")}`,
    );
    output.push(
      ` ${borderColor("│")} ${chalk.dim("Ctrl+N: new conversation")}${" ".repeat(Math.max(0, innerWidth - 25))}${borderColor("│")}`,
    );
    output.push(
      ` ${borderColor("│")} ${chalk.dim("Ctrl+C / Ctrl+Q: quit")}${" ".repeat(Math.max(0, innerWidth - 22))}${borderColor("│")}`,
    );
    output.push(emptyLine);

    // Chat section
    output.push(
      ` ${borderColor("│")} ${chalk.bold("Chat")}${" ".repeat(innerWidth - 5)}${borderColor("│")}`,
    );
    output.push(
      ` ${borderColor("│")} ${chalk.dim("Enter: send | Esc: clear | Ctrl+↑↓: scroll")}${" ".repeat(Math.max(0, innerWidth - 43))}${borderColor("│")}`,
    );
    output.push(
      ` ${borderColor("│")} ${chalk.dim("/help: show commands")}${" ".repeat(Math.max(0, innerWidth - 21))}${borderColor("│")}`,
    );
    output.push(emptyLine);

    // Tasks section
    output.push(
      ` ${borderColor("│")} ${chalk.bold("Tasks")}${" ".repeat(innerWidth - 6)}${borderColor("│")}`,
    );
    output.push(
      ` ${borderColor("│")} ${chalk.dim("↑↓ select | Enter switch | d done/open | f finished | e edit mode")}${" ".repeat(Math.max(0, innerWidth - 66))}${borderColor("│")}`,
    );
    output.push(
      ` ${borderColor("│")} ${chalk.dim("Edit mode: r rename | p pause/resume | c cancel | x delete (y/n confirm)")}${" ".repeat(Math.max(0, innerWidth - 72))}${borderColor("│")}`,
    );
    output.push(
      ` ${borderColor("│")} ${chalk.dim("/task pane show|hide|auto|toggle")}${" ".repeat(Math.max(0, innerWidth - 34))}${borderColor("│")}`,
    );
    output.push(emptyLine);

    // Commands section
    output.push(
      ` ${borderColor("│")} ${chalk.bold("Commands")}${" ".repeat(innerWidth - 9)}${borderColor("│")}`,
    );
    output.push(
      ` ${borderColor("│")} ${chalk.dim("/new, /switch, /rename, /delete, /reset")}${" ".repeat(Math.max(0, innerWidth - 40))}${borderColor("│")}`,
    );
    output.push(
      ` ${borderColor("│")} ${chalk.dim("/task, /tasks, /cd, /pwd, /clear")}${" ".repeat(Math.max(0, innerWidth - 33))}${borderColor("│")}`,
    );
    output.push(emptyLine);

    // Fill remaining height
    const usedLines = output.length;
    const remainingLines = height - usedLines - 2; // -2 for bottom content
    for (let i = 0; i < remainingLines; i++) {
      output.push(emptyLine);
    }

    // Footer
    output.push(
      ` ${borderColor("│")} ${chalk.dim("Press ? or Esc to close")}${" ".repeat(Math.max(0, innerWidth - 24))}${borderColor("│")}`,
    );
    output.push(bottomBorder);

    return output;
  }
}
