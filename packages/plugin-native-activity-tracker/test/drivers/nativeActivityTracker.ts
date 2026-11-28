// spec/nativeActivityTracker/index.md, "Story: Observe my desktop activity while my collector is running"
import type { Driver } from "../../gen/nativeActivityTracker.conformance.ts"
import { createCollectorSession, type CollectorSession } from "../../src/index.vibe"

let sessions = new Map<string, CollectorSession>()

function sessionFor(key: string): CollectorSession {
  let session = sessions.get(key)
  if (!session) {
    session = createCollectorSession()
    sessions.set(key, session)
  }
  return session
}

export const driver: Driver = {
  reset() {
    sessions = new Map()
  },
  dispatch(key, event) {
    const session = sessionFor(key)
    switch (event.type) {
      case "startCollector":
        return session.start(event.platform, event.binaryPresent) ? "accepted" : "refused"
      case "stopCollector":
        return session.stop() ? "accepted" : "refused"
      case "observeCollectorExit":
        return session.observeExit(event.generation) ? "accepted" : "refused"
    }
  },
  observe(key) {
    return sessionFor(key).state()
  },
}
