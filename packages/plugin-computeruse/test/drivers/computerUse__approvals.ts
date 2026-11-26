// spec/computerUse/approvals.md, "Story: Gate computer-use commands by approval mode and operator decisions"
import type { Driver } from "../../gen/computerUse__approvals.conformance.ts"
import type { ApprovalQueue, CommandRisk, Event } from "../../gen/computerUse__approvals.ts"
import { ComputerUseApprovalManager, fromSpecApprovalMode } from "../../src/approvals.vibe"

interface Instance {
  readonly manager: ComputerUseApprovalManager
  readonly requests: Map<number, AbortController>
}

const COMMAND_FOR_RISK: Record<CommandRisk, string> = {
  ReadOnly: "screenshot",
  Mutating: "type",
  Destructive: "kill_app",
}

let instances = new Map<string, Instance>()

function forKey(key: string): Instance {
  let instance = instances.get(key)
  if (!instance) {
    instance = { manager: new ComputerUseApprovalManager(), requests: new Map() }
    instances.set(key, instance)
  }
  return instance
}

function isPending(manager: ComputerUseApprovalManager, approvalId: number): boolean {
  return manager.getSnapshot().pendingApprovals.some((a) => a.id === `appr_${approvalId}`)
}

function dispatchEvent(instance: Instance, event: Event): boolean {
  const { manager, requests } = instance
  switch (event.type) {
    case "setMode": {
      const mode = fromSpecApprovalMode(event.nextMode)
      if (manager.getMode() === mode) return false
      manager.setMode(mode)
      return true
    }
    case "enqueueApproval": {
      const command = COMMAND_FOR_RISK[event.risk]
      if (manager.evaluateCommand(command) !== "NeedsApproval") return false
      const approvalId = manager.getQueueState().nextId
      const controller = new AbortController()
      requests.set(approvalId, controller)
      void manager.requestApproval(command, {}, controller.signal)
      return isPending(manager, approvalId)
    }
    case "resolveApproval":
      return manager.resolveApproval(`appr_${event.approvalId}`, event.approved) !== null
    case "cancelApproval": {
      const controller = requests.get(event.approvalId)
      if (!controller || !isPending(manager, event.approvalId)) return false
      controller.abort()
      return true
    }
    case "cancelAllApprovals": {
      if (manager.getSnapshot().pendingCount === 0) return false
      manager.cancelAll("conformance")
      return true
    }
  }
}

export const driver: Driver = {
  reset() {
    instances = new Map<string, Instance>()
    return Promise.resolve()
  },
  dispatch(key: string, event: Event) {
    return Promise.resolve(dispatchEvent(forKey(key), event) ? "accepted" : "refused")
  },
  observe(key: string): Promise<ApprovalQueue> {
    const { manager } = forKey(key)
    const queue = manager.getQueueState()
    const queued = [...queue.pendingIds].sort((a, b) => a - b)
    const tracked = manager.getSnapshot().pendingApprovals.map((a) => Number(a.id.slice("appr_".length))).sort((a, b) => a - b)
    if (JSON.stringify(queued) !== JSON.stringify(tracked)) {
      return Promise.reject(new Error(`pending approvals ${JSON.stringify(tracked)} disagree with the queue ${JSON.stringify(queued)}`))
    }
    return Promise.resolve(queue)
  },
}

export const options = { keys: ["a", "b"] }
