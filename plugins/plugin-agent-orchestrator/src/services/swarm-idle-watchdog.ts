/**
 * Swarm Coordinator — Idle Watchdog
 *
 * Extracted from swarm-coordinator.ts for modularity.
 * Scans active sessions for idle ones and asks the LLM to assess their state.
 *
 * @module services/swarm-idle-watchdog
 */

import { ModelType } from "@elizaos/core";
import { cleanForChat, stripAnsi } from "./ansi-utils.js";
import type {
  SwarmCoordinatorContext,
  TaskContext,
} from "./swarm-coordinator.js";
import {
  buildIdleCheckPrompt,
  type CoordinationLLMResponse,
  type DecisionHistoryEntry,
  parseCoordinationResponse,
  type SiblingTaskSummary,
  type TaskContextSummary,
} from "./swarm-coordinator-prompts.js";
import {
  checkAllTasksComplete,
  executeDecision,
} from "./swarm-decision-loop.js";
import { withTrajectoryContext } from "./trajectory-context.js";

// ─── Constants ───

/** How long a session can be idle before the watchdog checks on it (ms). */
export const IDLE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

/** Max idle checks before force-escalating a session. */
export const MAX_IDLE_CHECKS = 4;

// ─── Idle Watchdog ───

/**
 * Scan all active sessions for idle ones. Called periodically by the watchdog timer.
 */
