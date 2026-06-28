/**
 * Unit coverage for the action param/result helpers (#9170).
 *
 * `resolveActionParams` merges planner-supplied `options.parameters` over the
 * message content; `toComputerUseActionResult` shapes the ActionResult and
 * **redacts raw screenshot base64 to a boolean** so multi-MB frames never leak
 * into the action-result data; `buildScreenshotAttachment` builds the data-URI
 * attachment. None were tested.
 */

import type { HandlerOptions, Memory } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  buildScreenshotAttachment,
  resolveActionParams,
  toComputerUseActionResult,
} from "../actions/helpers.js";

describe("resolveActionParams", () => {
  it("prefers options.parameters over message.content, filling the rest from content", () => {
    const out = resolveActionParams<{ x: number; y: number }>(
      { content: { x: 1, y: 2 } } as unknown as Memory,
      { parameters: { x: 99 } } as unknown as HandlerOptions,
    );
    expect(out).toEqual({ x: 99, y: 2 });
  });

  it("falls back entirely to message.content when there are no options", () => {
    const out = resolveActionParams<{ a: string }>({
      content: { a: "hi" },
    } as unknown as Memory);
    expect(out).toEqual({ a: "hi" });
  });

  it("keeps a defined option even when it is falsy (does not get overwritten by content)", () => {
    const out = resolveActionParams<{ flag: boolean }>(
      { content: { flag: true } } as unknown as Memory,
      { parameters: { flag: false } } as unknown as HandlerOptions,
    );
    expect(out.flag).toBe(false);
  });
});

describe("buildScreenshotAttachment", () => {
  it("builds a base64 PNG data-uri attachment with a prefixed id", () => {
    const a = buildScreenshotAttachment({
      idPrefix: "shot",
      screenshot: "AAAA",
      title: "Title",
      description: "Desc",
    });
    expect(a.id.startsWith("shot-")).toBe(true);
    expect(a.url).toBe("data:image/png;base64,AAAA");
    expect(a.title).toBe("Title");
    expect(a.description).toBe("Desc");
    expect(a.source).toBe("computeruse");
    expect(a.contentType).toBe("image");
  });
});

describe("toComputerUseActionResult", () => {
  it("maps a success result and redacts screenshot base64 to a boolean", () => {
    const r = toComputerUseActionResult({
      action: "click",
      result: {
        success: true,
        message: "ok",
        screenshot: "BBBB",
        frontendScreenshot: "",
      },
      text: "Clicked",
    });
    expect(r.success).toBe(true);
    expect(r.text).toBe("Clicked");
    expect(r.error).toBeUndefined();
    expect(r.data).toMatchObject({
      source: "computeruse",
      computerUseAction: "click",
      result: {
        success: true,
        message: "ok",
        hasScreenshot: true,
        hasFrontendScreenshot: false,
      },
    });
    // The raw base64 must NOT survive into the action-result data.
    const data = r.data as { result: Record<string, unknown> };
    expect(data.result.screenshot).toBeUndefined();
    expect(data.result.frontendScreenshot).toBeUndefined();
  });

  it("surfaces an error on failure and the clipboard-suppression flag on request", () => {
    const r = toComputerUseActionResult({
      action: "ocr",
      result: { success: false, error: "boom" },
      text: "failed",
      suppressClipboard: true,
    });
    expect(r.success).toBe(false);
    expect(r.error).toBe("boom");
    expect(r.data).toMatchObject({ suppressActionResultClipboard: true });
  });

  it("defaults the error message when a failure carries none", () => {
    const r = toComputerUseActionResult({
      action: "x",
      result: { success: false },
      text: "t",
    });
    expect(r.error).toBe("Computer-use failed");
  });
});
