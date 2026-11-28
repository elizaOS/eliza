// spec/nativeWebsiteblocker/session.md, "Story: Track an active website block session from install through removal or expiry"
import type { Driver } from "../../gen/nativeWebsiteblocker__session.conformance.ts"
import { createWebsiteBlockerSession, type WebsiteBlockerSession } from "../../src/index.vibe"

let sessions = new Map<string, WebsiteBlockerSession>()

function sessionFor(key: string): WebsiteBlockerSession {
  let session = sessions.get(key)
  if (!session) {
    session = createWebsiteBlockerSession()
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
      case "startWebsiteSession":
        return session.start(event.granted, event.domainCount, event.nowMs, event.deadlineMs) ? "accepted" : "refused"
      case "stopWebsiteSession":
        return session.stop() ? "accepted" : "refused"
      case "expireWebsiteSession":
        return session.expire(event.nowMs) ? "accepted" : "refused"
    }
  },
  observe(key) {
    return sessionFor(key).state()
  },
}
