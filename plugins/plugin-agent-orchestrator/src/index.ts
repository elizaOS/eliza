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
  Character,
  IAgentRuntime,
  Memory,
  Plugin,
  ServiceClass,
  TargetInfo,
  ThreadHandle,
  UUID,
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
// Shared relay sanitizer (issue elizaOS/eliza#11578). Re-exported from the
// package root so packages/agent's swarm-synthesis path can strip captured
// tool-output envelopes with the SAME implementation the sub-agent router uses.
export {
  elideLongBlocks,
  sanitizeCompletionRelay,
  stripToolTranscript,
} from "./services/transcript-sanitizer.js";

import {
  createTerminalUnsupportedTasksAction,
  tasksSandboxStubAction,
} from "./actions/sandbox-stub.js";
import { tasksAction } from "./actions/tasks.js";
import { subAgentCompletionResponseEvaluator } from "./evaluators/sub-agent-completion.js";
import { subAgentFailureResponseEvaluator } from "./evaluators/sub-agent-failure.js";
import { codingAgentExamplesProvider } from "./providers/action-examples.js";
import { activeSubAgentsProvider } from "./providers/active-sub-agents.js";
import { activeWorkspaceContextProvider } from "./providers/active-workspace-context.js";
import { availableAgentsProvider } from "./providers/available-agents.js";
import { codingSessionChangesProvider } from "./providers/coding-session-changes.js";
import { AcpService } from "./services/acp-service.js";
import {
  createActiveSessionForwardHandler,
  isSessionBusy,
} from "./services/active-session-forward.js";
import {
  appendAuditLine,
  defaultAuditLogPath,
  TASK_AUDIT_EVENT,
  type TaskAuditPayload,
} from "./services/audit.js";
import { OrchestratorTaskService } from "./services/orchestrator-task-service.js";
import { SubAgentInbox } from "./services/sub-agent-inbox.js";
import { SubAgentRouter } from "./services/sub-agent-router.js";
import { SwarmCoordinatorService } from "./services/swarm-coordinator-service.js";
import { TaskSupervisorService } from "./services/task-supervisor-service.js";
import { TaskWatchdogService } from "./services/task-watchdog-service.js";
import { detectOrchestratorTerminalSupport } from "./services/terminal-capabilities.js";
import {
  type AcpToolCall,
  TERMINAL_SESSION_STATUSES,
} from "./services/types.js";
import { CodingWorkspaceService } from "./services/workspace-service.js";
import { codingAgentRoutePlugin } from "./setup-routes.js";

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
        serviceClass(TaskSupervisorService),
        serviceClass(TaskWatchdogService),
        // Discoverable SWARM_COORDINATOR adapter. server.ts's
        // wireCoordinatorBridgesWhenReady + plugin-app-control's
        // verification-room-bridge both look this up by serviceType; without
        // it the coordinator bridges time out ("coding agent features
        // disabled") and the verification bridge stays inactive. See
        // services/swarm-coordinator-service.ts for the consolidation backstory.
        serviceClass(SwarmCoordinatorService),
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
  let disposeInboxFlush: (() => void) | undefined;
  // In-flight inbox-flush poll timers + the set of sessions currently being
  // polled — tracked at plugin scope so dispose() can clear them (an unref'd
  // timer that fires post-dispose would touch a torn-down runtime/service).
  const flushTimers = new Set<ReturnType<typeof setTimeout>>();
  const flushPending = new Set<string>();
  let activeSessionForwardHandler:
    | ((payload: { message: Memory }) => Promise<void>)
    | undefined;
  // Holds room messages that the interruption decider QUEUEs (relevant, but the
  // sub-agent is mid-turn) or that survive an INTERRUPT cancel, until the
  // session next goes idle and they can be flushed without derailing a turn.
  const subAgentInbox = new SubAgentInbox();

  return {
    name: "@elizaos/plugin-agent-orchestrator",
    description: codeExecutionAllowed
      ? "Orchestrate coding sub-agents via the Agent Client Protocol (acpx) with workspace operations, GitHub integration, task history, sub-agent routing, and skill-recommender support. Single TASKS parent action covers create / spawn_agent / send / stop_agent / list_agents / cancel / history / control / share / provision_workspace / submit_workspace / manage_issues / archive / reopen."
      : (terminalSupport.message ??
        "Coding-agent orchestrator is unavailable in this runtime. Exposes a single TASKS action that explains the limitation when the planner reaches for a coding-agent action."),
    dependencies: ["@elizaos/plugin-edge-tts"],
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
        id: "agent-orchestrator.accounts",
        pluginId: "agent-orchestrator",
        slot: "chat-sidebar",
        label: "Coding accounts",
        icon: "Zap",
        order: 250,
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
    routes: codeExecutionAllowed ? (codingAgentRoutePlugin.routes ?? []) : [],
    responseHandlerEvaluators: codeExecutionAllowed
      ? [subAgentCompletionResponseEvaluator, subAgentFailureResponseEvaluator]
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
      activeSessionForwardHandler = createActiveSessionForwardHandler(
        runtime,
        subAgentInbox,
      );
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
        // Eager-start so its digest interval begins without waiting for a
        // getService() that nothing else issues (#8900).
        TaskSupervisorService.serviceType,
        // Eager-start the stalled-agent watchdog loop too (#8901).
        TaskWatchdogService.serviceType,
        // Eager-start the coordinator adapter so it subscribes to the ACP
        // event stream at boot (rather than waiting for a getService() that
        // only the server's bridge-wiring poll issues). This makes
        // wireCoordinatorBridgesWhenReady succeed on its first attempt and the
        // verification-room-bridge attach without burning its retry budget.
        SwarmCoordinatorService.serviceType,
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

          // Flush the interruption-decider inbox when a sub-agent finishes its
          // turn: queued room messages are delivered to the now-idle session
          // without ever having derailed the work mid-turn. A short settle poll
          // bridges the gap between the `task_complete` event and the session
          // status returning to a promptable state.
          if (acp) {
            // Poll bound for the task_complete→ready settle gap. This is NOT a
            // delivery deadline: every subsequent ready/task_complete/reconnected
            // event re-triggers a flush, so a queued message survives a turn far
            // longer than the poll window. Giving up here only stops polling;
            // it never clears a non-terminal session's inbox.
            const MAX_FLUSH_POLLS = 120;
            const scheduleFlush = (sessionId: string, tries = 0): void => {
              if (subAgentInbox.size(sessionId) === 0) return;
              // Coalesce: one in-flight poll chain per session. External
              // re-triggers (tries===0) are dropped while a chain is active;
              // self-rescheduling continuations (tries>0) pass through.
              if (tries === 0 && flushPending.has(sessionId)) return;
              flushPending.add(sessionId);
              const timer = setTimeout(() => {
                flushTimers.delete(timer);
                void (async () => {
                  const svc = runtime.getService<AcpService>(
                    AcpService.serviceType,
                  );
                  // error-policy:J3 session lookup on a deferred flush timer; a
                  // missing/failed lookup degrades to null and the guard below
                  // treats it as "terminal", cancelling the flush cleanly.
                  const session = svc
                    ? await svc.getSession(sessionId).catch(() => null)
                    : null;
                  if (
                    !session ||
                    TERMINAL_SESSION_STATUSES.has(session.status)
                  ) {
                    flushPending.delete(sessionId);
                    subAgentInbox.clear(sessionId);
                    return;
                  }
                  // Still mid-turn (busy / tool_running / running / blocked /
                  // authenticating) — wait for it to return to `ready`.
                  if (isSessionBusy(session.status)) {
                    if (tries < MAX_FLUSH_POLLS) {
                      scheduleFlush(sessionId, tries + 1);
                    } else {
                      // Stop polling; the next session event re-arms a flush.
                      flushPending.delete(sessionId);
                    }
                    return;
                  }
                  flushPending.delete(sessionId);
                  const queued = subAgentInbox.drain(sessionId);
                  if (!queued) return;
                  try {
                    await svc?.sendPrompt(sessionId, queued);
                  } catch (err) {
                    // Lost the race back to busy — requeue and re-arm rather
                    // than drop the user's message.
                    subAgentInbox.enqueue(sessionId, queued);
                    scheduleFlush(sessionId);
                    runtime.logger?.warn?.(
                      {
                        src: "@elizaos/plugin-agent-orchestrator",
                        sessionId,
                        err: err instanceof Error ? err.message : String(err),
                      },
                      "inbox flush failed; requeued",
                    );
                  }
                })();
              }, 1000);
              timer.unref?.();
              flushTimers.add(timer);
            };
            disposeInboxFlush = acp.onSessionEvent((sessionId, event) => {
              if (
                event === "task_complete" ||
                event === "ready" ||
                event === "reconnected"
              ) {
                scheduleFlush(sessionId);
              }
            });
          }
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
      if (disposeInboxFlush) {
        try {
          disposeInboxFlush();
        } catch {
          // listener already detached
        }
        disposeInboxFlush = undefined;
      }
      // Cancel any in-flight flush poll timers so none fire after teardown.
      for (const timer of flushTimers) clearTimeout(timer);
      flushTimers.clear();
      flushPending.clear();
      subAgentInbox.clearAll();
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
      const coordinator = runtime.getService<SwarmCoordinatorService>(
        SwarmCoordinatorService.serviceType,
      );
      await coordinator?.stop();
      await CodingWorkspaceService.stopRuntime(runtime);
    },
  };
}

