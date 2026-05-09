import type { AutomationNodeDescriptor } from "@elizaos/app-core";
import {
  type AutomationNodeContributorContext,
  registerAutomationNodeContributor,
} from "@elizaos/app-core";
import { logger } from "@elizaos/core";
import type {
  LifeOpsDiscordConnectorStatus,
  LifeOpsGoogleConnectorStatus,
  LifeOpsSignalConnectorStatus,
  LifeOpsTelegramConnectorStatus,
} from "@elizaos/shared";
import { LifeOpsService } from "./lifeops/service";

async function resolveGoogleStatus(
  lifeOps: LifeOpsService,
): Promise<LifeOpsGoogleConnectorStatus | null> {
  try {
    return await lifeOps.getGoogleConnectorStatus(
      new URL("http://127.0.0.1/api/connectors/google/accounts"),
      undefined,
      "owner",
    );
  } catch (error) {
    logger.warn(
      `[lifeops] Failed to resolve Google connector status: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

async function resolveTelegramStatus(
  lifeOps: LifeOpsService,
): Promise<LifeOpsTelegramConnectorStatus | null> {
  try {
    return await lifeOps.getTelegramConnectorStatus("owner");
  } catch (error) {
    logger.warn(
      `[lifeops] Failed to resolve Telegram connector status: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

async function resolveSignalStatus(
  lifeOps: LifeOpsService,
): Promise<LifeOpsSignalConnectorStatus | null> {
  try {
    return await lifeOps.getSignalConnectorStatus("owner");
  } catch (error) {
    logger.warn(
      `[lifeops] Failed to resolve Signal connector status: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

async function resolveDiscordStatus(
  lifeOps: LifeOpsService,
): Promise<LifeOpsDiscordConnectorStatus | null> {
  try {
    return await lifeOps.getDiscordConnectorStatus("owner");
  } catch (error) {
    logger.warn(
      `[lifeops] Failed to resolve Discord connector status: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

function buildLifeOpsNode(
  id: string,
  label: string,
  description: string,
  enabled: boolean,
  disabledReason: string,
): AutomationNodeDescriptor {
  return {
    id,
    label,
    description,
    class: "integration",
    source: "lifeops",
    backingCapability: id,
    ownerScoped: true,
    requiresSetup: true,
    availability: enabled ? "enabled" : "disabled",
    ...(enabled ? {} : { disabledReason }),
  };
}

function buildLifeOpsEventNode(
  eventKind: string,
  label: string,
  description: string,
  enabled: boolean,
  disabledReason: string,
): AutomationNodeDescriptor {
  return {
    id: `event:${eventKind}`,
    label,
    description,
    class: "trigger",
    source: "lifeops_event",
    backingCapability: eventKind,
    ownerScoped: true,
    requiresSetup: !enabled,
    availability: enabled ? "enabled" : "disabled",
    ...(enabled ? {} : { disabledReason }),
  };
}

async function buildLifeOpsAutomationNodes({
  runtime,
  adminEntityId,
}: AutomationNodeContributorContext): Promise<AutomationNodeDescriptor[]> {
  const lifeOps = new LifeOpsService(runtime, { ownerEntityId: adminEntityId });
  const [googleStatus, telegramStatus, signalStatus, discordStatus] =
    await Promise.all([
      resolveGoogleStatus(lifeOps),
      resolveTelegramStatus(lifeOps),
      resolveSignalStatus(lifeOps),
      resolveDiscordStatus(lifeOps),
    ]);

  const googleCapabilities = new Set(googleStatus?.grantedCapabilities ?? []);
  const hasGoogleCapability = (needle: string) =>
    [...googleCapabilities].some((capability) => capability.includes(needle));
  const githubToken = runtime.getSetting("GITHUB_TOKEN");
  const githubConnected =
    typeof githubToken === "string" && githubToken.trim().length > 0;
  const calendarConnected = Boolean(
    googleStatus?.connected && hasGoogleCapability("calendar"),
  );

  return [
    buildLifeOpsNode(
      "lifeops:gmail",
      "Gmail",
      "Owner-scoped Gmail triage, drafting, and send operations.",
      Boolean(googleStatus?.connected && hasGoogleCapability("gmail")),
      "Connect the owner Google account with Gmail access.",
    ),
    buildLifeOpsNode(
      "lifeops:calendar",
      "Calendar",
      "Owner-scoped calendar reading and event creation.",
      calendarConnected,
      "Connect the owner Google account with Calendar access.",
    ),
    buildLifeOpsNode(
      "lifeops:telegram",
      "Telegram",
      "Owner-scoped Telegram account messaging.",
      Boolean(telegramStatus?.connected),
      "Connect the owner Telegram account.",
    ),
    buildLifeOpsNode(
      "lifeops:signal",
      "Signal",
      "Owner-scoped Signal messaging.",
      Boolean(signalStatus?.connected),
      "Pair the owner Signal account.",
    ),
    buildLifeOpsNode(
      "lifeops:discord",
      "Discord",
      "Owner-scoped Discord messaging through the active owner session.",
      Boolean(discordStatus?.connected && discordStatus.available),
      "Connect the owner Discord session.",
    ),
    buildLifeOpsNode(
      "lifeops:github",
      "GitHub",
      "Owner-scoped GitHub access for repositories, issues, and pull requests.",
      githubConnected,
      "Link the owner GitHub account.",
    ),
    buildLifeOpsEventNode(
      "calendar.event.ended",
      "Calendar event ended",
      "Fires a workflow after a synced calendar event's end time has passed.",
      calendarConnected,
      "Connect the owner Google account with Calendar access.",
    ),
  ];
}

export function registerLifeOpsAutomationNodeContributor(): void {
  registerAutomationNodeContributor("lifeops", buildLifeOpsAutomationNodes);
}