export async function scanIdleSessions(
  ctx: SwarmCoordinatorContext,
): Promise<void> {
  const now = Date.now();
  for (const taskCtx of ctx.tasks.values()) {
    // Always run the liveness check — a task stuck at "blocked"
    // (login_required, pending_approval, ...) whose PTY has actually
    // exited would otherwise remain blocked forever and prevent the
    // swarm from reaching a terminal state, so synthesis never fires.
    // The status-based skip only applies to the idle-timer path below.
    if (ctx.ptyService) {
      const session = ctx.ptyService.getSession(taskCtx.sessionId);
      if (
        !session &&
        taskCtx.status !== "completed" &&
        taskCtx.status !== "stopped" &&
        taskCtx.status !== "error"
      ) {
        const completionSummary = taskCtx.completionSummary?.trim();
        if (completionSummary) {
          ctx.log(
            `Idle watchdog: "${taskCtx.label}" — PTY session is gone after captured completion, marking completed`,
          );
          taskCtx.status = "completed";
          await ctx.syncTaskContext(taskCtx);
          checkAllTasksComplete(ctx);
          continue;
        }

        ctx.log(
          `Idle watchdog: "${taskCtx.label}" — PTY session no longer exists, marking as stopped`,
        );
        taskCtx.status = "stopped";
        taskCtx.stoppedAt = now;
        await ctx.recordDecision(taskCtx, {
          timestamp: now,
          event: "idle_watchdog",
          promptText: "PTY session no longer exists",
          decision: "stopped",
          reasoning:
            "Underlying PTY process is gone (likely killed during restart)",
        });
        ctx.broadcast({
          type: "stopped",
          sessionId: taskCtx.sessionId,
          timestamp: now,
          data: { reason: "pty_session_gone" },
        });
        ctx.sendChatMessage(
          `[${taskCtx.label}] Session lost — the agent process is no longer running (likely killed during a restart).`,
          "coding-agent",
        );
        checkAllTasksComplete(ctx);
        continue;
      }
    }

    // Idle-timer path below only applies to live, running sessions — skip
    // anything already in a non-running state.
    if (taskCtx.status !== "active" && taskCtx.status !== "tool_running") {
      continue;
    }

    const idleMs = now - taskCtx.lastActivityAt;
    if (idleMs < IDLE_THRESHOLD_MS) continue;

    // Skip if already checking this session
    if (ctx.inFlightDecisions.has(taskCtx.sessionId)) continue;

    // Check if PTY output has changed since last scan — if data is flowing,
    // the session is active even without named events (e.g. loading spinners).
    // Compare stripped output to ignore TUI cursor movements and redraws
    // that would otherwise fool the watchdog into thinking the session is active.
    if (ctx.ptyService) {
      try {
        const rawOutput = await ctx.ptyService.getSessionOutput(
          taskCtx.sessionId,
          20,
        );
        const currentOutput = stripAnsi(rawOutput).trim();
        const lastSeen = ctx.lastSeenOutput.get(taskCtx.sessionId) ?? "";
        ctx.lastSeenOutput.set(taskCtx.sessionId, currentOutput);
        if (currentOutput !== lastSeen) {
          // Output changed — session is producing data, reset idle state
          taskCtx.lastActivityAt = now;
          taskCtx.idleCheckCount = 0;
          ctx.log(
            `Idle watchdog: "${taskCtx.label}" has fresh PTY output — not idle`,
          );
          continue;
        }
      } catch {
        // Can't read output — proceed with idle check
      }

      // Even if the visible 20-line tail didn't change, trust the adapter's
      // own "I am busy" signal. TUIs like Codex redraw their status row
      // ("Working (Xs • esc to interrupt)") in place via cursor positioning,
      // so consecutive ANSI-stripped tails can collapse to identical text
      // even while the model is actively reasoning for minutes. The adapter's
      // detectLoading() runs against the full buffer and is the source of
      // truth for "is the agent processing right now".
      try {
        const isLoading = await ctx.ptyService.isSessionLoading(
          taskCtx.sessionId,
        );
        if (isLoading) {
          taskCtx.lastActivityAt = now;
          taskCtx.idleCheckCount = 0;
          ctx.log(
            `Idle watchdog: "${taskCtx.label}" adapter reports loading — not idle`,
          );
          continue;
        }
      } catch {
        // Fall through to the LLM idle check if we can't query the adapter.
      }
    }

    taskCtx.idleCheckCount++;
    const idleMinutes = Math.round(idleMs / 60_000);
    ctx.log(
      `Idle watchdog: "${taskCtx.label}" idle for ${idleMinutes}m (check ${taskCtx.idleCheckCount}/${MAX_IDLE_CHECKS})`,
    );

    if (taskCtx.idleCheckCount >= MAX_IDLE_CHECKS) {
      // Force-stop — too many idle checks with no resolution
      ctx.log(
        `Idle watchdog: force-stopping "${taskCtx.label}" after ${MAX_IDLE_CHECKS} checks`,
      );
      taskCtx.status = "stopped";
      taskCtx.stoppedAt = now;
      await ctx.recordDecision(taskCtx, {
        timestamp: now,
        event: "idle_watchdog",
        promptText: `Session idle for ${idleMinutes} minutes`,
        decision: "stopped",
        reasoning: `Force-stopped after ${MAX_IDLE_CHECKS} idle checks with no activity`,
      });
      ctx.broadcast({
        type: "stopped",
        sessionId: taskCtx.sessionId,
        timestamp: now,
        data: {
          reason: "idle_watchdog_max_checks",
          idleMinutes,
          idleCheckCount: taskCtx.idleCheckCount,
        },
      });
      ctx.sendChatMessage(
        `[${taskCtx.label}] Session stopped — idle for ${idleMinutes} minutes with no progress.`,
        "coding-agent",
      );
      // Force-kill the PTY session — idle timeout means nothing to save.
      if (ctx.ptyService) {
        try {
          await ctx.ptyService.stopSession(taskCtx.sessionId, /* force */ true);
        } catch (err) {
          ctx.log(
            `Idle watchdog: failed to stop session ${taskCtx.sessionId}: ${err}`,
          );
          taskCtx.status = "error";
          await ctx.syncTaskContext(taskCtx);
          ctx.broadcast({
            type: "error",
            sessionId: taskCtx.sessionId,
            timestamp: now,
            data: { message: `Failed to stop idle session: ${err}` },
          });
        }
      }
      // Check if all tasks are now done
      checkAllTasksComplete(ctx);
      continue;
    }

    // Ask the LLM what's going on
    await handleIdleCheck(ctx, taskCtx, idleMinutes);
  }
}

/**
 * Handle an idle session by asking the LLM to assess its state.
 */
