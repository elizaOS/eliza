import type {
  CompanionHalfFramerateMode,
  CompanionVrmPowerMode,
} from "@elizaos/ui";

export const COMPANION_VRM_POWER_OPTIONS: readonly CompanionVrmPowerMode[] = [
  "quality",
  "balanced",
  "efficiency",
];

export const COMPANION_HALF_FRAMERATE_OPTIONS: readonly CompanionHalfFramerateMode[] =
  ["off", "when_saving_power", "always"];
