// spec/scheduling/dispatch.md, "Task execution guards transitions by revision and freezes terminal states"
import type { Driver, Options } from "../../gen/scheduling__dispatch.conformance.ts"
import type { TaskExecution, TaskLifecycle } from "../../gen/scheduling__dispatch.ts"
import { ScheduledTaskRunner } from "@elizaos/plugin-scheduling"

interface Session {
  readonly runner: ScheduledTaskRunner
  readonly taskId: string
}

const sessions = new Map<string, Session>()

function toLifecycle(status: string): TaskLifecycle {
  if (status === "fired") return "TaskFired"
  if (status === "acknowledged") return "TaskAcknowledged"
  if (status === "completed") return "TaskCompleted"
  if (status === "skipped") return "TaskSkipped"
  if (status === "expired") return "TaskExpired"
  if (status === "dismissed") return "TaskDismissed"
  if (status === "failed") return "TaskFailed"
  return "TaskScheduled"
}

async function sessionOf(key: string): Promise<Session> {
  const existing = sessions.get(key)
  if (existing !== undefined) return existing
  const runner = new ScheduledTaskRunner({
    agentId: `agent-${key}`,
    dispatcher: () => Promise.resolve({ ok: true, messageId: "ok" }),
  })
  const task = await runner.create({
    id: `task-${key}`,
    ownerId: "owner-1",
    title: "Conformance task",
    priority: "high",
    trigger: { kind: "manual" },
  })
  const created: Session = { runner, taskId: task.id }
  sessions.set(key, created)
  return created
}

export const driver: Driver<TaskExecution> = {
  reset() {
    for (const session of sessions.values()) {
      session.runner.store.close()
    }
    sessions.clear()
  },
  async dispatch(key, event) {
    const session = await sessionOf(key)
    switch (event.type) {
      case "fireTask": {
        const res = await session.runner.fire(session.taskId, {
          manual: true,
          seenRevision: event.seenRevision,
        })
        return res.kind === "fired" ? "accepted" : "refused"
      }
      case "acknowledgeTask": {
        const res = await session.runner.apply(session.taskId, "acknowledge", {
          seenRevision: event.seenRevision,
        })
        return res.kind === "applied" ? "accepted" : "refused"
      }
      case "snoozeTask": {
        const res = await session.runner.apply(session.taskId, "snooze", {
          seenRevision: event.seenRevision,
          snoozeMinutes: 10,
        })
        return res.kind === "applied" ? "accepted" : "refused"
      }
      case "escalateStep": {
        const res = await session.runner.escalate(session.taskId, event.seenRevision, 3)
        return res.kind === "applied" ? "accepted" : "refused"
      }
      case "completeTask": {
        const res = await session.runner.apply(session.taskId, "complete", {
          seenRevision: event.seenRevision,
        })
        return res.kind === "applied" ? "accepted" : "refused"
      }
      case "settleTerminal": {
        const map: Record<string, "skipped" | "expired" | "dismissed" | "failed" | undefined> = {
          TaskSkipped: "skipped",
          TaskExpired: "expired",
          TaskDismissed: "dismissed",
          TaskFailed: "failed",
        }
        const target = map[event.terminalStatus]
        if (!target) return "refused"
        const res = await session.runner.pipeline(session.taskId, target, {
          seenRevision: event.seenRevision,
        })
        return res.kind === "applied" ? "accepted" : "refused"
      }
      default: {
        const unreachable: never = event
        return unreachable
      }
    }
  },
  observe(key): TaskExecution {
    const existing = sessions.get(key)
    const task = existing?.runner.store.getTask(existing.taskId)
    if (!task) {
      return { status: "TaskScheduled", revision: 0, occurrence: 0, stepIndex: 0, maxSteps: 3, receiptCount: 0 }
    }
    return {
      status: toLifecycle(task.state.status),
      revision: task.state.revision,
      occurrence: task.state.occurrence,
      stepIndex: task.state.stepIndex,
      maxSteps: 3,
      receiptCount: Object.keys(task.state.appliedReceipts).length,
    }
  },
}

export const options: Options<TaskExecution> = { keys: ["task-1"] }
