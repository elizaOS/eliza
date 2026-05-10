import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { ModelType, runWithTrajectoryContext } from "@elizaos/core";
import { createFeatureFlagService } from "../lifeops/feature-flags.js";
import {
  ALL_FEATURE_KEYS,
  type LifeOpsFeatureFlagKey,
} from "../lifeops/feature-flags.types.js";
import {
  type FeatureFlagContribution,
  type FeatureFlagRegistry,
  getFeatureFlagRegistry,
  UnknownFeatureFlagError,
} from "../lifeops/registries/feature-flag-registry.js";
import { parseJsonModelRecord } from "../utils/json-model-output.js";
import { formatPromptSection } from "./lib/prompt-format.js";
import { recentConversationTexts as collectRecentConversationTexts } from "./lib/recent-context.js";

const ACTION_NAME = "TOGGLE_FEATURE";

interface ToggleParameters {
  readonly featureKey?: string;
  readonly enabled?: boolean;
  readonly reason?: string;
}

interface ExtractedToggle {
  featureKey: LifeOpsFeatureFlagKey | null;
  enabled: boolean | null;
  reason: string | null;
}

function getParams(options: HandlerOptions | undefined): ToggleParameters {
  return ((options?.parameters as ToggleParameters | undefined) ??
    {}) as ToggleParameters;
}

function messageText(message: Memory): string {
  return typeof message.content?.text === "string" ? message.content.text : "";
}

function trimToNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildFeatureCatalog(registry: FeatureFlagRegistry): string {
  return registry
    .list()
    .map((c) => {
      const costsMoney = c.metadata?.costsMoney === "true";
      return `- ${c.key}: ${c.description}${costsMoney ? " (costs money)" : ""}`;
    })
    .join("\n");
}

function pickFeatureKeyFromInput(
  registry: FeatureFlagRegistry,
  raw: unknown,
): LifeOpsFeatureFlagKey | null {
  if (typeof raw !== "string") return null;
  return registry.has(raw) ? raw : null;
}

async function extractToggleWithLlm(args: {
  runtime: IAgentRuntime;
  registry: FeatureFlagRegistry;
  message: Memory;
  state: State | undefined;
  params: ToggleParameters;
}): Promise<ExtractedToggle> {
  if (typeof args.runtime.useModel !== "function") {
    return {
      featureKey: pickFeatureKeyFromInput(args.registry, args.params.featureKey),
      enabled:
        typeof args.params.enabled === "boolean" ? args.params.enabled : null,
      reason: trimToNull(args.params.reason),
    };
  }

  const recentConversation = (
    await collectRecentConversationTexts({
      runtime: args.runtime,
      message: args.message,
      state: args.state,
      limit: 4,
    })
  ).join("\n");

  const prompt = [
    "Decide which LifeOps feature flag the owner is asking to toggle, if any.",
    "Return JSON only as a single object with exactly these keys:",
    "featureKey: string|null",
    "enabled: boolean|null",
    "reason: string|null",
    'Example: {"featureKey":"browser.automation","enabled":false,"reason":"wants manual control"}',
    "",
    "Allowed featureKey values (use null when no good match):",
    buildFeatureCatalog(args.registry),
    "",
    "Rules:",
    "- featureKey must be exactly one of the allowed values, or null.",
    "- enabled is true when the owner asks to enable/turn on/activate the feature.",
    "- enabled is false when the owner asks to disable/turn off/deactivate it.",
    "- enabled is null when the owner is not clearly toggling anything.",
    "- reason captures the owner's stated motivation in <= 12 words, or null.",
    "",
    `User message:\n${messageText(args.message)}`,
    "",
    formatPromptSection("Current parameters", args.params),
    "",
    `Recent conversation:\n${recentConversation}`,
  ].join("\n");

  const raw = await runWithTrajectoryContext(
    { purpose: "lifeops-toggle-feature" },
    () => args.runtime.useModel(ModelType.TEXT_SMALL, { prompt }),
  );
  const rawText = typeof raw === "string" ? raw : "";
  const parsed = parseJsonModelRecord<Record<string, unknown>>(rawText);

  const featureKey = pickFeatureKeyFromInput(args.registry, parsed?.featureKey);
  const enabled =
    typeof parsed?.enabled === "boolean"
      ? parsed.enabled
      : typeof parsed?.enabled === "string"
        ? parsed.enabled.toLowerCase() === "true"
        : null;

  return {
    featureKey,
    enabled,
    reason: trimToNull(parsed?.reason),
  };
}

