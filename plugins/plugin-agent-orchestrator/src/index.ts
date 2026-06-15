/**
 * Agent Orchestrator Plugin for Eliza
 *
 * Canonical orchestration plugin: combines the ACP-based subprocess spawn
 * surface (acpx) with workspace lifecycle, GitHub integration, task share,
 * task history, runtime-driven sub-agent routing, and supporting services.
 *
 * @module @elizaos/plugin-agent-orchestrator
 */

import type {
  IAgentRuntime,
  Memory,
  Plugin,
  ServiceClass,
  TargetInfo,
  ThreadHandle,
} from "@elizaos/core";
import {
  createUniqueUuid,
  EventType,
  isLocalCodeExecutionAllowed,
  ModelType,
  promoteSubactionsToActions,
} from "@elizaos/core";

// Register coding-agent HTTP routes with the runtime route registry.
// Re-exporting the registration sentinel (rather than a side-effect-only
// `import "./register-routes.js"`) keeps Bun.build's node-target
// tree-shaker from dropping the module — a public re-export is a
// value-flow edge no bundler can prune, and the registration runs as a
// side-effect of evaluating that module. Without this the entire
// `/api/coding-agents/*` surface 404s on the node bundle.
export { codingAgentRouteRegistration } from "./register-routes.js";

import {
  createTerminalUnsupportedTasksAction,
  tasksSandboxStubAction,
} from "./actions/sandbox-stub.js";
import { tasksAction } from "./actions/tasks.js";
import { subAgentCompletionResponseEvaluator } from "./evaluators/sub-agent-completion.js";
import { codingAgentExamplesProvider } from "./providers/action-examples.js";
import { activeSubAgentsProvider } from "./providers/active-sub-agents.js";
import { activeWorkspaceContextProvider } from "./providers/active-workspace-context.js";
import { availableAgentsProvider } from "./providers/available-agents.js";
import { codingSessionChangesProvider } from "./providers/coding-session-changes.js";
import { AcpService } from "./services/acp-service.js";
import {
  appendAuditLine,
  defaultAuditLogPath,
  TASK_AUDIT_EVENT,
  type TaskAuditPayload,
} from "./services/audit.js";
import { OrchestratorTaskService } from "./services/orchestrator-task-service.js";
import { SubAgentRouter } from "./services/sub-agent-router.js";
import { requireTaskAgentAccess } from "./services/task-policy.js";
import { detectOrchestratorTerminalSupport } from "./services/terminal-capabilities.js";
import {
  type AcpToolCall,
  type SessionInfo,
  TERMINAL_SESSION_STATUSES,
} from "./services/types.js";
import { CodingWorkspaceService } from "./services/workspace-service.js";

// Skip forwarding our own posts back into `acp.sendPrompt` — would echo-loop.
// `entityId === runtime.agentId` is not enough: the router uses a synthetic
// sub-agent UUID, so we also filter by Content.source.
const INTERNAL_FORWARD_SKIP_SOURCES = new Set([
  "sub_agent",
  "sub_agent_progress",
  "sub_agent_complete",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null && (typeof value === "object" || typeof value === "function")
  );
}

function assertServiceClass(service: unknown): asserts service is ServiceClass {
  if (
    !isRecord(service) ||
    typeof service.serviceType !== "string" ||
    typeof service.start !== "function"
  ) {
    throw new TypeError("Invalid orchestrator service class");
  }
}

function serviceClass(service: unknown): ServiceClass {
  assertServiceClass(service);
  return service;
}

