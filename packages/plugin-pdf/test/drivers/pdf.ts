// spec/pdf/index.md, "Story: Extract a complete document while my request is active"
import type { Driver } from "../../gen/pdf.conformance.ts"
import type { Event, PdfRead } from "../../gen/pdf.ts"
import { createPdfReadSession, type PdfReadSession } from "../../src/index.vibe"

const sessions = new Map<string, PdfReadSession>()

function sessionFor(key: string): PdfReadSession {
  const existing = sessions.get(key)
  if (existing !== undefined) return existing
  const created = createPdfReadSession()
  sessions.set(key, created)
  return created
}

export const driver: Driver<PdfRead> = {
  reset() {
    sessions.clear()
  },
  async dispatch(key: string, event: Event) {
    const session = sessionFor(key)
    let ok = false
    switch (event.type) {
      case "beginPdfRead":
        ok = await session.begin(event.kind, event.document, event.first, event.lastPage, event.pageCount, event.authorized)
        break
      case "recordPdfPage":
        ok = await session.record(event.document, event.pageNumber, event.visualSucceeded, event.authorized)
        break
      case "failPdfRead":
        ok = await session.fail()
        break
      case "cancelPdfRead":
        ok = await session.cancel()
        break
      case "publishPdfRead":
        ok = await session.publish(event.authorized)
        break
    }
    return ok ? "accepted" : "refused"
  },
  async observe(key: string): Promise<PdfRead> {
    return sessionFor(key).snapshot()
  },
}

export const options = { keys: ["doc-a", "doc-b"] }
