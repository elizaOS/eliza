import { describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/tui", () => ({
  ansi: {
    brightCyan: (t: string) => `bc:${t}`,
    white: (t: string) => `w:${t}`,
    gray: (t: string) => `g:${t}`,
    dim: (t: string) => `d:${t}`,
    red: (t: string) => `r:${t}`,
  },
  darkTheme: { colors: { border: "border-color" } },
}));

import { createEditorTheme } from "../editor-theme.ts";

describe("createEditorTheme", () => {
  it("builds a theme from the dark palette", () => {
    const theme = createEditorTheme();
    expect(theme.borderColor).toBe("border-color");
    expect(theme.selectList.selectedPrefix("x")).toBe("bc:x");
    expect(theme.selectList.selectedText("x")).toBe("w:x");
    expect(theme.selectList.description("x")).toBe("g:x");
    expect(theme.selectList.scrollInfo("x")).toBe("d:x");
    expect(theme.selectList.noMatch("x")).toBe("r:x");
  });
});