function buildConfirmation(
  contribution: FeatureFlagContribution,
  enabled: boolean,
  source: string,
  reason: string | null,
): string {
  const costsMoney = contribution.metadata?.costsMoney === "true";
  const verb = enabled ? "Enabled" : "Disabled";
  const tail = reason ? ` (${reason})` : "";
  const cost =
    costsMoney && enabled
      ? " Heads up: this feature can cost money — every action still requires explicit approval."
      : "";
  return `${verb} '${contribution.key}' (${source}). ${contribution.description}${tail}.${cost}`;
}

export const toggleFeatureAction: Action = {
  name: ACTION_NAME,
  similes: [
    "ENABLE_FEATURE",
    "DISABLE_FEATURE",
    "TURN_ON_FEATURE",
    "TURN_OFF_FEATURE",
    "OPT_IN",
    "OPT_OUT",
  ],
  description:
    "Owner-only: enable or disable a LifeOps capability (flight booking, push notifications, browser automation, escalation, etc.). " +
    "The set of feature keys is registry-driven — only keys registered in the FeatureFlagRegistry are accepted.",
  descriptionCompressed:
    "toggle LifeOps feature flight-booking push-notifs browser-automation escalation: enable | disable; registry-driven feature key set",
  contexts: ["settings", "automation", "connectors"],
  roleGate: { minRole: "OWNER" },
  validate: async () => true,
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state,
    options,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const registry = getFeatureFlagRegistry(runtime);
    if (!registry) {
      const text =
        "Feature flag registry is not initialized. Restart the LifeOps plugin and try again.";
      await callback?.({ text });
      return {
        text,
        success: false,
        values: { success: false, error: "REGISTRY_NOT_INITIALIZED" },
        data: { actionName: ACTION_NAME, error: "REGISTRY_NOT_INITIALIZED" },
      };
    }

    const params = getParams(options as HandlerOptions | undefined);
    const extracted = await extractToggleWithLlm({
      runtime,
      registry,
      message,
      state,
      params,
    });

    const featureKey = extracted.featureKey;
    const enabled = extracted.enabled;
    if (!featureKey || enabled === null) {
      const knownKeys = registry.list().map((c) => c.key);
      const text =
        "I could not match your request to a LifeOps feature. Available keys: " +
        knownKeys.join(", ") +
        ". Tell me which one to enable or disable.";
      await callback?.({ text });
      return {
        text,
        success: false,
        values: { success: false, error: "AMBIGUOUS_TOGGLE" },
        data: { actionName: ACTION_NAME, error: "AMBIGUOUS_TOGGLE" },
      };
    }

    if (!registry.has(featureKey)) {
      throw new UnknownFeatureFlagError(
        featureKey,
        registry.list().map((c) => c.key),
      );
    }
    const contribution = registry.get(featureKey);
    if (!contribution) {
      throw new UnknownFeatureFlagError(
        featureKey,
        registry.list().map((c) => c.key),
      );
    }

    const service = createFeatureFlagService(runtime);
    const subjectUserId =
      typeof message.entityId === "string" ? message.entityId : null;
    const next = enabled
      ? await service.enable(featureKey, "local", subjectUserId)
      : await service.disable(featureKey, "local", subjectUserId);

    const text = buildConfirmation(
      contribution,
      next.enabled,
      next.source,
      extracted.reason,
    );
    await callback?.({ text });

    return {
      text,
      success: true,
      values: {
        success: true,
        featureKey,
        enabled: next.enabled,
        source: next.source,
      },
      data: {
        actionName: ACTION_NAME,
        featureKey,
        enabled: next.enabled,
        source: next.source,
        costsMoney: next.costsMoney,
      },
    };
  },
  parameters: [
    {
      name: "featureKey",
      description:
        "LifeOps feature key. Must be a key that has been registered in the FeatureFlagRegistry " +
        "(see GET /api/lifeops/dev/registries → featureFlags for the live list).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "enabled",
      description: "True to enable, false to disable.",
      required: false,
      schema: { type: "boolean" as const },
    },
    {
      name: "reason",
      description: "Optional short reason captured for the audit log.",
      required: false,
      schema: { type: "string" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Enable flight booking, I want you to be able to book trips.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Enabled 'travel.book_flight' (local). Place real flight bookings via Duffel. Heads up: this feature can cost money — every action still requires explicit approval.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Turn off the browser automation, I want to drive myself.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Disabled 'browser.automation' (local). Allow Eliza to drive the browser extension (form fills, navigation, clicks).",
        },
      },
    ],
  ] as ActionExample[][],
};
