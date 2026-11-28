// spec/github/index.md, "Story: Review the exact GitHub operation before it changes a repository"
import type { Driver } from "../../gen/github.conformance.ts"
import type { Event, GitHubCaller, GitHubOperation } from "../../gen/github.ts"
import { createGitHubOperationHandle, type GitHubOperationMachineHandle } from "../../src/index.vibe"

const handles = new Map<string, GitHubOperationMachineHandle>()

function forKey(key: string): GitHubOperationMachineHandle {
  const existing = handles.get(key)
  if (existing) return existing
  const created = createGitHubOperationHandle()
  handles.set(key, created)
  return created
}

export const driver: Driver<GitHubOperation> = {
  reset() {
    handles.clear()
  },
  dispatch(key: string, event: Event, by?: unknown) {
    return forKey(key).dispatch(event, by as GitHubCaller)
  },
  observe(key: string): GitHubOperation {
    return forKey(key).state()
  },
  observeOutput(key: string) {
    return forKey(key).lastOutput()
  },
  receive(key: string, raw: unknown, by?: unknown) {
    return forKey(key).receive(raw, by as GitHubCaller)
  },
}

export const options = { keys: ["a", "b"] }
