// spec/computerUse/batching.md, "Story: Execute a bounded sequence of desktop actions in a single LLM turn"
import type { Driver } from "../../gen/computerUse__batching.conformance.ts"
import type { BatchMachine, Event } from "../../gen/computerUse__batching.ts"
import { ComputerUseService } from "../../src/service.vibe"

let services = new Map<string, ComputerUseService>()

function forKey(key: string): ComputerUseService {
  let svc = services.get(key)
  if (!svc) {
    svc = new ComputerUseService()
    services.set(key, svc)
  }
  return svc
}

export const driver: Driver = {
  reset() {
    services = new Map<string, ComputerUseService>()
    return Promise.resolve()
  },
  dispatch(key: string, event: Event) {
    const res = forKey(key).stepBatch(event)
    return Promise.resolve(res.accepted ? "accepted" : "refused")
  },
  observe(key: string): Promise<BatchMachine> {
    return Promise.resolve(forKey(key).getBatchState())
  },
}

export const options = { keys: ["a", "b"] }
