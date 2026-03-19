/**
 * Tests for workspace-provider buildContext — verifies boilerplate filtering.
 */

import { describe, expect, it } from "vitest";
import type { WorkspaceBootstrapFile } from "./workspace";
import { buildContext } from "./workspace-provider";

const DEFAULT_AGENTS_CONTENT = `# Agents

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

const CUSTOM_AGENTS_CONTENT = `# Agents

You are Mima, a cozy companion agent powered by ElizaOS.

## Capabilities

- Provide emotional support and companionship
- Play emotes and animations
`;

describe("buildContext", () => {
  it("skips default boilerplate files", () => {
    const files: WorkspaceBootstrapFile[] = [
      {
        name: "AGENTS.md",
        path: "/workspace/AGENTS.md",
        content: DEFAULT_AGENTS_CONTENT,
        missing: false,
      },
    ];
    const result = buildContext(files, 20_000);
    expect(result).toBe("");
  });

  it("includes customized files", () => {
    const files: WorkspaceBootstrapFile[] = [
      {
        name: "AGENTS.md",
        path: "/workspace/AGENTS.md",
        content: CUSTOM_AGENTS_CONTENT,
        missing: false,
      },
    ];
    const result = buildContext(files, 20_000);
    expect(result).toContain("AGENTS.md");
    expect(result).toContain("Mima");
  });

  it("skips missing files", () => {
    const files: WorkspaceBootstrapFile[] = [
      {
        name: "AGENTS.md",
        path: "/workspace/AGENTS.md",
        missing: true,
      },
    ];
    const result = buildContext(files, 20_000);
    expect(result).toBe("");
  });

  it("skips empty files", () => {
    const files: WorkspaceBootstrapFile[] = [
      {
        name: "AGENTS.md",
        path: "/workspace/AGENTS.md",
        content: "   \n  ",
        missing: false,
      },
    ];
    const result = buildContext(files, 20_000);
    expect(result).toBe("");
  });

  it("includes mix of custom and default files, only custom appears", () => {
    const files: WorkspaceBootstrapFile[] = [
      {
        name: "AGENTS.md",
        path: "/workspace/AGENTS.md",
        content: DEFAULT_AGENTS_CONTENT,
        missing: false,
      },
      {
        name: "IDENTITY.md",
        path: "/workspace/IDENTITY.md",
        content: "# Identity\n\nI am Mima, a warm companion.",
        missing: false,
      },
    ];
    const result = buildContext(files, 20_000);
    expect(result).not.toContain("AGENTS.md");
    expect(result).toContain("IDENTITY.md");
    expect(result).toContain("Mima");
  });
});
