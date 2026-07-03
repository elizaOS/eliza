/**
 * CREATE_APP — "build me an app called X".
 *
 * Parses the app name + description + monetization intent from the user's text
 * (planner options win when present), calls the typed `client.createApp({...})`,
 * and replies with the created draft app and an offer to deploy it.
 *
 * Monetization intent is passed through, but the server never enables
 * monetization at create time — it creates the app with monetization off,
 * persists any requested markup as a pricing default, and returns the review
 * requirement in `warnings`, which this action relays to the user (#11863).
 *
 * Security: the create response returns the app's plaintext API key ONCE. We do
 * NOT echo it into the chat reply (credentials must never transit a connector) —
 * the key lives in the user's dashboard.
 *
 * A brand-new app has no public URL yet, so we register it with the draft
 * sentinel `app_url` the server recognizes; DEPLOY_APP later assigns the real
 * `production_url`.
 */

import type { CreateAppInput } from "@elizaos/cloud-sdk";
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
import { invalidateAppsCache } from "../providers/cloud-apps.js";

/**
 * Draft sentinel URL the server recognizes as "not yet deployed" (suppresses the
 * launch alert + the custom-domain DNS exact-match guard skips it). Must match
 * the server/fixtures sentinel exactly — `https://placeholder.invalid` — or a
 * draft app surfaces a fake URL and a pre-deploy domain buy would CNAME to it.
 */
export const DRAFT_APP_URL = "https://placeholder.invalid";

const NO_KEY_MESSAGE =
  "I can't reach Eliza Cloud yet — no Cloud API key is configured. Add your ELIZAOS_CLOUD_API_KEY and I can create apps for you.";
const NO_NAME_MESSAGE =
  "Sure — what should I call the app? Give me a name and I'll create it on Eliza Cloud.";
const ERROR_MESSAGE =
  "I couldn't create that app right now — the Cloud API returned an error. Try again in a moment.";

export interface CreateAppIntent {
  name: string | null;
  description?: string;
  monetization: boolean;
  markupPercentage?: number;
}

const OPTION_NAME_KEYS = ["name", "appName", "app", "title"] as const;
const OPTION_DESCRIPTION_KEYS = ["description", "desc", "about"] as const;
const OPTION_MONETIZATION_KEYS = [
  "monetization",
  "monetize",
  "monetization_enabled",
  "monetizationEnabled",
  "paid",
] as const;
const OPTION_MARKUP_KEYS = [
  "markup",
  "markupPercentage",
  "inference_markup_percentage",
  "inferenceMarkupPercentage",
] as const;

// Free-text name extraction. Bounded captures so a name never swallows a clause.
// The lookahead ends a name at punctuation, a continuation clause, or common
// trailing filler ("please", "now", "thanks", …) so "named Zephyr please" → "Zephyr".
const NAME_STOP =
  "(?=$|[.,;!?\\n]|\\s+(?:that|which|with|to|for|and|please|now|thanks|thank|asap|today|right now|for me)\\b)";
const NAME_PATTERNS: RegExp[] = [
  new RegExp(
    `(?:app|bot|project|tool|site|game|agent)\\s+(?:called|named|titled)\\s+["“']?([^"”'.,\\n]{1,60}?)["”']?${NAME_STOP}`,
    "i",
  ),
  new RegExp(
    `\\b(?:called|named|titled)\\s+["“']?([^"”'.,\\n]{1,60}?)["”']?${NAME_STOP}`,
    "i",
  ),
  /\bname\s*[:=]\s*["“']?([^"”'.,\n]{1,60}?)["”']?(?=$|[.,;!?\n])/i,
  /["“']([^"”'\n]{2,60})["”']/,
];

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asBool(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (["true", "yes", "on", "1"].includes(v)) return true;
    if (["false", "no", "off", "0"].includes(v)) return false;
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

function parseNameFromText(text: string): string | null {
  for (const pattern of NAME_PATTERNS) {
    const match = pattern.exec(text);
    const captured = match?.[1]?.trim();
    if (captured && captured.length >= 1 && captured.length <= 100) {
      return captured.replace(/\s+/g, " ");
    }
  }
  return null;
}

/** Parse name/description/monetization intent from planner options + raw text. */
export function parseCreateAppIntent(
  text: string,
  options?: unknown,
): CreateAppIntent {
  const opts =
    options && typeof options === "object"
      ? (options as Record<string, unknown>)
      : {};

  const firstOption = (keys: readonly string[]): unknown => {
    for (const key of keys) {
      if (opts[key] !== undefined) return opts[key];
    }
    return undefined;
  };

  let name: string | null = null;
  for (const key of OPTION_NAME_KEYS) {
    const v = asString(opts[key]);
    if (v) {
      name = v;
      break;
    }
  }
  if (!name) name = parseNameFromText(text ?? "");

  let description: string | undefined;
  for (const key of OPTION_DESCRIPTION_KEYS) {
    const v = asString(opts[key]);
    if (v) {
      description = v;
      break;
    }
  }

  const monetizationOpt = asBool(firstOption(OPTION_MONETIZATION_KEYS));
  const monetization =
    monetizationOpt ??
    /\b(monetiz\w*|charge(?:s|d)?\s+(?:users|for)|paid\s+app|make\s+money|earn\b|revenue|premium|subscription)\b/i.test(
      text ?? "",
    );

  let markupPercentage = asNumber(firstOption(OPTION_MARKUP_KEYS)) ?? undefined;
  if (markupPercentage === undefined && monetization) {
    const m = /(\d+(?:\.\d+)?)\s*%/.exec(text ?? "");
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n)) markupPercentage = n;
    }
  }
  if (
    markupPercentage !== undefined &&
    (markupPercentage < 0 || markupPercentage > 1000)
  ) {
    markupPercentage = undefined; // out of the server's 0–1000 range; drop it
  }

  return { name, description, monetization, markupPercentage };
}

