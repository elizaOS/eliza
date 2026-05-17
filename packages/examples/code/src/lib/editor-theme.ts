import type { EditorTheme } from "@elizaos/tui";
import { ansi, darkTheme } from "@elizaos/tui";

/** Theme bundle for {@link import("@elizaos/tui").Editor} using the built-in dark palette. */
export function createEditorTheme(): EditorTheme {
  return {
    borderColor: darkTheme.colors.border,
    selectList: {
      selectedPrefix: (text: string) => ansi.brightCyan(text),
      selectedText: (text: string) => ansi.white(text),
      description: (text: string) => ansi.gray(text),
      scrollInfo: (text: string) => ansi.dim(text),
      noMatch: (text: string) => ansi.red(text),
    },
  };
}
