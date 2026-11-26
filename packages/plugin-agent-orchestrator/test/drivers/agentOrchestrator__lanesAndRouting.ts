// spec/agentOrchestrator/lanesAndRouting.md, "Multi-lane wave execution prevents scope collisions and enforces concurrency and budget caps"
import { Effect, Exit } from "effect"
import type { Driver, Options } from "../../gen/agentOrchestrator__lanesAndRouting.conformance.ts"
import type { Event, WaveState } from "../../gen/agentOrchestrator__lanesAndRouting.ts"
import { WaveSupervisor } from "../../src/index.vibe"

let waves = new WaveSupervisor()

export const driver: Driver = {
  reset() {
    waves = new WaveSupervisor()
  },
  async dispatch(key: string, event: Event) {
    const exit = await Effect.runPromiseExit(waves.stepWave(key, event))
    return Exit.isSuccess(exit) ? "accepted" : "refused"
  },
  observe(key: string): WaveState {
    return waves.getWaveState(key)
  },
}

export const options: Options = { keys: ["w1", "w2"] }
