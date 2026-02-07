import { describe, expect, it, beforeEach } from "bun:test";
import {
  detectCommand,
  hasCommand,
  normalizeCommandBody,
  parseCommand,
} from "../src/parser";
import {
  findCommandByAlias,
  findCommandByKey,
  getCommands,
  getCommandsByCategory,
  getEnabledCommands,
  registerCommand,
  resetCommands,
  startsWithCommand,
  unregisterCommand,
} from "../src/registry";
import type { CommandDefinition } from "../src/types";

describe("Command Parser", () => {
  describe("hasCommand", () => {
    it("detects / prefix commands", () => {
      expect(hasCommand("/help")).toBe(true);
      expect(hasCommand("/status")).toBe(true);
      expect(hasCommand("/think:high")).toBe(true);
    });

    it("detects ! prefix for bash", () => {
      expect(hasCommand("!ls")).toBe(false); // Not registered by default
    });

    it("returns false for plain text", () => {
      expect(hasCommand("hello world")).toBe(false);
      expect(hasCommand("")).toBe(false);
    });

    it("returns false for unknown commands", () => {
      expect(hasCommand("/unknown123")).toBe(false);
    });
  });

  describe("detectCommand", () => {
    it("detects and parses help command", () => {
      const result = detectCommand("/help");
      expect(result.isCommand).toBe(true);
      expect(result.command?.key).toBe("help");
      expect(result.command?.args).toEqual([]);
    });

    it("detects command with colon args", () => {
      const result = detectCommand("/think:high");
      expect(result.isCommand).toBe(true);
      expect(result.command?.key).toBe("think");
      expect(result.command?.args[0]).toBe("high");
    });

    it("detects command with space args", () => {
      const result = detectCommand("/verbose on");
      expect(result.isCommand).toBe(true);
      expect(result.command?.key).toBe("verbose");
      expect(result.command?.args[0]).toBe("on");
    });

    it("detects short aliases", () => {
      const result = detectCommand("/h");
      expect(result.isCommand).toBe(true);
      expect(result.command?.key).toBe("help");
    });

    it("returns isCommand false for non-commands", () => {
      expect(detectCommand("hello").isCommand).toBe(false);
      expect(detectCommand("").isCommand).toBe(false);
    });
  });

  describe("normalizeCommandBody", () => {
    it("handles colon separator", () => {
      expect(normalizeCommandBody("/status: test")).toBe("/status test");
    });

    it("removes bot mention prefix", () => {
      expect(normalizeCommandBody("@mybot /help", "mybot")).toBe("/help");
    });

    it("trims whitespace", () => {
      expect(normalizeCommandBody("  /help  ")).toBe("/help");
    });

    it("preserves command if no normalization needed", () => {
      expect(normalizeCommandBody("/help")).toBe("/help");
    });
  });
});

