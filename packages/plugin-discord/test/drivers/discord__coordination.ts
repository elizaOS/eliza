// spec/discord/coordination.md, "A durable turn claims a bounded speaker lease, budgets human and bot lanes independently, and reconciles already-stored replies"
import type { Driver } from "../../gen/discord__coordination.conformance.ts"
import type { DiscordCoordState, Event } from "../../gen/discord__coordination.ts"
import { createDiscordCoordinationHandle, type DiscordCoordinationMachineHandle } from "../../src/index.vibe"

const handles = new Map<string, DiscordCoordinationMachineHandle>()

function forKey(key: string): DiscordCoordinationMachineHandle {
  const existing = handles.get(key)
  if (existing) return existing
  const created = createDiscordCoordinationHandle()
  handles.set(key, created)
  return created
}

export const driver: Driver<DiscordCoordState> = {
  reset() {
    handles.clear()
  },
  dispatch(key: string, event: Event) {
    return forKey(key).dispatch(event)
  },
  observe(key: string): DiscordCoordState {
    return forKey(key).state()
  },
  receive(key: string, raw: unknown) {
    return forKey(key).receive(raw)
  },
}

export const options = { keys: ["a", "b"] }
