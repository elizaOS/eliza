/**
 * Regression tests for surrogate safety in file read content windows and
 * Android trajectory error logging. Exercises the production seams
 * `readFile` (temp file) and `emitAndroidAction` (logger spy) so reverting
 * either truncation site to `.slice()` makes the suite red.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emitAndroidAction,
  MAX_ERROR_MSG,
} from "../mobile/android-trajectory.js";
import { READ_FILE_CHAR_LIMIT, readFile } from "./file-ops.js";

function isWellFormed(value: string): boolean {
  if (!value) return true;
  const maybe = value as unknown as { isWellFormed?: () => boolean };
  if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

describe("computeruse file-ops and android trajectory surrogate safety (production-connected)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "computeruse-surrogate-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("readFile keeps surrogate pairs intact at 10,000-char boundary via real file", async () => {
    const fox = String.fromCharCode(0xd83e, 0xdd8a);
    const input = `${"a".repeat(READ_FILE_CHAR_LIMIT - 1)}${fox}${"g".repeat(100)}`;
    const filePath = join(tempDir, "surrogate-boundary.txt");
    writeFileSync(filePath, input, "utf8");

    const result = await readFile(filePath);
    expect(result.success).toBe(true);
    const out = result.content ?? "";
    // Mutation proof: naive `.slice(0, 10_000)` leaves a lone high surrogate
    // (length 10000, well-formed false). Correct helper backs off to 9999.
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBe(READ_FILE_CHAR_LIMIT - 1);
    expect(out).not.toContain("\uD83E");
    expect(() => JSON.stringify({ content: out })).not.toThrow();
    const parsed = JSON.parse(JSON.stringify({ content: out })) as {
      content: string;
    };
    expect(isWellFormed(parsed.content)).toBe(true);
  });

  it("readFile truncation is JSON-safe and length-bounded via production path", async () => {
    const fox = String.fromCharCode(0xd83e, 0xdd8a);
    const input = `${fox.repeat(6000)}${"z".repeat(5000)}`;
    const filePath = join(tempDir, "surrogate-json.txt");
    writeFileSync(filePath, input, "utf8");

    const result = await readFile(filePath);
    expect(result.success).toBe(true);
    const out = result.content ?? "";
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(READ_FILE_CHAR_LIMIT);
    expect(() => JSON.stringify({ content: out })).not.toThrow();
  });

  it("emitAndroidAction keeps surrogate pairs intact at 256-char boundary via real emitter", () => {
    const spy = vi.spyOn(logger, "info").mockImplementation(() => logger);
    try {
      const fox = String.fromCharCode(0xd83e, 0xdd8a);
      const input = `${"e".repeat(MAX_ERROR_MSG - 1)}${fox}${"h".repeat(50)}`;
      const payload = emitAndroidAction({
        kind: "tap",
        success: false,
        errorCode: "test_surrogate",
        errorMessage: input,
      });
      const out = payload.errorMessage ?? "";
      // Mutation proof: naive `.slice(0, 256)` yields length 256 with trailing
      // lone high surrogate (well-formed false). Correct backs off to 255.
      expect(isWellFormed(out)).toBe(true);
      expect(out.length).toBe(MAX_ERROR_MSG - 1);
      expect(out).not.toContain("\uD83E");
      expect(() => JSON.stringify(payload)).not.toThrow();
      const logged = spy.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(logged.evt).toBe("computeruse.android.action");
      expect(logged.platform).toBe("android");
      expect(isWellFormed(String(logged.errorMessage))).toBe(true);
      expect(String(logged.errorMessage).length).toBe(MAX_ERROR_MSG - 1);
      expect(() => JSON.stringify(logged)).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });

  it("emitAndroidAction sanitizes lone surrogates via production path", () => {
    const spy = vi.spyOn(logger, "info").mockImplementation(() => logger);
    try {
      const lone = `header ${String.fromCharCode(0xd800)} content`;
      const payload = emitAndroidAction({
        kind: "tap",
        success: false,
        errorCode: "lone_surrogate",
        errorMessage: lone,
      });
      const out = payload.errorMessage ?? "";
      expect(isWellFormed(out)).toBe(true);
      expect(out.includes("�")).toBe(true);
      expect(out.length).toBeLessThanOrEqual(MAX_ERROR_MSG);
      expect(() => JSON.stringify(payload)).not.toThrow();
      const logged = spy.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(isWellFormed(String(logged.errorMessage))).toBe(true);
      expect(String(logged.errorMessage).includes("�")).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("emitAndroidAction truncation is JSON-safe at cap", () => {
    const spy = vi.spyOn(logger, "info").mockImplementation(() => logger);
    try {
      const fox = String.fromCharCode(0xd83e, 0xdd8a);
      const input = `${fox.repeat(200)}`;
      const payload = emitAndroidAction({
        kind: "swipe",
        success: false,
        errorCode: "json_safe",
        errorMessage: input,
      });
      const out = payload.errorMessage ?? "";
      expect(isWellFormed(out)).toBe(true);
      expect(out.length).toBeLessThanOrEqual(MAX_ERROR_MSG);
      expect(() => JSON.stringify(payload)).not.toThrow();
      const logged = spy.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(() => JSON.stringify(logged)).not.toThrow();
      expect(isWellFormed(String(logged.errorMessage))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
