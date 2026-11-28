// spec/elizaCloud/delegation.md, "Story: Gate managed Google delegation and gateway relay on owner consent"
import type { IAgentRuntime, UUID } from "@elizaos/core"
import type { Driver } from "../../gen/elizaCloud__delegation.conformance.ts"
import type { DelegationRelayState, Event } from "../../gen/elizaCloud__delegation.ts"
import { CloudGoogleDelegationService } from "../../src/index.vibe"

const stubRuntime = {
  agentId: "00000000-0000-0000-0000-000000000001" as UUID,
  getSetting: () => undefined,
  getService: () => null,
} as unknown as IAgentRuntime

const instances = new Map<string, CloudGoogleDelegationService>()

function forKey(key: string): CloudGoogleDelegationService {
  let svc = instances.get(key)
  if (!svc) {
    svc = new CloudGoogleDelegationService(stubRuntime)
    instances.set(key, svc)
  }
  return svc
}

export const driver: Driver = {
  reset() {
    instances.clear()
    return Promise.resolve()
  },
  dispatch(key: string, event: Event) {
    const res = forKey(key).stepMachine(event)
    return Promise.resolve(res.accepted ? "accepted" : "refused")
  },
  observe(key: string): Promise<DelegationRelayState> {
    return Promise.resolve(forKey(key).getState())
  },
}

export const options = { keys: ["a", "b"] }