export function createAgentOrchestratorPlugin(): Plugin {
  const terminalSupport = detectOrchestratorTerminalSupport();
  const localCodeAllowed = isLocalCodeExecutionAllowed();
  const codeExecutionAllowed = localCodeAllowed && terminalSupport.supported;

  // Store-distributed builds cannot fork user-installed CLIs. Drop the host-CLI
  // services and the spawn-bearing actions; expose a single user-facing
  // unavailable action so reaches for SPAWN_AGENT / CREATE_TASK / etc. surface a
  // clean error instead of attempting (and failing) to spawn.
  const orchestratorServices: ServiceClass[] = codeExecutionAllowed
    ? [
        serviceClass(AcpService),
        serviceClass(OrchestratorTaskService),
        serviceClass(SubAgentRouter),
        serviceClass(CodingWorkspaceService),
      ]
    : [];

  const orchestratorActions = codeExecutionAllowed
    ? [
        ...promoteSubactionsToActions(tasksAction, {
          // Override the auto-generated description for `spawn_agent` so
          // the planner reliably picks it over inline tools (e.g.
          // `FILE.write`) when the user explicitly asks to delegate.
          //
          // Why this override matters: without it, the virtual
          // `TASKS_SPAWN_AGENT` action inherits a generic blurb derived
          // from the parent's enum description, which says "Task
          // operation: ..." — that doesn't signal "this is the
          // delegation path". When FILE was promoted to tier-A on
          // develop, the planner started preferring `FILE.write` for
          // any prompt that mentioned writing files, even when the user
          // said "spawn a sub-agent". The explicit description below
          // anchors `TASKS_SPAWN_AGENT` as the canonical sub-agent
          // delegation surface.
          overrides: {
            spawn_agent: {
              description:
                "Delegate a coding task to a dedicated ACP coding sub-agent (claude / codex / opencode — selected from configured providers). USE THIS when the user explicitly asks to delegate coding work, use a coding adapter by name, or run substantial multi-step coding work that benefits from a dedicated workspace and its own tool loop. The coding sub-agent runs in its own workspace, can read / write / edit files and run tests, and reports back when done. Prefer this over inline FILE / BASH tools whenever delegation is the user's intent — even for single-file tasks if delegation is explicitly requested. IMPORTANT: if `# Active sub-agent sessions` shows a live sub-agent already working on the SAME workdir (or the same logical area of the same workdir), prefer `TASKS_SEND_TO_AGENT` to continue that session instead of spawning a parallel agent in the same workspace. Parallel agents in one workdir race on files and waste tokens — only spawn when the existing session is on a different workdir, is terminal (stopped/errored), or the new task is unrelated to the in-flight work.",
              // Compressed blurb is what the planner sees in tier-A
              // summaries; if we don't override it, it inherits the
              // generic parent enum dump and the planner can't tell
              // `TASKS_SPAWN_AGENT` apart from inline `FILE.write` for
              // delegation requests. See the parent comment above.
              descriptionCompressed:
                "delegate ACP coding sub-agent claude|codex|opencode; multi-step; prefer TASKS_SEND if active session exists on same workdir",
            },
          },
        }),
      ]
    : [
        localCodeAllowed
          ? createTerminalUnsupportedTasksAction(terminalSupport)
          : tasksSandboxStubAction,
      ];

  const orchestratorProviders = codeExecutionAllowed
    ? [
        availableAgentsProvider, // Adapter inventory + raw session list
        activeSubAgentsProvider, // Cache-stable view of routed sub-agent sessions
        activeWorkspaceContextProvider, // Live workspace/session state
        codingAgentExamplesProvider, // Structured action call examples
        codingSessionChangesProvider, // Real git change set for "show me the diff"
      ]
    : [];

  // Captured so dispose() can unregister on hot-reload (otherwise listeners
  // stack and fan out to N orphaned closures per reload).
  let taskAuditHandler:
    | ((
        payload: TaskAuditPayload & { runtime: IAgentRuntime },
      ) => Promise<void>)
    | undefined;
  let disposeProgressHook: (() => void) | undefined;
  let activeSessionForwardHandler:
    | ((payload: { message: Memory }) => Promise<void>)
    | undefined;

  return {
    name: "@elizaos/plugin-agent-orchestrator",
    description: codeExecutionAllowed
      ? "Orchestrate coding sub-agents via the Agent Client Protocol (acpx) with workspace operations, GitHub integration, task history, sub-agent routing, and skill-recommender support. Single TASKS parent action covers create / spawn_agent / send / stop_agent / list_agents / cancel / history / control / share / provision_workspace / submit_workspace / manage_issues / archive / reopen."
      : (terminalSupport.message ??
        "Coding-agent orchestrator is unavailable in this runtime. Exposes a single TASKS action that explains the limitation when the planner reaches for a coding-agent action."),
    widgets: [
      {
        id: "agent-orchestrator.apps",
        pluginId: "agent-orchestrator",
        slot: "chat-sidebar",
        label: "App Runs",
        icon: "Activity",
        order: 150,
        defaultEnabled: true,
      },
      {
        id: "agent-orchestrator.activity",
        pluginId: "agent-orchestrator",
        slot: "chat-sidebar",
        label: "Activity",
        icon: "Activity",
        order: 300,
        defaultEnabled: true,
      },
    ],
    // Services manage ACPX subprocesses, workspaces, and sub-agent routing.
    services: orchestratorServices,
    actions: orchestratorActions,
    providers: orchestratorProviders,
    responseHandlerEvaluators: codeExecutionAllowed
      ? [subAgentCompletionResponseEvaluator]
      : [],
    // Eager-start the orchestrator's services. They're declared in `services:`
    // above and registered by elizaOS, but service registration is lazy — the
    // instance is only constructed on first `getServiceLoadPromise()`. Sync
    // `getService()` calls (which is what `tasksAction.validate` and the TASKS
    // handlers use to find the ACP service) silently return null until then,
    // making the very first TASKS call fail. Force-load on plugin init so
    // `runtime.services` is populated before any message handling runs.
    async init(_config: Record<string, string>, runtime: IAgentRuntime) {
      if (!codeExecutionAllowed) return;
      const auditLogSetting = runtime.getSetting?.("ACP_AUDIT_LOG_PATH");
      const auditLogPath =
        typeof auditLogSetting === "string" && auditLogSetting.length > 0
          ? auditLogSetting
          : defaultAuditLogPath();
      taskAuditHandler = async (payload) => {
        // Strip the runtime reference before persisting — it's a live object,
        // not serialisable data, and not useful in a flat audit log.
        const { runtime: _runtime, ...persisted } = payload;
        await appendAuditLine(auditLogPath, persisted).catch((err) =>
          runtime.logger?.warn?.(
            {
              src: "@elizaos/plugin-agent-orchestrator",
              err: err instanceof Error ? err.message : String(err),
            },
            "Failed to append TASK_AUDIT entry",
          ),
        );
      };
      runtime.registerEvent<TaskAuditPayload & { runtime: IAgentRuntime }>(
        TASK_AUDIT_EVENT,
        taskAuditHandler,
      );
      // Forward mid-task user messages to the live sub-agent for this roomId.
      // Bind is on (source, roomId) — no Discord-thread dependency, so plain
      // SMS/WhatsApp follow-ups work too.
      activeSessionForwardHandler = async ({ message }) => {
        try {
          if (!message?.entityId || message.entityId === runtime.agentId)
            return;
          // Skip orchestrator/sub-agent-router internal posts. The router
          // emits MESSAGE_RECEIVED with a synthetic `entityId` (not
          // `runtime.agentId`) for narration/status fan-out, so the
          // entityId check above does not filter them out. Without the
          // source filter the router's sub-agent narration would be fed
          // straight back into `acp.sendPrompt` for the same session →
          // echo loop on every sub-agent message.
          const contentRecord = (message.content ?? {}) as Record<
            string,
            unknown
          >;
          const contentSource =
            typeof contentRecord.source === "string"
              ? contentRecord.source
              : undefined;
          if (contentSource && INTERNAL_FORWARD_SKIP_SOURCES.has(contentSource))
            return;
          // Skip transient status posts. These are persisted by the
          // orchestrator's own progress hook (sub_agent_progress /
          // sub_agent_complete) and by the discord plugin via
          // `extraMetadata`. They can carry the agent's own entityId (so
          // the agent-id check covers most), but defending against both
          // top-level Memory.metadata.transient and nested
          // content.metadata.transient matches the recentMessages
          // provider's isTransientStatusMessage contract.
          const topMeta = (message.metadata ?? {}) as Record<string, unknown>;
          const nestedMeta = (contentRecord.metadata ?? {}) as Record<
            string,
            unknown
          >;
          if (topMeta.transient === true || nestedMeta.transient === true)
            return;
          const acp = runtime.getService<AcpService>(AcpService.serviceType);
          if (!acp) return;
          const sessions = await Promise.resolve(acp.listSessions()).catch(
            (err: unknown) => {
              runtime.logger?.warn?.(
                {
                  src: "@elizaos/plugin-agent-orchestrator",
                  err: err instanceof Error ? err.message : String(err),
                },
                "active-session forward listSessions failed",
              );
              return [] as SessionInfo[];
            },
          );
          const active = sessions.find((s) => {
            if (TERMINAL_SESSION_STATUSES.has(s.status)) return false;
            const meta = s.metadata;
            const roomId =
              typeof meta?.roomId === "string" ? meta.roomId : undefined;
            // threadRoomId matches replies posted inside the per-label
            // thread (where roomId derives from the thread id, not the
            // parent channel). Without this, in-thread replies miss the
            // session and the planner re-spawns instead of continuing.
            const threadRoomId =
              typeof meta?.threadRoomId === "string"
                ? meta.threadRoomId
                : undefined;
            return roomId === message.roomId || threadRoomId === message.roomId;
          });
          if (!active) return;
          // Skip sessions already running a prompt. acp.sendPrompt tracks
          // the spawned subprocess via `activeProcesses.set(sessionId, ...)`
          // — a concurrent call OVERWRITES that record, so the first
          // subprocess silently runs untracked. Skipping the forward when
          // the session is `busy` avoids a double-spawn race and keeps the
          // user's text deliverable on the next planner turn (the planner
          // pipeline runs alongside this listener and can still route via
          // TASKS_SEND_TO_AGENT once the in-flight turn settles).
          if (active.status === "busy") return;
          const text =
            typeof (message.content as { text?: unknown })?.text === "string"
              ? ((message.content as { text: string }).text ?? "").trim()
              : "";
          if (!text) return;
          if (typeof acp.sendPrompt !== "function") return;
          // ACL: forwarding user text mid-flight is functionally identical
          // to the TASKS_SEND_TO_AGENT action — bypassing this check would
          // let any user with channel write access inject prompts into a
          // sub-agent another user spawned ("scope drift"). The default
          // policy requires ADMIN for `interact`; GUEST-allowed deployments
          // pass through here too.
          const access = await requireTaskAgentAccess(
            runtime,
            message,
            "interact",
          );
          if (!access.allowed) return;
          await acp.sendPrompt(active.id, text).catch((err: unknown) =>
            runtime.logger?.warn?.(
              {
                src: "@elizaos/plugin-agent-orchestrator",
                sessionId: active.id,
                err: err instanceof Error ? err.message : String(err),
              },
              "active-session forward failed",
            ),
          );
        } catch (err) {
          runtime.logger?.warn?.(
            {
              src: "@elizaos/plugin-agent-orchestrator",
              err: err instanceof Error ? err.message : String(err),
            },
            "active-session forward listener threw",
          );
        }
      };
      runtime.registerEvent(
        EventType.MESSAGE_RECEIVED,
        activeSessionForwardHandler,
      );
      // Service registration & startup happens AFTER plugin.init() returns —
      // plugins are wired in two phases (register-types, then run-inits).
      // Calling `getServiceLoadPromise` here would either hang (waiting on
      // `runtime.initPromise`) or fail (the service class isn't in the
      // `serviceTypes` map yet). Defer to the next macrotask so we run once
      // all plugins are fully wired.
      const types = [
        AcpService.serviceType,
        OrchestratorTaskService.serviceType,
        SubAgentRouter.serviceType,
        CodingWorkspaceService.serviceType,
      ];
      setTimeout(() => {
        void (async () => {
          for (const sType of types) {
            await runtime.getServiceLoadPromise(sType).catch((err: unknown) =>
              runtime.logger?.warn?.(
                {
                  src: "@elizaos/plugin-agent-orchestrator",
                  serviceType: sType,
                  err: err instanceof Error ? err.message : String(err),
                },
                "Failed to eager-start orchestrator service",
              ),
            );
          }
          disposeProgressHook = registerProgressHook(runtime);
          // Orphan recovery runs AFTER the progress hook so resumed-session
          // events (tool_running / task_complete / heartbeat) flow into the
          // hook's listener instead of being dropped on the floor.
          const acp = runtime.getService<AcpService>(AcpService.serviceType);
          void acp?.resumeOrphanedBusySessions?.().catch((err: unknown) =>
            runtime.logger?.warn?.(
              {
                src: "@elizaos/plugin-agent-orchestrator",
                err: err instanceof Error ? err.message : String(err),
              },
              "resumeOrphanedBusySessions failed",
            ),
          );
        })();
      }, 0);
    },
    async dispose(runtime) {
      if (taskAuditHandler) {
        runtime.unregisterEvent?.<
          TaskAuditPayload & { runtime: IAgentRuntime }
        >(TASK_AUDIT_EVENT, taskAuditHandler);
        taskAuditHandler = undefined;
      }
      if (activeSessionForwardHandler) {
        runtime.unregisterEvent?.(
          EventType.MESSAGE_RECEIVED,
          activeSessionForwardHandler,
        );
        activeSessionForwardHandler = undefined;
      }
      if (disposeProgressHook) {
        try {
          disposeProgressHook();
        } catch (err) {
          runtime.logger?.warn?.(
            {
              src: "@elizaos/plugin-agent-orchestrator",
              err: err instanceof Error ? err.message : String(err),
            },
            "progress hook dispose threw",
          );
        }
        disposeProgressHook = undefined;
      }
      const acp = runtime.getService<AcpService>(AcpService.serviceType);
      await acp?.stop();
      const taskService = runtime.getService<OrchestratorTaskService>(
        OrchestratorTaskService.serviceType,
      );
      await taskService?.stop();
      const router = runtime.getService<SubAgentRouter>(
        SubAgentRouter.serviceType,
      );
      await router?.stop();
      await CodingWorkspaceService.stopRuntime(runtime);
    },
  };
}

