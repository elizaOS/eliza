import type { Plugin } from "@elizaos/core";

import { remoteDesktopAction } from "./actions/remote-desktop.js";

/**
 * @elizaos/plugin-remote-desktop
 *
 * Owner-only remote desktop session control. Provides a single
 * `REMOTE_DESKTOP` umbrella action with subactions:
 *   - start  — open a session (requires confirmation; pairing code in cloud mode)
 *   - status — look up a session by id
 *   - end    — close a session by id
 *   - list   — list active sessions
 *   - revoke — revoke an active session
 *
 * Backends: Tailscale VNC, Tailscale SSH, and ngrok TCP. Pairing-code gating
 * lives in the underlying RemoteSessionService (`src/remote/`); backend
 * detection and the in-process session store live in `src/lifeops/`.
 */
export const remoteDesktopPlugin: Plugin = {
  name: "remote-desktop",
  description:
    "Remote desktop session control for Eliza agents. REMOTE_DESKTOP umbrella action (start/status/end/list/revoke) over Tailscale VNC/SSH and ngrok backends with pairing-code confirmation. Extracted from @elizaos/plugin-personal-assistant.",
  actions: [remoteDesktopAction],
};

export default remoteDesktopPlugin;
