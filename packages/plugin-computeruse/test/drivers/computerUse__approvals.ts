// spec/computerUse/approvals.md, "Story: Gate computer-use commands by approval mode and operator decisions"
import type { Driver } from "../../gen/computerUse__approvals.conformance.ts"
import type { ApprovalQueue, Event } from "../../gen/computerUse__approvals.ts"
import { ComputerUseApprovalManager } from "../../src/approvals.vibe"

let managers = new Map<string, ComputerUseApprovalManager>()

function forKey(key: string): ComputerUseApprovalManager {
  let mgr = managers.get(key)
  if (!mgr) {
    mgr = new ComputerUseApprovalManager()
    managers.set(key, mgr)
  }
  return mgr
}

export const driver: Driver = {
  reset() {
    managers = new Map<string, ComputerUseApprovalManager>()
    return Promise.resolve()
  },
  dispatch(key: string, event: Event) {
    const res = forKey(key).stepQueue(event)
    return Promise.resolve(res.accepted ? "accepted" : "refused")
  },
  observe(key: string): Promise<ApprovalQueue> {
    return Promise.resolve(forKey(key).getQueueState())
  },
}

export const options = { keys: ["a", "b"] }
