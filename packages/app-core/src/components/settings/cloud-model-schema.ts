/**
 * Cloud model tier schema + hints builder.
 *
 * Exposes seven `ConfigRenderer` selects (five tiers + response handler + action planner).
 *
 * **WHY sentinels + `DEFAULT_ELIZA_CLOUD_TIER_MODEL_IDS`:** Tier enums used to be
 * catalog-only; empty / not-yet-loaded values rendered as “Select…” because `ConfigRenderer`
 * treats missing keys as unset. Response handler / planner already used `__DEFAULT_*__`
 * sentinels with “Default (…)” labels — tiers follow the same UX. Sentinels resolve to
 * real model ids on save; defaults must stay aligned with server routing defaults.
 *
 * **WHY `required` on all seven keys:** Prevents a “None” row on optional selects, which
 * read like “off” rather than “platform default”.
 *
 * **Design context:** `docs/settings-ui-design.md` § Eliza Cloud model tiers.
 */

import type { OnboardingOptions } from "../../api";
import type { JsonSchemaObject } from "../../config";
import type { ConfigUiHint } from "../../types";

export const DEFAULT_RESPONSE_HANDLER_MODEL = "__DEFAULT_RESPONSE_HANDLER__";
export const DEFAULT_ACTION_PLANNER_MODEL = "__DEFAULT_ACTION_PLANNER__";

/** Canonical Eliza Cloud default model id per tier (matches server defaults). */
export const DEFAULT_ELIZA_CLOUD_TIER_MODEL_IDS = {
  nano: "openai/gpt-5.4-nano",
  small: "minimax/minimax-m2.7",
  medium: "anthropic/claude-sonnet-4.6",
  large: "moonshotai/kimi-k2.5",
  mega: "anthropic/claude-sonnet-4.6",
} as const;

export type CloudModelTierKey = keyof typeof DEFAULT_ELIZA_CLOUD_TIER_MODEL_IDS;

export const CLOUD_MODEL_TIER_KEYS = Object.keys(
  DEFAULT_ELIZA_CLOUD_TIER_MODEL_IDS,
) as CloudModelTierKey[];

/** UI / persisted sentinel meaning “use the tier’s default catalog model”. */
export const DEFAULT_CLOUD_TIER_SENTINEL: Record<CloudModelTierKey, string> = {
  nano: "__DEFAULT_ELIZA_CLOUD_NANO__",
  small: "__DEFAULT_ELIZA_CLOUD_SMALL__",
  medium: "__DEFAULT_ELIZA_CLOUD_MEDIUM__",
  large: "__DEFAULT_ELIZA_CLOUD_LARGE__",
  mega: "__DEFAULT_ELIZA_CLOUD_MEGA__",
};

export function isDefaultCloudTierSentinel(
  tier: CloudModelTierKey,
  value: string,
): boolean {
  return value === DEFAULT_CLOUD_TIER_SENTINEL[tier];
}

/** Resolve a tier dropdown value to the concrete model id stored in config. */
export function resolveCloudTierModelForPersistence(
  tier: CloudModelTierKey,
  value: string,
): string {
  if (!value || isDefaultCloudTierSentinel(tier, value)) {
    return DEFAULT_ELIZA_CLOUD_TIER_MODEL_IDS[tier];
  }
  return value;
}

/**
 * Map stored config to the value shown in the tier select (sentinel when the
 * effective model is the tier default).
 */
export function normalizeCloudTierModelForUi(
  tier: CloudModelTierKey,
  stored: string,
  elizaCloud: boolean,
): string {
  if (!elizaCloud) return stored;
  if (isDefaultCloudTierSentinel(tier, stored)) {
    return DEFAULT_CLOUD_TIER_SENTINEL[tier];
  }
  const def = DEFAULT_ELIZA_CLOUD_TIER_MODEL_IDS[tier];
  if (!stored || stored === def) {
    return DEFAULT_CLOUD_TIER_SENTINEL[tier];
  }
  return stored;
}

type ModelOption = {
  id: string;
  name: string;
  provider: string;
  description: string;
};

const TIER_LABELS: Record<CloudModelTierKey, string> = {
  nano: "Nano Model",
  small: "Small Model",
  medium: "Medium Model",
  large: "Large Model",
  mega: "Mega Model",
};

