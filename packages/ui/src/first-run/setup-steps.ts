import { canRunLocal } from "../platform/init";
import type {
  FlaminaGuideTopic,
  SetupStep,
  SetupStepMeta,
} from "../state/types";
import { SETUP_STEPS } from "../state/types";

export function getSetupStepOrder(): SetupStep[] {
  return SETUP_STEPS.map((s) => s.id);
}

export function getSetupStepIndex(step: SetupStep): number {
  return getSetupStepOrder().indexOf(step);
}

export function resolveSetupNextStep(current: SetupStep): SetupStep | null {
  const order = getSetupStepOrder();
  const i = order.indexOf(current);
  if (i < 0 || i >= order.length - 1) return null;
  return order[i + 1] ?? null;
}

export function resolveSetupPreviousStep(current: SetupStep): SetupStep | null {
  const order = getSetupStepOrder();
  const i = order.indexOf(current);
  if (i > 0) return order[i - 1] ?? null;
  return null;
}

export function canRevertSetupTo(params: {
  current: SetupStep;
  target: SetupStep;
}): boolean {
  const curIdx = getSetupStepIndex(params.current);
  const tgtIdx = getSetupStepIndex(params.target);
  return tgtIdx >= 0 && curIdx >= 0 && tgtIdx < curIdx;
}

export function getSetupNavMetas(
  _currentStep: SetupStep,
  cloudOnly: boolean,
): SetupStepMeta[] {
  if (cloudOnly || canRunLocal()) {
    return SETUP_STEPS.filter((s) => s.id !== "connection");
  }
  return [...SETUP_STEPS];
}

export function shouldSkipConnectionStepsForCloudProvisionedContainer(args: {
  currentStep: SetupStep;
  cloudProvisionedContainer: boolean;
}): boolean {
  return args.cloudProvisionedContainer && args.currentStep === "connection";
}

export function shouldUseCloudSetupFastTrack(args: {
  cloudProvisionedContainer: boolean;
  elizaCloudConnected: boolean;
  firstRunRunMode: "local" | "cloud" | "";
  firstRunProvider: string;
}): boolean {
  if (args.cloudProvisionedContainer) {
    return true;
  }

  return (
    args.elizaCloudConnected &&
    !(
      args.firstRunRunMode === "local" &&
      args.firstRunProvider &&
      args.firstRunProvider !== "elizacloud"
    )
  );
}

export function getFlaminaTopicForSetupStep(
  step: SetupStep,
): FlaminaGuideTopic | null {
  switch (step) {
    case "model":
      return "provider";
    case "capabilities":
      return "features";
    default:
      return null;
  }
}
