/**
 * Influencer marketplace agent actions (#10687).
 *
 * CREATE_INFLUENCER_PROFILE — the agent publishes an influencer profile so it
 *                             can be booked (and earn) by advertisers.
 * LIST_INFLUENCERS          — browse active influencer profiles (advertiser
 *                             discovery, before booking).
 */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import { getCloudClient, resolveCloudApiKey } from "../client.js";

const NO_KEY_MESSAGE =
  "I can't reach Eliza Cloud yet — no Cloud API key is configured. Add your ELIZAOS_CLOUD_API_KEY.";

function readOpt(options: unknown): Record<string, unknown> {
  if (!options || typeof options !== "object") return {};
  const o = options as Record<string, unknown>;
  const nested = o.parameters;
  return nested && typeof nested === "object"
    ? (nested as Record<string, unknown>)
    : o;
}

export const createInfluencerProfileAction: Action = {
  name: "CREATE_INFLUENCER_PROFILE",
  similes: [
    "BECOME_INFLUENCER",
    "PUBLISH_INFLUENCER_PROFILE",
    "OFFER_INFLUENCER_SERVICES",
  ],
  description:
    "Publish an influencer profile on Eliza Cloud so the agent/user can be booked by advertisers and earn. Use when the user wants to become / list as an influencer or offer promotion services.",
  descriptionCompressed: "Publish an influencer profile to be booked + earn.",
  contexts: ["settings", "finance"],
  contextGate: { anyOf: ["settings", "finance"] },
  suppressPostActionContinuation: true,

  validate: async (runtime: IAgentRuntime): Promise<boolean> =>
    resolveCloudApiKey(runtime) !== null,

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const client = getCloudClient(runtime);
    if (!client) {
      await callback?.({
        text: NO_KEY_MESSAGE,
        actions: ["CREATE_INFLUENCER_PROFILE"],
      });
      return {
        success: false,
        text: "No Cloud API key.",
        userFacingText: NO_KEY_MESSAGE,
        data: { reason: "no_key" },
      };
    }
    const rec = readOpt(options);
    const displayName =
      typeof rec.displayName === "string" && rec.displayName.trim()
        ? rec.displayName.trim()
        : runtime.character?.name || "Creator";
    const niche = typeof rec.niche === "string" ? rec.niche : undefined;
    try {
      const { profile } = await client.createInfluencerProfile({
        displayName,
        niche,
      });
      const reply = `Published your influencer profile "${profile.display_name}"${profile.niche ? ` (${profile.niche})` : ""}. Advertisers can now book you.`;
      await callback?.({ text: reply, actions: ["CREATE_INFLUENCER_PROFILE"] });
      return {
        success: true,
        text: `Published influencer profile ${profile.display_name}.`,
        userFacingText: reply,
        verifiedUserFacing: true,
        data: {
          profile: { id: profile.id, displayName: profile.display_name },
        },
      };
    } catch (err) {
      logger.warn(
        `[CREATE_INFLUENCER_PROFILE] failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      const msg = "I couldn't publish that profile right now.";
      await callback?.({ text: msg, actions: ["CREATE_INFLUENCER_PROFILE"] });
      return {
        success: false,
        text: "Failed to publish profile.",
        userFacingText: msg,
        error: err instanceof Error ? err : new Error(String(err)),
        data: { reason: "error" },
      };
    }
  },

  examples: [
    [
      { name: "{{user}}", content: { text: "list me as a tech influencer" } },
      {
        name: "{{agent}}",
        content: {
          text: 'Published your influencer profile "Creator" (tech). Advertisers can now book you.',
          actions: ["CREATE_INFLUENCER_PROFILE"],
        },
      },
    ],
  ],
};

export const listInfluencersAction: Action = {
  name: "LIST_INFLUENCERS",
  similes: ["BROWSE_INFLUENCERS", "FIND_INFLUENCERS", "SEARCH_INFLUENCERS"],
  description:
    "Browse active influencer profiles on Eliza Cloud (optionally by niche) so the user can pick one to book for promotion. Use when the user wants to find / hire an influencer.",
  descriptionCompressed: "Browse influencer profiles to book for promotion.",
  contexts: ["settings", "finance", "apps"],
  contextGate: { anyOf: ["settings", "finance", "apps"] },
  suppressPostActionContinuation: true,

  validate: async (runtime: IAgentRuntime): Promise<boolean> =>
    resolveCloudApiKey(runtime) !== null,

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const client = getCloudClient(runtime);
    if (!client) {
      await callback?.({ text: NO_KEY_MESSAGE, actions: ["LIST_INFLUENCERS"] });
      return {
        success: false,
        text: "No Cloud API key.",
        userFacingText: NO_KEY_MESSAGE,
        data: { reason: "no_key" },
      };
    }
    const rec = readOpt(options);
    const niche =
      typeof rec.niche === "string" && rec.niche.trim()
        ? rec.niche.trim()
        : undefined;
    try {
      const { profiles } = await client.listInfluencers(niche);
      const reply =
        profiles.length === 0
          ? `No influencer profiles${niche ? ` in "${niche}"` : ""} found yet.`
          : `${profiles.length} influencer(s)${niche ? ` in "${niche}"` : ""}:\n${profiles
              .map((p) => {
                const reach = p.platforms.reduce(
                  (n, pl) => n + (pl.followers || 0),
                  0,
                );
                return `• ${p.display_name}${p.niche ? ` (${p.niche})` : ""}${reach ? ` — ~${reach.toLocaleString()} followers` : ""}`;
              })
              .join("\n")}`;
      await callback?.({ text: reply, actions: ["LIST_INFLUENCERS"] });
      return {
        success: true,
        text: `Listed ${profiles.length} influencers.`,
        userFacingText: reply,
        verifiedUserFacing: true,
        data: { count: profiles.length },
      };
    } catch (err) {
      logger.warn(
        `[LIST_INFLUENCERS] failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      const msg = "I couldn't browse influencers right now.";
      await callback?.({ text: msg, actions: ["LIST_INFLUENCERS"] });
      return {
        success: false,
        text: "Failed to list influencers.",
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
        content: { text: "find tech influencers to promote my app" },
      },
      {
        name: "{{agent}}",
        content: {
          text: '2 influencer(s) in "tech":\n• Creator (tech) — ~50,000 followers',
          actions: ["LIST_INFLUENCERS"],
        },
      },
    ],
  ],
};
