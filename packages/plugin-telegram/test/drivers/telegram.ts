// spec/telegram/index.md, "Story: Run one Telegram long-poller for each bot credential"
import type { Driver } from "../../gen/telegram.conformance.ts"
import type { Event, TelegramCaller, TelegramPoller } from "../../gen/telegram.ts"
import { createTelegramPollerSession, type TelegramPollerSession } from "../../src/index.vibe"

const sessions = new Map<string, TelegramPollerSession>()

function sessionFor(key: string): TelegramPollerSession {
  const existing = sessions.get(key)
  if (existing !== undefined) return existing
  const created = createTelegramPollerSession()
  sessions.set(key, created)
  return created
}

export const driver: Driver<TelegramPoller> = {
  reset() {
    sessions.clear()
  },
  async dispatch(key: string, event: Event, sender?: TelegramCaller) {
    const session = sessionFor(key)
    const by: TelegramCaller = sender ?? "TelegramHost"
    let ok = false
    switch (event.type) {
      case "claimTelegramPoller":
        ok = await session.claim(event.claim, by)
        break
      case "connectTelegramPoller":
        ok = await session.connect(event.claim, event.updatedAt, by)
        break
      case "observeTelegramUpdate":
        ok = await session.observeUpdate(event.claim, event.updatedAt, by)
        break
      case "terminateTelegramPoller":
        ok = await session.terminate(event.claim, by)
        break
      case "releaseTelegramPoller":
        ok = await session.release(event.claim, by)
        break
    }
    return ok ? "accepted" : "refused"
  },
  async observe(key: string): Promise<TelegramPoller> {
    return sessionFor(key).snapshot()
  },
}

export const options = { keys: ["bot-a", "bot-b"] }