// Defensive: the planner LLM repeatedly paraphrases obsolete "restart the
// acpx daemon" / "clear stale sessions" advice that lived in past Discord
// messages, even though the provider rule says self-healing is automatic.
// This is a recency-bias hallucination from the conversation memory. Until
// memory rewriting lands upstream, intercept user-facing text and replace
// the cleanup-cleanup phrases with the canonical self-heal recovery line so
// the user never sees instructions to do something the runtime already does.
const FORBIDDEN_CLEANUP_PATTERNS: RegExp[] = [
  /[^.!?\n]*\b(restart|kick(?:[\s-]?off)?|bounce)[^.!?\n]*\bacpx[^.!?\n]*[.!?]?/gi,
  /[^.!?\n]*\bacpx[^.!?\n]*\b(restart|reboot|not\s+accepting|isn'?t\s+accepting)[^.!?\n]*[.!?]?/gi,
  /[^.!?\n]*\b(clear|clean|wipe)[^.!?\n]*\bstale\s+sessions?[^.!?\n]*[.!?]?/gi,
  /[^.!?\n]*\bmanually\s+clear[^.!?\n]*\bsessions?[^.!?\n]*[.!?]?/gi,
  /[^.!?\n]*\bdaemon\b[^.!?\n]*\b(restart|reboot|not\s+accepting|isn'?t\s+accepting)[^.!?\n]*[.!?]?/gi,
];

const SELF_HEAL_REPLACEMENT =
  "(Sub-agent state self-heals; respawning a fresh one automatically.)";

/**
 * Strip the `<emoji> [label] ` prefix from a progress line so it reads
 * cleanly when posted into a per-label thread (the thread name already
 * carries the label). `⚠️` and `⏸️` are 2-codepoint sequences (base +
 * U+FE0F variation selector), so they cannot live inside a `[...]`
 * character class — express each emoji as its own alternation branch.
 * Exported for unit tests; not a public API.
 */
const PROGRESS_PREFIX_REGEX = /^(💬|⏳|⚠️|⏸️|✅|❌|🚀)\s+\[[^\]]+\]\s+/u;
const PROGRESS_EMOJI_PREFIX_REGEX = /^(💬|⏳|⚠️|⏸️|✅|❌|🚀)\s+/u;
export function stripProgressLabelPrefix(text: string): string {
  return text.replace(PROGRESS_PREFIX_REGEX, "$1 ");
}

type SubAgentProgressMode = "compact" | "threaded" | "silent";

interface SubAgentProgressPolicy {
  mode: SubAgentProgressMode;
  reactions: boolean;
  delayMs: number;
}

function readProgressSetting(
  runtime: IAgentRuntime,
  key: string,
): string | undefined {
  const value = runtime.getSetting(key);
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function parseProgressMode(value: string | undefined): SubAgentProgressMode {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === "off" ||
    normalized === "silent" ||
    normalized === "disabled" ||
    normalized === "none" ||
    normalized === "0" ||
    normalized === "false"
  ) {
    return "silent";
  }
  if (normalized === "thread" || normalized === "threaded") return "threaded";
  return "compact";
}

function parseProgressDelayMs(value: string | undefined): number {
  if (!value) return 15_000;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 15_000;
  return Math.min(parsed, 120_000);
}

function parseProgressReactions(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

// Exported for unit tests; not part of the plugin's public API contract.
export function resolveSubAgentProgressPolicy(
  runtime: IAgentRuntime,
): SubAgentProgressPolicy {
  return {
    mode: parseProgressMode(
      readProgressSetting(runtime, "ACPX_PROGRESS_MODE") ??
        readProgressSetting(runtime, "ELIZA_SUB_AGENT_PROGRESS_MODE"),
    ),
    reactions: parseProgressReactions(
      readProgressSetting(runtime, "ACPX_PROGRESS_REACTIONS") ??
        readProgressSetting(runtime, "ELIZA_SUB_AGENT_PROGRESS_REACTIONS"),
    ),
    delayMs: parseProgressDelayMs(
      readProgressSetting(runtime, "ACPX_PROGRESS_DELAY_MS") ??
        readProgressSetting(runtime, "ELIZA_SUB_AGENT_PROGRESS_DELAY_MS"),
    ),
  };
}

// Exported for unit tests; not part of the plugin's public API contract.
export function compactProgressText(text: string): string {
  const stripped = stripProgressLabelPrefix(text)
    .replace(PROGRESS_EMOJI_PREFIX_REGEX, "")
    .trim();
  return stripped || "Working.";
}

// Exported for unit tests; not part of the plugin's public API contract.
export function sanitizePlannerText(text: string): string {
  if (!text) return text;
  let cleaned = text;
  for (const pattern of FORBIDDEN_CLEANUP_PATTERNS) {
    cleaned = cleaned.replace(pattern, "");
  }
  if (cleaned === text) return text;
  cleaned = cleaned.replace(/\s{2,}/g, " ").trim();
  return cleaned.length > 0
    ? `${cleaned} ${SELF_HEAL_REPLACEMENT}`
    : SELF_HEAL_REPLACEMENT;
}

function stripToolTranscripts(raw: string): string {
  if (!raw) return "";
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  let insideToolOutput = false;
  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!insideToolOutput && trimmed.startsWith("[tool output:")) {
      insideToolOutput = true;
      // Extract tool name from `[tool output: NAME]` or `[tool output: NAME: arg]`
      const m = trimmed.match(/^\[tool output:\s*([^:\]]+)/);
      const toolName = (m?.[1] ?? "").trim() || "tool";
      out.push(`[Tool: ${toolName}]`);
      continue;
    }
    if (insideToolOutput && trimmed === "[/tool output]") {
      insideToolOutput = false;
      continue;
    }
    if (insideToolOutput) continue;
    if (trimmed.startsWith("[sub-agent:")) continue;
    if (trimmed.startsWith("[verification:")) continue;
    if (/^\/[^\s]+/.test(trimmed)) continue;
    out.push(line);
  }
  return out.join("\n").trim();
}

export function extractCompletionSummary(raw: string): string {
  if (!raw.trim()) return "done";
  const lines = stripToolTranscripts(raw)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("[Tool:"));
  const last = lines[lines.length - 1] ?? "";
  if (!last) return "done";
  return last.length > 300 ? `${last.slice(0, 297).trimEnd()}…` : last;
}

/**
 * Prompt for the LLM-driven progress heartbeat. The model gets the
 * recently captured narration tail and must reply with ONE short sentence
 * describing what the sub-agent is doing right now — the same kind of
 * concise status the parent agent would give the user when asked "where
 * are you?".
 */
const HEARTBEAT_SUMMARY_PROMPT = `Thin progress reporter for an autonomous coding sub-agent.
Below is recent activity. It may include:
- prose narration the sub-agent wrote ("Now let me build...")
- a list of CONCRETE tool calls with args (most recent last), e.g. \`Read(…/site/index.html)\`, \`Bash(wrangler pages deploy)\`, \`Edit(…/styles.css)\`, \`Grep("color-accent")\`

Reply with ONE short sentence (max 25 words) describing what the sub-agent is actually doing right now — be SPECIFIC: name the files, commands, or patterns when the tool list shows them. Match the narration's language (French if FR, English if EN, default English).

Rules:
- ALWAYS use the concrete details from the tool list. "Editing locales/fr.json and rebuilding" beats "editing files". "Running wrangler pages deploy" beats "running terminal commands".
- If the narration is present, prefer summarizing it but enrich with one tool detail.
- If the tool list looks IDENTICAL to what was reported a minute ago (same paths, same commands), say so briefly ("Still iterating on …/styles.css") instead of repeating verbatim.
- NEVER say "no narration provided", "cannot assess", "investigating", "running terminal commands" (too generic) — the tool list always has specifics.
- No prefix, no markdown, no quotes. Just the sentence.

Recent activity:
{tail}`;

