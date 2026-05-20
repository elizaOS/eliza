/**
 * @elizaos/plugin-sub-agent-claude-code
 *
 * Reference remote-mode sub-agent plugin. Shipped as a workspace
 * package so the agent's `installRemotePlugin(plugin, { source: {
 * kind: "workspace", pkgName: "@elizaos/plugin-sub-agent-claude-code"
 * } })` can drop it in without writing any worker source on the fly.
 *
 * The agent typically constructs the Plugin object like:
 *
 * ```ts
 * import { plugin } from "@elizaos/plugin-sub-agent-claude-code";
 * await runtime.installRemotePlugin(plugin, {
 *   source: { kind: "workspace", pkgName: "@elizaos/plugin-sub-agent-claude-code" },
 *   lifetime: "session",
 * });
 * await runtime.getService("sub-agent.claude-code").createSession({
 *   cwd: "/path/to/project",
 *   initialPrompt: "list files in src/",
 * });
 * ```
 *
 * The plugin opts into `role: "sub-agent"` and `isolation: "isolated-process"`
 * so the host's AdaptiveWorkerRunner spawns it via Bun.spawn rather than as
 * a Worker. That guarantees a crash in the Claude Code CLI doesn't bring
 * down the agent process.
 */

import { ClaudeCodeSubAgentService } from "./sub-agent-service.ts";

// We intentionally use loose typing for the Plugin shape rather than
// pulling in @elizaos/core (which would force a heavyweight dep tree
// onto every sub-agent runner). The runtime materialises this through
// the worker-runtime descriptor builder, which validates structurally.
export const plugin = {
	name: "@elizaos/plugin-sub-agent-claude-code",
	description:
		"Drives the Claude Code CLI as a sub-agent inside an isolated subprocess.",
	mode: "remote" as const,
	services: [ClaudeCodeSubAgentService],
	remote: {
		role: "sub-agent" as const,
		permissions: {
			bun: {
				network: "allowlist" as const,
				networkAllowlist: ["api.anthropic.com"],
				fs: "readwrite" as const,
				fsAllowlist: ["."],
				process: true,
				env: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
			},
			host: {
				services: [],
				models: [],
				events: ["sub-agent.session.created", "sub-agent.session.terminated"],
				memory: "none" as const,
			},
		},
		isolation: "isolated-process" as const,
		worker: { relativePath: "dist/worker.js" },
		deployment: {
			preferred: "auto" as const,
			allowedTargets: ["host", "cloud"] as ("host" | "cloud")[],
			requiresProcess: true,
		},
		lifetime: "session" as const,
		subAgent: {
			runner: "claude-code" as const,
			promptInjection: "stdin-only" as const,
		},
	},
};

export default plugin;
