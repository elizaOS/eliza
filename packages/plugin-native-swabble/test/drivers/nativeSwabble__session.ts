// spec/nativeSwabble/session.md, "Each wake start or device switch advances the lease generation and stop clears the active lease"
import type { Driver } from "../../gen/nativeSwabble__session.conformance.ts"
import type { Event, WakeSessionState } from "../../gen/nativeSwabble__session.ts"
import { createSwabbleSessionHandle, type SwabbleSessionMachineHandle } from "../../src/index.vibe"

const handles = new Map<string, SwabbleSessionMachineHandle>()

function forKey(key: string): SwabbleSessionMachineHandle {
  const existing = handles.get(key)
  if (existing) return existing
  const created = createSwabbleSessionHandle()
  handles.set(key, created)
  return created
}

export const driver: Driver<WakeSessionState> = {
  reset() {
    handles.clear()
  },
  dispatch(key: string, event: Event) {
    return forKey(key).dispatch(event)
  },
  observe(key: string): WakeSessionState {
    return forKey(key).state()
  },
  receive(key: string, raw: unknown) {
    return forKey(key).receive(raw)
  },
}

export const options = { keys: ["a", "b"] }
