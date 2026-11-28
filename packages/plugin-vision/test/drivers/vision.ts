// spec/vision/index.md, "Story: Control which of my visual sources the assistant can use"
import type { Driver } from "../../gen/vision.conformance.ts"
import type { Event, VisionState } from "../../gen/vision.ts"
import { VisionCaptureController } from "../../src/index.vibe"

const controllers = new Map<string, VisionCaptureController>()

function controllerFor(key: string): VisionCaptureController {
  let controller = controllers.get(key)
  if (!controller) {
    controller = new VisionCaptureController()
    controllers.set(key, controller)
  }
  return controller
}

export const driver: Driver<VisionState> = {
  reset() {
    controllers.clear()
    return Promise.resolve()
  },
  dispatch(key: string, event: Event) {
    const controller = controllerFor(key)
    let ok = false
    if (event.type === "configureVision") {
      ok = controller.configure({
        mode: event.mode,
        cameraConnected: event.cameraConnected,
        screenConnected: event.screenConnected,
        protectedScreen: event.protectedScreen,
        revision: event.revision,
      })
    } else if (event.type === "requestCapture") {
      ok = controller.request({
        captureId: event.captureId,
        source: event.source,
        purpose: event.purpose,
        includeImage: event.includeImage,
      })
    } else if (event.type === "acceptCameraOrScreen") {
      ok = controller.accept({
        captureId: event.captureId,
        source: event.source,
        revision: event.revision,
        frameRef: event.frameRef,
      })
    } else if (event.type === "failCapture") {
      ok = controller.fail(event.captureId, event.revision)
    } else if (event.type === "retireCapture") {
      ok = controller.retire(event.captureId, event.revision)
    }
    return Promise.resolve(ok ? "accepted" : "refused")
  },
  observe(key: string): Promise<VisionState> {
    return Promise.resolve(controllerFor(key).getState())
  },
}

export const options = { keys: ["vision-a", "vision-b"] }
