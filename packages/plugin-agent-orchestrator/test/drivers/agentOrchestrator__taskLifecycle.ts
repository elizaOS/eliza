// spec/agentOrchestrator/taskLifecycle.md, "Story: Track an orchestrated coding task from creation through verified completion"
import { Effect, Exit } from "effect"
import type { Driver, Options } from "../../gen/agentOrchestrator__taskLifecycle.conformance.ts"
import type { Event, TaskLifecycle } from "../../gen/agentOrchestrator__taskLifecycle.ts"
import { OrchestratorTaskService } from "../../src/index.vibe"

let service = new OrchestratorTaskService()
const taskIds = new Map<string, string>()

function ensureTask(key: string): string {
  const existing = taskIds.get(key)
  if (existing) return existing
  const created = service.createTask({ title: `task-${key}`, goal: `goal-${key}` })
  taskIds.set(key, created.task.id)
  return created.task.id
}

export const driver: Driver = {
  reset() {
    service = new OrchestratorTaskService()
    taskIds.clear()
  },
  async dispatch(key: string, event: Event) {
    const id = ensureTask(key)
    const exit = await Effect.runPromiseExit(service.transitionTask(id, event, `conformance:${event.type}`))
    return Exit.isSuccess(exit) ? "accepted" : "refused"
  },
  observe(key: string): TaskLifecycle {
    const id = ensureTask(key)
    return service.getLifecycleState(id)!
  },
}

export const options: Options = { keys: ["t1", "t2"] }
