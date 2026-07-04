/**
 * UPDATE_MONETIZATION — "set the price / change the markup / enable monetization".
 *
 * Parses the monetization change (enable/disable, inference markup %, purchase
 * share %) from the user's text (planner options win), resolves the app, then
 * calls the typed `client.updateMonetization(id, settings)` and echoes the
 * resulting settings.
 *
 * Absurd values are rejected BEFORE the call with a clear message. The bounds
 * mirror the server's zod schema exactly (`UpdateMonetizationSchema`):
 *   - inference markup: 0–1000 %
 *   - purchase share:   0–100 %
 * Rejecting a value the server would accept (or sending one it would reject) is
 * a bug, so the guard is the server's contract — not a stricter local opinion.
 */

import type { AppDto, UpdateAppMonetizationInput } from "@elizaos/cloud-sdk";
import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import {
  extractAppReference,
  getCloudClient,
  resolveApp,
  resolveCloudApiKey,
} from "../client.js";
import { invalidateAppsCache } from "../providers/cloud-apps.js";

/** Server-enforced bounds (mirror `UpdateMonetizationSchema` in cloud-api). */
export const MARKUP_MIN = 0;
export const MARKUP_MAX = 1000;
export const SHARE_MIN = 0;
export const SHARE_MAX = 100;

const NO_KEY_MESSAGE =
  "I can't reach Eliza Cloud yet — no Cloud API key is configured. Add your ELIZAOS_CLOUD_API_KEY and I can change your app's monetization.";
const NO_REFERENCE_MESSAGE =
  "Which app's monetization would you like to change? Tell me its name.";
const NO_CHANGE_MESSAGE =
  "What should I change? You can turn monetization on or off, set the inference markup % (0–1000), or set the purchase share % (0–100).";
const ERROR_MESSAGE =
  "I couldn't update that app's monetization right now — the Cloud API returned an error. Try again in a moment.";

export interface MonetizationIntent {
  reference: string | null;
  settings: UpdateAppMonetizationInput;
  /** Out-of-range value that was parsed but rejected (for a clear message). */
  rejected?: {
    field: "markup" | "share";
    value: number;
    min: number;
    max: number;
  };
}

const OPTION_REFERENCE_KEYS = ["app", "appName", "appId", "id"] as const;
const OPTION_ENABLE_KEYS = [
  "monetization",
  "monetize",
  "monetizationEnabled",
  "monetization_enabled",
  "enabled",
  "enable",
] as const;
const OPTION_MARKUP_KEYS = [
  "markup",
  "markupPercentage",
  "inferenceMarkupPercentage",
  "inference_markup_percentage",
] as const;
const OPTION_SHARE_KEYS = [
  "purchaseShare",
  "purchaseSharePercentage",
  "purchase_share_percentage",
  "share",
] as const;

function asBool(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (["true", "yes", "on", "1", "enable", "enabled"].includes(v))
      return true;
    if (["false", "no", "off", "0", "disable", "disabled"].includes(v)) {
      return false;
    }
  }
  return null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value.replace(/%/g, "").trim());
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function firstOption(
  opts: Record<string, unknown>,
  keys: readonly string[],
): unknown {
  for (const key of keys) {
    if (opts[key] !== undefined) return opts[key];
  }
  return undefined;
}

