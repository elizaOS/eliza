/** Adapts a granted encrypted remote host session to one immutable device Chromium profile. */
import type { RemoteBrowserCommandPayload } from "@elizaos/core/contracts/remote-control";
import { parseRemoteBrowserCommandPayload } from "@elizaos/core/contracts/remote-control";
import type { BrowserTarget } from "../browser-service.js";
import { BrowserDispatchFailure } from "../dispatch-types.js";
import type {
  BrowserWorkspaceCommand,
  BrowserWorkspaceCommandResult,
} from "../workspace/browser-workspace-types.js";

export interface RemoteBrowserDeviceConnection {
  /** Registered remote-host identity, never an endpoint supplied by page text. */
  deviceId: string;
  profileId: string;
  displayName: string;
  /** The relay owner checks grant, tenant, revocation, and online status. */
  available(): Promise<boolean>;
  /** Executes once through the existing signed command/start/result envelope flow. */
  execute(command: RemoteBrowserCommandPayload): Promise<unknown>;
}

export function createRemoteBrowserDeviceTarget(
  connection: RemoteBrowserDeviceConnection,
): BrowserTarget & { getProfileId(): string } {
  const deviceId = connection.deviceId;
  const profileId = connection.profileId;
  const id = `device:${deviceId}:${profileId}`;
  return {
    id,
    getProfileId: () => profileId,
    name: connection.displayName,
    description:
      "Registered device Chromium profile reached through its explicit owner grant.",
    kind: "external",
    priority: 180,
    available: () => connection.available(),
    supports: (command: BrowserWorkspaceCommand) =>
      [
        "list",
        "open",
        "navigate",
        "snapshot",
        "click",
        "fill",
        "scroll",
        "back",
        "forward",
        "reload",
        "close",
      ].includes(command.subaction),
    execute: async (command) => {
      if (
        connection.profileId !== profileId ||
        connection.deviceId !== deviceId
      )
        throw new BrowserDispatchFailure(
          "POLICY_BLOCKED",
          "The registered device profile changed; establish a new target grant.",
          { targetId: id },
        );
      const payload = parseRemoteBrowserCommandPayload({ profileId, command });
      const result = await connection.execute(payload);
      if (
        !result ||
        typeof result !== "object" ||
        Array.isArray(result) ||
        !("mode" in result) ||
        !["desktop", "web", "cloud"].includes(String(result.mode)) ||
        !("subaction" in result) ||
        result.subaction !== command.subaction
      ) {
        throw new BrowserDispatchFailure(
          "UNCERTAIN_OUTCOME",
          "The device returned a malformed browser receipt; do not replay the command.",
          { targetId: id },
        );
      }
      return { ...(result as BrowserWorkspaceCommandResult), targetId: id };
    },
  };
}
