// spec/nativeLocation/index.md, "A watch reports under the identifier it acquired until that watch is cleared"
import type { Driver } from "../../gen/nativeLocation.conformance.ts"
import type { Event, LocationWatch } from "../../gen/nativeLocation.ts"
import { createLocationWatchHandle, type LocationWatchMachineHandle } from "../../src/index.vibe"

const handles = new Map<string, LocationWatchMachineHandle>()

function forKey(key: string): LocationWatchMachineHandle {
  const existing = handles.get(key)
  if (existing) return existing
  const created = createLocationWatchHandle()
  handles.set(key, created)
  return created
}

export const driver: Driver<LocationWatch> = {
  reset() {
    handles.clear()
  },
  dispatch(key: string, event: Event) {
    return forKey(key).dispatch(event)
  },
  observe(key: string): LocationWatch {
    return forKey(key).state()
  },
  receive(key: string, raw: unknown) {
    return forKey(key).receive(raw)
  },
}

export const options = { keys: ["a", "b"] }