describe("Command Registry", () => {
  beforeEach(() => {
    resetCommands();
  });

  describe("getCommands", () => {
    it("returns all commands", () => {
      const commands = getCommands();
      expect(commands.length).toBeGreaterThan(0);
    });

    it("includes expected default commands", () => {
      const commands = getCommands();
      const keys = commands.map((c) => c.key);
      expect(keys).toContain("help");
      expect(keys).toContain("status");
      expect(keys).toContain("stop");
    });
  });

  describe("getEnabledCommands", () => {
    it("excludes disabled commands", () => {
      const allCommands = getCommands();
      const enabledCommands = getEnabledCommands();

      const disabledCount = allCommands.filter((c) => c.enabled === false).length;
      expect(enabledCommands.length).toBe(allCommands.length - disabledCount);
    });
  });

  describe("getCommandsByCategory", () => {
    it("returns commands in category", () => {
      const statusCommands = getCommandsByCategory("status");
      expect(statusCommands.length).toBeGreaterThan(0);
      expect(statusCommands.every((c) => c.category === "status")).toBe(true);
    });

    it("returns empty array for unknown category", () => {
      const commands = getCommandsByCategory("nonexistent");
      expect(commands).toEqual([]);
    });
  });

  describe("findCommandByAlias", () => {
    it("finds command by primary alias", () => {
      const cmd = findCommandByAlias("/help");
      expect(cmd?.key).toBe("help");
    });

    it("finds command by secondary alias", () => {
      const cmd = findCommandByAlias("/h");
      expect(cmd?.key).toBe("help");
    });

    it("is case-insensitive", () => {
      const cmd = findCommandByAlias("/HELP");
      expect(cmd?.key).toBe("help");
    });

    it("returns undefined for unknown alias", () => {
      const cmd = findCommandByAlias("/unknown123");
      expect(cmd).toBeUndefined();
    });
  });

  describe("findCommandByKey", () => {
    it("finds command by key", () => {
      const cmd = findCommandByKey("help");
      expect(cmd?.key).toBe("help");
    });

    it("returns undefined for unknown key", () => {
      const cmd = findCommandByKey("unknown123");
      expect(cmd).toBeUndefined();
    });
  });

  describe("registerCommand", () => {
    it("registers a new command", () => {
      const customCmd: CommandDefinition = {
        key: "custom-test",
        description: "Custom test command",
        textAliases: ["/custom-test", "/ct"],
        scope: "text",
      };

      registerCommand(customCmd);

      const found = findCommandByKey("custom-test");
      expect(found).not.toBeUndefined();
      expect(found?.description).toBe("Custom test command");
    });

    it("replaces existing command with same key", () => {
      const cmd1: CommandDefinition = {
        key: "replace-test",
        description: "First version",
        textAliases: ["/replace-test"],
        scope: "text",
      };

      const cmd2: CommandDefinition = {
        key: "replace-test",
        description: "Second version",
        textAliases: ["/replace-test"],
        scope: "text",
      };

      registerCommand(cmd1);
      registerCommand(cmd2);

      const found = findCommandByKey("replace-test");
      expect(found?.description).toBe("Second version");
    });
  });

  describe("unregisterCommand", () => {
    it("removes a command", () => {
      const customCmd: CommandDefinition = {
        key: "unregister-test",
        description: "Will be unregistered",
        textAliases: ["/unregister-test"],
        scope: "text",
      };

      registerCommand(customCmd);
      expect(findCommandByKey("unregister-test")).not.toBeUndefined();

      unregisterCommand("unregister-test");
      expect(findCommandByKey("unregister-test")).toBeUndefined();
    });

    it("does nothing for unknown key", () => {
      const countBefore = getCommands().length;
      unregisterCommand("nonexistent");
      const countAfter = getCommands().length;
      expect(countAfter).toBe(countBefore);
    });
  });

  describe("startsWithCommand", () => {
    it("finds command at start of text", () => {
      const cmd = startsWithCommand("/help me please");
      expect(cmd?.key).toBe("help");
    });

    it("finds exact command match", () => {
      const cmd = startsWithCommand("/help");
      expect(cmd?.key).toBe("help");
    });

    it("handles colon separator", () => {
      const cmd = startsWithCommand("/think:high what");
      expect(cmd?.key).toBe("think");
    });

    it("returns undefined for non-command", () => {
      const cmd = startsWithCommand("hello world");
      expect(cmd).toBeUndefined();
    });
  });
});

describe("Command Properties", () => {
  it("all commands have required properties", () => {
    const commands = getCommands();
    for (const cmd of commands) {
      expect(cmd.key).toBeTruthy();
      expect(cmd.description).toBeTruthy();
      expect(cmd.textAliases.length).toBeGreaterThan(0);
      expect(["text", "native", "both"]).toContain(cmd.scope);
    }
  });

  it("all text aliases start with /", () => {
    const commands = getCommands();
    for (const cmd of commands) {
      for (const alias of cmd.textAliases) {
        if (!alias.startsWith("/") && !alias.startsWith("!")) {
          throw new Error(`Alias '${alias}' for command '${cmd.key}' should start with / or !`);
        }
      }
    }
  });

  it("command keys are unique", () => {
    const commands = getCommands();
    const keys = commands.map((c) => c.key);
    const uniqueKeys = new Set(keys);
    expect(uniqueKeys.size).toBe(keys.length);
  });
});
