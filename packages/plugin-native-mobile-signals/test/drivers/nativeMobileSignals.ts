// spec/nativeMobileSignals/index.md, "Story: Observe only the mobile signals I have authorized"
import type { Driver } from "../../gen/nativeMobileSignals.conformance.ts"
import { createMobileSignalsMonitorSession, type MobileSignalsMonitorSession } from "../../src/index.vibe"

let sessions = new Map<string, MobileSignalsMonitorSession>()

function sessionFor(key: string): MobileSignalsMonitorSession {
  let session = sessions.get(key)
  if (!session) {
    session = createMobileSignalsMonitorSession()
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
      case "startMonitoring":
        return session.start(event.supported) ? "accepted" : "refused"
      case "stopMonitoring":
        return session.stop() ? "accepted" : "refused"
    }
  },
  observe(key) {
    return sessionFor(key).state()
  },
}
