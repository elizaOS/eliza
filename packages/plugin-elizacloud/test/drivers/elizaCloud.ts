// spec/elizaCloud/index.md, "Story: Read account state and use Cloud under my current connection"
import type { IAgentRuntime, UUID } from "@elizaos/core"
import type { Driver } from "../../gen/elizaCloud.conformance.ts"
import type { CloudView, Event } from "../../gen/elizaCloud.ts"
import { CloudAuthService } from "../../src/index.vibe"

const stubRuntime = {
  agentId: "00000000-0000-0000-0000-000000000001" as UUID,
  getSetting: () => undefined,
  getService: () => null,
} as unknown as IAgentRuntime

const instances = new Map<string, CloudAuthService>()

function forKey(key: string): CloudAuthService {
  let svc = instances.get(key)
  if (!svc) {
    svc = new CloudAuthService(stubRuntime)
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
  observe(key: string): Promise<CloudView> {
    return Promise.resolve(forKey(key).getView())
  },
}

export const options = { keys: ["a", "b"] }
