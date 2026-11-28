// spec/mcp/index.md, "Story: Call an explicitly enabled server with valid tool arguments"
import type { Driver } from "../../gen/mcp.conformance.ts"
import type { Event, McpInvocation } from "../../gen/mcp.ts"
import { createMcpInvocationHandle, type McpInvocationMachineHandle } from "../../src/index.vibe"

const handles = new Map<string, McpInvocationMachineHandle>()

function forKey(key: string): McpInvocationMachineHandle {
  const existing = handles.get(key)
  if (existing) return existing
  const created = createMcpInvocationHandle()
  handles.set(key, created)
  return created
}

export const driver: Driver<McpInvocation> = {
  reset() {
    handles.clear()
  },
  dispatch(key: string, event: Event) {
    return forKey(key).dispatch(event)
  },
  observe(key: string): McpInvocation {
    return forKey(key).state()
  },
  receive(key: string, raw: unknown) {
    return forKey(key).receive(raw)
  },
}

export const options = { keys: ["a", "b"] }
