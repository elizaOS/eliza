// spec/x/index.md, "X cursors compare complete decimal provider IDs and stay with the selected session"
import { ManagedRuntime, type Effect } from "effect"
import * as KeyValueStore from "effect/persistence/KeyValueStore"
import type { Driver, Options } from "../../gen/x.conformance.ts"
import type { Event, XCaller, XCursor } from "../../gen/x.ts"
import { advanceXCursorState, bindXCursor, readXCursorState, seedXCursorState } from "../../src/service.vibe"

let runtime = ManagedRuntime.make(KeyValueStore.layerMemory)

function runWithStore<A, E>(eff: Effect.Effect<A, E, KeyValueStore.KeyValueStore>): Promise<A> {
  return runtime.runPromise(eff)
}

export const options: Options = {
  keys: ["a", "b"],
}

export const driver: Driver = {
  async reset() {
    await runtime.dispose()
    runtime = ManagedRuntime.make(KeyValueStore.layerMemory)
  },
  async dispatch(key: string, event: Event, by?: unknown) {
    const caller: XCaller = by === "XAdapter" ? "XAdapter" : "XExternal"
    const storeKey = `x:cursor:${key}`
    try {
      if (event.type === "bindX") {
        await runWithStore(bindXCursor(storeKey, caller, event.binding))
        return "accepted"
      }
      if (event.type === "seedXCursor") {
        await runWithStore(seedXCursorState(storeKey, caller, event.binding, event.eventId))
        return "accepted"
      }
      await runWithStore(
        advanceXCursorState(storeKey, caller, event.binding, event.eventId, event.eventFinalized),
      )
      return "accepted"
    } catch {
      return "refused"
    }
  },
  observe(key: string): Promise<XCursor> {
    return runWithStore(readXCursorState(`x:cursor:${key}`))
  },
}
