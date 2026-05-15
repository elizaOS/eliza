import { modelLooksLikeElizaCloudHosted } from "@elizaos/ui";

export type CompanionInferenceNotice =
  | { kind: "cloud"; variant: "danger" | "warn"; tooltip: string }
  | { kind: "settings"; variant: "warn"; tooltip: string };

export function resolveCompanionInferenceNotice(args: {
  elizaCloudConnected: boolean;
  elizaCloudAuthRejected: boolean;
  elizaCloudCreditsError: string | null | undefined;
  elizaCloudEnabled: boolean;
  chatLastUsageModel?: string;
  hasInterruptedAssistant: boolean;
  t: (key: string) => string;
}): CompanionInferenceNotice | null {
  const {
    elizaCloudConnected,
    elizaCloudAuthRejected,
    elizaCloudCreditsError,
    elizaCloudEnabled,
    chatLastUsageModel,
    hasInterruptedAssistant,
    t,
  } = args;

  if (
    elizaCloudConnected &&
    (elizaCloudAuthRejected || Boolean(elizaCloudCreditsError?.trim()))
  ) {
    return {
      kind: "cloud",
      variant: elizaCloudAuthRejected ? "danger" : "warn",
      tooltip: elizaCloudAuthRejected
        ? t("notice.elizaCloudAuthRejected")
        : (elizaCloudCreditsError?.trim() ?? ""),
    };
  }

  const disconnectedCloudRelevant =
    !elizaCloudConnected &&
    (elizaCloudEnabled || modelLooksLikeElizaCloudHosted(chatLastUsageModel));

  if (disconnectedCloudRelevant) {
    return {
      kind: "cloud",
      variant: "warn",
      tooltip: t("chat.inferenceCloudNotConnected"),
    };
  }

  if (hasInterruptedAssistant) {
    return {
      kind: "settings",
      variant: "warn",
      tooltip: t("chat.inferenceStreamInterrupted"),
    };
  }

  return null;
}
