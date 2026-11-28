// spec/inbox/triage.md, "Triage item state transitions advance the revision monotonically"
import type { IAgentRuntime, UUID } from "@elizaos/core"
import type { Driver } from "../../gen/inbox__triage.conformance.ts"
import type { Event, InboxTriageItem } from "../../gen/inbox__triage.ts"
import { InboxTriageService } from "../../src/index.vibe"

const stubRuntime = {
  agentId: "00000000-0000-0000-0000-000000000001" as UUID,
  getSetting: () => undefined,
  getService: () => null,
} as unknown as IAgentRuntime

let service = new InboxTriageService(stubRuntime)

export const driver: Driver = {
  reset() {
    service = new InboxTriageService(stubRuntime)
    return Promise.resolve()
  },
  dispatch(key: string, event: Event) {
    const res = service.stepItemMachine(key, event)
    return Promise.resolve(res.accepted ? "accepted" : "refused")
  },
  observe(key: string): Promise<InboxTriageItem> {
    return Promise.resolve(service.getItemState(key))
  },
}

export const options = { keys: ["a", "b"] }