function formatToolCallForHuman(tc: AcpToolCall | undefined): string {
  if (!tc) return "tool";
  const title = (tc.title ?? "").trim();
  const kind = (tc.kind ?? "").toLowerCase();
  const input = tc.rawInput ?? {};
  const firstLoc = Array.isArray(tc.locations) ? tc.locations[0] : undefined;
  // Prefer arg-carrying fields when available.
  const cmd =
    typeof input.command === "string" ? input.command.trim() : undefined;
  const filePath =
    typeof input.file_path === "string"
      ? input.file_path
      : typeof input.path === "string"
        ? input.path
        : typeof firstLoc?.path === "string"
          ? firstLoc.path
          : undefined;
  const pattern = typeof input.pattern === "string" ? input.pattern : undefined;
  const url = typeof input.url === "string" ? input.url : undefined;
  const shortPath = (p: string): string => {
    // Trim long absolute paths to the last 2 segments.
    const parts = p.split("/").filter(Boolean);
    return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : p;
  };
  const trimCmd = (c: string): string =>
    c.length > 80 ? `${c.slice(0, 77)}...` : c;
  // Heuristic: pick a noun based on title/kind, then attach the most
  // informative arg.
  const noun = (() => {
    const t = title.toLowerCase();
    if (kind === "execute" || t.includes("terminal") || t.includes("bash"))
      return "Bash";
    if (kind === "read" || t.includes("read")) return "Read";
    if (kind === "edit" || t.includes("edit")) return "Edit";
    if (kind === "search" || t.includes("grep") || t.includes("search"))
      return "Grep";
    if (kind === "fetch" || t.includes("fetch") || t.includes("web"))
      return "WebFetch";
    return title || "Tool";
  })();
  if (cmd) return `${noun}(${trimCmd(cmd)})`;
  if (filePath) return `${noun}(${shortPath(filePath)})`;
  if (pattern) return `${noun}("${trimCmd(pattern)}")`;
  if (url) return `${noun}(${url})`;
  // No informative arg in the ACP update — fall back to bare noun.
  // The caller debounces identical consecutive bare nouns over a longer
  // window so this doesn't spam.
  return noun;
}

/**
 * Subscribe to AcpService session events and post a tight, human-readable
 * progress update to the *origin* room of each sub-agent session (Discord
 * channel, Slack thread, etc.). Terminal `task_complete` events are skipped
 * — those are routed by `subAgentCompletionResponseEvaluator` which
 * synthesizes a full summary turn. Tool-call updates surface as `tool_running`
 * with a debounce so a single tool invocation only fires once.
 *
 * This is registered AFTER plugin.init() returns to avoid the deadlock where
 * `_runServiceStart` awaits `runtime.initPromise` (which only resolves after
 * all plugin.init() complete). The fire-and-forget chain in init() schedules
 * us for after that promise settles.
 */
