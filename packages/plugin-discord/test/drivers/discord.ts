// spec/discord/index.md, "Every accepted Discord event keeps the captured account and channel"
import type { Driver } from "../../gen/discord.conformance.ts"
import type { DiscordCaller, DiscordSession, Event } from "../../gen/discord.ts"
import { createDiscordSessionHandle, type DiscordSessionMachineHandle } from "../../src/index.vibe"

const handles = new Map<string, DiscordSessionMachineHandle>()

function forKey(key: string): DiscordSessionMachineHandle {
  const existing = handles.get(key)
  if (existing) return existing
  const created = createDiscordSessionHandle()
  handles.set(key, created)
  return created
}

export const driver: Driver<DiscordSession> = {
  reset() {
    handles.clear()
  },
  dispatch(key: string, event: Event, by?: unknown) {
    return forKey(key).dispatch(event, by as DiscordCaller)
  },
  observe(key: string): DiscordSession {
    return forKey(key).state()
  },
  observeOutput(key: string) {
    return forKey(key).lastOutput()
  },
  receive(key: string, raw: unknown, by?: unknown) {
    return forKey(key).receive(raw, by as DiscordCaller)
  },
}

export const options = { keys: ["a", "b"] }
