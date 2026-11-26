// spec/computerUse/sessions.md, "Story: Manage leased computer-use sessions with fresh observations"
import type { Driver } from "../../gen/computerUse__sessions.conformance.ts"
import type { Event, SessionMachine } from "../../gen/computerUse__sessions.ts"
import { ComputerUseSessionManager } from "../../src/sessions.vibe"

let manager = new ComputerUseSessionManager()

export const driver: Driver = {
  reset() {
    manager = new ComputerUseSessionManager()
    return Promise.resolve()
  },
  dispatch(key: string, event: Event) {
    const res = manager.stepMachine(key, event)
    return Promise.resolve(res.accepted ? "accepted" : "refused")
  },
  observe(key: string): Promise<SessionMachine> {
    const existing = manager.getMachineState(key)
    if (existing) return Promise.resolve(existing)
    return Promise.resolve(manager.stepMachine(key, { type: "closeSession" }).state)
  },
}

export const options = { keys: ["a", "b"] }
