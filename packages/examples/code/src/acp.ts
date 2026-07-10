#!/usr/bin/env node
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
import {
  SandboxService,
  SessionCwdService,
} from "@elizaos/plugin-coding-tools";
import { publishParsedReply } from "./acp-response.js";
import { initializeAgent } from "./lib/agent.js";
import { getAgentClient } from "./lib/agent-client.js";
import {
  ensureSessionIdentity,
  getMainRoomElizaId,
  type SessionIdentity,
} from "./lib/identity.js";
import { applyOpencodeProviderEnv } from "./lib/model-provider.js";
import type { ChatRoom } from "./types.js";

/** A `console.error` logger (stdout is the ACP JSON-RPC channel — never log there). */
function log(message: string, extra?: unknown): void {
  if (extra !== undefined) {
    process.stderr.write(
      `[eliza-code-acp] ${message} ${JSON.stringify(extra)}\n`,
    );
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
      // The sub-agent's own task workspace is always reachable. ALSO grant
      // access to the published-apps directory (when the host configured one)
      // so the agent can read/edit/republish an EXISTING deployed app — not just
      // build new ones into a throwaway workspace. Without this, "edit the
      // coinflip app" lands in an empty workspace, the app dir is sandbox-blocked,
      // and nothing happens. Roots are comma-separated; the agent picks the path
      // (its workspace for scripts, the apps dir for web apps) by the task.
      const appsDir = process.env.ELIZA_APP_DEPLOY_CUSTOM_APPS_DIR?.trim();
      const roots = appsDir && appsDir !== cwd ? `${cwd},${appsDir}` : cwd;
      process.env.CODING_TOOLS_WORKSPACE_ROOTS ??= roots;
      process.env.SHELL_ALLOWED_DIRECTORY ??= roots;
    }
    // Drop-in for the opencode coding sub-agent: when the host configured
    // opencode (ELIZA_OPENCODE_* — e.g. a Cerebras key/url/models) but no
    // explicit OPENAI_*, inherit that provider config so eliza-code runs on the
    // same backend with zero extra setup. The orchestrator forwards the parent
    // env to this spawned process.
    applyOpencodeProviderEnv(process.env);
    // Isolated, ephemeral database for this coding sub-agent. PGlite is
    // single-process: the parent bot (and any other concurrently-spawned
    // eliza-code sub-agent) holds the PGlite dir under ELIZA_STATE_DIR, so a
    // spawned eliza-code that inherits the same dir crashes on init with
    // "this.adapter is undefined" → the orchestrator reports state_lost and the
    // respawn fails (observed live: intermittent app-build failures under
    // concurrent/overlapping requests). A coding agent works on the filesystem,
    // not the DB, so force an in-memory DB and don't inherit the parent's
    // Postgres/PGlite connection. (Force-set: this must win over inherited env.)
    process.env.PGLITE_DATA_DIR = ":memory:";
    process.env.DATABASE_URL = "";
    process.env.POSTGRES_URL = "";
    runtimePromise = (async () => {
      // Resolve the session identity FIRST and mark its user as the runtime OWNER
      // — the coding tools are role-gated (FILE=ADMIN, SHELL=OWNER), so without
      // this the sub-agent runs as GUEST and every tool is denied ("I don't have
      // permission… role (GUEST)"). A spawned coding sub-agent IS the operator in
      // its sandbox, so it gets full rights. Must be set before initializeAgent so
      // the role resolver sees the owner at boot.
      identity = ensureSessionIdentity();
      process.env.ELIZA_ADMIN_ENTITY_ID ??= identity.userId;
      // A coding sub-agent has a small, all-relevant tool set (FILE/SHELL/READ/
      // EDIT/…); expose them ALL as native tools (full surface, no chat-style
      // tiering) so the model can actually CALL them instead of only seeing them
      // described in the prompt and narrating.
      process.env.ELIZA_PLANNER_FULL_ACTION_SURFACE ??= "1";
      // Headless coding sub-agent: only sql + provider + shell + coding-tools.
      // codingOnly drops mcp/goals AND the orchestrator (recursion guard).
      const runtime = await initializeAgent({ codingOnly: true });
      // Mark the session user as OWNER via the RUNTIME SETTING the role resolver
      // actually reads (getConfiguredOwnerEntityIds → runtime.getSetting), not just
      // process.env — otherwise the sender stays GUEST and FILE/SHELL are gated off.
      const rt = runtime as unknown as {
        setSetting?: (k: string, v: unknown) => void;
      };
      rt.setSetting?.("ELIZA_ADMIN_ENTITY_ID", identity.userId);
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

// Per-session state: the chat room, the workspace cwd, and whether the
// orchestrator's scaffolded operating manual has been injected yet.
interface AcpSession {
  room: ChatRoom;
  cwd?: string;
  manualInjected: boolean;
}
const sessions = new Map<string, AcpSession>();

/**
 * Read the operating manual the orchestrator scaffolds into a spawned sub-agent's
 * workspace (`AGENTS.md` / `CLAUDE.md` — "what Eliza is, you are a non-interactive
 * coding sub-agent, the relay contract"). claude/codex/opencode auto-read these
 * from their cwd; eliza-code runs from the monorepo for dep resolution, so it must
 * read them explicitly from the build workspace and inject them so the sub-agent
 * gets the same orientation as the other backends.
 */
async function readWorkspaceManual(cwd?: string): Promise<string> {
  if (!cwd) return "";
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    try {
      const text = await readFile(join(cwd, name), "utf8");
      if (text.trim()) return text.trim();
    } catch (error) {
      // error-policy:J4 A missing optional manual is an expected unavailable
      // state; read and permission failures must still stop session setup.
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
    }
  }
  return "";
}

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

const _connection = new AgentSideConnection(
  (conn) => ({
    async initialize() {
      return {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: {
            image: false,
            audio: false,
            embeddedContext: true,
          },
        },
        authMethods: [],
      };
    },
    async authenticate() {
      return {};
    },
    async newSession(params: { cwd?: string }) {
      const runtime = await ensureRuntime(params.cwd);
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
      sessions.set(id, { room, cwd: params.cwd, manualInjected: false });
      // Point the coding tools' per-conversation working directory at the ACP
      // workspace. We can't process.chdir() (it would break bun's workspace
      // @elizaos/* resolution, so the process stays in the monorepo), and
      // SessionCwdService otherwise defaults the conversation cwd to
      // process.cwd() — the monorepo — making `pwd`, relative-path resolution,
      // and the sandbox roots all point at the wrong directory. Set it
      // explicitly to the build workspace so FILE/SHELL/LS operate there.
      // conversationId == message.roomId == room.elizaRoomId (see agent-client).
      if (params.cwd) {
        const conversationId = String(room.elizaRoomId);
        const cwdSvc = runtime.getService<SessionCwdService>(
          SessionCwdService.serviceType,
        );
        cwdSvc?.setCwd(conversationId, params.cwd);
        const sandbox = runtime.getService<SandboxService>(
          SandboxService.serviceType,
        );
        sandbox?.addRoot(conversationId, params.cwd);
      }
      log("session created", { id, cwd: params.cwd });
      return { sessionId: id };
    },
    async prompt(params: { sessionId: string; prompt: unknown }) {
      const session = sessions.get(params.sessionId);
      if (!session || !identity) {
        throw new Error(`[eliza-code-acp] unknown session ${params.sessionId}`);
      }
      const { room } = session;
      let text = promptToText(params.prompt);
      if (!text) return { stopReason: "end_turn" };
      // Inject the orchestrator's scaffolded operating manual on the first prompt
      // of the session so eliza-code gets the same "you are a non-interactive Eliza
      // coding sub-agent + relay contract" orientation as claude/codex/opencode.
      if (!session.manualInjected) {
        session.manualInjected = true;
        const preamble: string[] = [];
        const manual = await readWorkspaceManual(session.cwd);
        if (manual) preamble.push(manual);
        // Execution contract: weaker coding models (e.g. Cerebras glm-4.7) tend
        // to NARRATE a plan ("I'll create the app...") and end the turn instead
        // of emitting the FILE/SHELL action, especially on larger tasks — which
        // leaves nothing on disk. Make the act-don't-describe requirement
        // explicit so a build actually happens before the agent reports done.
        preamble.push(
          "Execution contract: DO the work by calling tools — use the FILE " +
            "action to actually write/edit each file and the SHELL action to run " +
            "commands. Do NOT reply with a description of what you are about to " +
            'do; a turn that only says "I\'ll create..." or "Creating the app ' +
            'now" without an accompanying FILE/SHELL tool call is a failure. For ' +
            "a multi-file or large build, write the full content of each file " +
            "with a FILE action first, then verify, and only then report what you " +
            "did. Never claim a file exists unless you wrote it this session.",
        );
        if (session.cwd) {
          // The coding tools (FILE/EDIT) require ABSOLUTE paths. Tell the agent
          // its workspace root up front so it writes absolute paths directly
          // instead of emitting a relative path, having it rejected, and
          // round-tripping through `pwd` to rediscover the directory.
          preamble.push(
            `Your workspace directory is: ${session.cwd}\n` +
              `All file paths MUST be absolute — create and edit files under ` +
              `this directory (e.g. ${session.cwd}/<filename>) and run shell ` +
              `commands from here.`,
          );
        }
        if (preamble.length > 0) {
          text = `${preamble.join("\n\n---\n\n")}\n\n---\n\nTask:\n${text}`;
          log("injected workspace preamble", {
            manual: manual.length,
            cwd: session.cwd ?? null,
          });
        }
      }
      log("prompt", { sessionId: params.sessionId, chars: text.length });
      // Do NOT forward raw stream deltas as agent_message_chunk. The inner
      // runtime's stream is the model's RAW output — for a structured planner
      // (response-grammar JSON/XML) that is the unparsed envelope, and the
      // orchestrator concatenates chunks into the session's captured finalText,
      // which the parent then relays to the user verbatim. Streaming raw here
      // is how a Discord user ends up seeing ```json {"response":...} instead
      // of the answer. The parsed user-facing reply only exists once the turn
      // completes, so emit exactly one authoritative chunk with it.
      const response = await getAgentClient().sendMessage({
        room,
        text,
        identity,
        source: "acp",
      });
      await publishParsedReply(params.sessionId, response, (update) =>
        conn.sessionUpdate(update),
      );
      log("prompt done", { response: response.length });
      return { stopReason: "end_turn" };
    },
    async cancel() {
      // Best-effort: the runtime turn isn't externally cancellable here; the next
      // prompt simply starts a new turn. (Hook into runtime abort when available.)
    },
    // The elizaOS orchestrator's native ACP transport sends `session/close` on
    // teardown. It IS a standard ACP method (schema.AGENT_METHODS.session_close),
    // so the SDK only routes it when the agent implements `closeSession`;
    // otherwise it returns JSON-RPC "Method not found" (-32601), which the
    // orchestrator surfaces to the user as a failed task ("Couldn't finish —
    // Method not found: session/close"). Drop the session entry and ack.
    async closeSession(params: { sessionId?: string }) {
      const sessionId = params?.sessionId;
      if (sessionId) sessions.delete(sessionId);
      log("session closed", { sessionId });
      return {};
    },
  }),
  stream,
);

log("ACP server listening on stdio");
