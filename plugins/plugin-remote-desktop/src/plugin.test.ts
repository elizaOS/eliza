import { describe, expect, it } from "vitest";

import remoteDesktopPlugin, {
  REMOTE_DESKTOP_ACTION_NAME,
  remoteDesktopAction,
} from "./index.js";

describe("@elizaos/plugin-remote-desktop", () => {
  it("exports the migration-stubbed remote desktop action", () => {
    expect(remoteDesktopPlugin.name).toBe("remote-desktop");
    expect(remoteDesktopPlugin.actions).toContain(remoteDesktopAction);
    expect(REMOTE_DESKTOP_ACTION_NAME).toBe("REMOTE_DESKTOP");
    expect(remoteDesktopAction.suppressPostActionContinuation).toBe(true);
    expect(remoteDesktopAction.roleGate).toEqual({ minRole: "OWNER" });
  });
});
