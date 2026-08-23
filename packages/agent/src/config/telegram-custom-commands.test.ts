/**
 * Behavioral coverage for Telegram custom-command normalization: name/description
 * trimming, reserved and duplicate rejection, and the per-entry issue list the
 * config UI surfaces. Pure in-process assertions against the real module.
 */

import { describe, expect, it } from "vitest";
import {
  normalizeTelegramCommandDescription,
  normalizeTelegramCommandName,
  resolveTelegramCustomCommands,
  TELEGRAM_COMMAND_NAME_PATTERN,
} from "./telegram-custom-commands.ts";

describe("TELEGRAM_COMMAND_NAME_PATTERN", () => {
  it("accepts 1–32 lowercase letters, digits, and underscores", () => {
    expect(TELEGRAM_COMMAND_NAME_PATTERN.test("a")).toBe(true);
    expect(TELEGRAM_COMMAND_NAME_PATTERN.test("help")).toBe(true);
    expect(TELEGRAM_COMMAND_NAME_PATTERN.test("cmd_1")).toBe(true);
    expect(TELEGRAM_COMMAND_NAME_PATTERN.test("a".repeat(32))).toBe(true);
  });

  it("rejects empty, oversized, and out-of-alphabet names", () => {
    expect(TELEGRAM_COMMAND_NAME_PATTERN.test("")).toBe(false);
    expect(TELEGRAM_COMMAND_NAME_PATTERN.test("a".repeat(33))).toBe(false);
    expect(TELEGRAM_COMMAND_NAME_PATTERN.test("Help")).toBe(false);
    expect(TELEGRAM_COMMAND_NAME_PATTERN.test("help-me")).toBe(false);
    expect(TELEGRAM_COMMAND_NAME_PATTERN.test("help me")).toBe(false);
    expect(TELEGRAM_COMMAND_NAME_PATTERN.test("/help")).toBe(false);
  });
});

describe("normalizeTelegramCommandName", () => {
  it("returns empty for blank, whitespace-only, and slash-only input", () => {
    expect(normalizeTelegramCommandName("")).toBe("");
    expect(normalizeTelegramCommandName("   ")).toBe("");
    expect(normalizeTelegramCommandName("/")).toBe("");
    expect(normalizeTelegramCommandName(" / ")).toBe("");
  });

  it("strips a single leading slash, trims, and lowercases", () => {
    expect(normalizeTelegramCommandName("Help")).toBe("help");
    expect(normalizeTelegramCommandName("/Help")).toBe("help");
    expect(normalizeTelegramCommandName("  /Status  ")).toBe("status");
    expect(normalizeTelegramCommandName("/  Ping  ")).toBe("ping");
  });

  it("does not strip a second leading slash after the first", () => {
    expect(normalizeTelegramCommandName("//help")).toBe("/help");
  });
});

describe("normalizeTelegramCommandDescription", () => {
  it("trims surrounding whitespace and preserves inner text", () => {
    expect(normalizeTelegramCommandDescription("  Show status  ")).toBe(
      "Show status",
    );
    expect(normalizeTelegramCommandDescription("   ")).toBe("");
    expect(normalizeTelegramCommandDescription("")).toBe("");
  });
});

