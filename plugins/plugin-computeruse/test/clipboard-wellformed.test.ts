/**
 * Production-path regression coverage for the clipboard-read preview
 * (issue #23937): the preview must never contain a lone surrogate, and
 * pre-existing lone surrogates must be normalized at the result boundary.
 *
 * Only the host clipboard driver is mocked; the public
 * `clipboardAction.handler` path is exercised directly.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const driverMock = vi.hoisted(() => ({
  readClipboard: vi.fn(),
  writeClipboard: vi.fn(),
}));

vi.mock("../src/platform/clipboard.js", () => driverMock);

import { clipboardAction } from "../src/actions/clipboard.js";

const CLIPBOARD_PREVIEW_BYTES = 4096;

function isWellFormed(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

async function readResult(text: string) {
  driverMock.readClipboard.mockResolvedValue(text);
  let captured: any;
  const callback = async (msg: any) => {
    captured = msg;
    return [];
  };
  await clipboardAction.handler(
    {} as any,
    { action: "read" } as any,
    callback as any,
    {} as any,
    {} as any,
  );
  return captured;
}

describe("clipboard read preview well-formedness (#23937)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps empty and short text unchanged", async () => {
    const msg = await readResult("");
    expect(msg.text).toBe("");
    expect(msg.message).toBe("Clipboard is empty.");

    const short = await readResult("short");
    expect(short.text).toBe("short");
    expect(short.message).toBe("short");
  });

  it("keeps exact-max text unchanged", async () => {
    const text = "a".repeat(CLIPBOARD_PREVIEW_BYTES);
    const msg = await readResult(text);
    expect(msg.text).toBe(text);
    expect(msg.message).toBe(text);
  });

  it("truncates max+1 with a suffix ellipsis and stays well-formed", async () => {
    const text = "a".repeat(CLIPBOARD_PREVIEW_BYTES + 1);
    const msg = await readResult(text);
    expect(msg.message.length).toBe(CLIPBOARD_PREVIEW_BYTES);
    expect(msg.message.endsWith("…")).toBe(true);
    expect(isWellFormed(msg.message)).toBe(true);
  });

  it("never splits an astral pair crossing the cut", async () => {
    const emoji = "\u{1F9E0}";
    const text = "a".repeat(CLIPBOARD_PREVIEW_BYTES - 2) + emoji + "z";
    const msg = await readResult(text);
    expect(isWellFormed(msg.message)).toBe(true);
  });

  it("normalizes short lone-high and lone-low surrogates", async () => {
    const high = await readResult("ok\uD83E");
    expect(isWellFormed(high.text)).toBe(true);

    const low = await readResult("ok\uDE00");
    expect(isWellFormed(low.text)).toBe(true);
  });

  it("normalizes long lone surrogates", async () => {
    const high = await readResult("a".repeat(CLIPBOARD_PREVIEW_BYTES - 1) + "\uD83E");
    expect(isWellFormed(high.message)).toBe(true);

    const low = await readResult("a".repeat(CLIPBOARD_PREVIEW_BYTES - 1) + "\uDE00");
    expect(isWellFormed(low.message)).toBe(true);
  });
});
