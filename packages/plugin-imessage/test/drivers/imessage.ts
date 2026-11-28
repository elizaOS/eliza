// spec/imessage/index.md, "The native cursor commits rows in order, with bounded persistence and attachment retries"
import { ManagedRuntime, type Effect } from "effect"
import * as KeyValueStore from "effect/persistence/KeyValueStore"
import type { Driver, Options } from "../../gen/imessage.conformance.ts"
import type { Event, IMessageCursor } from "../../gen/imessage.ts"
import { observeIMessageCursorRow, readIMessageCursor } from "../../src/service.vibe"

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
  async dispatch(key: string, event: Event) {
    try {
      await runWithStore(observeIMessageCursorRow(`imessage:cursor:${key}`, event.rowId, event.nativeResult))
      return "accepted"
    } catch {
      return "refused"
    }
  },
  observe(key: string): Promise<IMessageCursor> {
    return runWithStore(readIMessageCursor(`imessage:cursor:${key}`))
  },
}
