// spec/calendar/autoJoin.md, "Auto-join approval lifecycle joins only after owner approval or under all-policy"
import { Effect } from "effect"
import type { Driver } from "../../gen/calendar__autoJoin.conformance.ts"
import type { AutoJoinMachine, Event } from "../../gen/calendar__autoJoin.ts"
import { MeetingAutoJoinTracker } from "../../src/index.vibe"

let tracker = new MeetingAutoJoinTracker()

export const driver: Driver = {
  reset() {
    tracker = new MeetingAutoJoinTracker()
    return Promise.resolve()
  },
  async dispatch(key: string, event: Event) {
    const outcome = await Effect.runPromise(Effect.result(tracker.stepEvent(key, event)))
    return outcome._tag === "Success" ? "accepted" : "refused"
  },
  observe(key: string): Promise<AutoJoinMachine> {
    return Promise.resolve(tracker.getState(key))
  },
}

export const options = { keys: ["a", "b"] }
