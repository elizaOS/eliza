/**
 * Cloud model tier schema + hints builder.
 *
 * The AI Model settings panel exposes 7 dropdowns (nano, small, medium, large,
 * mega, responseHandler, actionPlanner). Each is a `ConfigRenderer` select
 * field with the same shape — this module produces the schema and hints so
 * the component stays readable.
 */

import type { OnboardingOptions } from "../../api";
import type { JsonSchemaObject } from "../../config/config-catalog";
import type { ConfigUiHint } from "../../types";

export const DEFAULT_RESPONSE_HANDLER_MODEL = "__DEFAULT_RESPONSE_HANDLER__";
export const DEFAULT_ACTION_PLANNER_MODEL = "__DEFAULT_ACTION_PLANNER__";

type ModelOption = {
  id: string;
  name: string;
  provider: string;
  description: string;
  recommended?: boolean;
  free?: boolean;
};

const TIER_KEYS = ["nano", "small", "medium", "large", "mega"] as const;
type TierKey = (typeof TIER_KEYS)[number];

const TIER_LABELS: Record<TierKey, string> = {
  nano: "Nano Model",
  small: "Small Model",
  medium: "Medium Model",
  large: "Large Model",
  mega: "Mega Model",
};

const TIER_DESCRIPTIONS: Record<TierKey, string> = {
  nano: "Fastest, cheapest text tier.",
  small: "Default lightweight text tier.",
  medium: "Planning tier. Falls back to small.",
  large: "Primary high-capability text tier.",
  mega: "Future top tier. Falls back to large.",
};

function formatOption(m: ModelOption) {
  const badges = [
    m.recommended ? "recommended" : null,
    m.free ? "free" : null,
  ].filter(Boolean);
  const badgeText = badges.length > 0 ? ` (${badges.join(", ")})` : "";

  return {
    value: m.id,
    label: m.name,
    description: `${m.provider}${badgeText} - ${m.description}`,
  };
}

export interface CloudModelSchema {
  schema: JsonSchemaObject;
  hints: Record<string, ConfigUiHint>;
}

/**
 * Build the JSONSchema + UI hints for the cloud model tier grid.
 *
 * `allChoices` is the union of every tier's catalog, de-duped by id, used by
 * the override selectors (responseHandler, actionPlanner) which accept any
 * model.
 */
export function buildCloudModelSchema(
  options: OnboardingOptions["models"],
): CloudModelSchema {
  const tierOptions: Record<TierKey, ModelOption[]> = {
    nano: options.nano ?? [],
    small: options.small ?? [],
    medium: options.medium ?? [],
    large: options.large ?? [],
    mega: options.mega ?? [],
  };

  const allChoices = Array.from(
    new Map(
      TIER_KEYS.flatMap((k) => tierOptions[k]).map((m) => [m.id, m]),
    ).values(),
  );

  const properties: Record<string, Record<string, unknown>> = {};
  const hints: Record<string, ConfigUiHint> = {};

  for (const key of TIER_KEYS) {
    properties[key] = {
      type: "string",
      enum: tierOptions[key].map((m) => m.id),
      description: TIER_DESCRIPTIONS[key],
    };
    hints[key] = {
      label: TIER_LABELS[key],
      width: "half",
      options: tierOptions[key].map(formatOption),
    };
  }

  properties.responseHandler = {
    type: "string",
    enum: [DEFAULT_RESPONSE_HANDLER_MODEL, ...allChoices.map((m) => m.id)],
    description:
      "Should-respond / response-handler override. Defaults to nano.",
  };
  hints.responseHandler = {
    label: "Response Handler",
    width: "half",
    options: [
      {
        value: DEFAULT_RESPONSE_HANDLER_MODEL,
        label: "Default (Nano)",
        description: "Use the nano tier unless explicitly overridden.",
      },
      ...allChoices.map(formatOption),
    ],
  };

  properties.actionPlanner = {
    type: "string",
    enum: [DEFAULT_ACTION_PLANNER_MODEL, ...allChoices.map((m) => m.id)],
    description: "Planning override. Defaults to medium.",
  };
  hints.actionPlanner = {
    label: "Action Planner",
    width: "half",
    options: [
      {
        value: DEFAULT_ACTION_PLANNER_MODEL,
        label: "Default (Medium)",
        description: "Use the medium tier unless explicitly overridden.",
      },
      ...allChoices.map(formatOption),
    ],
  };

  const schema: JsonSchemaObject = {
    type: "object",
    properties,
    required: [] as string[],
  };

  return { schema, hints };
}
