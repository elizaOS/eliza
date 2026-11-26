// spec/codingTools/worktree.md, "Story: Enter and exit git worktrees without losing the previous working directory"
import type { IAgentRuntime, UUID } from "@elizaos/core"
import type { Driver } from "../../gen/codingTools__worktree.conformance.ts"
import type { Event, WorktreeSession } from "../../gen/codingTools__worktree.ts"
import { SessionCwdService } from "../../src/index.vibe"

let service: SessionCwdService | undefined
const initialized = new Set<string>()

function createRuntime(): IAgentRuntime {
  return {
    agentId: "00000000-0000-0000-0000-000000000001" as UUID,
    getSetting: () => undefined,
    getService: () => null,
  } as unknown as IAgentRuntime
}

function ensureKey(svc: SessionCwdService, key: string): void {
  if (!initialized.has(key)) {
    svc.setCwd(key, "/repo")
    initialized.add(key)
  }
}

export const driver: Driver<WorktreeSession> = {
  async reset() {
    if (service) await service.stop()
    initialized.clear()
    service = await SessionCwdService.start(createRuntime())
  },
  async dispatch(key: string, event: Event) {
    if (!service) service = await SessionCwdService.start(createRuntime())
    ensureKey(service, key)
    if (event.type === "enterWorktree") {
      const before = service.worktreeDepth(key)
      if (event.wtPath === "") return "refused"
      service.pushWorktree(key, event.wtPath)
      return service.worktreeDepth(key) > before ? "accepted" : "refused"
    }
    const popped = service.popWorktree(key, event.cleanup)
    return popped ? "accepted" : "refused"
  },
  async observe(key: string): Promise<WorktreeSession> {
    if (!service) service = await SessionCwdService.start(createRuntime())
    ensureKey(service, key)
    return service.getWorktreeState(key)
  },
}

export const options = { keys: ["conv-a", "conv-b"] }
