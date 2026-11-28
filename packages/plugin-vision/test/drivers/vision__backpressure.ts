// spec/vision/backpressure.md, "Scene description admits work only when memory, arbiter, concurrency, and circuit state permit"
import type { Driver } from "../../gen/vision__backpressure.conformance.ts"
import type { BackpressureState, Event } from "../../gen/vision__backpressure.ts"
import { DescribeBackpressureController } from "../../src/index.vibe"

const controllers = new Map<string, DescribeBackpressureController>()

function controllerFor(key: string): DescribeBackpressureController {
  let controller = controllers.get(key)
  if (!controller) {
    controller = new DescribeBackpressureController()
    controllers.set(key, controller)
  }
  return controller
}

export const driver: Driver<BackpressureState> = {
  reset() {
    controllers.clear()
    return Promise.resolve()
  },
  dispatch(key: string, event: Event) {
    const controller = controllerFor(key)
    let ok = false
    if (event.type === "setPressure") {
      const before = controller.getSpecState().pressure
      if (event.nextPressure !== before) {
        controller.setPressure(
          event.nextPressure === "PressureCritical"
            ? "critical"
            : event.nextPressure === "PressureElevated"
              ? "elevated"
              : "normal",
        )
        ok = true
      }
    } else if (event.type === "setArbiter") {
      const before = controller.getSpecState().arbiterAllowed
      if (event.allowed !== before) {
        controller.setArbiterAllowed(event.allowed)
        ok = true
      }
    } else if (event.type === "acquireDescribe") {
      ok = controller.acquire()
    } else if (event.type === "finishSuccess") {
      ok = controller.finishSuccess()
    } else if (event.type === "finishFailure") {
      ok = controller.finishFailure()
    } else if (event.type === "resetCircuit") {
      ok = controller.resetCircuit()
    }
    return Promise.resolve(ok ? "accepted" : "refused")
  },
  observe(key: string): Promise<BackpressureState> {
    return Promise.resolve(controllerFor(key).getSpecState())
  },
}

export const options = { keys: ["bp-a", "bp-b"] }
