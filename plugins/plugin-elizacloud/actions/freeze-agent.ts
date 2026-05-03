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
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import type { CloudAuthService } from "../services/cloud-auth";
import type { CloudBackupService } from "../services/cloud-backup";
import type { CloudBridgeService } from "../services/cloud-bridge";
import type { CloudContainerService } from "../services/cloud-container";
import { confirmationRequired, isConfirmed, mergedOptions } from "./confirmation";

function getContainerId(message: Memory, options?: HandlerOptions): string | null {
  const params = mergedOptions(options);
  if (params.containerId) return String(params.containerId);
  const meta = (message.metadata as Record<string, unknown> | undefined)?.actionParams as
    | Record<string, unknown>
    | undefined;
  return meta?.containerId ? String(meta.containerId) : null;
}

export const freezeCloudAgentAction: Action = {
  name: "FREEZE_CLOUD_AGENT",
  description: "Freeze a cloud agent: snapshot state, disconnect bridge, stop container.",
  descriptionCompressed: "Freeze cloud agent: snapshot, disconnect, stop container.",
  similes: ["freeze agent", "hibernate agent", "pause agent", "stop cloud agent"],
  tags: ["cloud", "container", "backup"],
  parameters: [
    {
      name: "containerId",
      description: "ID of the container to freeze",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "confirmed",
      description: "Must be true to freeze the cloud agent after preview.",
      required: false,
      schema: { type: "boolean", default: false },
    },
  ],

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: HandlerOptions
  ): Promise<boolean> => {
    const __avTextRaw = typeof message?.content?.text === "string" ? message.content.text : "";
    const __avText = __avTextRaw.toLowerCase();
    const __avKeywords = ["freeze", "cloud"];
    const __avKeywordOk =
      __avKeywords.length > 0 && __avKeywords.some((kw) => kw.length > 0 && __avText.includes(kw));
    const __avRegex = /\b(?:freeze|cloud)\b/i;
    const __avRegexOk = Boolean(__avText.match(__avRegex));
    const __avSource = String(message?.content?.source ?? "");
    const __avExpectedSource = "";
    const __avSourceOk = __avExpectedSource
      ? __avSource === __avExpectedSource
      : Boolean(__avSource || state || runtime?.agentId || runtime?.getService);
    const __avOptions = options && typeof options === "object" ? options : {};
    const __avInputOk =
      __avText.trim().length > 0 ||
      Object.keys(__avOptions as Record<string, unknown>).length > 0 ||
      Boolean(message?.content && typeof message.content === "object");

    if (!(__avKeywordOk && __avRegexOk && __avSourceOk && __avInputOk)) {
      return false;
    }

    const __avLegacyValidate = async (runtime: IAgentRuntime) => {
      return !!(
        runtime.getService("CLOUD_AUTH") as CloudAuthService | undefined
      )?.isAuthenticated();
    };
    try {
      return Boolean(await __avLegacyValidate(runtime));
    } catch {
      return false;
    }
  },

  async handler(
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback
  ): Promise<ActionResult> {
    const containers = runtime.getService("CLOUD_CONTAINER") as CloudContainerService;
    const bridge = runtime.getService("CLOUD_BRIDGE") as CloudBridgeService | undefined;
    const backup = runtime.getService("CLOUD_BACKUP") as CloudBackupService | undefined;

    const containerId = getContainerId(message, options);
    if (!containerId) return { success: false, error: "Missing containerId" };

    const container = await containers.getContainer(containerId);
    if (container.status !== "running") {
      return {
        success: false,
        error: `Container not running (status: ${container.status})`,
      };
    }

    const preview = [
      "Confirmation required before freezing Eliza Cloud agent:",
      `Container: ${container.name}`,
      `ID: ${containerId}`,
      "Effects: create snapshot, disconnect bridge, stop container.",
    ].join("\n");
    if (!isConfirmed(options)) {
      await callback?.({ text: preview, actions: ["FREEZE_CLOUD_AGENT"] });
      return confirmationRequired(preview, {
        containerId,
        containerName: container.name,
      });
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

    await notify(`"${container.name}" frozen.${snapshotId ? ` Snapshot: ${snapshotId}` : ""}`);

    return {
      success: true,
      text: `Agent "${container.name}" frozen`,
      data: { containerId, containerName: container.name, snapshotId },
    };
  },
};
