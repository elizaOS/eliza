// spec/nativeDesktop/index.md, "Story: Manage desktop tray, shortcuts, window state, and notifications safely"
import type { Driver } from "../../gen/nativeDesktop.conformance.ts"
import { createDesktopSession, type DesktopSession } from "../../src/index.vibe"

let sessions = new Map<string, DesktopSession>()

function sessionFor(key: string): DesktopSession {
  let session = sessions.get(key)
  if (!session) {
    session = createDesktopSession()
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
      case "createTray":
        return session.createTray() ? "accepted" : "refused"
      case "destroyTray":
        return session.destroyTray() ? "accepted" : "refused"
      case "registerShortcut":
        return session.registerShortcut() ? "accepted" : "refused"
      case "unregisterShortcut":
        return session.unregisterShortcut() ? "accepted" : "refused"
      case "setWindowVisibility":
        return session.setWindowVisibility(event.visible) ? "accepted" : "refused"
      case "setWindowOpacity":
        return session.setWindowOpacity(event.opacityHundredths) ? "accepted" : "refused"
      case "setFullscreen":
        return session.setFullscreen(event.flag) ? "accepted" : "refused"
      case "showNotification":
        return session.showNotification() ? "accepted" : "refused"
      case "closeNotification":
        return session.closeNotification() ? "accepted" : "refused"
    }
  },
  observe(key) {
    return sessionFor(key).state()
  },
}
