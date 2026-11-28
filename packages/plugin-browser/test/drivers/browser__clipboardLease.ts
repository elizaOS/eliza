// spec/browser/clipboardLease.md, "Story: A copied credential is erased by the command that wrote it"
import type { Driver } from "../../gen/browser__clipboardLease.conformance.ts"
import type { ClipboardLease, Event } from "../../gen/browser__clipboardLease.ts"
import { createClipboardLeaseSession, type ClipboardLeaseSession } from "../../src/index.vibe"

const sessions = new Map<string, ClipboardLeaseSession>()

function sessionFor(key: string): ClipboardLeaseSession {
  const existing = sessions.get(key)
  if (existing !== undefined) return existing
  const created = createClipboardLeaseSession()
  sessions.set(key, created)
  return created
}

export const driver: Driver<ClipboardLease> = {
  reset() {
    sessions.clear()
  },
  async dispatch(key: string, event: Event) {
    const session = sessionFor(key)
    let ok = false
    switch (event.type) {
      case "admitLease":
        ok = await session.admitLease()
        break
      case "switchBackend":
        ok = await session.switchBackend(event.port)
        break
      case "copyNewer":
        ok = await session.copyNewer()
        break
      case "removeExecutable":
        ok = await session.removeExecutable()
        break
      case "finishLease":
        ok = await session.finishLease()
        break
    }
    return ok ? "accepted" : "refused"
  },
  async observe(key: string): Promise<ClipboardLease> {
    return sessionFor(key).snapshot()
  },
}

export const options = { keys: ["lease-a", "lease-b"] }