describe("resolveTelegramCustomCommands", () => {
  it("treats a missing, null, or empty command list as an empty result", () => {
    expect(resolveTelegramCustomCommands({})).toEqual({
      commands: [],
      issues: [],
    });
    expect(resolveTelegramCustomCommands({ commands: null })).toEqual({
      commands: [],
      issues: [],
    });
    expect(resolveTelegramCustomCommands({ commands: [] })).toEqual({
      commands: [],
      issues: [],
    });
  });

  it("accepts a single valid command", () => {
    expect(
      resolveTelegramCustomCommands({
        commands: [{ command: "/Help", description: " Show help " }],
      }),
    ).toEqual({
      commands: [{ command: "help", description: "Show help" }],
      issues: [],
    });
  });

  it("preserves acceptance order for several valid commands", () => {
    const result = resolveTelegramCustomCommands({
      commands: [
        { command: "alpha", description: "first" },
        { command: "beta", description: "second" },
        { command: "gamma", description: "third" },
      ],
    });
    expect(result.commands.map((entry) => entry.command)).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
    expect(result.issues).toEqual([]);
  });

  it("reports a missing command name and skips the entry", () => {
    const result = resolveTelegramCustomCommands({
      commands: [
        { command: "keep", description: "kept" },
        { command: "   ", description: "blank name" },
        { command: null, description: "null name" },
        { description: "omitted name" },
        { command: "/", description: "slash only" },
      ],
    });
    expect(result.commands).toEqual([{ command: "keep", description: "kept" }]);
    expect(result.issues).toEqual([
      {
        index: 1,
        field: "command",
        message: "Telegram custom command is missing a command name.",
      },
      {
        index: 2,
        field: "command",
        message: "Telegram custom command is missing a command name.",
      },
      {
        index: 3,
        field: "command",
        message: "Telegram custom command is missing a command name.",
      },
      {
        index: 4,
        field: "command",
        message: "Telegram custom command is missing a command name.",
      },
    ]);
  });

  it("treats a hole in the command array as a missing name at that index", () => {
    const commands: Array<{
      command?: string | null;
      description?: string | null;
    }> = [];
    commands[0] = { command: "keep", description: "kept" };
    commands[2] = { command: "later", description: "after hole" };
    const result = resolveTelegramCustomCommands({ commands });
    expect(result.commands).toEqual([
      { command: "keep", description: "kept" },
      { command: "later", description: "after hole" },
    ]);
    expect(result.issues).toEqual([
      {
        index: 1,
        field: "command",
        message: "Telegram custom command is missing a command name.",
      },
    ]);
  });

  it("rejects names that fail Telegram's 1–32 a-z/0-9/_ pattern", () => {
    const overflow = `x${"a".repeat(32)}`;
    const result = resolveTelegramCustomCommands({
      commands: [
        { command: "help-me", description: "hyphen" },
        { command: overflow, description: "too long" },
        { command: "//help", description: "double slash" },
        { command: "ok_cmd", description: "valid" },
      ],
    });
    expect(result.commands).toEqual([
      { command: "ok_cmd", description: "valid" },
    ]);
    expect(result.issues).toEqual([
      {
        index: 0,
        field: "command",
        message:
          'Telegram custom command "/help-me" is invalid (use a-z, 0-9, underscore; max 32 chars).',
      },
      {
        index: 1,
        field: "command",
        message: `Telegram custom command "/${overflow}" is invalid (use a-z, 0-9, underscore; max 32 chars).`,
      },
      {
        index: 2,
        field: "command",
        message:
          'Telegram custom command "//help" is invalid (use a-z, 0-9, underscore; max 32 chars).',
      },
    ]);
  });

  it("accepts a 32-character name at the Telegram capacity boundary", () => {
    const name = "a".repeat(32);
    const result = resolveTelegramCustomCommands({
      commands: [{ command: name, description: "max length" }],
    });
    expect(result).toEqual({
      commands: [{ command: name, description: "max length" }],
      issues: [],
    });
  });

  it("rejects reserved names by default and keeps later valid entries", () => {
    const result = resolveTelegramCustomCommands({
      commands: [
        { command: "/Start", description: "boot" },
        { command: "status", description: "ok" },
      ],
      reservedCommands: new Set(["start"]),
    });
    expect(result.commands).toEqual([{ command: "status", description: "ok" }]);
    expect(result.issues).toEqual([
      {
        index: 0,
        field: "command",
        message:
          'Telegram custom command "/start" conflicts with a native command.',
      },
    ]);
  });

  it("skips the reserved check when checkReserved is false", () => {
    const result = resolveTelegramCustomCommands({
      commands: [{ command: "start", description: "boot" }],
      reservedCommands: new Set(["start"]),
      checkReserved: false,
    });
    expect(result).toEqual({
      commands: [{ command: "start", description: "boot" }],
      issues: [],
    });
  });

  it("keeps the first of a name collision and flags later ties as duplicates", () => {
    const result = resolveTelegramCustomCommands({
      commands: [
        { command: "Help", description: "first" },
        { command: "/help", description: "second" },
        { command: "other", description: "ok" },
      ],
    });
    expect(result.commands).toEqual([
      { command: "help", description: "first" },
      { command: "other", description: "ok" },
    ]);
    expect(result.issues).toEqual([
      {
        index: 1,
        field: "command",
        message: 'Telegram custom command "/help" is duplicated.',
      },
    ]);
  });

  it("allows duplicate names when checkDuplicates is false", () => {
    const result = resolveTelegramCustomCommands({
      commands: [
        { command: "help", description: "first" },
        { command: "help", description: "second" },
      ],
      checkDuplicates: false,
    });
    expect(result).toEqual({
      commands: [
        { command: "help", description: "first" },
        { command: "help", description: "second" },
      ],
      issues: [],
    });
  });

  it("reports a missing description without accepting the command", () => {
    const result = resolveTelegramCustomCommands({
      commands: [
        { command: "help", description: "   " },
        { command: "ping", description: null },
        { command: "pong" },
      ],
    });
    expect(result.commands).toEqual([]);
    expect(result.issues).toEqual([
      {
        index: 0,
        field: "description",
        message: 'Telegram custom command "/help" is missing a description.',
      },
      {
        index: 1,
        field: "description",
        message: 'Telegram custom command "/ping" is missing a description.',
      },
      {
        index: 2,
        field: "description",
        message: 'Telegram custom command "/pong" is missing a description.',
      },
    ]);
  });

  it("does not treat a later valid copy as a duplicate of a missing-description predecessor", () => {
    const result = resolveTelegramCustomCommands({
      commands: [
        { command: "help", description: "" },
        { command: "help", description: "Show help" },
      ],
    });
    expect(result.commands).toEqual([
      { command: "help", description: "Show help" },
    ]);
    expect(result.issues).toEqual([
      {
        index: 0,
        field: "description",
        message: 'Telegram custom command "/help" is missing a description.',
      },
    ]);
  });

  it("classifies a later missing-description collision as a duplicate, not a description issue", () => {
    const result = resolveTelegramCustomCommands({
      commands: [
        { command: "help", description: "Show help" },
        { command: "help", description: "" },
      ],
    });
    expect(result.commands).toEqual([
      { command: "help", description: "Show help" },
    ]);
    expect(result.issues).toEqual([
      {
        index: 1,
        field: "command",
        message: 'Telegram custom command "/help" is duplicated.',
      },
    ]);
  });

  it("checks reserved names before duplicates", () => {
    const result = resolveTelegramCustomCommands({
      commands: [
        { command: "start", description: "first" },
        { command: "start", description: "second" },
      ],
      reservedCommands: new Set(["start"]),
    });
    expect(result.commands).toEqual([]);
    expect(result.issues).toEqual([
      {
        index: 0,
        field: "command",
        message:
          'Telegram custom command "/start" conflicts with a native command.',
      },
      {
        index: 1,
        field: "command",
        message:
          'Telegram custom command "/start" conflicts with a native command.',
      },
    ]);
  });

  it("collects mixed issues while keeping later valid commands", () => {
    const result = resolveTelegramCustomCommands({
      commands: [
        { command: "ok", description: "first" },
        { command: "bad-name", description: "invalid" },
        { command: "ok", description: "dup" },
        { command: "need_desc", description: "  " },
        { command: "last", description: "kept" },
      ],
    });
    expect(result.commands).toEqual([
      { command: "ok", description: "first" },
      { command: "last", description: "kept" },
    ]);
    expect(result.issues.map((issue) => issue.index)).toEqual([1, 2, 3]);
  });
});
