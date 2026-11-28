// spec/browser/websiteGoal.md, "Story: Preserve a checked answer while honoring the task's completion and ownership fences"
import type { Driver } from "../../gen/browser__websiteGoal.conformance.ts"
import type { Event, WebsiteResult } from "../../gen/browser__websiteGoal.ts"
import { createWebsiteGoalSession, type WebsiteGoalSession } from "../../src/index.vibe"

const sessions = new Map<string, WebsiteGoalSession>()

function sessionFor(key: string): WebsiteGoalSession {
  const existing = sessions.get(key)
  if (existing !== undefined) return existing
  const created = createWebsiteGoalSession()
  sessions.set(key, created)
  return created
}

export const driver: Driver<WebsiteResult> = {
  reset() {
    sessions.clear()
  },
  async dispatch(key: string, event: Event) {
    const session = sessionFor(key)
    let ok = false
    switch (event.type) {
      case "saveReading":
        ok = await session.saveReading(event.reading, event.clock, event.ownerCurrent)
        break
      case "completeReading":
        ok = await session.completeReading(event.ownerCurrent, event.unresolved)
        break
      case "sweepReading":
        ok = await session.sweepReading(event.clock)
        break
    }
    return ok ? "accepted" : "refused"
  },
  async observe(key: string): Promise<WebsiteResult> {
    return sessionFor(key).snapshot()
  },
}

export const options = { keys: ["goal-a", "goal-b"] }