function buildCreateBody(intent: CreateAppIntent): CreateAppInput {
  const body: CreateAppInput = {
    name: intent.name as string,
    app_url: DRAFT_APP_URL,
    // Create a TEMPLATE app (no GitHub repo). The agent has no build-from-repo
    // flow, and build-from-repo is intentionally OFF, so a repo-backed app would
    // have no image and DEPLOY_APP would throw "build-from-repo is disabled / no
    // image to deploy". With skipGitHubRepo the server stamps a first-party,
    // allowlisted template image onto metadata.imageTag at create time, so the
    // create -> deploy loop resolves a real image instead of failing.
    skipGitHubRepo: true,
  };
  if (intent.description) body.description = intent.description;
  if (intent.monetization) body.monetization_enabled = true;
  if (intent.markupPercentage !== undefined) {
    body.inference_markup_percentage = intent.markupPercentage;
  }
  return body;
}

export const createAppAction: Action = {
  name: "CREATE_APP",
  similes: ["BUILD_APP", "MAKE_APP", "NEW_APP", "CREATE_CLOUD_APP"],
  description:
    "Create a new Eliza Cloud app for the user from a name (and optional description / monetization intent). Use when the user asks to build, make, create, or start a new app.",
  descriptionCompressed: "Create a new Eliza Cloud app from the user's intent.",
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
      await callback?.({ text: NO_KEY_MESSAGE, actions: ["CREATE_APP"] });
      return {
        success: false,
        text: "No Eliza Cloud API key configured.",
        userFacingText: NO_KEY_MESSAGE,
        data: { reason: "no_key" },
      };
    }

    const intent = parseCreateAppIntent(message.content?.text ?? "", options);
    if (!intent.name) {
      await callback?.({ text: NO_NAME_MESSAGE, actions: ["CREATE_APP"] });
      return {
        success: false,
        text: "No app name supplied.",
        userFacingText: NO_NAME_MESSAGE,
        data: { reason: "no_name" },
      };
    }

    try {
      const body = buildCreateBody(intent);
      const { app, warnings } = await client.createApp(body);
      // A new app now exists — drop the provider cache so it shows up this turn.
      invalidateAppsCache(runtime);

      const lines = [`Created "${app.name}" on Eliza Cloud (status: draft).`];
      if (intent.description) lines.push(intent.description);
      if (app.monetization_enabled) {
        const markup =
          typeof app.inference_markup_percentage === "number"
            ? ` (${app.inference_markup_percentage}% inference markup)`
            : "";
        lines.push(`Monetization is on${markup}.`);
      }
      if (warnings && warnings.length > 0) {
        lines.push(`Note: ${warnings.join(" ")}`);
      }
      lines.push(`Want me to deploy it now? Just say "deploy ${app.name}".`);
      const reply = lines.join("\n");

      await callback?.({ text: reply, actions: ["CREATE_APP"] });
      return {
        success: true,
        text: `Created Eliza Cloud app ${app.name}.`,
        userFacingText: reply,
        verifiedUserFacing: true,
        data: {
          app: { id: app.id, name: app.name, slug: app.slug },
          monetization: app.monetization_enabled,
          reviewStatus: app.review_status,
        },
      };
    } catch (err) {
      logger.warn(
        `[CREATE_APP] Failed to create app "${intent.name}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      await callback?.({ text: ERROR_MESSAGE, actions: ["CREATE_APP"] });
      return {
        success: false,
        text: "Failed to create Eliza Cloud app.",
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
        content: { text: "build me an app called Acme Bot" },
      },
      {
        name: "{{agent}}",
        content: {
          text: 'Created "Acme Bot" on Eliza Cloud (status: draft).\nWant me to deploy it now? Just say "deploy Acme Bot".',
          actions: ["CREATE_APP"],
        },
      },
    ],
  ],
};

export default createAppAction;
