import { describe, expect, it, vi } from "vitest";

const style = vi.hoisted(() => vi.fn((t: string) => `styled(${t})`));

vi.mock("chalk", () => {
  const styleFn = (t: string) => style(t);
  const handler: ProxyHandler<typeof styleFn> = {
    get: () => new Proxy(styleFn, handler),
    apply: (_t, _this, args: unknown[]) => styleFn(String(args[0])),
  };
  return { default: new Proxy(styleFn, handler) };
});

import { createChatMarkdownTheme } from "../markdown-theme.ts";

describe("createChatMarkdownTheme", () => {
  it("builds a theme with all markdown slots", () => {
    const theme = createChatMarkdownTheme();
    expect(theme.heading("h")).toBe("styled(h)");
    expect(theme.link("l")).toBe("styled(l)");
    expect(theme.codeBlock("c")).toBe("styled(c)");
    expect(theme.listBullet("-")).toBe("styled(-)");
    expect(theme.bold("b")).toBe("styled(b)");
    expect(theme.hr("---")).toBe("styled(---)");
  });

  it("sets a code block indent gutter", () => {
    const theme = createChatMarkdownTheme();
    expect(theme.codeBlockIndent).toBe("  ");
  });
});
