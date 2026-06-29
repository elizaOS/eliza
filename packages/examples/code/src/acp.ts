/**
 * eliza-code ACP server — lets eliza-code run AS a coding sub-agent that the
 * elizaOS orchestrator (plugin-agent-orchestrator) can spawn over the Agent
 * Client Protocol, exactly like the opencode / codex / claude ACP agents.
 *
 * The orchestrator resolves the `elizaos` agent type to the command in
 * `ELIZA_ELIZAOS_ACP_COMMAND` and spawns it as a long-lived ACP JSON-RPC server
 * on stdio (initialize → session/new → session/prompt → session/cancel). This
 * entrypoint backs those methods onto eliza-code's EXISTING runtime + agent
 * client (the same `initializeAgent()` / `getAgentClient().sendMessage(onDelta)`
 * loop the TUI uses), so a spawned eliza-code sub-agent builds with the same
 * runtime, plugins, and configured model provider (e.g. Cerebras via
 * `@elizaos/plugin-openai`).
 *
 * Recursion guard: the runtime is built WITHOUT `@elizaos/plugin-agent-orchestrator`
 * (`includeOrchestrator: false`) so a sub-agent cannot spawn its own sub-agents.
 *
 * Run directly (the orchestrator does this):
 *   bun packages/examples/code/dist/acp.js
 * or via acpx for an isolated test:
 *   acpx --agent "bun .../dist/acp.js" --cwd <workspace> "<build task>"
 *
 * @module example-code/acp
 */

import { randomUUID } from "node:crypto";
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import type { AgentRuntime } from "@elizaos/core";
import { getAgentClient } from "./lib/agent-client.js";
import { initializeAgent } from "./lib/agent.js";
import {
  ensureSessionIdentity,
  getMainRoomElizaId,
  type SessionIdentity,
} from "./lib/identity.js";
import type { ChatRoom } from "./types.js";

/** A `console.error` logger (stdout is the ACP JSON-RPC channel — never log there). */
function log(message: string, extra?: unknown): void {
  if (extra !== undefined) {
    process.stderr.write(`[eliza-code-acp] ${message} ${JSON.stringify(extra)}\n`);
  } else {
    process.stderr.write(`[eliza-code-acp] ${message}\n`);
  }
}

// Lazily-initialized shared runtime (one per ACP server process).
let runtimePromise: Promise<AgentRuntime> | null = null;
let identity: SessionIdentity | null = null;

async function ensureRuntime(cwd?: string): Promise<AgentRuntime> {
  if (!runtimePromise) {
    // The coding tools + shell sandbox to the workspace via these env vars — set
    // them from the ACP session cwd. We deliberately do NOT process.chdir(): the
    // process must stay in the monorepo so bun resolves the workspace @elizaos/*
    // packages (a different cwd resolves stale/broken builds from the bun cache).
    // The build target is conveyed purely through the workspace-root env.
    if (cwd) {
      process.env.CODING_TOOLS_WORKSPACE_ROOTS ??= cwd;
      process.env.SHELL_ALLOWED_DIRECTORY ??= cwd;
    }
    runtimePromise = (async () => {
      // Resolve the session identity FIRST and mark its user as the runtime OWNER
      // — the coding tools are role-gated (FILE=ADMIN, SHELL=OWNER), so without
      // this the sub-agent runs as GUEST and every tool is denied ("I don't have
      // permission… role (GUEST)"). A spawned coding sub-agent IS the operator in
      // its sandbox, so it gets full rights. Must be set before initializeAgent so
      // the role resolver sees the owner at boot.
      identity = ensureSessionIdentity();
      process.env.ELIZA_ADMIN_ENTITY_ID ??= identity.userId;
      // Headless coding sub-agent: only sql + provider + shell + coding-tools.
      // codingOnly drops mcp/goals AND the orchestrator (recursion guard).
      const runtime = await initializeAgent({ codingOnly: true });
      getAgentClient().setRuntime(runtime);
      log("runtime initialized", { owner: identity.userId });
      return runtime;
    })();
  }
  return runtimePromise;
}

/** Extract plain text from an ACP prompt's content blocks. */
function promptToText(prompt: unknown): string {
  if (!Array.isArray(prompt)) return "";
  const parts: string[] = [];
  for (const block of prompt) {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.join("\n").trim();
}

// Per-session room state.
const sessions = new Map<string, ChatRoom>();

// stdout = the ACP JSON-RPC output; stdin = the input. (ndJsonStream(output, input).)
const output = new WritableStream<Uint8Array>({
  write(chunk) {
    return new Promise<void>((resolve, reject) => {
      process.stdout.write(chunk, (err) => (err ? reject(err) : resolve()));
    });
  },
});
const input = new ReadableStream<Uint8Array>({
  start(controller) {
    process.stdin.on("data", (chunk: Buffer) =>
      controller.enqueue(new Uint8Array(chunk)),
    );
    process.stdin.on("end", () => controller.close());
    process.stdin.on("error", (err) => controller.error(err));
  },
});
const stream = ndJsonStream(output, input);

// biome-ignore lint/correctness/noUnusedVariables: AgentSideConnection wires itself onto the stream.
const _connection = new AgentSideConnection(
  (conn) => ({
    async initialize() {
      return {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: { image: false, audio: false, embeddedContext: true },
        },
        authMethods: [],
      };
    },
    async authenticate() {
      return {};
    },
    async newSession(params: { cwd?: string }) {
      await ensureRuntime(params.cwd);
      const id = randomUUID();
      const session = identity as SessionIdentity;
      const room: ChatRoom = {
        id,
        name: "acp",
        messages: [],
        createdAt: new Date(),
        taskIds: [],
        elizaRoomId: getMainRoomElizaId(session),
      };
      sessions.set(id, room);
      log("session created", { id, cwd: params.cwd });
      return { sessionId: id };
    },
    async prompt(params: { sessionId: string; prompt: unknown }) {
      const room = sessions.get(params.sessionId);
      if (!room || !identity) {
        throw new Error(`[eliza-code-acp] unknown session ${params.sessionId}`);
      }
      const text = promptToText(params.prompt);
      if (!text) return { stopReason: "end_turn" };
      log("prompt", { sessionId: params.sessionId, chars: text.length });
      let streamed = "";
      const response = await getAgentClient().sendMessage({
        room,
        text,
        identity,
        source: "acp",
        onDelta: (delta: string) => {
          streamed += delta;
          void conn
            .sessionUpdate({
              sessionId: params.sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: delta },
              },
            })
            .catch((err) => log("sessionUpdate failed", { err: String(err) }));
        },
      });
      // If nothing streamed via onDelta but sendMessage returned the full reply,
      // emit it as a single chunk so the client/orchestrator sees the result.
      if (!streamed.trim() && response.trim()) {
        await conn
          .sessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: response },
            },
          })
          .catch((err) => log("final sessionUpdate failed", { err: String(err) }));
      }
      log("prompt done", { streamed: streamed.length, response: response.length });
      return { stopReason: "end_turn" };
    },
    async cancel() {
      // Best-effort: the runtime turn isn't externally cancellable here; the next
      // prompt simply starts a new turn. (Hook into runtime abort when available.)
    },
  }),
  stream,
);

log("ACP server listening on stdio");
