// spec/agentOrchestrator/routerGuard.md, "Story: Bound subagent round-trips, deduplicate completion relays, and dispatch streaming parent directives once"
import { Effect } from "effect"
import type { Driver, Options } from "../../gen/agentOrchestrator__routerGuard.conformance.ts"
import type { Event, RouterGuardState } from "../../gen/agentOrchestrator__routerGuard.ts"
import { SubAgentRouter } from "../../src/index.vibe"

let router = new SubAgentRouter()

export const driver: Driver = {
  reset() {
    router = new SubAgentRouter()
  },
  async dispatch(key: string, event: Event) {
    const result = await Effect.runPromise(router.dispatchGuard(key, event))
    return result.accepted ? "accepted" : "refused"
  },
  observe(key: string): RouterGuardState {
    return router.getGuardState(key)
  },
}

export const options: Options = { keys: ["s1", "s2"] }