/** Parse the enable/markup/share change + app reference from options + text. */
export function parseMonetizationIntent(
  text: string,
  options?: unknown,
): MonetizationIntent {
  const opts =
    options && typeof options === "object"
      ? (options as Record<string, unknown>)
      : {};
  const body = text ?? "";
  const settings: UpdateAppMonetizationInput = {};
  let reference: string | null = null;

  for (const key of OPTION_REFERENCE_KEYS) {
    const v = opts[key];
    if (typeof v === "string" && v.trim()) {
      reference = v.trim();
      break;
    }
  }

  // Enable / disable.
  let enable = asBool(firstOption(opts, OPTION_ENABLE_KEYS));
  if (enable === null) {
    if (
      /\b(disable|turn\s+off|deactivate|stop|switch\s+off)\b[^.!?\n]*\bmoneti/i.test(
        body,
      ) ||
      /\bmoneti\w*\s+(off|disabled?)\b/i.test(body)
    ) {
      enable = false;
    } else if (
      /\b(enable|turn\s+on|activate|start|switch\s+on)\b[^.!?\n]*\bmoneti/i.test(
        body,
      ) ||
      /\bmoneti\w*\s+(on|enabled?)\b/i.test(body)
    ) {
      enable = true;
    }
  }
  if (enable !== null) settings.monetizationEnabled = enable;

  // Inference markup %.
  let markup = asNumber(firstOption(opts, OPTION_MARKUP_KEYS));
  if (markup === null) {
    const m =
      /\bmarkup\b[^%\d-]*(-?\d+(?:\.\d+)?)\s*%?/i.exec(body) ??
      /(-?\d+(?:\.\d+)?)\s*%\s*markup\b/i.exec(body);
    if (m) markup = asNumber(m[1]);
  }

  // Purchase share %.
  let share = asNumber(firstOption(opts, OPTION_SHARE_KEYS));
  if (share === null) {
    const m =
      /\b(?:purchase\s+share|revenue\s+share|share)\b[^%\d-]*(-?\d+(?:\.\d+)?)\s*%?/i.exec(
        body,
      );
    if (m) share = asNumber(m[1]);
  }

  // Range-guard absurd values; surface the first offender for a clear message.
  if (markup !== null) {
    if (markup < MARKUP_MIN || markup > MARKUP_MAX) {
      return {
        reference,
        settings,
        rejected: {
          field: "markup",
          value: markup,
          min: MARKUP_MIN,
          max: MARKUP_MAX,
        },
      };
    }
    settings.inferenceMarkupPercentage = markup;
    // Enabling monetization is implied by setting a markup if not stated.
    if (settings.monetizationEnabled === undefined && markup > 0) {
      settings.monetizationEnabled = true;
    }
  }
  if (share !== null) {
    if (share < SHARE_MIN || share > SHARE_MAX) {
      return {
        reference,
        settings,
        rejected: {
          field: "share",
          value: share,
          min: SHARE_MIN,
          max: SHARE_MAX,
        },
      };
    }
    settings.purchaseSharePercentage = share;
  }

  return { reference, settings };
}

function settingsHaveFields(settings: UpdateAppMonetizationInput): boolean {
  return Object.keys(settings).length > 0;
}

function notFoundMessage(reference: string, available: string[]): string {
  const base = `I couldn't find an app matching "${reference}".`;
  if (available.length === 0) {
    return `${base} You don't have any apps on Eliza Cloud yet.`;
  }
  return `${base} Your apps are: ${available.join(", ")}.`;
}

/** Echo the resulting monetization settings from the server response. */
function formatSettings(
  name: string,
  monetization: {
    monetizationEnabled?: boolean;
    inferenceMarkupPercentage?: number;
    purchaseSharePercentage?: number;
  } | null,
): string {
  if (!monetization) {
    return `Updated "${name}"'s monetization.`;
  }
  if (monetization.monetizationEnabled === false) {
    return `Monetization is now OFF for "${name}".`;
  }
  const lines = [`Monetization is ON for "${name}".`];
  if (typeof monetization.inferenceMarkupPercentage === "number") {
    lines.push(`Inference markup: ${monetization.inferenceMarkupPercentage}%`);
  }
  if (typeof monetization.purchaseSharePercentage === "number") {
    lines.push(`Purchase share: ${monetization.purchaseSharePercentage}%`);
  }
  return lines.join("\n");
}

