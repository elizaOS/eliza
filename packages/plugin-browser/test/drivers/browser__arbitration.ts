// spec/browser/arbitration.md, "Story: Keep task binding authority on its original browser"
import type { Driver } from "../../gen/browser__arbitration.conformance.ts"
import type { BrowserArbitration, Event } from "../../gen/browser__arbitration.ts"
import { createBrowserArbitrationSession, type BrowserArbitrationSession } from "../../src/index.vibe"

const sessions = new Map<string, BrowserArbitrationSession>()

function sessionFor(key: string): BrowserArbitrationSession {
  const existing = sessions.get(key)
  if (existing !== undefined) return existing
  const created = createBrowserArbitrationSession()
  sessions.set(key, created)
  return created
}

export const driver: Driver<BrowserArbitration> = {
  reset() {
    sessions.clear()
  },
  async dispatch(key: string, event: Event) {
    const session = sessionFor(key)
    let ok = false
    switch (event.type) {
      case "beginBind":
        ok = await session.beginBind(event.epoch)
        break
      case "choosePeer":
        ok = await session.choosePeer(event.active)
        break
      case "finishBind":
        ok = await session.finishBind(event.peerAccepted)
        break
      case "otherBind":
        ok = await session.otherBind(event.competitor)
        break
      case "revokeBrowser":
        ok = await session.revokeBrowser(event.epoch)
        break
      case "stopTargets":
        ok = await session.stopTargets()
        break
    }
    return ok ? "accepted" : "refused"
  },
  async observe(key: string): Promise<BrowserArbitration> {
    return sessionFor(key).snapshot()
  },
}

export const options = { keys: ["task-a", "task-b"] }
