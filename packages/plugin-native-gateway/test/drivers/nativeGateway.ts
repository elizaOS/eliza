// spec/nativeGateway/index.md, "Story: Connect to the gateway I chose and isolate its replies"
import type { Driver } from "../../gen/nativeGateway.conformance.ts"
import { createGatewayConnectionSession, type GatewayConnectionSession } from "../../src/index.vibe"

let sessions = new Map<string, GatewayConnectionSession>()

function sessionFor(key: string): GatewayConnectionSession {
  let session = sessions.get(key)
  if (!session) {
    session = createGatewayConnectionSession()
    sessions.set(key, session)
  }
  return session
}

export const driver: Driver = {
  reset() {
    sessions = new Map()
  },
  dispatch(key, event) {
    const session = sessionFor(key)
    switch (event.type) {
      case "connectGateway":
        return session.connect(event.endpointId) ? "accepted" : "refused"
      case "confirmGateway":
        return session.confirm(event.endpointId, event.generation, event.authenticated) ? "accepted" : "refused"
      case "disconnectGateway":
        return session.disconnect() ? "accepted" : "refused"
    }
  },
  observe(key) {
    return sessionFor(key).state()
  },
}