export const updateMonetizationAction: Action = {
  name: "UPDATE_MONETIZATION",
  similes: [
    "SET_PRICE",
    "CHANGE_MARKUP",
    "ENABLE_MONETIZATION",
    "DISABLE_MONETIZATION",
    "SET_MARKUP",
  ],
  description:
    "Change an Eliza Cloud app's monetization — turn it on or off, set the inference markup percentage, or set the purchase share percentage. Use when the user asks to monetize, set a price/markup, or enable/disable earning on an app.",
  descriptionCompressed: "Set a Cloud app's monetization (markup / on-off).",
  contexts: ["settings", "finance", "apps"],
  contextGate: { anyOf: ["settings", "finance", "apps"] },
  suppressPostActionContinuation: true,

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    return resolveCloudApiKey(runtime) !== null;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const client = getCloudClient(runtime);
    if (!client) {
      await callback?.({
        text: NO_KEY_MESSAGE,
        actions: ["UPDATE_MONETIZATION"],
      });
      return {
        success: false,
        text: "No Eliza Cloud API key configured.",
        userFacingText: NO_KEY_MESSAGE,
        data: { reason: "no_key" },
      };
    }

    const intent = parseMonetizationIntent(
      message.content?.text ?? "",
      options,
    );

    if (intent.rejected) {
      const { field, value, min, max } = intent.rejected;
      const label = field === "markup" ? "inference markup" : "purchase share";
      const msg = `${value}% is out of range for the ${label} — it has to be between ${min}% and ${max}%. Tell me a value in that range.`;
      await callback?.({ text: msg, actions: ["UPDATE_MONETIZATION"] });
      return {
        success: false,
        text: `Out-of-range ${label}: ${value}%.`,
        userFacingText: msg,
        data: { reason: "out_of_range", field, value, min, max },
      };
    }

    const reference = intent.reference ?? extractAppReference(message, options);
    if (!reference) {
      await callback?.({
        text: NO_REFERENCE_MESSAGE,
        actions: ["UPDATE_MONETIZATION"],
      });
      return {
        success: false,
        text: "No app reference supplied.",
        userFacingText: NO_REFERENCE_MESSAGE,
        data: { reason: "no_reference" },
      };
    }

    if (!settingsHaveFields(intent.settings)) {
      await callback?.({
        text: NO_CHANGE_MESSAGE,
        actions: ["UPDATE_MONETIZATION"],
      });
      return {
        success: false,
        text: "No monetization change supplied.",
        userFacingText: NO_CHANGE_MESSAGE,
        data: { reason: "no_change" },
      };
    }

    let app: AppDto | null;
    let available: string[];
    try {
      ({ app, available } = await resolveApp(client, reference));
    } catch (err) {
      logger.warn(
        `[UPDATE_MONETIZATION] Failed to resolve app "${reference}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      await callback?.({
        text: ERROR_MESSAGE,
        actions: ["UPDATE_MONETIZATION"],
      });
      return {
        success: false,
        text: "Failed to resolve Eliza Cloud app.",
        userFacingText: ERROR_MESSAGE,
        error: err instanceof Error ? err : new Error(String(err)),
        data: { reason: "error" },
      };
    }

    if (!app) {
      const msg = notFoundMessage(reference, available);
      await callback?.({ text: msg, actions: ["UPDATE_MONETIZATION"] });
      return {
        success: false,
        text: `No app matched "${reference}".`,
        userFacingText: msg,
        data: { reason: "not_found", reference },
      };
    }

    const target = app;
    try {
      const { monetization } = await client.updateMonetization(
        target.id,
        intent.settings,
      );
      // Monetization state changed — evict the provider cache so the next
      // turn doesn't serve a stale enabled/markup/share for ~60s.
      invalidateAppsCache(runtime);
      const reply = formatSettings(target.name, monetization);
      await callback?.({ text: reply, actions: ["UPDATE_MONETIZATION"] });
      return {
        success: true,
        text: `Updated monetization for ${target.name}.`,
        userFacingText: reply,
        verifiedUserFacing: true,
        data: {
          app: { id: target.id, name: target.name, slug: target.slug },
          monetization: monetization ?? null,
        },
      };
    } catch (err) {
      logger.warn(
        `[UPDATE_MONETIZATION] updateMonetization(${target.id}) failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      await callback?.({
        text: ERROR_MESSAGE,
        actions: ["UPDATE_MONETIZATION"],
      });
      return {
        success: false,
        text: "Failed to update monetization.",
        userFacingText: ERROR_MESSAGE,
        error: err instanceof Error ? err : new Error(String(err)),
        data: { reason: "error" },
      };
    }
  },

  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "set Acme Bot's inference markup to 20%" },
      },
      {
        name: "{{agent}}",
        content: {
          text: 'Monetization is ON for "Acme Bot".\nInference markup: 20%',
          actions: ["UPDATE_MONETIZATION"],
        },
      },
    ],
    [
      { name: "{{user}}", content: { text: "turn off monetization for Acme" } },
      {
        name: "{{agent}}",
        content: {
          text: 'Monetization is now OFF for "Acme Bot".',
          actions: ["UPDATE_MONETIZATION"],
        },
      },
    ],
  ],
};

export default updateMonetizationAction;
