// spec/agentOrchestrator/sessionAdmission.md, "Story: Admit coding agent sessions within concurrency, disk, and spend limits"
import { Effect, Exit } from "effect"
import type { Driver, Options } from "../../gen/agentOrchestrator__sessionAdmission.conformance.ts"
import type { AdmissionPool, Event } from "../../gen/agentOrchestrator__sessionAdmission.ts"
import { AcpService } from "../../src/index.vibe"

const pools = new Map<string, AcpService>()

function poolFor(key: string): AcpService {
  const existing = pools.get(key)
  if (existing) return existing
  const created = new AcpService()
  pools.set(key, created)
  return created
}

export const driver: Driver = {
  reset() {
    pools.clear()
  },
  async dispatch(key: string, event: Event) {
    const exit = await Effect.runPromiseExit(poolFor(key).admissionStep(event))
    return Exit.isSuccess(exit) ? "accepted" : "refused"
  },
  observe(key: string): AdmissionPool {
    return poolFor(key).getAdmissionState()
  },
}

export const options: Options = { keys: ["pool-a", "pool-b"] }
