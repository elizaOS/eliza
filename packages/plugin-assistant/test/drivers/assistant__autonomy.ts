// spec/assistant/autonomy.md, "Autonomy respects enablement, global pause, interval bounds, and error ceilings"
import type { Driver } from "../../gen/assistant__autonomy.conformance.ts"
import type { AutonomyState, Event } from "../../gen/assistant__autonomy.ts"
import { AutonomyController } from "../../src/index.vibe"

const controllers = new Map<string, AutonomyController>()

function controllerFor(key: string): AutonomyController {
  let controller = controllers.get(key)
  if (!controller) {
    controller = new AutonomyController()
    controllers.set(key, controller)
  }
  return controller
}

export const driver: Driver<AutonomyState> = {
  reset() {
    controllers.clear()
    return Promise.resolve()
  },
  dispatch(key: string, event: Event) {
    const controller = controllerFor(key)
    let ok = false
    if (event.type === "enableAutonomy") ok = controller.enable()
    else if (event.type === "disableAutonomy") ok = controller.disable()
    else if (event.type === "setGlobalPause") ok = controller.setGlobalPause(event.paused)
    else if (event.type === "setIntervalMs") ok = controller.setIntervalMs(event.nextMs)
    else if (event.type === "startThink") ok = controller.startThink()
    else if (event.type === "finishThinkSuccess") ok = controller.finishThinkSuccess()
    else if (event.type === "finishThinkFailure") ok = controller.finishThinkFailure()
    return Promise.resolve(ok ? "accepted" : "refused")
  },
  observe(key: string): Promise<AutonomyState> {
    return Promise.resolve(controllerFor(key).getState())
  },
}

export const options = { keys: ["auto-a", "auto-b"] }
