/**
 * A chalk-based {@link MarkdownTheme} for eliza-code's chat transcript.
 *
 * `@elizaos/tui` ships a full Markdown renderer (headings, lists, tables,
 * inline styles, fenced code blocks) but exports no ready-made production
 * theme — only a test fixture. This maps each theme slot to a chalk style so
 * assistant replies render with real markdown formatting + code-block framing
 * instead of the previous flat wrapped text (the biggest look-and-feel gap vs
 * opencode/claude-code). Colors intentionally track the existing transcript
 * palette (cyan/green accents, dim chrome); orange is reserved as accent
 * elsewhere so we avoid it here.
 */

import type { MarkdownTheme } from "@elizaos/tui";
import chalk from "chalk";

export function createChatMarkdownTheme(): MarkdownTheme {
  return {
    heading: (t) => chalk.bold.cyan(t),
    link: (t) => chalk.underline.cyan(t),
    linkUrl: (t) => chalk.dim(t),
    code: (t) => chalk.yellowBright(t),
    codeBlock: (t) => chalk.greenBright(t),
    codeBlockBorder: (t) => chalk.dim(t),
    quote: (t) => chalk.italic.dim(t),
    quoteBorder: (t) => chalk.dim(t),
    hr: (t) => chalk.dim(t),
    listBullet: (t) => chalk.cyan(t),
    bold: (t) => chalk.bold(t),
    italic: (t) => chalk.italic(t),
    strikethrough: (t) => chalk.strikethrough(t),
    underline: (t) => chalk.underline(t),
    // Code blocks get a two-space gutter so they read as an indented block.
    codeBlockIndent: "  ",
  };
}
