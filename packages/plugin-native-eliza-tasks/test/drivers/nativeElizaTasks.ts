// spec/nativeElizaTasks/index.md, "Story: Schedule a background wake without stacking duplicate requests"
import type { Driver } from "../../gen/nativeElizaTasks.conformance.ts"
import { createElizaTaskScheduleSession, type ElizaTaskScheduleSession } from "../../src/index.vibe"

let sessions = new Map<string, ElizaTaskScheduleSession>()

function sessionFor(key: string): ElizaTaskScheduleSession {
  let session = sessions.get(key)
  if (!session) {
    session = createElizaTaskScheduleSession()
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
      case "scheduleNext":
        return session.scheduleNext(event.nowMs, event.delayMs, event.platformAccepted, event.alsoProcessing) ? "accepted" : "refused"
      case "cancelWakes":
        return session.cancelWakes() ? "accepted" : "refused"
      case "recordWake":
        return session.recordWake(event.kind, event.nowMs, event.remotePushEnabled) ? "accepted" : "refused"
    }
  },
  observe(key) {
    return sessionFor(key).state()
  },
}
