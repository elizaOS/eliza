// spec/nativeActionJournal/index.md, "A reservation binds the owner scope, proposal, operation and record digest"
import type { Driver } from "../../gen/nativeActionJournal.conformance.ts"
import type { Entry, Event } from "../../gen/nativeActionJournal.ts"
import { createActionJournalMachineHandle, type ActionJournalMachineHandle } from "../../src/index.vibe"

const handles = new Map<string, ActionJournalMachineHandle>()

function forKey(key: string): ActionJournalMachineHandle {
  const existing = handles.get(key)
  if (existing) return existing
  const created = createActionJournalMachineHandle()
  handles.set(key, created)
  return created
}

export const driver: Driver<Entry> = {
  reset() {
    handles.clear()
  },
  dispatch(key: string, event: Event) {
    return forKey(key).dispatch(event)
  },
  observe(key: string): Entry {
    return forKey(key).state()
  },
  receive(key: string, raw: unknown) {
    return forKey(key).receive(raw)
  },
}

export const options = { keys: ["a", "b"] }