export async function handleIdleCheck(
  ctx: SwarmCoordinatorContext,
  taskCtx: TaskContext,
  idleMinutes: number,
): Promise<void> {
  const sessionId = taskCtx.sessionId;
  ctx.inFlightDecisions.add(sessionId);
  try {
    let recentOutput = "";
    if (ctx.ptyService) {
      try {
        const raw = await ctx.ptyService.getSessionOutput(sessionId, 50);
        recentOutput = cleanForChat(raw);
      } catch {
        recentOutput = "";
      }
    }

    const contextSummary: TaskContextSummary = {
      sessionId,
      agentType: taskCtx.agentType,
      label: taskCtx.label,
      originalTask: taskCtx.originalTask,
      workdir: taskCtx.workdir,
    };

    const decisionHistory: DecisionHistoryEntry[] = taskCtx.decisions
      .filter((d) => d.decision !== "auto_resolved")
      .slice(-5)
      .map((d) => ({
        event: d.event,
        promptText: d.promptText,
        action: d.decision,
        response: d.response,
        reasoning: d.reasoning,
      }));

    const siblings: SiblingTaskSummary[] = [];
    for (const [sid, task] of ctx.tasks) {
      if (sid === sessionId) continue;
      siblings.push({
        label: task.label,
        agentType: task.agentType,
        originalTask: task.originalTask,
        status: task.status,
      });
    }

    const prompt = buildIdleCheckPrompt(
      contextSummary,
      recentOutput,
      idleMinutes,
      taskCtx.idleCheckCount,
      MAX_IDLE_CHECKS,
      decisionHistory,
      siblings,
      ctx.sharedDecisions,
      ctx.getSwarmContext(),
    );

    let decision: CoordinationLLMResponse | null = null;
    try {
      const result = await withTrajectoryContext(
        ctx.runtime,
        {
          source: "orchestrator",
          decisionType: "idle-check",
          sessionId,
          taskLabel: taskCtx.label,
          repo: taskCtx.repo,
          workdir: taskCtx.workdir,
          originalTask: taskCtx.originalTask,
        },
        () => ctx.runtime.useModel(ModelType.TEXT_SMALL, { prompt }),
      );
      decision = parseCoordinationResponse(result);
    } catch (err) {
      ctx.log(`Idle check LLM call failed: ${err}`);
    }

    if (!decision) {
      ctx.log(
        `Idle check for "${taskCtx.label}": LLM returned invalid response — escalating`,
      );
      ctx.sendChatMessage(
        `[${taskCtx.label}] Session idle for ${idleMinutes}m — couldn't determine status. Needs your attention.`,
        "coding-agent",
      );
      return;
    }

    // Record the decision
    await ctx.recordDecision(taskCtx, {
      timestamp: Date.now(),
      event: "idle_watchdog",
      promptText: `Session idle for ${idleMinutes} minutes`,
      decision: decision.action,
      response:
        decision.action === "respond"
          ? decision.useKeys
            ? `keys:${decision.keys?.join(",")}`
            : decision.response
          : undefined,
      reasoning: decision.reasoning,
    });

    ctx.broadcast({
      type: "idle_check_decision",
      sessionId,
      timestamp: Date.now(),
      data: {
        action: decision.action,
        idleMinutes,
        idleCheckNumber: taskCtx.idleCheckCount,
        reasoning: decision.reasoning,
      },
    });

    // Send chat message
    if (decision.action === "complete") {
      // executeDecision handles chat + stop for "complete"
    } else if (decision.action === "respond") {
      const actionDesc = decision.useKeys
        ? `Sent keys: ${decision.keys?.join(", ")}`
        : `Nudged: ${decision.response ?? ""}`;
      ctx.log(`[${taskCtx.label}] Idle for ${idleMinutes}m — ${actionDesc}`);
    } else if (decision.action === "escalate") {
      ctx.sendChatMessage(
        `[${taskCtx.label}] Idle for ${idleMinutes}m — needs your attention: ${decision.reasoning}`,
        "coding-agent",
      );
    } else if (decision.action === "ignore") {
      ctx.log(
        `Idle check for "${taskCtx.label}": LLM says still working — ${decision.reasoning}`,
      );
    }

    await executeDecision(ctx, sessionId, decision);
  } finally {
    ctx.inFlightDecisions.delete(sessionId);
  }
}
