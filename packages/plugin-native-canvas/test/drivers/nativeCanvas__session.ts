// spec/nativeCanvas/session.md, "Story: Manage canvas lifecycle, attachment, layers, and touch routing"
import type { Driver } from "../../gen/nativeCanvas__session.conformance.ts"
import { createCanvasLifecycleSession, type CanvasLifecycleSession } from "../../src/index.vibe"

let sessions = new Map<string, CanvasLifecycleSession>()

function sessionFor(key: string): CanvasLifecycleSession {
  let session = sessions.get(key)
  if (!session) {
    session = createCanvasLifecycleSession()
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
      case "createCanvasSession":
        return session.create(event.widthPx, event.heightPx) ? "accepted" : "refused"
      case "attachCanvasSession":
        return session.attach() ? "accepted" : "refused"
      case "detachCanvasSession":
        return session.detach() ? "accepted" : "refused"
      case "addCanvasLayer":
        return session.addLayer() ? "accepted" : "refused"
      case "removeCanvasLayer":
        return session.removeLayer() ? "accepted" : "refused"
      case "destroyCanvasSession":
        return session.destroy() ? "accepted" : "refused"
    }
  },
  observe(key) {
    return sessionFor(key).state()
  },
}
