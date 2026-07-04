/**
 * UPDATE_APP — "rename / edit app X".
 *
 * Parses the field(s) to change (name, description, logo, website, contact email)
 * from the user's text (planner options win when present), resolves the target
 * app, then calls the typed `client.updateApp(id, patch)` and confirms the change.
 *
 * Non-destructive + reversible, so there is no two-phase confirm — an edit is
 * applied directly. Validation is light (the server is authoritative); we only
 * reject obviously malformed input (e.g. a non-http logo URL) before the call.
 */

import type { AppDto, UpdateAppInput } from "@elizaos/cloud-sdk";
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

const NO_KEY_MESSAGE =
  "I can't reach Eliza Cloud yet — no Cloud API key is configured. Add your ELIZAOS_CLOUD_API_KEY and I can update your apps.";
const NO_REFERENCE_MESSAGE =
  "Which app would you like to update? Tell me its name.";
const NO_CHANGE_MESSAGE =
  "What would you like to change? You can rename the app, or set its description, logo, website, or contact email.";
const ERROR_MESSAGE =
  "I couldn't update that app right now — the Cloud API returned an error. Try again in a moment.";

export interface UpdateAppIntent {
  /** App reference (name/slug/id) parsed from the request, if any. */
  reference: string | null;
  /** The partial update to apply. Empty when nothing parseable was found. */
  patch: UpdateAppInput;
}

const OPTION_REFERENCE_KEYS = ["app", "appName", "appId", "id"] as const;
const OPTION_NAME_KEYS = ["name", "newName", "new_name", "title"] as const;
const OPTION_DESCRIPTION_KEYS = ["description", "desc", "about"] as const;
const OPTION_LOGO_KEYS = ["logo", "logo_url", "logoUrl"] as const;
const OPTION_WEBSITE_KEYS = ["website", "website_url", "websiteUrl"] as const;
const OPTION_EMAIL_KEYS = ["email", "contact_email", "contactEmail"] as const;

// Bounded captures: a value never swallows a trailing clause/punctuation.
const VALUE_END = `["”']?\\s*[.!?]?\\s*$`;
const REF = `(?:my\\s+|the\\s+)?(?:app\\s+)?["“']?([^"”']+?)["”']?`;

// "rename Acme to Beta" / "rename my app Acme to Beta"
const RENAME_PATTERN = new RegExp(
  `\\brename\\s+${REF}\\s+to\\s+["“']?([^"”'.!?\\n]+?)${VALUE_END}`,
  "i",
);
// "set Acme's name to Beta"
const POSSESSIVE_NAME_PATTERN = new RegExp(
  `\\b(?:set|change|update)\\s+(?:my\\s+|the\\s+)?["“']?([^"”']+?)["”']?(?:'s|s')\\s+name\\s+to\\s+["“']?([^"”'.!?\\n]+?)${VALUE_END}`,
  "i",
);
// "change the name of Acme to Beta" / "set the name to Beta"
const NAME_OF_PATTERN = new RegExp(
  `\\b(?:change|set|update)\\s+(?:the\\s+)?name\\s+(?:of\\s+${REF}\\s+)?to\\s+["“']?([^"”'.!?\\n]+?)${VALUE_END}`,
  "i",
);
// "set Acme's description to ..." (possessive form, ref captured)
const POSSESSIVE_DESC_PATTERN = new RegExp(
  `\\b(?:set|change|update)\\s+(?:my\\s+|the\\s+)?["“']?([^"”']+?)["”']?(?:'s|s')\\s+(?:description|desc)\\s+to\\s+["“']?(.+?)${VALUE_END}`,
  "i",
);
// "set the description (of Acme) to ..."
const DESC_OF_PATTERN = new RegExp(
  `\\b(?:set|change|update)\\s+(?:the\\s+)?(?:description|desc|about)\\s+(?:(?:of|for)\\s+${REF}\\s+)?to\\s+["“']?(.+?)${VALUE_END}`,
  "i",
);
// "set the logo (of Acme) to <url>"
const LOGO_PATTERN = new RegExp(
  `\\b(?:set|change|update)\\s+(?:the\\s+)?logo\\s+(?:url\\s+)?(?:(?:of|for)\\s+${REF}\\s+)?to\\s+(\\S+)`,
  "i",
);
// "set the website (of Acme) to <url>"
const WEBSITE_PATTERN = new RegExp(
  `\\b(?:set|change|update)\\s+(?:the\\s+)?(?:website|site|url)\\s+(?:(?:of|for)\\s+${REF}\\s+)?to\\s+(\\S+)`,
  "i",
);
// "set the contact email (of Acme) to <email>"
const EMAIL_PATTERN = new RegExp(
  `\\b(?:set|change|update)\\s+(?:the\\s+)?(?:contact\\s+)?email\\s+(?:(?:of|for)\\s+${REF}\\s+)?to\\s+(\\S+)`,
  "i",
);

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function firstOption(
  opts: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const v = asString(opts[key]);
    if (v) return v;
  }
  return null;
}

