/**
 * Exercises clipboard-read Unicode normalization through the real action
 * handler while mocking only the host clipboard driver boundary.
 */
import type { ActionResult, IAgentRuntime, Memory } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { readClipboardMock, writeClipboardMock } = vi.hoisted(() => ({
  readClipboardMock: vi.fn<() => Promise<string>>(),
  writeClipboardMock: vi.fn<(text: string) => Promise<void>>(),
}));

vi.mock("../platform/clipboard.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../platform/clipboard.js")>()),
  readClipboard: readClipboardMock,
  writeClipboard: writeClipboardMock,
}));

import { clipboardAction } from "./clipboard.ts";

const PREVIEW_CAP = 4096;
const runtime = {
  getService: () => ({
    getCapabilities: () => ({ clipboard: { available: true } }),
  }),
} as unknown as IAgentRuntime;
const message = {
  content: { text: "read my clipboard", action: "read" },
} as unknown as Memory;

function clipboardPayload(result: ActionResult): {
  message?: string;
  text?: string;
} {
  const data = result.data as
    | { result?: { message?: unknown; text?: unknown } }
    | undefined;
  return {
    message:
      typeof data?.result?.message === "string"
        ? data.result.message
        : undefined,
    text: typeof data?.result?.text === "string" ? data.result.text : undefined,
  };
}

function isWellFormed(text: string): boolean {
  return (
    (text as unknown as { isWellFormed?: () => boolean }).isWellFormed?.() ??
    !/[\uD800-\uDFFF]/u.test(text)
  );
}

async function readClipboardThroughAction(text: string): Promise<{
  result: ActionResult;
  payload: ReturnType<typeof clipboardPayload>;
}> {
  readClipboardMock.mockResolvedValueOnce(text);
  const result = await clipboardAction.handler(runtime, message);
  return { result, payload: clipboardPayload(result) };
}

describe("clipboard action Unicode-safe read projection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["high", "\uD800"],
    ["low", "\uDC00"],
  ])(
    "normalizes a short lone-%s surrogate in text and preview",
    async (_, lone) => {
      const { result, payload } = await readClipboardThroughAction(
        `before ${lone} after`,
      );

      expect(result.success).toBe(true);
      expect(result.text).toBe("before � after");
      expect(payload).toEqual({
        message: "before � after",
        text: "before � after",
      });
    },
  );

  it("keeps a boundary surrogate pair intact and preserves full returned text", async () => {
    const fox = "🦊";
    const fullText = `${"a".repeat(PREVIEW_CAP - 2)}${fox}z`;
    const { result, payload } = await readClipboardThroughAction(fullText);

    expect(fullText.length).toBe(PREVIEW_CAP + 1);
    expect(result.text).toBe(`${"a".repeat(PREVIEW_CAP - 2)}…`);
    expect(isWellFormed(result.text ?? "")).toBe(true);
    expect(payload.text).toBe(fullText);
    expect(payload.message).toBe(result.text);
  });

  it("caps an over-limit preview at exactly 4096 code units including ellipsis", async () => {
    const fullText = "a".repeat(PREVIEW_CAP + 1);
    const { result, payload } = await readClipboardThroughAction(fullText);

    expect(result.text).toBe(`${"a".repeat(PREVIEW_CAP - 1)}…`);
    expect(result.text).toHaveLength(PREVIEW_CAP);
    expect(payload.text).toBe(fullText);
    expect(payload.text).toHaveLength(PREVIEW_CAP + 1);
  });
});
