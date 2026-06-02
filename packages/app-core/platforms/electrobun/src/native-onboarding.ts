/**
 * Native macOS notification–driven onboarding flow.
 *
 * Instead of opening a BrowserWindow for onboarding, this module:
 * 1. Posts a native macOS notification with action buttons
 *    ("Local (On-Device)", "Local (Cloud AI)", "Eliza Cloud")
 * 2. Polls for the user's choice via FFI
 * 3. Calls the local first-run API to complete onboarding
 *
 * This runs entirely in the main process — no renderer needed for the choice.
 * After the first-run API responds, the caller opens the dashboard.
 */

import {
  DEFAULT_ELIZA_CLOUD_TEXT_MODEL,
  getDefaultStylePreset,
} from "@elizaos/shared";
import { buildFirstRunRuntimeConfig } from "../../../src/first-run/first-run-config";
import { logger } from "./logger";
import {
  dismissOnboardingNotification,
  getOnboardingChoice,
  type OnboardingChoice,
  postOnboardingNotification,
} from "./native/mac-window-effects";

/**
 * Resolved user choice from the notification, mapped to the runtime fields
 * understood by the first-run API.
 */
export interface ResolvedOnboardingChoice {
  runtime: "local" | "cloud";
  localInference: "all-local" | "cloud-inference";
}

/**
 * Post the onboarding notification and poll until the user picks an action.
 * Returns `null` if the notification could not be posted (e.g. non-macOS) or
 * the user dismissed it.
 */
export async function waitForOnboardingNotificationChoice(): Promise<ResolvedOnboardingChoice | null> {
  const posted = postOnboardingNotification(
    "Welcome to Eliza",
    "Choose how to run your agent.",
  );
  if (!posted) {
    logger.warn(
      "[native-onboarding] Failed to post notification — falling back to overlay",
    );
    return null;
  }
  logger.info("[native-onboarding] Notification posted, waiting for choice…");

  return new Promise<ResolvedOnboardingChoice | null>((resolve) => {
    const timer = setInterval(() => {
      const choice: OnboardingChoice = getOnboardingChoice();
      if (choice === 0) return; // still waiting

      clearInterval(timer);
      dismissOnboardingNotification();

      switch (choice) {
        case 1: // Local (On-Device)
          logger.info("[native-onboarding] User chose: local all-on-device");
          resolve({ runtime: "local", localInference: "all-local" });
          break;
        case 2: // Local (Cloud AI)
          logger.info("[native-onboarding] User chose: local cloud-inference");
          resolve({ runtime: "local", localInference: "cloud-inference" });
          break;
        case 3: // Eliza Cloud
          logger.info("[native-onboarding] User chose: Eliza Cloud");
          resolve({ runtime: "cloud", localInference: "all-local" });
          break;
        case 4: // Dismissed — re-post
          logger.info(
            "[native-onboarding] Notification dismissed — re-posting",
          );
          // Recursive: re-post on dismiss
          resolve(waitForOnboardingNotificationChoice());
          break;
        default:
          resolve(null);
      }
    }, 500);
  });
}

/**
 * Build the first-run submit payload and POST it to the local API server.
 *
 * This mirrors what the renderer does in `finishLocal` / `finishCloud`,
 * but runs entirely from the main process so no renderer window is needed.
 */
export async function submitOnboardingFirstRun(
  apiBase: string,
  choice: ResolvedOnboardingChoice,
): Promise<boolean> {
  const style = getDefaultStylePreset();
  const agentName = style.name;

  const runtimeTarget =
    choice.runtime === "cloud"
      ? "elizacloud"
      : choice.localInference === "cloud-inference"
        ? "elizacloud-hybrid"
        : "local";

  const provider =
    choice.runtime === "cloud" || choice.localInference === "cloud-inference"
      ? "elizacloud"
      : "";

  const useCloudModels =
    choice.runtime === "cloud" || choice.localInference === "cloud-inference";
  const cloudModel = useCloudModels ? DEFAULT_ELIZA_CLOUD_TEXT_MODEL : "";

  const runtimeConfig = buildFirstRunRuntimeConfig({
    firstRunRuntimeTarget: runtimeTarget,
    firstRunCloudApiKey: "",
    firstRunProvider: provider,
    firstRunApiKey: "",
    omitRuntimeProvider: provider !== "elizacloud",
    firstRunVoiceProvider: "",
    firstRunVoiceApiKey: "",
    firstRunPrimaryModel: "",
    firstRunOpenRouterModel: "",
    firstRunRemoteConnected: false,
    firstRunRemoteApiBase: "",
    firstRunRemoteToken: "",
    firstRunNanoModel: cloudModel,
    firstRunSmallModel: cloudModel,
    firstRunMediumModel: cloudModel,
    firstRunLargeModel: cloudModel,
    firstRunMegaModel: cloudModel,
    firstRunFeatureCrypto: true,
    firstRunFeatureBrowser: true,
  });

  const systemPrompt =
    style.system?.replace(/\{\{name\}\}/g, agentName) ??
    `You are ${agentName}, an autonomous AI agent powered by elizaOS.`;

  const payload = {
    name: agentName,
    sandboxMode: choice.runtime === "cloud" ? "standard" : "off",
    bio: style.bio ?? ["An autonomous AI agent."],
    systemPrompt,
    style: style.style,
    adjectives: style.adjectives,
    topics: style.topics,
    postExamples: style.postExamples,
    messageExamples: style.messageExamples,
    avatarIndex: style.avatarIndex ?? 1,
    language: "en",
    presetId: style.id,
    deploymentTarget: runtimeConfig.deploymentTarget,
    ...(runtimeConfig.linkedAccounts
      ? { linkedAccounts: runtimeConfig.linkedAccounts }
      : {}),
    ...(runtimeConfig.serviceRouting
      ? { serviceRouting: runtimeConfig.serviceRouting }
      : {}),
    ...(runtimeConfig.credentialInputs
      ? { credentialInputs: runtimeConfig.credentialInputs }
      : {}),
    features: {
      crypto: { enabled: true },
      browser: { enabled: true },
      voice: { enabled: true, firstRun: true },
    },
  };

  logger.info(
    `[native-onboarding] Submitting first-run to ${apiBase}/api/first-run (runtime=${choice.runtime}, target=${runtimeTarget})`,
  );

  try {
    const response = await fetch(`${apiBase}/api/first-run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text();
      logger.error(
        `[native-onboarding] First-run API failed (${response.status}): ${text}`,
      );
      return false;
    }

    logger.info("[native-onboarding] First-run API succeeded");
    return true;
  } catch (err) {
    logger.error(
      `[native-onboarding] First-run API call failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/**
 * Wait for the local API server to be ready by polling `/api/first-run/status`.
 */
export async function waitForApiReady(
  apiBase: string,
  timeoutMs = 60_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${apiBase}/api/first-run/status`);
      if (res.ok) return true;
    } catch {
      // Server not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}
