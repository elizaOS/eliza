/**
 * Tests for workspace boilerplate detection.
 */

import { describe, expect, it } from "vitest";
import { isDefaultBoilerplate } from "./workspace";

describe("isDefaultBoilerplate", () => {
  it("returns true for exact default AGENTS.md content", () => {
    const content = `# Agents

You are an autonomous AI agent powered by ElizaOS.

## Capabilities

- Respond to user messages conversationally
- Execute actions and use available tools
- Access and manage knowledge from your workspace
- Maintain context across conversations

## Guidelines

- Be helpful, concise, and accurate
- Ask for clarification when instructions are ambiguous
- Use tools when they would help accomplish the user's goal
- Respect the user's preferences and communication style
`;
    expect(isDefaultBoilerplate("AGENTS.md", content)).toBe(true);
  });

  it("returns true when content has extra whitespace around it", () => {
    const content = `
  # Agents

You are an autonomous AI agent powered by ElizaOS.

## Capabilities

- Respond to user messages conversationally
- Execute actions and use available tools
- Access and manage knowledge from your workspace
- Maintain context across conversations

## Guidelines

- Be helpful, concise, and accurate
- Ask for clarification when instructions are ambiguous
- Use tools when they would help accomplish the user's goal
- Respect the user's preferences and communication style
  `;
    expect(isDefaultBoilerplate("AGENTS.md", content)).toBe(true);
  });

  it("returns false for customized content", () => {
    const content = `# Agents

You are Mima, a cozy companion agent.

## Guidelines

- Be warm and supportive
`;
    expect(isDefaultBoilerplate("AGENTS.md", content)).toBe(false);
  });

  it("returns false for unknown file names", () => {
    expect(
      isDefaultBoilerplate(
        "CUSTOM.md" as Parameters<typeof isDefaultBoilerplate>[0],
        "anything",
      ),
    ).toBe(false);
  });

  it("returns true for default TOOLS.md content", () => {
    const content = `# Tools

Available tools and capabilities for the agent.

## Built-in Tools

The agent has access to tools provided by enabled plugins.
Each plugin may register actions, providers, and evaluators
that extend the agent's capabilities.

## Usage

Tools are invoked automatically when the agent determines
they would help accomplish the user's goal. No manual
configuration is required.
`;
    expect(isDefaultBoilerplate("TOOLS.md", content)).toBe(true);
  });
});
