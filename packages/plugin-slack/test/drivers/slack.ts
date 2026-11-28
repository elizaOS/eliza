// spec/slack/index.md, "A public or private mention takes the app-mention lane and replies to the captured thread"
import { ManagedRuntime, type Effect } from "effect"
import * as KeyValueStore from "effect/persistence/KeyValueStore"
import type { Driver, Options } from "../../gen/slack.conformance.ts"
import type { Event, SlackCaller, SlackSession } from "../../gen/slack.ts"
import { bindSlackSession, claimSlackMessage, readSlackSession } from "../../src/service.vibe"

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
    const caller: SlackCaller = by === "SlackSocket" ? "SlackSocket" : "SlackUntrusted"
    try {
      if (event.type === "bindSlack") {
        await runWithStore(bindSlackSession(`slack:session:${key}`, caller, event.installation))
        return "accepted"
      }
      await runWithStore(claimSlackMessage(`slack:session:${key}`, caller, event.inbound, event.policy))
      return "accepted"
    } catch {
      return "refused"
    }
  },
  observe(key: string): Promise<SlackSession> {
    return runWithStore(readSlackSession(`slack:session:${key}`))
  },
}
