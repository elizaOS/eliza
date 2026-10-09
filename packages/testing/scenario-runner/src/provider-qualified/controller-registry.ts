/**
 * Defines the repository-owned routing table from every release-blocking
 * provider canary to its operation contract and raw controller family. The
 * table is data-only so operator tooling can select a reviewed adapter without
 * importing scenario or provider code before authorization.
 */

import {
  PROVIDER_CANARY_SCENARIO_IDS,
  type ProviderCanaryScenarioId,
} from "./canary-catalog.ts";
import type { ProviderOperationKind } from "./operation-binding.ts";

export const PROVIDER_CONTROLLER_FAMILIES = [
  "bluebubbles",
  "discord",
  "duffel",
  "google-workspace",
  "messaging",
  "slack",
  "twilio",
] as const;

export type ProviderControllerFamily =
  (typeof PROVIDER_CONTROLLER_FAMILIES)[number];

export interface ProviderCanaryControllerContract {
  scenarioId: ProviderCanaryScenarioId;
  operationKind: ProviderOperationKind;
  controllerFamily: ProviderControllerFamily;
  requiresDeployedIngress: true;
  requiresVerifiedTrajectories: true;
  requiresIndependentObserver: true;
  requiresIndependentSemanticJudge: true;
  requiresReplayProof: true;
  requiresFailureProbeProof: true;
  requiresCleanupProof: true;
}

const REQUIRED_EXTERNAL_BOUNDARIES = Object.freeze({
  requiresDeployedIngress: true,
  requiresVerifiedTrajectories: true,
  requiresIndependentObserver: true,
  requiresIndependentSemanticJudge: true,
  requiresReplayProof: true,
  requiresFailureProbeProof: true,
  requiresCleanupProof: true,
} as const);

function contract(
  scenarioId: ProviderCanaryScenarioId,
  operationKind: ProviderOperationKind,
  controllerFamily: ProviderControllerFamily,
): ProviderCanaryControllerContract {
  return Object.freeze({
    scenarioId,
    operationKind,
    controllerFamily,
    ...REQUIRED_EXTERNAL_BOUNDARIES,
  });
}

/** Exact scenario-to-controller authority used by protected operator tooling. */
export const PROVIDER_CANARY_CONTROLLER_CONTRACTS = Object.freeze({
  "provider.bluebubbles-imessage.confirmed-send": contract(
    "provider.bluebubbles-imessage.confirmed-send",
    "bluebubbles.message-send",
    "bluebubbles",
  ),
  "provider.discord.confirmed-send": contract(
    "provider.discord.confirmed-send",
    "discord.message-send",
    "discord",
  ),
  "provider.duffel-travel.booking": contract(
    "provider.duffel-travel.booking",
    "duffel.booking-hold-create",
    "duffel",
  ),
  "provider.gmail.confirmed-send": contract(
    "provider.gmail.confirmed-send",
    "gmail.email-send",
    "google-workspace",
  ),
  "provider.google-calendar.create": contract(
    "provider.google-calendar.create",
    "google-calendar.event-create",
    "google-workspace",
  ),
  "provider.google-sheets.create": contract(
    "provider.google-sheets.create",
    "google-sheets.spreadsheet-create",
    "google-workspace",
  ),
  "provider.signal.confirmed-send": contract(
    "provider.signal.confirmed-send",
    "signal.message-send",
    "messaging",
  ),
  "provider.slack.confirmed-send": contract(
    "provider.slack.confirmed-send",
    "slack.message-send",
    "slack",
  ),
  "provider.telegram.confirmed-send": contract(
    "provider.telegram.confirmed-send",
    "telegram.message-send",
    "messaging",
  ),
  "provider.twilio-sms.confirmed-send": contract(
    "provider.twilio-sms.confirmed-send",
    "twilio.sms-send",
    "twilio",
  ),
  "provider.twilio-voice.confirmed-call": contract(
    "provider.twilio-voice.confirmed-call",
    "twilio.call-create",
    "twilio",
  ),
  "provider.whatsapp.confirmed-send": contract(
    "provider.whatsapp.confirmed-send",
    "whatsapp.message-send",
    "messaging",
  ),
  "provider.x-dm.confirmed-send": contract(
    "provider.x-dm.confirmed-send",
    "x.direct-message-send",
    "messaging",
  ),
} as const satisfies Record<
  ProviderCanaryScenarioId,
  ProviderCanaryControllerContract
>);

/** Resolve only a canonical release-blocking canary; arbitrary IDs fail closed. */
export function providerCanaryControllerContract(
  scenarioId: string,
): ProviderCanaryControllerContract {
  if (
    !(PROVIDER_CANARY_SCENARIO_IDS as readonly string[]).includes(scenarioId)
  ) {
    throw new Error(
      `provider controller registry rejects non-canonical scenario ${scenarioId}`,
    );
  }
  return PROVIDER_CANARY_CONTROLLER_CONTRACTS[
    scenarioId as ProviderCanaryScenarioId
  ];
}
