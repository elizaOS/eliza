/**
 * Exercises the `$include` byte budget through both the real filesystem-backed
 * config loader and an injected deterministic resolver.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  isIncludeFileTooLarge,
  MAX_INCLUDE_BYTES,
  readIncludeFileWithinBudget,
} from "./include-file-budget.ts";
import { ConfigIncludeError, resolveConfigIncludes } from "./includes.ts";

describe("isIncludeFileTooLarge", () => {
  it("accepts an honest small include", () => {
    expect(isIncludeFileTooLarge('{ "name": "ok" }\n')).toBe(false);
    expect(isIncludeFileTooLarge("x".repeat(MAX_INCLUDE_BYTES))).toBe(false);
  });

  it("rejects a file one byte over the budget", () => {
    expect(isIncludeFileTooLarge("x".repeat(MAX_INCLUDE_BYTES + 1))).toBe(true);
  });

  it("counts UTF-8 bytes instead of JavaScript code units", () => {
    const multibyte = "é".repeat(MAX_INCLUDE_BYTES / 2);
    expect(isIncludeFileTooLarge(multibyte)).toBe(false);
    expect(isIncludeFileTooLarge(`${multibyte}x`)).toBe(true);
  });

  it("rejects an oversized real include before reading it into a string", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-include-"));
    const readSpy = vi.spyOn(fs, "readSync");
    try {
      const includePath = path.join(directory, "oversized.json5");
      fs.writeFileSync(includePath, Buffer.alloc(MAX_INCLUDE_BYTES + 1, 0x20));

      expect(() =>
        resolveConfigIncludes(
          { $include: "./oversized.json5" },
          path.join(directory, "character.json5"),
        ),
      ).toThrowError(ConfigIncludeError);
      expect(() => readIncludeFileWithinBudget(includePath)).toThrow(
        `Include file exceeds ${MAX_INCLUDE_BYTES} bytes`,
      );
      expect(readSpy).not.toHaveBeenCalled();
    } finally {
      readSpy.mockRestore();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("loads and parses a real include exactly at the byte limit", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-include-"));
    try {
      const includePath = path.join(directory, "exact.json5");
      const prefix = '{ "name": "exact" }';
      fs.writeFileSync(
        includePath,
        prefix + " ".repeat(MAX_INCLUDE_BYTES - Buffer.byteLength(prefix)),
      );

      expect(
        resolveConfigIncludes(
          { $include: "./exact.json5" },
          path.join(directory, "character.json5"),
        ),
      ).toEqual({ name: "exact" });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("never parses an oversized value returned by an injected resolver", () => {
    const parseJson = vi.fn();

    expect(() =>
      resolveConfigIncludes({ $include: "large.json5" }, "/config/root.json5", {
        readFile: () => "x".repeat(MAX_INCLUDE_BYTES + 1),
        parseJson,
      }),
    ).toThrow(`Include file exceeds ${MAX_INCLUDE_BYTES} bytes`);
    expect(parseJson).not.toHaveBeenCalled();
  });
});
