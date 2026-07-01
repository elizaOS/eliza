/**
 * Ad inventory agent actions (#10687) — let an agent monetize an app with ads.
 *
 * CREATE_AD_SLOT — define an ad placement on one of the user's apps so it earns
 *                  when ads are served into it.
 * LIST_AD_SLOTS  — list the org's ad slots + their impressions/clicks/revenue.
 */

import type { AdSlotFormat } from "@elizaos/cloud-sdk";
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

const NO_KEY_MESSAGE =
  "I can't reach Eliza Cloud yet — no Cloud API key is configured. Add your ELIZAOS_CLOUD_API_KEY and I can set up ad slots.";

const FORMATS: AdSlotFormat[] = ["banner", "native", "interstitial", "feed"];

function readOpt(options: unknown): Record<string, unknown> | null {
  if (!options || typeof options !== "object") return null;
  const o = options as Record<string, unknown>;
  const nested = o.parameters;
  return nested && typeof nested === "object"
    ? (nested as Record<string, unknown>)
    : o;
}

export const createAdSlotAction: Action = {
  name: "CREATE_AD_SLOT",
  similes: [
    "ADD_AD_SLOT",
    "MONETIZE_WITH_ADS",
    "SELL_AD_SPACE",
    "CREATE_AD_PLACEMENT",
  ],
  description:
    "Create an ad slot on one of the user's Eliza Cloud apps so it can earn from serving ads. Use when the user wants to monetize an app with ads / sell ad space.",
  descriptionCompressed:
    "Create an ad slot on an app to earn from serving ads.",
  contexts: ["settings", "finance", "apps"],
  contextGate: { anyOf: ["settings", "finance", "apps"] },
  suppressPostActionContinuation: true,

  validate: async (runtime: IAgentRuntime): Promise<boolean> =>
    resolveCloudApiKey(runtime) !== null,

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const client = getCloudClient(runtime);
    if (!client) {
      await callback?.({ text: NO_KEY_MESSAGE, actions: ["CREATE_AD_SLOT"] });
      return {
        success: false,
        text: "No Cloud API key.",
        userFacingText: NO_KEY_MESSAGE,
        data: { reason: "no_key" },
      };
    }

    const reference = extractAppReference(message, options);
    const { app, available } = reference
      ? await resolveApp(client, reference)
      : { app: null, available: [] as string[] };
    if (!app) {
      const msg =
        available.length === 0
          ? "You don't have any apps yet — create one first, then I can add an ad slot."
          : `Which app? Your apps are: ${available.join(", ")}.`;
      await callback?.({ text: msg, actions: ["CREATE_AD_SLOT"] });
      return {
        success: false,
        text: "App not found.",
        userFacingText: msg,
        data: { reason: "not_found" },
      };
    }

    const rec = readOpt(options) ?? {};
    // Use `slotName` (not `name`, which the planner uses to reference the app).
    const name =
      typeof rec.slotName === "string" && rec.slotName.trim()
        ? rec.slotName.trim()
        : "Ad slot";
    const format = (
      FORMATS.includes(rec.format as AdSlotFormat) ? rec.format : "banner"
    ) as AdSlotFormat;
    const floorCpm =
      typeof rec.floorCpm === "number" && rec.floorCpm > 0
        ? rec.floorCpm
        : undefined;

    try {
      const { slot, adTagToken } = await client.createAdSlot({
        appId: app.id,
        name,
        format,
        floorCpm,
      });
      const reply = `Created ad slot "${slot.name}" (${slot.format}) on "${app.name}". It'll earn when ads are served into it.`;
      await callback?.({ text: reply, actions: ["CREATE_AD_SLOT"] });
      return {
        success: true,
        text: `Created ad slot for ${app.name}.`,
        userFacingText: reply,
        verifiedUserFacing: true,
        data: {
          slot: { id: slot.id, name: slot.name, format: slot.format },
          app: { id: app.id, name: app.name },
          // The ad tag needs this signed token to call the public serve
          // endpoint (null when the deployment has no ad-tag secret).
          adTagToken: adTagToken ?? null,
        },
      };
    } catch (err) {
      logger.warn(
        `[CREATE_AD_SLOT] failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      const msg =
        "I couldn't create that ad slot right now — the Cloud API returned an error.";
      await callback?.({ text: msg, actions: ["CREATE_AD_SLOT"] });
      return {
        success: false,
        text: "Failed to create ad slot.",
        userFacingText: msg,
        error: err instanceof Error ? err : new Error(String(err)),
        data: { reason: "error" },
      };
    }
  },

  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "monetize Acme Bot with a banner ad slot" },
      },
      {
        name: "{{agent}}",
        content: {
          text: 'Created ad slot "Ad slot" (banner) on "Acme Bot". It\'ll earn when ads are served into it.',
          actions: ["CREATE_AD_SLOT"],
        },
      },
    ],
  ],
};

export const listAdSlotsAction: Action = {
  name: "LIST_AD_SLOTS",
  similes: ["SHOW_AD_SLOTS", "MY_AD_INVENTORY", "AD_REVENUE"],
  description:
    "List the user's Eliza Cloud ad slots with impressions, clicks, and revenue. Use when the user asks about their ad inventory or ad earnings.",
  descriptionCompressed:
    "List the user's ad slots + their impressions/clicks/revenue.",
  contexts: ["settings", "finance", "apps"],
  contextGate: { anyOf: ["settings", "finance", "apps"] },
  suppressPostActionContinuation: true,

  validate: async (runtime: IAgentRuntime): Promise<boolean> =>
    resolveCloudApiKey(runtime) !== null,

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    _options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const client = getCloudClient(runtime);
    if (!client) {
      await callback?.({ text: NO_KEY_MESSAGE, actions: ["LIST_AD_SLOTS"] });
      return {
        success: false,
        text: "No Cloud API key.",
        userFacingText: NO_KEY_MESSAGE,
        data: { reason: "no_key" },
      };
    }
    try {
      const { slots } = await client.listAdSlots();
      const reply =
        slots.length === 0
          ? "You don't have any ad slots yet. Ask me to create one on an app to start earning from ads."
          : `You have ${slots.length} ad slot(s):\n${slots
              .map(
                (s) =>
                  `• ${s.name} (${s.format}, ${s.status}) — ${s.total_impressions} impressions, ${s.total_clicks} clicks, $${Number(s.total_revenue).toFixed(4)} earned`,
              )
              .join("\n")}`;
      await callback?.({ text: reply, actions: ["LIST_AD_SLOTS"] });
      return {
        success: true,
        text: `Listed ${slots.length} ad slots.`,
        userFacingText: reply,
        verifiedUserFacing: true,
        data: { count: slots.length },
      };
    } catch (err) {
      logger.warn(
        `[LIST_AD_SLOTS] failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      const msg = "I couldn't list your ad slots right now.";
      await callback?.({ text: msg, actions: ["LIST_AD_SLOTS"] });
      return {
        success: false,
        text: "Failed to list ad slots.",
        userFacingText: msg,
        error: err instanceof Error ? err : new Error(String(err)),
        data: { reason: "error" },
      };
    }
  },

  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "how much have my ad slots earned?" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "You have 1 ad slot(s):\n• Header (banner, active) — 1200 impressions, 34 clicks, $1.6800 earned",
          actions: ["LIST_AD_SLOTS"],
        },
      },
    ],
  ],
};