function cleanCapture(value: string | undefined): string | null {
  if (!value) return null;
  const v = value.trim().replace(/\s+/g, " ");
  return v.length > 0 && v.length <= 200 ? v : null;
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

/** Parse the app reference + the field patch from planner options and raw text. */
export function parseUpdateAppIntent(
  text: string,
  options?: unknown,
): UpdateAppIntent {
  const opts =
    options && typeof options === "object"
      ? (options as Record<string, unknown>)
      : {};
  const body = text ?? "";

  const patch: UpdateAppInput = {};
  let reference: string | null = firstOption(opts, OPTION_REFERENCE_KEYS);

  // 1) Planner options take priority for the patch fields.
  const optName = firstOption(opts, OPTION_NAME_KEYS);
  if (optName) patch.name = optName;
  const optDesc = firstOption(opts, OPTION_DESCRIPTION_KEYS);
  if (optDesc) patch.description = optDesc;
  const optLogo = firstOption(opts, OPTION_LOGO_KEYS);
  if (optLogo) patch.logo_url = optLogo;
  const optWebsite = firstOption(opts, OPTION_WEBSITE_KEYS);
  if (optWebsite) patch.website_url = optWebsite;
  const optEmail = firstOption(opts, OPTION_EMAIL_KEYS);
  if (optEmail) patch.contact_email = optEmail;

  // 2) Text patterns fill any field not supplied via options.
  const applyRefName = (ref?: string, name?: string): void => {
    const r = cleanCapture(ref);
    const n = cleanCapture(name);
    if (!reference && r) reference = r;
    if (patch.name === undefined && n) patch.name = n;
  };

  if (patch.name === undefined) {
    for (const pattern of [
      RENAME_PATTERN,
      POSSESSIVE_NAME_PATTERN,
      NAME_OF_PATTERN,
    ]) {
      const m = pattern.exec(body);
      if (m) {
        applyRefName(m[1], m[2]);
        if (patch.name !== undefined) break;
      }
    }
  }

  if (patch.description === undefined) {
    for (const pattern of [POSSESSIVE_DESC_PATTERN, DESC_OF_PATTERN]) {
      const m = pattern.exec(body);
      if (m) {
        if (!reference) reference = cleanCapture(m[1]);
        const d = cleanCapture(m[2]);
        if (d) patch.description = d;
        if (patch.description !== undefined) break;
      }
    }
  }

  if (patch.logo_url === undefined) {
    const m = LOGO_PATTERN.exec(body);
    if (m) {
      if (!reference) reference = cleanCapture(m[1]);
      const url = cleanCapture(m[2]);
      if (url) patch.logo_url = url;
    }
  }

  if (patch.website_url === undefined) {
    const m = WEBSITE_PATTERN.exec(body);
    if (m) {
      if (!reference) reference = cleanCapture(m[1]);
      const url = cleanCapture(m[2]);
      if (url) patch.website_url = url;
    }
  }

  if (patch.contact_email === undefined) {
    const m = EMAIL_PATTERN.exec(body);
    if (m) {
      if (!reference) reference = cleanCapture(m[1]);
      const email = cleanCapture(m[2]);
      if (email) patch.contact_email = email;
    }
  }

  return { reference, patch };
}

function patchHasFields(patch: UpdateAppInput): boolean {
  return Object.keys(patch).length > 0;
}

/** Describe the applied change(s) for the reply, using the updated app's values. */
function describeChange(patch: UpdateAppInput, updated: AppDto): string[] {
  const parts: string[] = [];
  if (patch.name !== undefined) parts.push(`renamed to "${updated.name}"`);
  if (patch.description !== undefined) parts.push("description updated");
  if (patch.logo_url !== undefined) parts.push("logo updated");
  if (patch.website_url !== undefined) parts.push("website updated");
  if (patch.contact_email !== undefined) parts.push("contact email updated");
  if (patch.is_active !== undefined) {
    parts.push(updated.is_active === false ? "deactivated" : "activated");
  }
  return parts;
}

function notFoundMessage(reference: string, available: string[]): string {
  const base = `I couldn't find an app matching "${reference}".`;
  if (available.length === 0) {
    return `${base} You don't have any apps on Eliza Cloud yet.`;
  }
  return `${base} Your apps are: ${available.join(", ")}.`;
}

export const updateAppAction: Action = {
  name: "UPDATE_APP",
  similes: ["RENAME_APP", "EDIT_APP", "UPDATE_CLOUD_APP", "CHANGE_APP"],
  description:
    "Update an existing Eliza Cloud app's details — rename it, or change its description, logo, website, or contact email. Use when the user asks to rename, edit, or change an app's settings (not its monetization).",
  descriptionCompressed: "Rename or edit a Cloud app's details.",
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
      await callback?.({ text: NO_KEY_MESSAGE, actions: ["UPDATE_APP"] });
      return {
        success: false,
        text: "No Eliza Cloud API key configured.",
        userFacingText: NO_KEY_MESSAGE,
        data: { reason: "no_key" },
      };
    }

    const intent = parseUpdateAppIntent(message.content?.text ?? "", options);
    const reference = intent.reference ?? extractAppReference(message, options);
    if (!reference) {
      await callback?.({ text: NO_REFERENCE_MESSAGE, actions: ["UPDATE_APP"] });
      return {
        success: false,
        text: "No app reference supplied.",
        userFacingText: NO_REFERENCE_MESSAGE,
        data: { reason: "no_reference" },
      };
    }

    if (!patchHasFields(intent.patch)) {
      await callback?.({ text: NO_CHANGE_MESSAGE, actions: ["UPDATE_APP"] });
      return {
        success: false,
        text: "No update fields supplied.",
        userFacingText: NO_CHANGE_MESSAGE,
        data: { reason: "no_change" },
      };
    }

    // Reject obviously malformed URLs before hitting the API.
    for (const [field, value] of [
      ["logo", intent.patch.logo_url],
      ["website", intent.patch.website_url],
    ] as const) {
      if (typeof value === "string" && !isHttpUrl(value)) {
        const msg = `That ${field} URL doesn't look like a valid http(s) URL. Give me a full URL like https://example.com/logo.png.`;
        await callback?.({ text: msg, actions: ["UPDATE_APP"] });
        return {
          success: false,
          text: `Invalid ${field} URL.`,
          userFacingText: msg,
          data: { reason: "invalid_url", field },
        };
      }
    }

    let app: AppDto | null;
    let available: string[];
    try {
      ({ app, available } = await resolveApp(client, reference));
    } catch (err) {
      logger.warn(
        `[UPDATE_APP] Failed to resolve app "${reference}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      await callback?.({ text: ERROR_MESSAGE, actions: ["UPDATE_APP"] });
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
      await callback?.({ text: msg, actions: ["UPDATE_APP"] });
      return {
        success: false,
        text: `No app matched "${reference}".`,
        userFacingText: msg,
        data: { reason: "not_found", reference },
      };
    }

    const target = app;
    try {
      const { app: updated } = await client.updateApp(target.id, intent.patch);
      // App inventory changed — evict the provider cache so the next turn's
      // context reflects the new name/description/etc. (cache-invalidation
      // invariant; the ~60s WeakMap cache would otherwise serve stale state).
      invalidateAppsCache(runtime);
      const result = updated ?? target;
      const changes = describeChange(intent.patch, result);
      const summary =
        changes.length > 0 ? changes.join(", ") : "settings updated";
      const reply = `Updated "${target.name}" — ${summary}.`;
      await callback?.({ text: reply, actions: ["UPDATE_APP"] });
      return {
        success: true,
        text: `Updated Eliza Cloud app ${result.name}.`,
        userFacingText: reply,
        verifiedUserFacing: true,
        data: {
          app: { id: result.id, name: result.name, slug: result.slug },
          updated: Object.keys(intent.patch),
        },
      };
    } catch (err) {
      logger.warn(
        `[UPDATE_APP] updateApp(${target.id}) failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      await callback?.({ text: ERROR_MESSAGE, actions: ["UPDATE_APP"] });
      return {
        success: false,
        text: "Failed to update Eliza Cloud app.",
        userFacingText: ERROR_MESSAGE,
        error: err instanceof Error ? err : new Error(String(err)),
        data: { reason: "error" },
      };
    }
  },

  examples: [
    [
      { name: "{{user}}", content: { text: "rename Acme Bot to Zephyr" } },
      {
        name: "{{agent}}",
        content: {
          text: 'Updated "Acme Bot" — renamed to "Zephyr".',
          actions: ["UPDATE_APP"],
        },
      },
    ],
    [
      {
        name: "{{user}}",
        content: {
          text: "set the description of Zephyr to a friendly support bot",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: 'Updated "Zephyr" — description updated.',
          actions: ["UPDATE_APP"],
        },
      },
    ],
  ],
};

export default updateAppAction;
