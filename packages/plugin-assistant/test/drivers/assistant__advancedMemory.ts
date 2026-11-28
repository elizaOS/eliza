// spec/assistant/advancedMemory.md, "Memory consolidation and first-run onboarding preserve capacity and completion invariants"
import type { Driver } from "../../gen/assistant__advancedMemory.conformance.ts"
import type { Event, MemoryFirstRunState } from "../../gen/assistant__advancedMemory.ts"
import { MemoryFirstRunController } from "../../src/index.vibe"

const controllers = new Map<string, MemoryFirstRunController>()

function controllerFor(key: string): MemoryFirstRunController {
  let controller = controllers.get(key)
  if (!controller) {
    controller = new MemoryFirstRunController()
    controllers.set(key, controller)
  }
  return controller
}

export const driver: Driver<MemoryFirstRunState> = {
  reset() {
    controllers.clear()
    return Promise.resolve()
  },
  dispatch(key: string, event: Event) {
    const controller = controllerFor(key)
    let ok = false
    if (event.type === "recordMemoryItem") ok = controller.recordMemoryItem()
    else if (event.type === "consolidateSummary") ok = controller.consolidateSummary()
    else if (event.type === "evictOldestMemory") ok = controller.evictOldestMemory()
    else if (event.type === "startFirstRun") ok = controller.startFirstRun()
    else if (event.type === "answerFirstRunQuestion") ok = controller.answerFirstRunQuestion()
    else if (event.type === "completeFirstRun") ok = controller.completeFirstRun()
    else if (event.type === "skipFirstRun") ok = controller.skipFirstRun()
    return Promise.resolve(ok ? "accepted" : "refused")
  },
  observe(key: string): Promise<MemoryFirstRunState> {
    return Promise.resolve(controllerFor(key).getState())
  },
}

export const options = { keys: ["mem-a", "mem-b"] }
