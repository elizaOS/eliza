// spec/assistant/agreements.md, "Agreements and handoffs enforce monotonic revisions and owner-reviewed fencing"
import type { Driver } from "../../gen/assistant__agreements.conformance.ts"
import type { AgreementHandoffState, Event } from "../../gen/assistant__agreements.ts"
import { AgreementHandoffController } from "../../src/index.vibe"

const controllers = new Map<string, AgreementHandoffController>()

function controllerFor(key: string): AgreementHandoffController {
  let controller = controllers.get(key)
  if (!controller) {
    controller = new AgreementHandoffController()
    controllers.set(key, controller)
  }
  return controller
}

export const driver: Driver<AgreementHandoffState> = {
  reset() {
    controllers.clear()
    return Promise.resolve()
  },
  dispatch(key: string, event: Event) {
    const controller = controllerFor(key)
    let ok = false
    if (event.type === "proposeAgreement") ok = controller.proposeAgreement()
    else if (event.type === "confirmAgreement") ok = controller.confirmAgreement(event.rev)
    else if (event.type === "fenceAgreement") ok = controller.fenceAgreement()
    else if (event.type === "deleteAgreement") ok = controller.deleteAgreement()
    else if (event.type === "saveHandoffChoices") ok = controller.saveHandoffChoices()
    else if (event.type === "deriveHandoffReview") ok = controller.deriveHandoffReview(event.rev)
    else if (event.type === "beginHandoffExecution") ok = controller.beginHandoffExecution(event.rev)
    else if (event.type === "advanceHandoffCheckpoint") ok = controller.advanceHandoffCheckpoint()
    else if (event.type === "completeHandoff") ok = controller.completeHandoff()
    else if (event.type === "abortHandoff") ok = controller.abortHandoff()
    return Promise.resolve(ok ? "accepted" : "refused")
  },
  observe(key: string): Promise<AgreementHandoffState> {
    return Promise.resolve(controllerFor(key).getState())
  },
}

export const options = { keys: ["agr-a", "agr-b"] }