function registerProgressHook(runtime: IAgentRuntime): () => void {
  const acp = runtime.getService<AcpService>(AcpService.serviceType);
  runtime.logger?.debug?.(
    { src: "@elizaos/plugin-agent-orchestrator" },
    `registerProgressHook acp=${acp ? "FOUND" : "MISSING"} onSessionEvent=${typeof acp?.onSessionEvent}`,
  );
  if (!acp?.onSessionEvent) {
    runtime.logger?.warn?.(
      { src: "@elizaos/plugin-agent-orchestrator" },
      "AcpService not available; sub-agent progress streaming disabled",
    );
    return () => undefined;
  }
  // Bound for the per-runtime thread + main-message label caches. Caches
  // are keyed by `${source}::${roomId}::${label}`; in the personal-bot
  // single-tenant case `label` cardinality is tiny, but a multi-tenant
  // process running 1000+ distinct labels over its lifetime would leak
  // ~100KB without eviction. 200 entries fits all realistic concurrent
  // labels with insertion-order eviction.
  const LABEL_CACHE_LIMIT = 200;
  const progressPolicy = resolveSubAgentProgressPolicy(runtime);
  const evictOldest = <V>(map: Map<string, V>): void => {
    if (map.size <= LABEL_CACHE_LIMIT) return;
    const first = map.keys().next();
    if (!first.done) map.delete(first.value);
  };
  const lastPostByKey = new Map<string, number>();
  const messageBuffers = new Map<string, string>();
  const messageTimers = new Map<string, NodeJS.Timeout>();
  // Periodic heartbeat per session — every 30s while the sub-agent is
  // still running we post a short status line so the user gets news
  // automatically without having to ask "où tu en es?". Triggered when
  // the first `tool_running` event fires; cleared when the session goes
  // to `stopped`/`error`/terminal.
  const heartbeatTimers = new Map<string, NodeJS.Timeout>();
  const lastHeartbeatPostAt = new Map<string, number>();
  const lastHeartbeatSummary = new Map<string, string>();
  // Track tool invocation history per session. claude-agent-sdk fires
  // `tool_running` events with a title (Bash/Read/Edit/...) but the
  // session output buffer stays empty until each tool reaches a terminal
  // status. Without this map the LLM heartbeat summarizer has nothing
  // to work with while tools are still in-flight. Entries are stored as
  // `{id, formatted}` so a follow-up `tool_call_update` with richer
  // arguments (e.g. the actual Bash command) can replace the bare initial
  // submission instead of duplicating the entry. The id is the ACP
  // toolCallId.
  const toolHistory = new Map<
    string,
    Array<{ id: string; formatted: string }>
  >();
  // Capability-aware UX state per session. When the connector supports
  // `edit_message`, the orchestrator captures the platform message id of
  // the initial ack and edits that message in place on subsequent updates
  // instead of posting new messages. Falls back to send when the cap is
  // absent (current behavior preserved).
  // Per-session UX state. Capability flags resolved once on first event so
  // the lifecycle is deterministic (e.g. a connector that gains/loses a cap
  // mid-task doesn't flip routing). The thread is the key anti-pollution
  // mechanism: when supported, ALL narration + heartbeat live in the
  // thread, so the main channel's recentMessages provider never sees them
  // and the planner LLM cannot paraphrase past status into hallucinations
  // on later turns.
  type ProgressState = {
    mainMessageId: string;
    canEdit: boolean;
    canReact: boolean;
    canThread: boolean;
    label: string;
    thread?: ThreadHandle;
    lastText: string;
  };
  const progressBySession = new Map<string, ProgressState>();
  // Cache threads by (source, roomId, label) so a rate-limit retry, a
  // mid-flight crash recovery, or a follow-up spawn for the same logical
  // project reuses the existing thread instead of creating a duplicate.
  // Without this, "plein de threads" with identical labels stack up in the
  // main channel — moltbot's thread-bindings-policy serves the same role.
  const threadCacheByKey = new Map<string, ThreadHandle>();
  const threadCacheKey = (
    source: string,
    roomId: string,
    label: string,
  ): string => `${source}::${roomId}::${label}`;
  // Cache the main-channel 🚀 message id by label too, so a respawn for the
  // same logical project doesn't post a duplicate "🚀 [label] running" line.
  // Together with threadCacheByKey, the result is exactly one main message +
  // exactly one thread per (source, roomId, label) for the life of the
  // orchestrator (cleared by stop()/dispose()).
  const mainMessageCacheByKey = new Map<string, string>();
  const delayedProgressTimers = new Map<string, NodeJS.Timeout>();
  const delayedProgressPayloads = new Map<
    string,
    {
      target: {
        source: string;
        roomId: `${string}-${string}-${string}-${string}-${string}`;
      };
      rawText: string;
      label?: string;
    }
  >();
  const delayedProgressFirstSeenAt = new Map<string, number>();

  // Cross-platform outgoing-message middleware. When the planner-loop's REPLY
  // action (or any other plugin) calls `runtime.sendMessageToTarget` for a
  // target where the orchestrator has an active per-label thread, redirect
  // the post into the thread instead of the main channel. This keeps the
  // planner's chatter (and any hallucinated paraphrasing of past errors)
  // out of the main channel's conversation memory — which is exactly the
  // surface the next turn's recentMessages provider reads. Capability-gated:
  // a connector without `post_to_thread` keeps the message on its main
  // surface. Internal orchestrator posts (sub-agent narration + completion
  // summary) opt out via `content.source === "sub_agent_progress"` /
  // `"sub_agent_complete"` since those drive the routing themselves.
  type SendMessageFn = (typeof runtime)["sendMessageToTarget"];
  type RuntimeWithMarker = IAgentRuntime & {
    __orchestratorSendWrapped?: boolean;
    __orchestratorOriginalSend?: SendMessageFn;
  };
  const taggedRuntime = runtime as RuntimeWithMarker;
  let restoreSend: (() => void) | undefined;
  if (
    !taggedRuntime.__orchestratorSendWrapped &&
    typeof runtime.sendMessageToTarget === "function"
  ) {
    const originalSend: SendMessageFn = runtime.sendMessageToTarget.bind(
      runtime,
    ) as SendMessageFn;
    const INTERNAL_SOURCES = new Set([
      "sub_agent_progress",
      "sub_agent_complete",
    ]);
    const wrapped: SendMessageFn = async (target, content) => {
      const contentSource =
        typeof (content as { source?: unknown })?.source === "string"
          ? (content as { source: string }).source
          : undefined;
      if (contentSource && INTERNAL_SOURCES.has(contentSource)) {
        return originalSend(target, content);
      }
      const source =
        typeof target.source === "string" ? target.source.trim() : "";
      const roomId = typeof target.roomId === "string" ? target.roomId : "";
      if (!source || !roomId) return originalSend(target, content);
      const prefix = `${source}::${roomId}::`;
      const matches: ThreadHandle[] = [];
      for (const [key, thread] of threadCacheByKey) {
        if (key.startsWith(prefix)) matches.push(thread);
        if (matches.length > 1) break;
      }
      // Ambiguous (≥2 active threads in this room) ⇒ fall back to main
      // channel so we never guess wrong. Zero matches ⇒ main channel.
      if (matches.length !== 1) return originalSend(target, content);
      if (typeof runtime.postToThreadOnTarget !== "function") {
        return originalSend(target, content);
      }
      const thread = matches[0];
      if (!thread) return originalSend(target, content);
      try {
        const result = await runtime.postToThreadOnTarget(
          target,
          thread,
          content,
        );
        return result ?? undefined;
      } catch {
        return originalSend(target, content);
      }
    };
    runtime.sendMessageToTarget = wrapped;
    taggedRuntime.__orchestratorSendWrapped = true;
    taggedRuntime.__orchestratorOriginalSend = originalSend;
    restoreSend = () => {
      // Only restore if we're still the active wrap. If a later wrapper
      // chained over ours, leave it alone — yanking the middle of a chain
      // would break downstream consumers.
      if (runtime.sendMessageToTarget === wrapped) {
        runtime.sendMessageToTarget = originalSend;
      }
      taggedRuntime.__orchestratorSendWrapped = false;
      taggedRuntime.__orchestratorOriginalSend = undefined;
    };
  }
  const POST_DEBOUNCE_MS = 1500;
  const MESSAGE_SILENCE_FLUSH_MS = 1500;
  // Edit-in-place targets get a snappier cadence: each tick is just a Haiku
  // summary call (~$0.001) edited onto the same message, so frequent updates
  // do not spam the channel. Post-only targets fall back to the slow cadence
  // because every tick is a fresh message.
  const HEARTBEAT_INTERVAL_FAST_MS = 10_000;
  const HEARTBEAT_INTERVAL_SLOW_MS = 30_000;
  // Slack on the per-session post-debounce window so a heartbeat that
  // fires a few hundred ms early (timer drift) still considers the
  // window elapsed.
  const HEARTBEAT_DEBOUNCE_MS = 500;

  const startHeartbeat = (
    sessionId: string,
    label: string,
    source: string,
    roomId: `${string}-${string}-${string}-${string}-${string}`,
  ): void => {
    if (heartbeatTimers.has(sessionId)) return;
    const intervalMs = resolveCanEdit(source)
      ? HEARTBEAT_INTERVAL_FAST_MS
      : HEARTBEAT_INTERVAL_SLOW_MS;
    const timer = setInterval(async () => {
      try {
        const session = await acp.getSession(sessionId);
        if (!session) {
          stopHeartbeat(sessionId);
          return;
        }
        const status = String(session.status ?? "?");
        if (TERMINAL_SESSION_STATUSES.has(status)) {
          stopHeartbeat(sessionId);
          return;
        }
        // Avoid spamming: skip if we posted any progress line less
        // than one tick ago (minus a small debounce slack for timer drift).
        const lastPost = lastHeartbeatPostAt.get(sessionId);
        const now = Date.now();
        if (lastPost && now - lastPost < intervalMs - HEARTBEAT_DEBOUNCE_MS)
          return;
        // LLM-summarized heartbeat. Read recent session output, strip
        // raw tool transcript bodies (keeping `[Tool: NAME]` headers),
        // ask the small text model for one short progress sentence.
        // CRITICAL: if there is no useful content to summarize, SKIP
        // the post entirely. A repeating "still working" line is more
        // annoying than silence — the user can always invoke
        // TASKS_LIST_AGENTS to ask "where are you?" on demand.
        const raw =
          typeof acp.getSessionOutput === "function"
            ? await acp.getSessionOutput(sessionId, 200).catch(() => "")
            : "";
        const cleaned = stripToolTranscripts(raw);
        const tools = toolHistory.get(sessionId) ?? [];
        // Skip if we genuinely have nothing — neither narration nor any
        // recorded tool call. That happens in the very first seconds
        // before the sub-agent emits anything; the user gets silence
        // until something concrete lands.
        if (cleaned.trim().length === 0 && tools.length === 0) return;
        const toolsLine =
          tools.length > 0
            ? `\nTools the sub-agent has called recently (most recent last): ${tools.map((t) => t.formatted).join(", ")}`
            : "";
        const filledPrompt = HEARTBEAT_SUMMARY_PROMPT.replace(
          "{tail}",
          `${cleaned}${toolsLine}`.trim() || "(no narration captured yet)",
        );
        const summary = await runtime
          .useModel(ModelType.TEXT_SMALL, {
            prompt: filledPrompt,
            maxTokens: 80,
          })
          .catch(() => "");
        const trimmedSummary = summary.trim().replace(/\s+/g, " ");
        if (trimmedSummary.length === 0) return;
        // Dedupe: if the LLM produced the same line as last tick (modulo
        // case/punctuation), skip the post — silence beats a stream of
        // identical lines.
        const norm = (s: string): string =>
          s
            .toLowerCase()
            .replace(/[^\p{L}\p{N}\s]+/gu, "")
            .trim();
        const prevSummary = lastHeartbeatSummary.get(sessionId);
        if (prevSummary && norm(prevSummary) === norm(trimmedSummary)) return;
        lastHeartbeatSummary.set(sessionId, trimmedSummary);
        const text = `⏳ [${label}] ${trimmedSummary.length > 200 ? `${trimmedSummary.slice(0, 197)}...` : trimmedSummary}`;
        lastHeartbeatPostAt.set(sessionId, now);
        await emitProgress(sessionId, { source, roomId }, text, label);
      } catch {
        // best-effort heartbeat — never crash
      }
    }, intervalMs);
    heartbeatTimers.set(sessionId, timer);
  };

  const stopHeartbeat = (sessionId: string): void => {
    const t = heartbeatTimers.get(sessionId);
    if (t) {
      clearInterval(t);
      heartbeatTimers.delete(sessionId);
    }
    lastHeartbeatPostAt.delete(sessionId);
    lastHeartbeatSummary.delete(sessionId);
  };

  // Generic capability probe — multi-integration aware. The orchestrator
  // routes UX through whichever surface the target connector supports,
  // falling back gracefully when a capability is missing (e.g. Twitter/X
  // has no threads, terminal stdio has neither threads nor reactions).
  // Mark every orchestrator-emitted Content block as transient: the
  // recentMessages provider skips Memory entries with metadata.transient
  // when building the planner's conversation window, so past 🚀/💬/⏳/✅/❌
  // status posts cannot resurface as text the planner LLM paraphrases on
  // later turns. Cross-platform: the flag rides on the persisted Memory
  // regardless of which connector surface delivered the post (thread,
  // edit-in-place, or fresh send).
  function transientContent(
    text: string,
    source: "sub_agent_progress" | "sub_agent_complete",
  ): { text: string; source: string; metadata: { transient: true } } {
    return { text, source, metadata: { transient: true } };
  }

  function hasCap(source: string, capability: string): boolean {
    const connectors = runtime.getMessageConnectors?.();
    if (!Array.isArray(connectors)) return false;
    const conn = connectors.find((c) => c.source === source);
    return Boolean(conn?.capabilities?.includes(capability));
  }
  const resolveCanEdit = (source: string): boolean =>
    hasCap(source, "edit_message");
  const resolveCanReact = (source: string): boolean =>
    progressPolicy.mode === "threaded" &&
    progressPolicy.reactions &&
    hasCap(source, "react_message");
  const resolveCanThread = (source: string): boolean =>
    progressPolicy.mode === "threaded" &&
    hasCap(source, "create_thread") &&
    hasCap(source, "post_to_thread");

  async function bestEffortReact(
    target: TargetInfo,
    messageId: string,
    emoji: string,
  ): Promise<void> {
    if (typeof runtime.addReactionOnTarget !== "function") return;
    try {
      await runtime.addReactionOnTarget(target, messageId, emoji);
    } catch {
      // best-effort: reactions are visual sugar, never block the flow
    }
  }

  function clearDelayedProgress(sessionId: string): void {
    const timer = delayedProgressTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    delayedProgressTimers.delete(sessionId);
    delayedProgressPayloads.delete(sessionId);
    delayedProgressFirstSeenAt.delete(sessionId);
  }

  // emitProgress is the single hot path for sub-agent narration + heartbeat.
  // Routing ladder (capability-aware):
  //   1. THREAD exists (or can be created) → all narration goes in thread.
  //      This is the ANTI-POLLUTION key: thread messages never enter the
  //      main channel's recentMessages window, so the planner LLM cannot
  //      paraphrase past status updates into hallucinations on later turns.
  //   2. canEdit → edit a single main-channel message in place.
  //   3. Fallback → send a new main-channel message each time.
  // First call lazily initializes state: creates the thread when supported
  // and adds a 🚀 reaction to the spawn message when supported.
  async function emitProgress(
    sessionId: string,
    target: {
      source: string;
      roomId: `${string}-${string}-${string}-${string}-${string}`;
    },
    rawText: string,
    label?: string,
  ): Promise<void> {
    if (progressPolicy.mode === "silent") return;
    const text = sanitizePlannerText(rawText);
    const state = progressBySession.get(sessionId);
    if (!state && progressPolicy.delayMs > 0) {
      const firstSeenAt =
        delayedProgressFirstSeenAt.get(sessionId) ?? Date.now();
      delayedProgressFirstSeenAt.set(sessionId, firstSeenAt);
      delayedProgressPayloads.set(sessionId, { target, rawText, label });
      const elapsed = Date.now() - firstSeenAt;
      if (elapsed < progressPolicy.delayMs) {
        if (!delayedProgressTimers.has(sessionId)) {
          const timer = setTimeout(() => {
            delayedProgressTimers.delete(sessionId);
            const payload = delayedProgressPayloads.get(sessionId);
            delayedProgressPayloads.delete(sessionId);
            if (!payload) return;
            void emitProgress(
              sessionId,
              payload.target,
              payload.rawText,
              payload.label,
            );
          }, progressPolicy.delayMs - elapsed);
          delayedProgressTimers.set(sessionId, timer);
        }
        return;
      }
      clearDelayedProgress(sessionId);
    }
    const displayText =
      progressPolicy.mode === "threaded" ? text : compactProgressText(text);
    // Silent-narration mode for capability-poor surfaces. When the target
    // supports neither threads nor edits (Twitter/X DM, SMS, plain stdio),
    // every emitProgress would otherwise produce a fresh message. After
    // the initial 🚀 spawn ack there is nothing useful to say mid-task
    // without spamming the user — suppress the post and keep narration
    // off-channel. The user still sees the spawn ack and the final ✅/❌
    // message from markTaskComplete / markTaskFailed.
    if (state && !state.thread && !state.canEdit) {
      state.lastText = text;
      return;
    }
    try {
      // ── post into the per-session thread when supported ──
      if (state?.thread && typeof runtime.postToThreadOnTarget === "function") {
        if (state.lastText === displayText) return;
        // The thread name IS the label — repeating `[label]` in the body
        // is redundant. Strip the emoji-prefixed `[label]` marker so the
        // thread reads as clean prose: `💬 [foo] Reading file...` becomes
        // `💬 Reading file...`. See PROGRESS_PREFIX_REGEX above for the
        // (subtle) reason this can't use a `[...]` character class.
        const threadText = stripProgressLabelPrefix(displayText);
        await runtime.postToThreadOnTarget(
          target,
          state.thread,
          transientContent(threadText, "sub_agent_progress"),
        );
        state.lastText = displayText;
        return;
      }
      // ── edit the single main-channel message in place ──
      if (
        state?.canEdit &&
        state.mainMessageId &&
        typeof runtime.editMessageOnTarget === "function"
      ) {
        if (state.lastText === displayText) return;
        await runtime.editMessageOnTarget(
          target,
          state.mainMessageId,
          transientContent(displayText, "sub_agent_progress"),
        );
        state.lastText = displayText;
        return;
      }
      // ── first emit OR fallback: send a fresh main-channel message ──
      const sessionLabel = state?.label ?? label ?? "sub-agent";
      const mainCacheKey = threadCacheKey(
        target.source,
        target.roomId,
        sessionLabel,
      );
      // Reuse the existing 🚀 main message for this label when it exists —
      // respawn / rate-limit retry / follow-up should NOT post a duplicate
      // "🚀 [label] running" line. Bind state to the cached message id and
      // skip the network send entirely. The thread (also cached by label)
      // continues to receive narration.
      const cachedMainId = mainMessageCacheByKey.get(mainCacheKey);
      const canEdit = resolveCanEdit(target.source);
      const canReact = resolveCanReact(target.source);
      const canThread = resolveCanThread(target.source);
      if (!state && cachedMainId) {
        const newState: ProgressState = {
          mainMessageId: cachedMainId,
          canEdit,
          canReact,
          canThread,
          label: sessionLabel,
          thread: threadCacheByKey.get(mainCacheKey),
          lastText: "",
        };
        progressBySession.set(sessionId, newState);
        // Recursive call lands on the thread/edit branch above now that
        // state is populated. No duplicate "🚀 [label] running" hits the
        // main channel.
        await emitProgress(sessionId, target, rawText, sessionLabel);
        return;
      }
      const initialText = state
        ? displayText
        : progressPolicy.mode === "threaded"
          ? `🚀 [${sessionLabel}] running`
          : displayText;
      const sent = await runtime.sendMessageToTarget(
        target,
        transientContent(initialText, "sub_agent_progress"),
      );
      const platformId = (sent?.metadata as Record<string, unknown> | undefined)
        ?.platformMessageId;
      if (
        !state &&
        typeof platformId === "string" &&
        platformId.trim().length > 0
      ) {
        mainMessageCacheByKey.set(mainCacheKey, platformId);
        evictOldest(mainMessageCacheByKey);
        const newState: ProgressState = {
          mainMessageId: platformId,
          canEdit,
          canReact,
          canThread,
          label: sessionLabel,
          lastText: initialText,
        };
        progressBySession.set(sessionId, newState);
        // 🚀 reaction marks "spawning/running" without polluting message text.
        if (canReact) {
          void bestEffortReact(target, platformId, "🚀");
        }
        // Resolve the per-(source,roomId,label) thread. Cache hit ⇒ reuse
        // (rate-limit retry / spawn-after-crash for the same logical project
        // posts into the same existing thread). Cache miss ⇒ create new one
        // off this spawn message. Narration flows there from the next emit;
        // the main channel stays clean.
        if (canThread && typeof runtime.createThreadOnTarget === "function") {
          const cacheKey = threadCacheKey(
            target.source,
            target.roomId,
            sessionLabel,
          );
          let thread = threadCacheByKey.get(cacheKey);
          if (!thread) {
            try {
              thread = await runtime.createThreadOnTarget(target, {
                parentMessageId: platformId,
                name: sessionLabel,
              });
              threadCacheByKey.set(cacheKey, thread);
              evictOldest(threadCacheByKey);
            } catch (err: unknown) {
              runtime.logger?.warn?.(
                {
                  src: "@elizaos/plugin-agent-orchestrator",
                  sessionId,
                  err: err instanceof Error ? err.message : String(err),
                },
                "createThread failed; falling back to main-channel edits",
              );
            }
          }
          if (thread) {
            newState.thread = thread;
            // Bind the session to the thread's derived roomId so in-thread
            // replies match (connectors derive roomId from channelId, and a
            // thread's channelId IS the thread id, not the parent channel).
            const threadRoomId = createUniqueUuid(runtime, thread.threadId);
            await acp
              ?.updateSessionMetadata(sessionId, { threadRoomId })
              .catch((err: unknown) =>
                runtime.logger?.warn?.(
                  {
                    src: "@elizaos/plugin-agent-orchestrator",
                    sessionId,
                    err: err instanceof Error ? err.message : String(err),
                  },
                  "updateSessionMetadata(threadRoomId) failed",
                ),
              );
            if (
              displayText !== initialText &&
              typeof runtime.postToThreadOnTarget === "function"
            ) {
              try {
                await runtime.postToThreadOnTarget(
                  target,
                  thread,
                  transientContent(displayText, "sub_agent_progress"),
                );
                newState.lastText = displayText;
              } catch {
                // best-effort: cached thread may have been archived; on next
                // call we'll attempt re-create lazily via the same path.
              }
            }
          }
        }
      }
    } catch (err: unknown) {
      runtime.logger?.warn?.(
        {
          src: "@elizaos/plugin-agent-orchestrator",
          sessionId,
          err: err instanceof Error ? err.message : String(err),
        },
        "emitProgress failed",
      );
    }
  }

  async function markTaskComplete(
    sessionId: string,
    target: TargetInfo,
    summary: string,
  ): Promise<void> {
    const state = progressBySession.get(sessionId);
    if (!state) return;
    const completionText =
      progressPolicy.mode === "threaded"
        ? `✅ [${state.label}] ${summary}`
        : `Completed ${state.label}: ${summary}`;
    if (state.canEdit && typeof runtime.editMessageOnTarget === "function") {
      try {
        await runtime.editMessageOnTarget(
          target,
          state.mainMessageId,
          transientContent(completionText, "sub_agent_complete"),
        );
      } catch {
        // ignore: reaction below is the secondary signal
      }
    } else {
      // Capability-poor surface (no edit): emitProgress was silenced
      // mid-task — post the final summary as a fresh message so the user
      // actually sees the outcome.
      try {
        await runtime.sendMessageToTarget(
          target,
          transientContent(completionText, "sub_agent_complete"),
        );
      } catch {
        // best-effort
      }
    }
    if (state.canReact) {
      void bestEffortReact(target, state.mainMessageId, "✅");
    }
  }

  async function markTaskFailed(
    sessionId: string,
    target: TargetInfo,
  ): Promise<void> {
    const state = progressBySession.get(sessionId);
    if (!state) return;
    if (state.canReact) {
      void bestEffortReact(target, state.mainMessageId, "❌");
      return;
    }
    // No reaction support and no edit: post a terminal failure message so
    // the user knows the sub-agent ended on a non-success state.
    if (!state.canEdit) {
      try {
        await runtime.sendMessageToTarget(
          target,
          transientContent(
            progressPolicy.mode === "threaded"
              ? `❌ [${state.label}] failed`
              : `Failed ${state.label}.`,
            "sub_agent_complete",
          ),
        );
      } catch {
        // best-effort
      }
    }
  }

  // Helper: post a message chunk buffer after silence detected.
  async function flushMessageBuffer(
    sessionId: string,
    label: string,
    source: string,
    roomId: `${string}-${string}-${string}-${string}-${string}`,
  ): Promise<void> {
    const buf = messageBuffers.get(sessionId);
    if (!buf) return;
    messageBuffers.delete(sessionId);
    messageTimers.delete(sessionId);
    // Trim dangling punctuation. Sub-agent narration often ends with
    // `:` / `,` / `—` because the next thing it would have typed was
    // the tool invocation or its output — flushing on silence leaves
    // that punctuation hanging. Stripping it makes the message read
    // like a clean sentence.
    const trimmed = buf.trim().replace(/[\s:;,\-—–]+$/, "");
    if (!trimmed) return;
    // Cap at 800 chars. Sub-agents sometimes dump multi-paragraph results
    // through narration chunks (full inventory tables, verification
    // explanations, etc.). Posting those raw produces a wall of text that
    // duplicates the final summary the response evaluator builds. A 800-char
    // window fits short tables and a few bullet points; longer dumps get
    // truncated and the canonical version lands via the summary.
    const text = `💬 [${label}] ${trimmed.length > 800 ? `${trimmed.slice(0, 793)}…[+]` : trimmed}`;
    // Reset heartbeat clock — message just posted, no need for a status
    // tick within the next heartbeat interval.
    lastHeartbeatPostAt.set(sessionId, Date.now());
    await emitProgress(sessionId, { source, roomId }, text, label);
  }
  runtime.logger?.debug?.(
    { src: "@elizaos/plugin-agent-orchestrator" },
    "HOOK REGISTERED on AcpService",
  );
  const unsubscribeSessionEvents = acp.onSessionEvent(
    async (sessionId, evName, data) => {
      runtime.logger?.debug?.(
        {
          src: "@elizaos/plugin-agent-orchestrator",
          sessionId: sessionId.slice(0, 8),
          ev: evName,
        },
        "session event",
      );
      try {
        const session = await acp.getSession(sessionId);
        const meta = (session?.metadata ?? {}) as Record<string, unknown>;
        const source =
          typeof meta.source === "string" ? meta.source : undefined;
        const roomId =
          typeof meta.roomId === "string"
            ? (meta.roomId as `${string}-${string}-${string}-${string}-${string}`)
            : undefined;
        if (!source || !roomId) return;
        const label =
          typeof meta.label === "string" && meta.label.trim().length > 0
            ? meta.label
            : `sub-agent ${sessionId.slice(0, 8)}`;
        // Start/stop the per-session heartbeat based on lifecycle events.
        // The interval is capability-aware: fast (10s) when the platform can
        // edit messages in place, slow (30s) when each tick is a new post.
        if (evName === "ready" || evName === "tool_running") {
          startHeartbeat(sessionId, label, source, roomId);
        } else if (
          evName === "stopped" ||
          evName === "error" ||
          evName === "task_complete" ||
          // `cancelled` is also a terminal event emitted by acp-service when a
          // session is cancelled mid-flight (cancelSession or active.cancelled
          // exit path). Without including it here, the heartbeat keeps polling
          // and per-session map entries (toolHistory, progressBySession,
          // lastPostByKey) leak for the life of the runtime.
          evName === "cancelled"
        ) {
          // Mark the main-channel spawn message with the terminal outcome via
          // reaction + (when supported) inline summary edit, BEFORE the
          // progressBySession entry is cleared below. This is the user-facing
          // ✅/❌ that turns a "spawning" message into a permanent done/failed
          // record. capability-gated — connectors without react/edit just
          // skip these signals.
          clearDelayedProgress(sessionId);
          if (evName === "task_complete") {
            const rawResponse =
              typeof (data as { response?: unknown })?.response === "string"
                ? (data as { response: string }).response
                : "";
            const summary = extractCompletionSummary(rawResponse);
            // await so the state lookup happens BEFORE progressBySession.delete
            // below — otherwise the helper races against the cleanup and finds
            // no state to attach the ✅ to.
            await markTaskComplete(sessionId, { source, roomId }, summary);
          } else if (evName === "error" || evName === "cancelled") {
            await markTaskFailed(sessionId, { source, roomId });
          }
          stopHeartbeat(sessionId);
          toolHistory.delete(sessionId);
          // Drop any pending `💬` flush. The last narration chunk is typically
          // the sub-agent's final result — letting it post would duplicate
          // the structured summary `subAgentCompletionResponseEvaluator`
          // synthesizes from the same task_complete event. Clearing the
          // buffer + timer keeps the canonical answer in one place.
          const pendingTimer = messageTimers.get(sessionId);
          if (pendingTimer) {
            clearTimeout(pendingTimer);
            messageTimers.delete(sessionId);
          }
          messageBuffers.delete(sessionId);
          // Capture the label BEFORE deleting state so we can evict the
          // per-(source, roomId, label) cache entries below — without
          // this the closed thread keeps mascarading as "active", and the
          // sendMessageToTarget middleware would redirect the user's
          // next plain follow-up into A's archived thread instead of
          // posting it to the main channel (greptile #1 review).
          const terminalState = progressBySession.get(sessionId);
          progressBySession.delete(sessionId);
          if (terminalState) {
            const cacheKey = threadCacheKey(
              source,
              roomId,
              terminalState.label,
            );
            threadCacheByKey.delete(cacheKey);
            mainMessageCacheByKey.delete(cacheKey);
          }
          // Drop dedupe keys scoped to this session so the map doesn't grow
          // unbounded across the runtime's lifetime (one entry per
          // session*event*text triplet). Without this cleanup a long-lived
          // orchestrator process leaks memory proportional to historical
          // session count.
          for (const key of lastPostByKey.keys()) {
            if (key.startsWith(`${sessionId}:`)) lastPostByKey.delete(key);
          }
        }
        // Append the human-readable tool call (with file path / command /
        // pattern args) to per-session history so the heartbeat summarizer
        // has concrete data to work with when the sub-agent runs in silent
        // autonomous mode (no narration between tools). Bare titles like
        // `Read`/`Bash` aren't specific enough to yield a useful summary.
        if (evName === "tool_running") {
          const tc = (data as { toolCall?: AcpToolCall })?.toolCall;
          const formatted = formatToolCallForHuman(tc);
          const id = tc?.id?.trim() ?? "";
          if (formatted && formatted !== "tool") {
            const arr = toolHistory.get(sessionId) ?? [];
            // Same toolCallId as an existing entry: replace it. claude-agent-acp
            // sends an initial `tool_call` with empty rawInput / generic title
            // ("Bash", "Terminal") followed by a `tool_call_update` carrying
            // the real command/path. Replacing keeps history clean instead of
            // listing both bare and enriched versions.
            const existingIdx = id
              ? arr.findIndex((entry) => entry.id === id)
              : -1;
            if (existingIdx >= 0) {
              arr[existingIdx] = { id, formatted };
            } else {
              // Drop consecutive duplicates so loops over the same file don't
              // dominate the prompt.
              if (arr[arr.length - 1]?.formatted !== formatted) {
                arr.push({ id, formatted });
              }
            }
            // Keep last 20 — enough context for a one-sentence summary
            // without bloating the LLM prompt.
            if (arr.length > 20) arr.shift();
            toolHistory.set(sessionId, arr);
          }
        }
        // Skip terminal events — evaluator owns those.
        if (evName === "task_complete") return;
        let text: string | undefined;
        switch (evName) {
          case "tool_running":
            // Text-only feed: tool invocations are implicit from the
            // narration ("Now let me build…"). When ACP doesn't carry
            // rawInput/locations (claude-agent-sdk only exposes bare
            // titles), 🔧 markers add visual noise without operational
            // info. The heartbeat covers long silent stretches.
            return;
          case "message": {
            // Sub-agent narration: each text_delta fires one event.
            // Accumulate chunks per session and flush on silence (no chunk
            // for MESSAGE_SILENCE_FLUSH_MS) — posts a complete narrative
            // segment at natural pauses between thoughts.
            const chunk =
              typeof (data as { text?: string })?.text === "string"
                ? (data as { text: string }).text
                : "";
            if (!chunk) return;
            const prev = messageBuffers.get(sessionId) ?? "";
            messageBuffers.set(sessionId, prev + chunk);
            const existing = messageTimers.get(sessionId);
            if (existing) clearTimeout(existing);
            const timer = setTimeout(() => {
              void flushMessageBuffer(sessionId, label, source, roomId);
            }, MESSAGE_SILENCE_FLUSH_MS);
            messageTimers.set(sessionId, timer);
            return;
          }
          case "error": {
            // Deny-by-default: only post `⚠️` for failure kinds that the USER
            // must act on (auth, rate-limit, etc.). Everything else is
            // self-heal / retry territory — the orchestrator handles it and
            // the provider surfaces the live state to the planner; a Discord
            // post would only pollute conversation memory with phrasings the
            // LLM paraphrases as obsolete "restart / reconnect" advice on
            // later turns.
            const failureKind = (data as { failureKind?: string })?.failureKind;
            const USER_ACTION_KINDS = new Set([
              "auth",
              "login_required",
              "blocked",
              "rate_limit",
            ]);
            if (!failureKind || !USER_ACTION_KINDS.has(failureKind)) return;
            const msg = (data as { message?: string })?.message ?? "error";
            text = `⚠️ [${label}] ${msg}`;
            break;
          }
          case "blocked":
          case "login_required":
            text = `⏸️ [${label}] ${evName}`;
            break;
          default:
            return;
        }
        if (!text) return;
        const dedupeKey =
          evName === "error" ||
          evName === "blocked" ||
          evName === "login_required"
            ? `${sessionId}:${evName}`
            : `${sessionId}:${evName}:${text}`;
        const dedupeWindow =
          evName === "error" ||
          evName === "blocked" ||
          evName === "login_required"
            ? 30_000
            : POST_DEBOUNCE_MS;
        const now = Date.now();
        const last = lastPostByKey.get(dedupeKey);
        if (last && now - last < dedupeWindow) return;
        lastPostByKey.set(dedupeKey, now);
        runtime.logger?.debug?.(
          {
            src: "@elizaos/plugin-agent-orchestrator",
            sessionId: sessionId.slice(0, 8),
            ev: evName,
            source,
            room: roomId.slice(0, 8),
          },
          `posting: "${text.slice(0, 80)}"`,
        );
        await emitProgress(sessionId, { source, roomId }, text, label);
      } catch (err) {
        runtime.logger?.warn?.(
          {
            src: "@elizaos/plugin-agent-orchestrator",
            err: err instanceof Error ? err.message : String(err),
          },
          "sub-agent progress hook threw",
        );
      }
    },
  );
  return () => {
    try {
      unsubscribeSessionEvents();
    } catch {
      // best-effort: AcpService may already be torn down
    }
    // Drain pending timers so they don't fire after the hook is dead —
    // those callbacks reference state we're about to drop and would call
    // back into the (now reset) sendMessageToTarget surface.
    for (const timer of messageTimers.values()) clearTimeout(timer);
    messageTimers.clear();
    messageBuffers.clear();
    for (const timer of heartbeatTimers.values()) clearInterval(timer);
    heartbeatTimers.clear();
    for (const timer of delayedProgressTimers.values()) clearTimeout(timer);
    delayedProgressTimers.clear();
    delayedProgressPayloads.clear();
    delayedProgressFirstSeenAt.clear();
    lastHeartbeatPostAt.clear();
    lastHeartbeatSummary.clear();
    toolHistory.clear();
    progressBySession.clear();
    threadCacheByKey.clear();
    mainMessageCacheByKey.clear();
    lastPostByKey.clear();
    if (restoreSend) {
      try {
        restoreSend();
      } catch {
        // best-effort: another wrapper may have chained over ours
      }
    }
  };
}