// Defensive: the planner LLM repeatedly paraphrases obsolete "restart the
// acpx daemon" / "clear stale sessions" advice that lived in past Discord
// messages, even though the provider rule says self-healing is automatic.
// This is a recency-bias hallucination from the conversation memory. Until
// memory rewriting lands upstream, intercept user-facing text and replace
// the teardown-retry phrases with the canonical self-heal recovery line so
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

type SubAgentProgressMode = "compact" | "threaded" | "silent" | "ack";

interface SubAgentProgressPolicy {
  mode: SubAgentProgressMode;
  reactions: boolean;
  delayMs: number;
}

function readProgressSetting(
  runtime: IAgentRuntime,
  key: string,
): string | undefined {
  // runtime.getSetting() reads character settings/secrets only; it never
  // consults process.env (its last fallback is the empty environmentSettings
  // map on the agent boot path). A value provided purely via the process
  // environment (e.g. ACPX_PROGRESS_MODE in the service env file) would
  // otherwise be invisible, silently leaving the policy at the "compact"
  // default. Fall back to process.env so env-based config is honored.
  const value = runtime.getSetting(key) ?? process.env[key];
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
  // "ack": post the spawn ACK once and never edit it again — let the
  // completion-evaluator synthesis be the separate final message. Gives a clean
  // "ack + final" UX with no in-place message editing.
  if (normalized === "ack" || normalized === "ack-only") return "ack";
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
  const mode = parseProgressMode(
    readProgressSetting(runtime, "ACPX_PROGRESS_MODE") ??
      readProgressSetting(runtime, "ELIZA_SUB_AGENT_PROGRESS_MODE"),
  );
  return {
    mode,
    reactions: parseProgressReactions(
      readProgressSetting(runtime, "ACPX_PROGRESS_REACTIONS") ??
        readProgressSetting(runtime, "ELIZA_SUB_AGENT_PROGRESS_REACTIONS"),
    ),
    // "ack" is a one-shot spawn acknowledgment, not a debounced progress
    // stream — the post-delay (which exists to skip progress on sub-second
    // tasks) would instead DROP the ack entirely when a fast sub-agent
    // reaches task_complete before the timer fires. Force it off for ack mode
    // so the ack is reliable regardless of the configured delay.
    delayMs:
      mode === "ack"
        ? 0
        : parseProgressDelayMs(
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

/**
 * Decide whether the planner already acknowledged a spawn turn, so the
 * orchestrator's spawn ACK can be suppressed (avoiding two back-to-back acks:
 * the planner's "On it." plus the orchestrator's own spawn ack). True iff the planner
 * sent a user-facing message to the room within the spawn turn — i.e. at/after
 * the session's createdAt minus a small lookback (REPLY and the TASKS spawn
 * action run in the same turn, in either order). A planner reply older than
 * that belongs to an earlier turn (e.g. a previous task's completion summary)
 * and must NOT suppress this spawn's ack. Pure + deterministic so it is unit
 * tested directly instead of relying on a flaky live "On it." case.
 */
export function plannerAlreadyAckedSpawn(
  plannerReplyAtMs: number | undefined,
  sessionCreatedAtMs: number | undefined,
  lookbackMs: number,
): boolean {
  if (sessionCreatedAtMs === undefined) return false;
  if (plannerReplyAtMs === undefined) return false;
  return plannerReplyAtMs >= sessionCreatedAtMs - lookbackMs;
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

// ── LLM-generated spawn acknowledgement ──────────────────────────────────────
// In "ack" mode the orchestrator posts ONE short line when it kicks off a coding
// sub-agent. A single hardcoded literal ("working on it now.") read identically
// robotic on every spawn, was always English regardless of the user's language,
// and never matched the agent's character voice. Instead, the small text model
// writes the line: it speaks in the configured character's own voice (no
// hardcoded personality, no scraping `style.chat`) and in the user's language
// (no i18n table), and natural sampling removes the verbatim repeat. This is the
// same approach the LLM progress heartbeat already uses to write its status line
// in the narration's language. The pure helpers below build the prompts and
// sanitize the output (unit-tested); the single `useModel` call in the progress
// hook is the only impure part, and it falls back to SPAWN_ACK_FALLBACK so the
// ack can never become silence.

// Minimal degraded fallback, used ONLY when the model call fails or returns
// nothing usable — never the primary path. Kept short and neutral on purpose.
export const SPAWN_ACK_FALLBACK = "On it.";

// Longest acknowledgement we keep. An ack is a one-liner; anything longer is the
// model over-answering, so it gets clipped.
const SPAWN_ACK_MAX_CHARS = 120;
const SPAWN_ACK_TIMEOUT_MS = 750;

function withSpawnAckTimeout<T>(promise: Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), SPAWN_ACK_TIMEOUT_MS);
    (timer as { unref?: () => void }).unref?.();
  });
  return Promise.race([promise.catch(() => fallback), timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * System prompt for spawn-ack generation. Carries the character's own voice —
 * derived from the configured character, never hardcoded — plus the hard
 * constraints that keep the output to a single short in-language line. Pure +
 * deterministic so it is unit-tested directly.
 */
export function buildSpawnAckSystemPrompt(character: Character): string {
  const name = (character.name ?? "").trim() || "the assistant";
  const voiceParts: string[] = [];
  const bio = (character.bio ?? []).map((b) => b.trim()).filter(Boolean);
  if (bio.length > 0) voiceParts.push(bio.slice(0, 3).join(" "));
  const traits = [
    ...(character.adjectives ?? []),
    ...(character.style?.chat ?? []),
    ...(character.style?.all ?? []),
  ]
    .map((t) => t.trim())
    .filter(Boolean);
  if (traits.length > 0) {
    voiceParts.push(`Voice: ${[...new Set(traits)].slice(0, 8).join(", ")}.`);
  }
  return [
    `You are ${name}.`,
    voiceParts.join(" ").trim(),
    "You have just kicked off a background task the user asked for.",
    "Reply with exactly ONE short, natural line, in your own voice, confirming you're on it.",
    "Write it in the same language the user used.",
    "No quotes, no emoji, no markdown, no preamble — just the line. Keep it under 12 words.",
  ]
    .filter((part) => part.length > 0)
    .join(" ");
}

/**
 * User-turn prompt for spawn-ack generation: the task being started. The task
 * text doubles as the language signal — the model replies in whatever language
 * it is written in (same mechanism as the heartbeat summarizer). Pure.
 */
export function buildSpawnAckUserPrompt(task: string): string {
  const trimmed = task.trim();
  const what = trimmed.length > 0 ? trimmed : "the task they just gave you";
  const clipped = what.length > 400 ? `${what.slice(0, 397)}…` : what;
  return `The task you're starting:\n${clipped}\n\nYour one-line acknowledgement:`;
}

/**
 * Clean a model-produced ack into a single plain line: first non-empty line,
 * surrounding quotes / emoji / list markers stripped, whitespace collapsed,
 * length capped. Returns "" when nothing usable remains (the caller then falls
 * back to SPAWN_ACK_FALLBACK). Pure + deterministic.
 */
export function sanitizeSpawnAck(raw: string): string {
  if (!raw) return "";
  const firstLine =
    raw
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  if (!firstLine) return "";
  let cleaned = firstLine
    .replace(PROGRESS_EMOJI_PREFIX_REGEX, "")
    .replace(/^[>*\-•\s]+/, "")
    .trim();
  // Strip a single pair of surrounding quotes (straight, smart, or backtick).
  const quotePairs: ReadonlyArray<readonly [string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ["“", "”"],
    ["‘", "’"],
    ["`", "`"],
  ];
  for (const [open, close] of quotePairs) {
    if (
      cleaned.length >= open.length + close.length &&
      cleaned.startsWith(open) &&
      cleaned.endsWith(close)
    ) {
      cleaned = cleaned
        .slice(open.length, cleaned.length - close.length)
        .trim();
      break;
    }
  }
  cleaned = cleaned.replace(/\s{2,}/g, " ").trim();
  if (!cleaned) return "";
  return cleaned.length > SPAWN_ACK_MAX_CHARS
    ? `${cleaned.slice(0, SPAWN_ACK_MAX_CHARS - 1).trimEnd()}…`
    : cleaned;
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

/**
 * Normalize a raw ACP `title` into either an informative noun or the empty
 * string. The upstream `stringifyMaybe` serializer turns a missing title
 * (`undefined`/`null`) into the literal two-character string `""` (a
 * JSON-stringified empty string), and some adapters send whitespace- or
 * quote-only titles. Left unhandled those became junk "tool calls" in the
 * hb_signal summarizer prompt (`Tools the sub-agent has called recently: "", ""`).
 * Strip surrounding quotes + whitespace; if nothing informative survives,
 * return "" so the caller falls back to a kind-derived noun or "Tool".
 */
function sanitizeToolTitle(raw: string | undefined): string {
  let t = (raw ?? "").trim();
  // Peel matched surrounding quotes (straight or smart), repeatedly, so
  // `""`, `''`, `"  "`, `"\"x\""` all collapse toward their inner content.
  // Bounded iterations guard against pathological input.
  for (let i = 0; i < 4; i++) {
    const next = t
      .replace(
        /^["'\u201c\u201d\u2018\u2019]+|["'\u201c\u201d\u2018\u2019]+$/g,
        "",
      )
      .trim();
    if (next === t) break;
    t = next;
  }
  // If nothing but punctuation/quotes remained, it carries no signal.
  if (!/[\p{L}\p{N}]/u.test(t)) return "";
  return t;
}

function formatToolCallForHuman(tc: AcpToolCall | undefined): string {
  if (!tc) return "tool";
  const title = sanitizeToolTitle(tc.title);
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
  // on subsequent turns.
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
  // Sessions whose first main-channel post is mid-flight. The first emit for a
  // session `await`s sendMessageToTarget BEFORE it records state in
  // progressBySession, so two progress events that arrive close together (the
  // window widens with ACPX_PROGRESS_DELAY_MS=0) would both see `!state`, both
  // pass the guards, and both post a duplicate spawn ACK. This set is set
  // synchronously before that await and cleared once state is recorded, so the
  // second concurrent emit bails — exactly one spawn message per session.
  const firstPostInFlight = new Set<string>();
  // Sessions whose single "ack"-mode spawn ACK has been posted. This is the
  // canonical "ack done" marker for ack mode — set synchronously the moment we
  // commit to sending the ACK (before any await) and cleared only on terminal
  // teardown. It does NOT depend on the post succeeding or on progressBySession
  // being recorded: when sendMessageToTarget returns an empty platformId (or a
  // post-send throw releases firstPostInFlight), `state.mainMessageId` never
  // gets set, so a `state?.mainMessageId`-keyed guard would let the 10s
  // heartbeat re-run the first-post path and post a SECOND ack. Keying ack
  // suppression on this set instead makes it exactly one ack per session.
  const ackedSessions = new Set<string>();
  // Terminal events can arrive while the model is still writing the first ack.
  // Once terminal is observed, a late ack must be suppressed; otherwise the user
  // can see "On it" after completion/failure. Bounded like ackedSessions.
  const terminalSessions = new Set<string>();
  const markSessionTerminal = (sessionId: string): void => {
    terminalSessions.add(sessionId);
    if (terminalSessions.size > 512) {
      const oldest = terminalSessions.values().next().value;
      if (oldest !== undefined) terminalSessions.delete(oldest);
    }
  };
  // Last "ack"-mode spawn ACK time per ROOM (`${source}::${roomId}`). One user
  // turn frequently fans out into several sub-agent sessions — a re-spawn, or a
  // multi-file build that spawns more than once — and ackedSessions is per
  // SESSION, so each would post its own spawn ack (the duplicate-ack nubs saw).
  // Suppressing a sibling session's ACK when the room already acked
  // within this window collapses one turn to a single ACK; a genuinely new
  // request after the window still gets its own.
  const roomAckAt = new Map<string, number>();
  const ACK_ROOM_DEDUP_MS = 60_000;
  // Resolved outbound target (channelId/serverId) cache, keyed by
  // `${source}::${roomId}`. emitProgress is a hot recursive path; resolving the
  // room's connector channel once per (source,roomId) avoids a getRoom lookup on
  // every narration tick. See resolveEmitTarget below.
  const emitTargetCacheByKey = new Map<string, EmitTarget>();
  // Sessions that have already logged an emitProgress failure at WARN. A single
  // unresolvable room (a stale/task-room UUID forwarded onto a verify-retry
  // successor session that has no live connector channel) would otherwise emit a
  // WARN on every narration tick + heartbeat. Warn once per session, then drop to
  // debug so the log doesn't spam. Bounded like the other per-session sets.
  const emitFailedSessions = new Set<string>();
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
  // Last time the planner (or any non-internal sender) posted a user-facing
  // message to a room, keyed by roomId. Recorded by the sendMessageToTarget
  // wrapper below. Used to dedupe the spawn ACK: if the planner already
  // acknowledged the spawn turn ("On it.") the orchestrator stays silent so
  // the user never sees two back-to-back acks. Bounded to stay memory-safe.
  const lastPlannerReplyAtByRoom = new Map<string, number>();
  // How far before a session's createdAt a planner reply still counts as that
  // spawn's acknowledgment. The planner's REPLY and the TASKS spawn action run
  // in the same turn (milliseconds to ~1s apart, either order), so a small
  // lookback reliably attributes the reply to this spawn without catching an
  // unrelated earlier chat reply.
  const PLANNER_ACK_LOOKBACK_MS = 8000;

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
      // This is a user-facing (non-internal) send — the planner's REPLY, a
      // synthesis, etc. Record it so the spawn-ACK dedup can tell whether the
      // planner already acknowledged the spawn turn for this room.
      lastPlannerReplyAtByRoom.set(roomId, Date.now());
      if (lastPlannerReplyAtByRoom.size > 512) {
        const oldest = lastPlannerReplyAtByRoom.keys().next().value;
        if (oldest !== undefined) lastPlannerReplyAtByRoom.delete(oldest);
      }
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
      // Only restore if we're still the active wrap. If a subsequent wrapper
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

  // Generate the one-line "ack"-mode spawn acknowledgement via the small text
  // model — in the character's own voice and the user's language (see
  // buildSpawnAckSystemPrompt). The task text (the language signal) is read from
  // the session's `initialTask` metadata, falling back to the label. Best-effort:
  // any failure (no model registered, a throw, empty output) collapses to a short
  // literal, so the ack is never silence and never blocks the spawn.
  const generateSpawnAck = async (
    sessionId: string,
    label: string,
  ): Promise<string> => {
    try {
      // error-policy:J3 session lookup for a best-effort ack label; an
      // unavailable session degrades to the passed `label`, never a fake ack.
      const session = await acp.getSession(sessionId).catch(() => null);
      const meta = (session?.metadata ?? {}) as Record<string, unknown>;
      const task =
        typeof meta.initialTask === "string" && meta.initialTask.trim()
          ? meta.initialTask
          : label;
      return await withSpawnAckTimeout(
        runtime
          .useModel(ModelType.TEXT_SMALL, {
            system: buildSpawnAckSystemPrompt(runtime.character),
            prompt: buildSpawnAckUserPrompt(task),
            maxTokens: 32,
            temperature: 0.7,
          })
          .then(
            (raw) =>
              sanitizeSpawnAck(typeof raw === "string" ? raw : "") ||
              SPAWN_ACK_FALLBACK,
          ),
        SPAWN_ACK_FALLBACK,
      );
    } catch {
      return SPAWN_ACK_FALLBACK;
    }
  };

  // Generic capability probe — multi-integration aware. The orchestrator
  // routes UX through whichever surface the target connector supports,
  // falling back gracefully when a capability is missing (e.g. Twitter/X
  // has no threads, terminal stdio has neither threads nor reactions).
  // Mark every orchestrator-emitted Content block as transient: the
  // recentMessages provider skips Memory entries with metadata.transient
  // when building the planner's conversation window, so past 🚀/💬/⏳/✅/❌
  // status posts cannot resurface as text the planner LLM paraphrases on
  // subsequent turns. Cross-platform: the flag rides on the persisted Memory
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

  // Resolve the outbound connector target for a `{ source, roomId }` pair the
  // SAME way the swarm-synthesis completion router does
  // (packages/agent/.../server-helpers-swarm.ts routeSynthesisToConnector):
  // look the room up and thread its `channelId` (falling back to the room id)
  // plus `serverId` onto the target. This matters because the orchestrator
  // takes `source`/`roomId` from `session.metadata`, and a verify-retry
  // successor session (SubAgentRouter.retryIncompleteBuild) inherits the
  // ORIGINAL session's `metadata.roomId`. That inherited roomId can be a
  // stale/task-room UUID with no live connector-channel mapping — so a
  // roomId-only target makes the Discord connector re-derive the channel from
  // the room and throw "Could not resolve Discord channel ID for room …",
  // spamming an Error+Warn on every narration tick. Supplying `channelId`
  // up front lets the connector send directly (target.channelId short-circuits
  // the room→channel derivation) and lands on the live room the synthesis
  // router already routes to. Cached per (source,roomId): the hot narration
  // path must not pay a getRoom lookup every tick. On any resolution miss we
  // fall back to the bare `{ source, roomId }` — no worse than before.
  type EmitTarget = {
    source: string;
    roomId: `${string}-${string}-${string}-${string}-${string}`;
    channelId?: string;
    serverId?: string;
  };
  async function resolveEmitTarget(target: {
    source: string;
    roomId: `${string}-${string}-${string}-${string}-${string}`;
  }): Promise<EmitTarget> {
    const key = `${target.source}::${target.roomId}`;
    const cached = emitTargetCacheByKey.get(key);
    if (cached) return cached;
    let resolved: EmitTarget = { source: target.source, roomId: target.roomId };
    try {
      if (typeof runtime.getRoom === "function") {
        const room = await runtime.getRoom(target.roomId as UUID);
        if (room) {
          resolved = {
            source: target.source,
            roomId: target.roomId,
            // Mirror routeSynthesisToConnector: prefer the connector channel id,
            // fall back to the room id when the room is its own channel.
            channelId: room.channelId ?? room.id,
            ...(room.serverId ? { serverId: room.serverId } : {}),
          };
        }
      }
    } catch {
      // best-effort resolution — fall back to the bare target below
    }
    emitTargetCacheByKey.set(key, resolved);
    if (emitTargetCacheByKey.size > 512) {
      const oldest = emitTargetCacheByKey.keys().next().value;
      if (oldest !== undefined) emitTargetCacheByKey.delete(oldest);
    }
    return resolved;
  }

  // emitProgress is the single hot path for sub-agent narration + hb_signal.
  // Routing ladder (capability-aware):
  //   1. THREAD exists (or can be created) → all narration goes in thread.
  //      This is the ANTI-POLLUTION key: thread messages never enter the
  //      main channel's recentMessages window, so the planner LLM cannot
  //      paraphrase past status updates into hallucinations on subsequent turns.
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
    // "ack" mode: the spawn ACK posts once (first emit); never edit it
    // afterward. Once the main message exists, suppress every subsequent progress
    // emit so the ACK stays untouched and the completion-evaluator synthesis is
    // the separate final message — no in-place editing of the channel message.
    if (progressPolicy.mode === "ack" && ackedSessions.has(sessionId)) {
      if (state) state.lastText = text;
      return;
    }
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
      // Resolve the outbound connector target (channelId/serverId) up front so
      // every send below routes the same way the swarm-synthesis completion
      // router does — landing on the live connector channel even when the room
      // id was inherited (verify-retry) from a session whose room no longer
      // maps to a channel. Cached per (source,roomId); the original `target`
      // is still used for state keys (source/roomId are unchanged by resolve).
      const sendTarget = await resolveEmitTarget(target);
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
          sendTarget,
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
          sendTarget,
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
      if (!state && terminalSessions.has(sessionId)) return;
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
      // The "ack"-mode spawn line is generated by the model AFTER the
      // synchronous claim below (so the claim stays atomic), so leave it empty
      // here and fill it once this event has exclusively claimed the first post.
      const isAckFirstPost = !state && progressPolicy.mode === "ack";
      let initialText = state
        ? displayText
        : progressPolicy.mode === "threaded"
          ? `🚀 [${sessionLabel}] running`
          : progressPolicy.mode === "ack"
            ? ""
            : displayText;
      // Claim the first post synchronously before the await. A second progress
      // event for the same session that arrives while this send is in flight
      // (it still sees `!state`) bails here instead of posting a duplicate
      // spawn ACK. Cleared once state is recorded (below) or on send failure
      // (catch). No `await` may sit between this check and the send.
      if (!state) {
        if (firstPostInFlight.has(sessionId)) return;
        // ack mode posts exactly one ACK per ROOM per window — a sibling
        // sub-agent session spawned by the SAME user turn must not post a second
        // ack. Checked synchronously before the claim/await so a concurrent
        // sibling bails here. (Per-session suppression below still guards the
        // heartbeat / narration re-entry for this one session.)
        if (progressPolicy.mode === "ack") {
          const roomAckKey = `${target.source}::${target.roomId}`;
          const now = Date.now();
          const lastRoomAck = roomAckAt.get(roomAckKey);
          if (
            lastRoomAck !== undefined &&
            now - lastRoomAck < ACK_ROOM_DEDUP_MS
          ) {
            return;
          }
          roomAckAt.set(roomAckKey, now);
          if (roomAckAt.size > 512) {
            const oldest = roomAckAt.keys().next().value;
            if (oldest !== undefined) roomAckAt.delete(oldest);
          }
        }
        firstPostInFlight.add(sessionId);
        // ack mode posts exactly one ACK per session — claim it here,
        // synchronously, so the heartbeat / narration flush / a trailing
        // post-completion event can never re-enter this first-post path even
        // if the send below returns no platformId (state stays unrecorded).
        // Persist for the session's life (never cleared on terminal); bound
        // the set so a long-lived runtime doesn't accumulate sessionIds.
        if (progressPolicy.mode === "ack") {
          ackedSessions.add(sessionId);
          if (ackedSessions.size > 512) {
            const oldest = ackedSessions.values().next().value;
            if (oldest !== undefined) ackedSessions.delete(oldest);
          }
        }
      }
      // "ack" mode posts ONE clean spawn ACK (never the raw sub-agent narration)
      // and never edits it afterward — the completion synthesis is the separate
      // final message. The line is the model's own in-voice, in-language
      // acknowledgement. Generated here, AFTER the claim above, so the dedup
      // stays synchronous and the model latency sits outside the claim window.
      if (isAckFirstPost) {
        initialText = await generateSpawnAck(sessionId, sessionLabel);
        if (terminalSessions.has(sessionId)) {
          firstPostInFlight.delete(sessionId);
          return;
        }
      }
      const sent = await runtime.sendMessageToTarget(
        sendTarget,
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
        // State is recorded — subsequent emits now take the edit/ack-guard branch.
        // Release the first-post claim so a genuine respawn can post again.
        firstPostInFlight.delete(sessionId);
        // A spawning/running reaction marks progress without polluting the
        // message text. Skip it in "ack" mode — the plain ACK already conveys
        // "working on it" and the rocket reads as noise next to it.
        if (canReact && progressPolicy.mode !== "ack") {
          void bestEffortReact(sendTarget, platformId, "🚀");
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
              thread = await runtime.createThreadOnTarget(sendTarget, {
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
                  sendTarget,
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
      // Release the first-post claim on failure so a retry can post the ACK
      // (on success it was already released once state was recorded).
      firstPostInFlight.delete(sessionId);
      // Fail-soft on repeat. A single unresolvable room (a stale/task-room
      // UUID inherited by a verify-retry successor session) would otherwise
      // WARN on every narration tick + heartbeat for the life of the session.
      // WARN once per session so the failure is still visible, then drop to
      // DEBUG for subsequent emits so the log doesn't spam.
      const alreadyWarned = emitFailedSessions.has(sessionId);
      const logFields = {
        src: "@elizaos/plugin-agent-orchestrator",
        sessionId,
        err: err instanceof Error ? err.message : String(err),
      };
      if (alreadyWarned) {
        runtime.logger?.debug?.(logFields, "emitProgress failed (repeat)");
      } else {
        emitFailedSessions.add(sessionId);
        if (emitFailedSessions.size > 512) {
          const oldest = emitFailedSessions.values().next().value;
          if (oldest !== undefined) emitFailedSessions.delete(oldest);
        }
        runtime.logger?.warn?.(logFields, "emitProgress failed");
      }
    }
  }

  async function markTaskComplete(
    sessionId: string,
    target: TargetInfo,
    summary: string,
  ): Promise<void> {
    const state = progressBySession.get(sessionId);
    if (!state) return;
    // Resolve the connector channel the same way emitProgress does so the
    // completion edit/reaction lands on the live channel (cached; a no-op when
    // the target already carries a channelId or the room is unresolvable).
    const sendTarget = target.roomId
      ? await resolveEmitTarget({
          source: target.source,
          roomId:
            target.roomId as `${string}-${string}-${string}-${string}-${string}`,
        })
      : target;
    const completionText =
      progressPolicy.mode === "threaded"
        ? `✅ [${state.label}] ${summary}`
        : `Completed ${state.label}: ${summary}`;
    // "ack"/"silent" mode: the completion-evaluator synthesis IS the final
    // user-facing message ("your site is live at <url>"). Posting or editing a
    // second completion message here would compete with that synthesis, so
    // suppress the completion post entirely in those modes and let the ✅
    // reaction on the untouched ACK be the only extra completion signal.
    const suppressCompletionPost =
      progressPolicy.mode === "ack" || progressPolicy.mode === "silent";
    if (!suppressCompletionPost) {
      if (state.canEdit && typeof runtime.editMessageOnTarget === "function") {
        try {
          await runtime.editMessageOnTarget(
            sendTarget,
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
            sendTarget,
            transientContent(completionText, "sub_agent_complete"),
          );
        } catch {
          // best-effort
        }
      }
    }
    if (state.canReact) {
      void bestEffortReact(sendTarget, state.mainMessageId, "✅");
    }
  }

  async function markTaskFailed(
    sessionId: string,
    target: TargetInfo,
  ): Promise<void> {
    const state = progressBySession.get(sessionId);
    if (!state) return;
    const sendTarget = target.roomId
      ? await resolveEmitTarget({
          source: target.source,
          roomId:
            target.roomId as `${string}-${string}-${string}-${string}-${string}`,
        })
      : target;
    if (state.canReact) {
      void bestEffortReact(sendTarget, state.mainMessageId, "❌");
      return;
    }
    // No reaction support and no edit: post a terminal failure message so
    // the user knows the sub-agent ended on a non-success state.
    const suppressFailurePost =
      progressPolicy.mode === "ack" || progressPolicy.mode === "silent";
    if (!state.canEdit && !suppressFailurePost) {
      try {
        await runtime.sendMessageToTarget(
          sendTarget,
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
        const isTerminalEvent =
          evName === "stopped" ||
          evName === "error" ||
          evName === "task_complete" ||
          evName === "cancelled";
        if (isTerminalEvent) {
          markSessionTerminal(sessionId);
        }
        // "ack" mode: post the single clean spawn ACK on the FIRST event of any
        // kind, not just narration. The ack used to ride on the first
        // message-buffer flush, which only fires after a narration silence gap
        // (MESSAGE_SILENCE_FLUSH_MS). Fast sub-agents (opencode/gpt-oss stream
        // continuously and reach task_complete before any flush) therefore
        // posted NO ack — only the final synthesis. Posting here, gated on the
        // first non-terminal event, makes "ack + separate synthesis" reliable
        // on every backend (codex/opencode/claude). emitProgress ignores the
        // empty rawText for the ack first-post and the firstPostInFlight +
        // mainMessageId guards keep it to exactly one ack.
        // A verification-retry re-dispatch (buildVerifyRetryCount > 0, set by
        // SubAgentRouter.retryIncompleteBuild) is an INTERNAL continuation of the
        // same user request, spawned under a fresh sessionId minutes subsequent. The
        // per-session ackedSessions/firstPostInFlight guards never see it, and the
        // per-room ack dedup window (60s) has long expired — so without this gate
        // each retry posts another spawn ack (the triple-ack users reported).
        // The original user-requested session has no
        // buildVerifyRetryCount, so it still acks exactly once.
        const isVerifyRetrySpawn =
          typeof meta.buildVerifyRetryCount === "number" &&
          meta.buildVerifyRetryCount > 0;
        if (
          progressPolicy.mode === "ack" &&
          !ackedSessions.has(sessionId) &&
          !terminalSessions.has(sessionId) &&
          !isVerifyRetrySpawn &&
          evName !== "task_complete" &&
          evName !== "turn_complete" &&
          evName !== "stopped" &&
          evName !== "error" &&
          evName !== "cancelled"
        ) {
          // Dedupe against the planner's own acknowledgment. The planner often
          // replies "On it." in the same turn it spawns the task; posting a
          // second orchestrator ACK right after is the back-to-back double-ack
          // users complained about. If a user-facing
          // (non-internal) message hit this room within the spawn turn — i.e.
          // at/after createdAt minus a small lookback — the planner already
          // acked: claim the marker (so trailing events + heartbeat stay
          // suppressed) and post nothing. When the planner was silent, the
          // orchestrator ACK is the single reliable ack.
          const createdAtMs =
            session?.createdAt instanceof Date
              ? session.createdAt.getTime()
              : undefined;
          const plannerAlreadyAcked = plannerAlreadyAckedSpawn(
            lastPlannerReplyAtByRoom.get(roomId),
            createdAtMs,
            PLANNER_ACK_LOOKBACK_MS,
          );
          if (plannerAlreadyAcked) {
            ackedSessions.add(sessionId);
            if (ackedSessions.size > 512) {
              const oldest = ackedSessions.values().next().value;
              if (oldest !== undefined) ackedSessions.delete(oldest);
            }
          } else {
            await emitProgress(sessionId, { source, roomId }, "", label);
          }
        }
        // Start/stop the per-session heartbeat based on lifecycle events.
        // The interval is capability-aware: fast (10s) when the platform can
        // edit messages in place, slow (30s) when each tick is a new post.
        if (evName === "ready" || evName === "tool_running") {
          startHeartbeat(sessionId, label, source, roomId);
        } else if (isTerminalEvent) {
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
            // below — otherwise the helper races against the teardown and finds
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
          firstPostInFlight.delete(sessionId);
          emitFailedSessions.delete(sessionId);
          // Do NOT clear ackedSessions here. Sub-agents (notably opencode /
          // gpt-oss) emit trailing `message` events AFTER `task_complete`;
          // clearing the marker let those late events re-enter the spawn-ack
          // path and post a SECOND "🚀 On it…" right before the synthesis.
          // A respawn always gets a fresh sessionId (uuid), so a per-sessionId
          // marker never needs releasing for reuse — it only needs bounding
          // (handled at the add site) to stay memory-safe.
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
          // session*event*text triplet). Without this teardown a long-lived
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
          // Only record entries that carry signal. Reject:
          //  - empty / whitespace-only `formatted` (defensive; sanitizeToolTitle
          //    already collapses junk titles like the JSON-serialized `""`),
          //  - the bare noun fallback ("tool"/"Tool") produced when the ACP
          //    update has no kind, no informative title, and no args — a
          //    content-free placeholder that used to pollute the heartbeat
          //    summarizer prompt.
          // Bare INFORMATIVE nouns (Bash/Read/Edit/Grep/WebFetch) are kept on
          // purpose: they're the debounced fallback for arg-less updates and
          // still tell the summarizer what class of work is happening.
          const trimmedFormatted = formatted.trim();
          const isNonInformative =
            trimmedFormatted.length === 0 ||
            trimmedFormatted.toLowerCase() === "tool";
          if (!isNonInformative) {
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
            // subsequent turns.
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
// Action helper: resolve the runtime's registered ACP service singleton. Used by
// out-of-tree live harnesses (e.g. packages/core/test/live/task-agent-live-smoke)
// so they read output from the same service instance the actions spawn into.
export { getAcpService } from "./actions/common.js";
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
export { subAgentFailureResponseEvaluator } from "./evaluators/sub-agent-failure.js";
// Providers
export { activeSubAgentsProvider } from "./providers/active-sub-agents.js";
export {
  acpAvailableAgentsProvider,
  availableAgentsProvider,
} from "./providers/available-agents.js";
// ACP service surface.
export { AcpService } from "./services/acp-service.js";
// Terminal-output normalizer for chat surfaces; consumed by live smoke harnesses.
export { cleanForChat } from "./services/ansi-utils.js";
export {
  COMPLETION_ENVELOPE_INSTRUCTION,
  type CompletionEnvelope,
  envelopeCorrection,
  parseCompletionEnvelope,
  summarizeEnvelope,
} from "./services/completion-envelope.js";
export {
  buildIndependentVerifierPrompt,
  type IndependentVerifierVerdict,
  runIndependentVerification,
  shouldRunIndependentVerify,
  verifierVerdict,
} from "./services/independent-verifier.js";
export {
  collectScreenshotPaths,
  deliverScreenshots,
  screenshotsToAttachments,
} from "./services/screenshot-delivery.js";
export {
  AcpSessionStore,
  FileSessionStore,
  InMemorySessionStore,
  RuntimeDbSessionStore,
} from "./services/session-store.js";
export { SubAgentRouter } from "./services/sub-agent-router.js";
// SWARM_COORDINATOR adapter — discoverable by the server's coordinator-bridge
// wiring and plugin-app-control's verification-room-bridge.
export {
  SWARM_COORDINATOR_SERVICE_TYPE,
  SwarmCoordinatorService,
  type SwarmEvent,
  type SwarmEventListener,
} from "./services/swarm-coordinator-service.js";
export {
  composeRoomDigest,
  runSupervisorTick,
  type SupervisorTaskView,
  statusEmoji,
  TASK_SUPERVISOR_SERVICE_TYPE,
  TaskSupervisorService,
} from "./services/task-supervisor-service.js";
export {
  detectStalledSessions,
  STALL_GRILL_PROMPT,
  TASK_WATCHDOG_SERVICE_TYPE,
  TaskWatchdogService,
  type WatchdogSessionView,
} from "./services/task-watchdog-service.js";
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