const TIER_DESCRIPTIONS: Record<CloudModelTierKey, string> = {
  nano: "Fastest, cheapest text tier.",
  small: "Default lightweight text tier.",
  medium:
    "Mid-tier text routing. When unset in config, reuses your Small model id.",
  large: "Primary high-capability text tier.",
  mega: "When unset in config, reuses your Large model id.",
};

function formatOption(m: ModelOption) {
  return {
    value: m.id,
    label: m.name,
    description: `${m.provider} — ${m.description}`,
  };
}

function catalogDisplayName(
  id: string,
  primaryTier: ModelOption[],
  allChoices: ModelOption[],
): string {
  return (
    primaryTier.find((m) => m.id === id)?.name ??
    allChoices.find((m) => m.id === id)?.name ??
    id
  );
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
  const tierOptions: Record<CloudModelTierKey, ModelOption[]> = {
    nano: options.nano ?? [],
    small: options.small ?? [],
    medium: options.medium ?? [],
    large: options.large ?? [],
    mega: options.mega ?? [],
  };

  const allChoices = Array.from(
    new Map(
      CLOUD_MODEL_TIER_KEYS.flatMap((k) => tierOptions[k]).map((m) => [
        m.id,
        m,
      ]),
    ).values(),
  );

  const properties: Record<string, Record<string, unknown>> = {};
  const hints: Record<string, ConfigUiHint> = {};

  for (const key of CLOUD_MODEL_TIER_KEYS) {
    const defaultId = DEFAULT_ELIZA_CLOUD_TIER_MODEL_IDS[key];
    const sentinel = DEFAULT_CLOUD_TIER_SENTINEL[key];
    const tierList = tierOptions[key];
    const idsWithoutDefaultDup = tierList
      .map((m) => m.id)
      .filter((id) => id !== defaultId);
    const defaultDisplay = catalogDisplayName(defaultId, tierList, allChoices);

    properties[key] = {
      type: "string",
      enum: [sentinel, ...idsWithoutDefaultDup],
      description: TIER_DESCRIPTIONS[key],
    };
    hints[key] = {
      label: TIER_LABELS[key],
      width: "half",
      options: [
        {
          value: sentinel,
          label: `Default (${defaultDisplay})`,
        },
        ...tierList.filter((m) => m.id !== defaultId).map(formatOption),
      ],
    };
  }

  const nanoDefaultId = DEFAULT_ELIZA_CLOUD_TIER_MODEL_IDS.nano;
  const mediumDefaultId = DEFAULT_ELIZA_CLOUD_TIER_MODEL_IDS.medium;
  const nanoDefaultName = catalogDisplayName(
    nanoDefaultId,
    tierOptions.nano,
    allChoices,
  );
  const mediumDefaultName = catalogDisplayName(
    mediumDefaultId,
    tierOptions.medium,
    allChoices,
  );

  properties.responseHandler = {
    type: "string",
    enum: [DEFAULT_RESPONSE_HANDLER_MODEL, ...allChoices.map((m) => m.id)],
    description: "Should-respond / response-handler model override.",
  };
  hints.responseHandler = {
    label: "Response Handler",
    width: "half",
    options: [
      {
        value: DEFAULT_RESPONSE_HANDLER_MODEL,
        label: `Default (${nanoDefaultName})`,
      },
      ...allChoices.map(formatOption),
    ],
  };

  properties.actionPlanner = {
    type: "string",
    enum: [DEFAULT_ACTION_PLANNER_MODEL, ...allChoices.map((m) => m.id)],
    description:
      "Model for tool/action planning. Not the Medium cloud tier above.",
  };
  hints.actionPlanner = {
    label: "Action Planner",
    width: "half",
    options: [
      {
        value: DEFAULT_ACTION_PLANNER_MODEL,
        label: `Default (${mediumDefaultName})`,
      },
      ...allChoices.map(formatOption),
    ],
  };

  const schema: JsonSchemaObject = {
    type: "object",
    properties,
    required: [
      ...CLOUD_MODEL_TIER_KEYS,
      "responseHandler",
      "actionPlanner",
    ] as string[],
  };

  return { schema, hints };
}
