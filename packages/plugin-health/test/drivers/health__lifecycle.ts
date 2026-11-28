// spec/health/lifecycle.md, "Connector authorization and sync transitions enforce owner consent and monotonic revisions"
import { Effect } from "effect"
import type { Driver } from "../../gen/health__lifecycle.conformance.ts"
import type { Event, HealthConnectorState } from "../../gen/health__lifecycle.ts"
import { HealthService } from "../../src/index.vibe"

let service = new HealthService()

export const driver: Driver = {
  async reset() {
    await service.stop()
    service = new HealthService()
  },
  async dispatch(key: string, event: Event) {
    const outcome = await Effect.runPromise(Effect.result(service.stepConnector(key, event)))
    return outcome._tag === "Success" ? "accepted" : "refused"
  },
  observe(key: string): Promise<HealthConnectorState> {
    return Promise.resolve(service.getConnectorState(key))
  },
}

export const options = { keys: ["owner:oura", "owner:fitbit"] }
