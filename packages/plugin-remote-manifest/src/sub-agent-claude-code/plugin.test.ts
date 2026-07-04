/**
 * Claude Code plugin tests lock the remote sub-agent descriptor, permissions,
 * and service registration exposed to the plugin loader.
 */
import { describe, expect, it } from "bun:test";
import { plugin } from "./plugin.js";
import { ClaudeCodeSubAgentService } from "./sub-agent-service.js";

describe("plugin remote contract", () => {
  it("declares a remote isolated subprocess sub-agent with narrow host permissions", () => {
    expect(plugin).toMatchObject({
      name: "@elizaos/plugin-sub-agent-claude-code",
      mode: "remote",
      services: [ClaudeCodeSubAgentService],
      remote: {
        role: "sub-agent",
        isolation: "isolated-process",
        worker: { relativePath: "dist/worker.js" },
        lifetime: "session",
        deployment: {
          preferred: "auto",
          allowedTargets: ["host", "cloud"],
          requiresProcess: true,
        },
        subAgent: {
          runner: "claude-code",
          promptInjection: "stdin-only",
        },
      },
    });
    expect(plugin.remote.permissions.host).toEqual({
      services: [],
      models: [],
      events: ["sub-agent.session.created", "sub-agent.session.terminated"],
      memory: "none",
    });
    expect(plugin.remote.permissions.bun).toMatchObject({
      network: "allowlist",
      networkAllowlist: ["api.anthropic.com"],
      fs: "readwrite",
      fsAllowlist: ["."],
      process: true,
    });
    expect(plugin.remote.permissions.bun.env).toEqual([
      "ANTHROPIC_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
    ]);
  });
});
