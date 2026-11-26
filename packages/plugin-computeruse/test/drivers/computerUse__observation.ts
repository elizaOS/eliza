// spec/computerUse/observation.md, "Story: Minimize vision tokens while keeping coordinates and history strictly bounded"
import type { Driver } from "../../gen/computerUse__observation.conformance.ts"
import type { Event, ObservationWindow } from "../../gen/computerUse__observation.ts"
import { ScreenStateStore } from "../../src/scene.vibe"

let stores = new Map<string, ScreenStateStore>()

function forKey(key: string): ScreenStateStore {
  let store = stores.get(key)
  if (!store) {
    store = new ScreenStateStore()
    stores.set(key, store)
  }
  return store
}

export const driver: Driver = {
  reset() {
    stores = new Map<string, ScreenStateStore>()
    return Promise.resolve()
  },
  dispatch(key: string, event: Event) {
    const store = forKey(key)
    const before = store.getObservationWindow()
    const after = store.stepObservation(event)
    const changed = after.entries !== before.entries
      || after.retainedImages !== before.retainedImages
      || after.framesCaptured !== before.framesCaptured
      || after.framesDeduplicated !== before.framesDeduplicated
      || after.tokensSaved !== before.tokensSaved
    return Promise.resolve(changed ? "accepted" : "refused")
  },
  observe(key: string): Promise<ObservationWindow> {
    return Promise.resolve(forKey(key).getObservationWindow())
  },
}

export const options = { keys: ["a", "b"] }
