/**
 * Edge coverage for command parser helpers: nullish inputs and boundary forms.
 */
import { describe, expect, it } from "vitest";
import {
  detectCommand,
  hasCommand,
  parseCommand,
  stripLeadingBotMention,
} from "../src/parser";
import type { CommandDefinition } from "../src/types";

function define(overrides: Partial<CommandDefinition> & Pick<CommandDefinition, "key" | "textAliases">): CommandDefinition {
  return { description: "test", scope: "both", ...overrides };
}

describe("stripLeadingBotMention edge", () => {
  it("leaves empty string untouched", () => {
    expect(stripLeadingBotMention("")).toBe("");
  });

  it("handles text with only whitespace before mention", () => {
    expect(stripLeadingBotMention("  <@123> /cmd")).toBe("  <@123> /cmd");
  });

  it("handles mention with no trailing space", () => {
    expect(stripLeadingBotMention("<@123>/cmd")).toBe("/cmd");
  });
});

describe("hasCommand nullish edge", () => {
  it("returns false for empty, nullish, and whitespace-only inputs", () => {
    expect(hasCommand("")).toBe(false);
    expect(hasCommand(null as unknown as string)).toBe(false);
    expect(hasCommand(undefined as unknown as string)).toBe(false);
    expect(hasCommand("   ")).toBe(false);
  });

  it("returns false for text without slash or bang prefix", () => {
    expect(hasCommand("hello world")).toBe(false);
    expect(hasCommand("model show")).toBe(false);
  });

  it("handles bang prefix without throwing", () => {
    expect(() => hasCommand("!help")).not.toThrow();
    expect(typeof hasCommand("!help")).toBe("boolean");
  });
});

describe("detectCommand nullish edge", () => {
  it("returns not a command for empty and nullish", () => {
    expect(detectCommand("").isCommand).toBe(false);
    expect(detectCommand(null as unknown as string).isCommand).toBe(false);
    expect(detectCommand(undefined as unknown as string).isCommand).toBe(false);
  });

  it("returns not a command for unknown slash command", () => {
    expect(detectCommand("/unknowncommand123").isCommand).toBe(false);
  });
});

describe("parseCommand edge", () => {
  it("returns null for non-matching alias", () => {
    const def = define({ key: "mykey", textAliases: ["/mykey"] });
    expect(parseCommand("/other", def)).toBeNull();
  });

  it("matches case-insensitively and trims", () => {
    const def = define({ key: "mykey", textAliases: ["/mykey"] });
    expect(parseCommand("  /MYKEY  ", def)).not.toBeNull();
    expect(parseCommand("  /MYKEY  ", def)?.key).toBe("mykey");
  });

  it("handles colon separator", () => {
    const def = define({ key: "think", textAliases: ["/think"] });
    const parsed = parseCommand("/think:high", def);
    expect(parsed).not.toBeNull();
    expect(parsed?.rawArgs).toBe("high");
  });
});
