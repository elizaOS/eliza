// spec/github/deviceFlow.md, "Story: Sign in to GitHub from the account setup screen"
import type { Driver } from "../../gen/github__deviceFlow.conformance.ts"
import type { Event, GithubDeviceCaller, GithubDeviceFlow } from "../../gen/github__deviceFlow.ts"
import { createGitHubDeviceFlowHandle, type GitHubDeviceFlowMachineHandle } from "../../src/index.vibe"

const handles = new Map<string, GitHubDeviceFlowMachineHandle>()

function forKey(key: string): GitHubDeviceFlowMachineHandle {
  const existing = handles.get(key)
  if (existing) return existing
  const created = createGitHubDeviceFlowHandle()
  handles.set(key, created)
  return created
}

export const driver: Driver<GithubDeviceFlow> = {
  reset() {
    handles.clear()
  },
  dispatch(key: string, event: Event, by?: unknown) {
    return forKey(key).dispatch(event, by as GithubDeviceCaller)
  },
  observe(key: string): GithubDeviceFlow {
    return forKey(key).state()
  },
  observeOutput(key: string) {
    return forKey(key).lastOutput()
  },
  receive(key: string, raw: unknown, by?: unknown) {
    return forKey(key).receive(raw, by as GithubDeviceCaller)
  },
}

export const options = { keys: ["a", "b"] }
