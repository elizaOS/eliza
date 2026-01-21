import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";

interface AutonomyService {
  getAutonomousRoomId?: () => string | undefined;
  isLoopRunning?: () => boolean;
  getLoopInterval?: () => number;
}

/**
 * Autonomy Status Provider - shows autonomy status in regular conversations
 * Does NOT show in autonomous monologue loop to avoid unnecessary context
 */
export const autonomyStatusProvider: Provider = {
  name: "AUTONOMY_STATUS",
  description:
    "Provides current autonomy status for agent awareness in conversations",

  get: async (runtime: IAgentRuntime, message: Memory, _state?: State) => {
    // Get autonomy service
    const autonomyService = runtime.getService("autonomy");
    if (!autonomyService) {
      return { text: "" }; // Service not available, don't show status
    }

    // Check if we're in the autonomous room - if so, don't show status (avoid noise)
    const autonomousRoomId = (
      autonomyService as AutonomyService
    ).getAutonomousRoomId?.();
    if (autonomousRoomId && message.roomId === autonomousRoomId) {
      return { text: "" }; // Don't show in autonomous context
    }

    // Get autonomy settings and service status
    const autonomyEnabledSetting = runtime.getSetting("AUTONOMY_ENABLED");
    const autonomyEnabled =
      autonomyEnabledSetting === true ||
      autonomyEnabledSetting === "true" ||
      runtime.enableAutonomy === true;
    const serviceRunning =
      (autonomyService as AutonomyService).isLoopRunning?.() || false;
    const interval =
      (autonomyService as AutonomyService).getLoopInterval?.() || 30000;

    // Determine status
    let status: string;
    let statusIcon: string;

    if (serviceRunning) {
      status = "running autonomously";
      statusIcon = "🤖";
    } else if (autonomyEnabled) {
      status = "autonomy enabled but not running";
      statusIcon = "⏸️";
    } else {
      status = "autonomy disabled";
      statusIcon = "🔕";
    }

    const intervalText = Math.round(interval / 1000);
    const intervalUnit =
      intervalText < 60
        ? "seconds"
        : `${Math.round(intervalText / 60)} minutes`;

    return {
      text: `[AUTONOMY_STATUS]\nCurrent status: ${statusIcon} ${status}\nThinking interval: ${intervalText < 60 ? `${intervalText} seconds` : intervalUnit}\n[/AUTONOMY_STATUS]`,
      data: {
        autonomyEnabled,
        serviceRunning,
        interval,
        intervalSeconds: intervalText,
        status: serviceRunning
          ? "running"
          : autonomyEnabled
            ? "enabled"
            : "disabled",
      },
    };
  },
};
