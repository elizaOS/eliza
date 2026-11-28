// spec/mcp/workerLifecycle.md, "Story: Isolate untrusted MCP schema compilation and validation"
import type { Driver } from "../../gen/mcp__workerLifecycle.conformance.ts"
import type { Event, SchemaWorkerState } from "../../gen/mcp__workerLifecycle.ts"
import { createSchemaWorkerHandle, type SchemaWorkerMachineHandle } from "../../src/index.vibe"

const handles = new Map<string, SchemaWorkerMachineHandle>()

function forKey(key: string): SchemaWorkerMachineHandle {
  const existing = handles.get(key)
  if (existing) return existing
  const created = createSchemaWorkerHandle()
  handles.set(key, created)
  return created
}

export const driver: Driver<SchemaWorkerState> = {
  reset() {
    handles.clear()
  },
  dispatch(key: string, event: Event) {
    return forKey(key).dispatch(event)
  },
  observe(key: string): SchemaWorkerState {
    return forKey(key).state()
  },
  receive(key: string, raw: unknown) {
    return forKey(key).receive(raw)
  },
}

export const options = { keys: ["a", "b"] }
