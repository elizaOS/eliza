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
  BASE_FEATURE_DEFAULTS,
  isLifeOpsFeatureKey,
  type LifeOpsFeatureKey,
} from "../lifeops/feature-flags.types.js";
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
  featureKey: LifeOpsFeatureKey | null;
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

function buildFeatureCatalog(): string {
  return ALL_FEATURE_KEYS.map((key) => {
    const def = BASE_FEATURE_DEFAULTS[key];
    return `- ${key}: ${def.description}${def.costsMoney ? " (costs money)" : ""}`;
  }).join("\n");
}

async function extractToggleWithLlm(args: {
  runtime: IAgentRuntime;
  message: Memory;
  state: State | undefined;
  params: ToggleParameters;
}): Promise<ExtractedToggle> {
  if (typeof args.runtime.useModel !== "function") {
    return {
      featureKey: isLifeOpsFeatureKey(args.params.featureKey)
        ? args.params.featureKey
        : null,
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
    buildFeatureCatalog(),
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

  const featureKeyRaw = parsed?.featureKey;
  const featureKey = isLifeOpsFeatureKey(featureKeyRaw) ? featureKeyRaw : null;
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
  key: LifeOpsFeatureKey,
  enabled: boolean,
  source: string,
  reason: string | null,
): string {
  const def = BASE_FEATURE_DEFAULTS[key];
  const verb = enabled ? "Enabled" : "Disabled";
  const tail = reason ? ` (${reason})` : "";
  const cost =
    def.costsMoney && enabled
      ? " Heads up: this feature can cost money — every action still requires explicit approval."
      : "";
  return `${verb} '${key}' (${source}). ${def.description}${tail}.${cost}`;
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
    "The set of feature keys is closed — do not invent new ones.",
  descriptionCompressed:
    "toggle LifeOps feature flight-booking push-notifs browser-automation escalation: enable | disable; closed feature key set",
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
    const params = getParams(options as HandlerOptions | undefined);
    const extracted = await extractToggleWithLlm({
      runtime,
      message,
      state,
      params,
    });

    const featureKey = extracted.featureKey;
    const enabled = extracted.enabled;
    if (!featureKey || enabled === null) {
      const text =
        "I could not match your request to a LifeOps feature. Available keys: " +
        ALL_FEATURE_KEYS.join(", ") +
        ". Tell me which one to enable or disable.";
      await callback?.({ text });
      return {
        text,
        success: false,
        values: { success: false, error: "AMBIGUOUS_TOGGLE" },
        data: { actionName: ACTION_NAME, error: "AMBIGUOUS_TOGGLE" },
      };
    }

    const service = createFeatureFlagService(runtime);
    const subjectUserId =
      typeof message.entityId === "string" ? message.entityId : null;
    const next = enabled
      ? await service.enable(featureKey, "local", subjectUserId)
      : await service.disable(featureKey, "local", subjectUserId);

    const text = buildConfirmation(
      featureKey,
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
      description: `LifeOps feature key. One of: ${ALL_FEATURE_KEYS.join(", ")}.`,
      required: false,
      schema: { type: "string" as const, enum: [...ALL_FEATURE_KEYS] },
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
