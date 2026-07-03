import { describe, expect, it } from "vitest";
import type { Button } from "./types";
import {
  cleanText,
  convertMarkdownToTelegram,
  convertToTelegramButtons,
} from "./utils";

/**
 * Telegram outbound formatting. convertMarkdownToTelegram rewrites standard
 * markdown into Telegram MarkdownV2 (single-asterisk bold, single-tilde strike)
 * and MUST backslash-escape MarkdownV2 reserved chars in plain text — an
 * unescaped "." or "!" makes Telegram reject the whole send. convertToTelegramButtons
 * skips malformed buttons, and cleanText strips the NUL sentinel used during
 * conversion so it can't leak into a delivered message.
 */

describe("convertMarkdownToTelegram", () => {
  it("rewrites bold/strikethrough to Telegram syntax", () => {
    expect(convertMarkdownToTelegram("**bold**")).toBe("*bold*");
    expect(convertMarkdownToTelegram("~~struck~~")).toBe("~struck~");
  });

  it("escapes MarkdownV2 reserved chars in plain text", () => {
    expect(convertMarkdownToTelegram("hello.")).toBe("hello\\.");
    expect(convertMarkdownToTelegram("a-b!")).toBe("a\\-b\\!");
  });

  it("preserves links (url chars other than ) and \\ stay raw)", () => {
    expect(convertMarkdownToTelegram("[docs](http://x.com)")).toBe(
      "[docs](http://x.com)",
    );
  });

  it("resolves nested tokens (inline code inside bold/header) without leaking NUL sentinels", () => {
    const bold = convertMarkdownToTelegram("**bold `code`**");
    expect(bold).toBe("*bold `code`*");
    expect(bold).not.toContain("\u0000");

    const header = convertMarkdownToTelegram("# Header with `code`");
    expect(header).toBe("*Header with `code`*");
    expect(header).not.toContain("\u0000");
  });
});

describe("convertToTelegramButtons", () => {
  it("renders url and login buttons, skips malformed ones", () => {
    const buttons: Button[] = [
      { kind: "url", text: "Open", url: "https://x.com" },
      { kind: "login", text: "Login", url: "https://x.com/auth" },
      { kind: "web_app", text: "Launch app", url: "https://x.com/embed/app" },
      { kind: "url", text: "", url: "https://x.com" } as Button, // missing text → skipped
      { kind: "url", text: "NoUrl" } as Button, // missing url → skipped
    ];
    const out = convertToTelegramButtons(buttons);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ text: "Open", url: "https://x.com" });
    // login buttons carry a login_url object rather than a plain url.
    expect((out[1] as { login_url?: { url: string } }).login_url?.url).toBe(
      "https://x.com/auth",
    );
    expect((out[2] as { web_app?: { url: string } }).web_app?.url).toBe(
      "https://x.com/embed/app",
    );
  });

  it("returns [] for null/undefined", () => {
    expect(convertToTelegramButtons(null)).toEqual([]);
    expect(convertToTelegramButtons(undefined)).toEqual([]);
  });
});

describe("cleanText", () => {
  it("strips NULL sentinels and handles nullish input", () => {
    const NUL = String.fromCharCode(0);
    expect(cleanText(`a${NUL}b${NUL}c`)).toBe("abc");
    expect(cleanText(null)).toBe("");
    expect(cleanText(undefined)).toBe("");
  });
});