export const agentOrchestratorPlugin: Plugin = createAgentOrchestratorPlugin();

export default agentOrchestratorPlugin;

// Re-export coding agent adapter types.
export type {
  AdapterType,
  AgentCredentials,
  AgentFileDescriptor,
  ApprovalConfig,
  ApprovalPreset as AdapterApprovalPreset,
  PreflightResult,
  PresetDefinition,
  RiskLevel,
  ToolCategory,
  WriteMemoryOptions,
} from "coding-agent-adapters";

// TASKS action surface.
export {
  archiveCodingTaskAction,
  cancelTaskAction,
  createTaskAction,
  finalizeWorkspaceAction,
  listAgentsAction,
  listTaskAgentsAction,
  manageIssuesAction,
  provisionWorkspaceAction,
  reopenCodingTaskAction,
  sendToAgentAction,
  sendToTaskAgentAction,
  spawnAgentAction,
  spawnTaskAgentAction,
  startCodingTaskAction,
  stopAgentAction,
  stopTaskAgentAction,
  taskControlAction,
  taskHistoryAction,
  taskShareAction,
  tasksAction,
} from "./actions/tasks.js";
// API routes
export {
  createCodingAgentRouteHandler,
  createTaskAgentRouteHandler,
  handleCodingAgentRoutes,
} from "./api/routes.js";
export { subAgentCompletionResponseEvaluator } from "./evaluators/sub-agent-completion.js";
// Providers
export { activeSubAgentsProvider } from "./providers/active-sub-agents.js";
export {
  acpAvailableAgentsProvider,
  availableAgentsProvider,
} from "./providers/available-agents.js";

// ACP service surface.
export { AcpService } from "./services/acp-service.js";
export {
  AcpSessionStore,
  FileSessionStore,
  InMemorySessionStore,
  RuntimeDbSessionStore,
} from "./services/session-store.js";
export { SubAgentRouter } from "./services/sub-agent-router.js";
// ACP types
export type {
  AcpEventCallback,
  AcpJsonRpcMessage,
  AgentType,
  ApprovalPreset,
  AvailableAgentInfo,
  PromptResult,
  SendOptions,
  SessionEventCallback,
  SessionEventName,
  SessionInfo,
  SessionStatus,
  SpawnOptions,
  SpawnResult,
} from "./services/types.js";
export type {
  AuthPromptCallback,
  CodingWorkspaceConfig,
  CommitOptions,
  ProvisionWorkspaceOptions,
  PushOptions,
  WorkspaceResult,
} from "./services/workspace-service.js";
export { CodingWorkspaceService } from "./services/workspace-service.js";
