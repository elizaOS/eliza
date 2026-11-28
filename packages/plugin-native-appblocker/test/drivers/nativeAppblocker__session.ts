// spec/nativeAppblocker/session.md, "Story: Track an active app block session from start through unblock or expiry"
import type { Driver } from "../../gen/nativeAppblocker__session.conformance.ts"
import { createAppBlockerSession, type AppBlockerSession } from "../../src/index.vibe"

let sessions = new Map<string, AppBlockerSession>()

function sessionFor(key: string): AppBlockerSession {
  let session = sessions.get(key)
  if (!session) {
    session = createAppBlockerSession()
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
      case "startAppBlockSession":
        return session.start(event.granted, event.selectedCount, event.nowMs, event.deadlineMs) ? "accepted" : "refused"
      case "stopAppBlockSession":
        return session.stop() ? "accepted" : "refused"
      case "expireAppBlockSession":
        return session.expire(event.nowMs) ? "accepted" : "refused"
    }
  },
  observe(key) {
    return sessionFor(key).state()
  },
}
