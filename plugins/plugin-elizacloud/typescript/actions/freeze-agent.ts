/**
 * FREEZE_CLOUD_AGENT — Snapshot and stop a cloud agent.
 *
 * Creates a state snapshot, disconnects bridge, cancels auto-backup,
 * stops the container. Resume later with RESUME_CLOUD_AGENT.
 */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import type { CloudAuthService } from "../services/cloud-auth";
import type { CloudBackupService } from "../services/cloud-backup";
import type { CloudBridgeService } from "../services/cloud-bridge";
import type { CloudContainerService } from "../services/cloud-container";

function getContainerId(
  message: Memory,
  options?: Record<string, unknown>,
): string | null {
  if (options?.containerId) return String(options.containerId);
  const meta = (message.metadata as Record<string, unknown> | undefined)
    ?.actionParams as Record<string, unknown> | undefined;
  return meta?.containerId ? String(meta.containerId) : null;
}

export const freezeCloudAgentAction: Action = {
  name: "FREEZE_CLOUD_AGENT",
  description:
    "Freeze a cloud agent: snapshot state, disconnect bridge, stop container.",
  similes: [
    "freeze agent",
    "hibernate agent",
    "pause agent",
    "stop cloud agent",
  ],
  tags: ["cloud", "container", "backup"],
  parameters: [
    {
      name: "containerId",
      description: "ID of the container to freeze",
      required: true,
      schema: { type: "string" },
    },
  ],

  async validate(runtime: IAgentRuntime): Promise<boolean> {
    return !!(
      runtime.getService("CLOUD_AUTH") as CloudAuthService | undefined
    )?.isAuthenticated();
  },

  async handler(
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: Record<string, unknown>,
    callback?: HandlerCallback,
  ): Promise<ActionResult> {
    const containers = runtime.getService(
      "CLOUD_CONTAINER",
    ) as CloudContainerService;
    const bridge = runtime.getService("CLOUD_BRIDGE") as
      | CloudBridgeService
      | undefined;
    const backup = runtime.getService("CLOUD_BACKUP") as
      | CloudBackupService
      | undefined;

    const containerId = getContainerId(message, options);
    if (!containerId) return { success: false, error: "Missing containerId" };

    const container = await containers.getContainer(containerId);
    if (container.status !== "running") {
      return {
        success: false,
        error: `Container not running (status: ${container.status})`,
      };
    }

    const notify = async (text: string) => {
      if (callback) await callback({ text, actions: ["FREEZE_CLOUD_AGENT"] });
    };
    await notify(`Freezing "${container.name}"... Creating snapshot.`);

    // Snapshot → disconnect → stop
    let snapshotId: string | null = null;
    if (backup) {
      const snap = await backup.createSnapshot(containerId, "manual", {
        trigger: "user-freeze",
        containerName: container.name,
      });
      snapshotId = snap.id;
      backup.cancelAutoBackup(containerId);
    }

    if (bridge) await bridge.disconnect(containerId);
    await containers.deleteContainer(containerId);

    await notify(
      `"${container.name}" frozen.${snapshotId ? ` Snapshot: ${snapshotId}` : ""}`,
    );

    return {
      success: true,
      text: `Agent "${container.name}" frozen`,
      data: { containerId, containerName: container.name, snapshotId },
    };
  },
};
