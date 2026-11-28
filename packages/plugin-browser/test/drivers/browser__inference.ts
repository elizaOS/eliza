// spec/browser/inference.md, "Story: Send each model call through my account's route with private text removed, and drop stale results"
import type { Driver } from "../../gen/browser__inference.conformance.ts"
import type { Event, Inference } from "../../gen/browser__inference.ts"
import { createBrowserInferenceSession, type BrowserInferenceSession } from "../../src/index.vibe"

const sessions = new Map<string, BrowserInferenceSession>()

function sessionFor(key: string): BrowserInferenceSession {
  const existing = sessions.get(key)
  if (existing !== undefined) return existing
  const created = createBrowserInferenceSession()
  sessions.set(key, created)
  return created
}

export const driver: Driver<Inference> = {
  reset() {
    sessions.clear()
  },
  async dispatch(key: string, event: Event) {
    const session = sessionFor(key)
    let ok = false
    switch (event.type) {
      case "prepareInference":
        ok = await session.prepareInference(event.bodyId, event.accountRoute, event.content)
        break
      case "sendInference":
        ok = await session.sendInference()
        break
      case "finishQuotaWait":
        ok = await session.finishQuotaWait()
        break
      case "stopInference":
        ok = await session.stopInference()
        break
      case "reportInference":
        ok = await session.reportInference(event.reply, event.waitAcceptable, event.lookCurrent)
        break
    }
    return ok ? "accepted" : "refused"
  },
  async observe(key: string): Promise<Inference> {
    return sessionFor(key).snapshot()
  },
}

export const options = { keys: ["call-a", "call-b"] }
