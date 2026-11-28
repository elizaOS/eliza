// spec/telegram/delivery.md, "Story: Keep a pinned task board or progress status as one message across edits, deletions, and restarts"
import type { Driver } from "../../gen/telegram__delivery.conformance.ts"
import type { Event, TelegramSlotState } from "../../gen/telegram__delivery.ts"
import { createTelegramSlotSession, type TelegramSlotSession } from "../../src/index.vibe"

const sessions = new Map<string, TelegramSlotSession>()

function sessionFor(key: string): TelegramSlotSession {
  const existing = sessions.get(key)
  if (existing !== undefined) return existing
  const created = createTelegramSlotSession()
  sessions.set(key, created)
  return created
}

export const driver: Driver<TelegramSlotState> = {
  reset() {
    sessions.clear()
  },
  async dispatch(key: string, event: Event) {
    const session = sessionFor(key)
    let ok = false
    switch (event.type) {
      case "selectSlotKind":
        ok = await session.selectKind(event.kind)
        break
      case "updateSlot":
        ok = await session.updateSlot(event.text)
        break
      case "restartHost":
        ok = await session.restartHost()
        break
      case "userDeleteMessage":
        ok = await session.userDeleteMessage()
        break
    }
    return ok ? "accepted" : "refused"
  },
  async observe(key: string): Promise<TelegramSlotState> {
    return sessionFor(key).snapshot()
  },
}

export const options = { keys: ["slot-a", "slot-b"] }
