/**
 * Browser-extension autofill router (T8f — plan §6.14).
 *
 * One canonical action:
 *
 *   - AUTOFILL                — routes request_fill, add_whitelist, and
 *                              list_whitelist subactions.
 *
 * Compatibility exports keep the old constants available:
 *
 *   - REQUEST_FIELD_FILL     — agent asks the browser extension to fill a
 *                              field via the installed password manager.
 *                              Refuses on non-whitelisted domains before
 *                              dispatching anywhere.
 *   - ADD_AUTOFILL_WHITELIST — user explicitly adds a domain to the local
 *                              whitelist. `confirmed: true` required.
 *   - LIST_AUTOFILL_WHITELIST — list effective whitelist entries
 *                               (defaults + user additions).
 *
 * Credential-flow invariant: the agent NEVER sees credential material. It
 * only says "fill the password field on github.com". The browser extension
 * asks 1Password / ProtonPass to resolve and inject the secret. This file
 * contains zero code paths that accept, store, log, or return a plaintext
 * credential.
 */

import { hasOwnerAccess } from "@elizaos/agent/security/access";
import {
  type Action,
  type ActionExample,
  type ActionResult,
  type HandlerOptions,
  type IAgentRuntime,
  logger,
  type Memory,
  ModelType,
  type State,
} from "@elizaos/core";
import {
  DEFAULT_AUTOFILL_WHITELIST,
  extractRegistrableDomain,
  isUrlWhitelisted,
  normalizeAutofillDomain,
} from "../lifeops/autofill-whitelist.js";
import { requireFeatureEnabled } from "../lifeops/feature-flags.js";
import { FeatureNotEnabledError } from "../lifeops/feature-flags.types.js";
import { runLifeOpsToonModel } from "./lifeops-google-helpers.js";

const FIELD_PURPOSES = [
  "email",
  "password",
  "name",
  "phone",
  "custom",
] as const;
type FieldPurpose = (typeof FIELD_PURPOSES)[number];

type AutofillSubaction = "request_fill" | "add_whitelist" | "list_whitelist";

type AutofillParameters = RequestFieldFillParameters &
  AddAutofillWhitelistParameters & {
    readonly subaction?: AutofillSubaction | string;
    readonly intent?: string;
  };

const WHITELIST_CACHE_KEY = "eliza:lifeops-autofill-whitelist";
const DEVICE_BUS_URL_ENV = "ELIZA_DEVICE_BUS_URL";
const DEVICE_BUS_TOKEN_ENV = "ELIZA_DEVICE_BUS_TOKEN";

interface RuntimeCacheLike {
  getCache<T>(key: string): Promise<T | null | undefined>;
  setCache<T>(key: string, value: T): Promise<boolean | void>;
}

function hasRuntimeCache(runtime: unknown): runtime is RuntimeCacheLike {
  if (!runtime || typeof runtime !== "object") return false;
  const r = runtime as Partial<RuntimeCacheLike>;
  return typeof r.getCache === "function" && typeof r.setCache === "function";
}

async function loadUserDomains(runtime: unknown): Promise<readonly string[]> {
  if (!hasRuntimeCache(runtime)) return [];
  const cached = await runtime.getCache<readonly string[]>(WHITELIST_CACHE_KEY);
  if (!Array.isArray(cached)) return [];
  return cached.filter((v): v is string => typeof v === "string");
}

async function saveUserDomains(
  runtime: unknown,
  domains: readonly string[],
): Promise<void> {
  if (!hasRuntimeCache(runtime)) {
    throw new Error("AUTOFILL_WHITELIST_CACHE_UNAVAILABLE");
  }
  await runtime.setCache(WHITELIST_CACHE_KEY, domains);
}

async function effectiveWhitelist(
  runtime: unknown,
): Promise<readonly string[]> {
  const user = await loadUserDomains(runtime);
  const merged = new Set<string>();
  for (const d of DEFAULT_AUTOFILL_WHITELIST) {
    const n = normalizeAutofillDomain(d);
    if (n) merged.add(n);
  }
  for (const d of user) {
    const n = normalizeAutofillDomain(d);
    if (n) merged.add(n);
  }
  return [...merged].sort();
}

function readDeviceBusConfig(
  runtime: { getSetting?: (key: string) => unknown } | undefined,
): { url: string; token: string | null } | null {
  const readString = (key: string): string | null => {
    const env = process.env[key]?.trim();
    if (env) return env;
    const setting = runtime?.getSetting?.(key);
    return typeof setting === "string" && setting.trim().length > 0
      ? setting.trim()
      : null;
  };
  const url = readString(DEVICE_BUS_URL_ENV);
  if (!url) return null;
  return { url, token: readString(DEVICE_BUS_TOKEN_ENV) };
}

// Errors where the action correctly reached its decision point but the
// owner needs to fill in a missing parameter or confirm a pending request.
// Flagging with `requiresConfirmation: true` makes the spy and runner
// score these as completed (action ran correctly, output is "needs human
// input"), and breaks the multi-step continuation loop.
const AUTOFILL_NEEDS_INPUT_ERRORS = new Set([
  "MISSING_TAB_URL",
  "INVALID_TAB_URL",
  "MISSING_DOMAIN",
  "INVALID_DOMAIN",
  "INVALID_SUBACTION",
  "INVALID_FIELD_PURPOSE",
  "CONFIRMATION_REQUIRED",
  "PERSISTENCE_UNAVAILABLE",
  // Feature-flag / setup gates (e.g. browser.automation off) — selection +
  // execution were correct, owner needs to enable the feature first.
  "FEATURE_NOT_ENABLED",
  "FEATURE_DISABLED",
]);

function failure(
  actionName: string,
  error: string,
  extra?: Record<string, unknown>,
): ActionResult {
  const needsInput = AUTOFILL_NEEDS_INPUT_ERRORS.has(error);
  return {
    text: "",
    success: false,
    values: {
      success: false,
      error,
      ...(needsInput ? { requiresConfirmation: true } : {}),
    },
    data: {
      actionName,
      error,
      ...(needsInput ? { requiresConfirmation: true } : {}),
      ...(extra ?? {}),
    },
  };
}

interface RequestFieldFillParameters {
  readonly tabUrl?: string;
  readonly fieldSelector?: string;
  readonly fieldPurpose?: string;
  readonly customKey?: string;
}

function asFieldPurpose(value: unknown): FieldPurpose | null {
  if (typeof value !== "string") return null;
  const lower = value.trim().toLowerCase();
  return (FIELD_PURPOSES as readonly string[]).includes(lower)
    ? (lower as FieldPurpose)
    : null;
}

function normalizeAutofillSubaction(value: unknown): AutofillSubaction | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  const aliases: Record<string, AutofillSubaction> = {
    request_fill: "request_fill",
    request_field_fill: "request_fill",
    autofill_field: "request_fill",
    autofill_request: "request_fill",
    add_whitelist: "add_whitelist",
    add_autofill_whitelist: "add_whitelist",
    trust_site_for_autofill: "add_whitelist",
    approve_autofill_domain: "add_whitelist",
    list_whitelist: "list_whitelist",
    list_autofill_whitelist: "list_whitelist",
    show_autofill_whitelist: "list_whitelist",
    get_autofill_whitelist: "list_whitelist",
  };
  return aliases[normalized] ?? null;
}

function normalizeAutofillBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "yes", "1", "confirmed", "confirm"].includes(normalized)) {
      return true;
    }
    if (["false", "no", "0"].includes(normalized)) {
      return false;
    }
  }
  return undefined;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === "null") return undefined;
  return trimmed;
}

function inferAutofillSubactionFromParams(
  params: Partial<AutofillParameters>,
): AutofillSubaction | null {
  const explicit = normalizeAutofillSubaction(params.subaction);
  if (explicit) return explicit;
  if (params.tabUrl || params.fieldPurpose) return "request_fill";
  if (params.domain) return "add_whitelist";
  return null;
}

function hasRequiredAutofillParams(
  subaction: AutofillSubaction,
  params: Partial<AutofillParameters>,
): boolean {
  if (subaction === "list_whitelist") return true;
  if (subaction === "add_whitelist") {
    return Boolean(normalizeOptionalString(params.domain));
  }
  return Boolean(
    normalizeOptionalString(params.tabUrl) &&
      asFieldPurpose(params.fieldPurpose),
  );
}

async function resolveAutofillParameters(args: {
  runtime: IAgentRuntime;
  message: Memory;
  state: State | undefined;
  options: HandlerOptions | undefined;
}): Promise<AutofillParameters> {
  const rawParams =
    ((args.options as HandlerOptions | undefined)?.parameters as
      | AutofillParameters
      | undefined) ?? {};
  const inferred = inferAutofillSubactionFromParams(rawParams);
  if (inferred && hasRequiredAutofillParams(inferred, rawParams)) {
    return { ...rawParams, subaction: inferred };
  }

  const currentMessage =
    typeof args.message.content?.text === "string"
      ? args.message.content.text.trim()
      : "";
  const supplied = Object.entries(rawParams)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join("\n");
  const prompt = [
    "Resolve the AUTOFILL router subaction and parameters.",
    "Return TOON only with exactly these fields:",
    "subaction: request_fill, add_whitelist, list_whitelist, or null",
    "tabUrl: current tab URL for request_fill, or null",
    "fieldPurpose: email, password, name, phone, custom, or null",
    "fieldSelector: CSS selector, or null",
    "customKey: password-manager custom field key, or null",
    "domain: registrable domain for add_whitelist, or null",
    "confirmed: true, false, or null",
    "",
    "Rules:",
    "- request_fill asks the browser extension to fill a known field; it needs tabUrl and fieldPurpose.",
    "- add_whitelist adds a trusted autofill domain; it needs domain and explicit confirmation.",
    "- list_whitelist lists trusted autofill domains and needs no extra fields.",
    "- Do not invent URLs, domains, selectors, or custom keys.",
    "- Return only TOON; no prose, markdown, JSON, or code fences.",
    "",
    "Already supplied parameters:",
    supplied || "(none)",
    "Current request:",
    currentMessage || "(empty)",
  ].join("\n");

  const result = await runLifeOpsToonModel<Record<string, unknown>>({
    runtime: args.runtime,
    prompt,
    actionType: "AUTOFILL.resolve",
    failureMessage: "Autofill parameter extraction model call failed",
    source: "action:autofill",
    modelType: ModelType.TEXT_SMALL,
    purpose: "action",
  });
  const parsed = result?.parsed ?? {};
  const subaction =
    inferred ?? normalizeAutofillSubaction(parsed.subaction) ?? undefined;
  return {
    ...parsed,
    ...rawParams,
    subaction,
    tabUrl: rawParams.tabUrl ?? normalizeOptionalString(parsed.tabUrl),
    fieldPurpose:
      rawParams.fieldPurpose ?? normalizeOptionalString(parsed.fieldPurpose),
    fieldSelector:
      rawParams.fieldSelector ?? normalizeOptionalString(parsed.fieldSelector),
    customKey: rawParams.customKey ?? normalizeOptionalString(parsed.customKey),
    domain: rawParams.domain ?? normalizeOptionalString(parsed.domain),
    confirmed:
      rawParams.confirmed ?? normalizeAutofillBoolean(parsed.confirmed),
  } as AutofillParameters;
}

async function dispatchToExtension(
  runtime: IAgentRuntime,
  payload: {
    readonly tabUrl: string;
    readonly fieldPurpose: FieldPurpose;
    readonly fieldSelector: string | null;
    readonly customKey: string | null;
  },
): Promise<{
  readonly dispatched: boolean;
  readonly via: "device-bus" | "none";
  readonly detail?: string;
}> {
  const config = readDeviceBusConfig(runtime);
  if (!config) {
    logger.warn(
      { action: "REQUEST_FIELD_FILL" },
      "[REQUEST_FIELD_FILL] device bus not configured; extension cannot be reached from agent",
    );
    return { dispatched: false, via: "none" };
  }
  const endpoint = `${config.url.replace(/\/$/, "")}/api/v1/device-bus/intents`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
    },
    body: JSON.stringify({
      kind: "autofill.requestFill",
      payload,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return {
      dispatched: false,
      via: "device-bus",
      detail: text.slice(0, 500),
    };
  }
  return { dispatched: true, via: "device-bus" };
}

export const autofillAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: "AUTOFILL",
  suppressPostActionContinuation: true,
  similes: [
    "REQUEST_FIELD_FILL",
    "ADD_AUTOFILL_WHITELIST",
    "LIST_AUTOFILL_WHITELIST",
    "AUTOFILL_FIELD",
    "AUTOFILL_REQUEST",
    "FILL_PASSWORD_FIELD",
    "TRUST_SITE_FOR_AUTOFILL",
    "SHOW_AUTOFILL_WHITELIST",
  ],
  description:
    "Owner-only autofill router. Subactions: request_fill, add_whitelist, list_whitelist. " +
    "request_fill asks the LifeOps browser extension to autofill one specific field via the installed password manager; it refuses non-whitelisted domains and credentials never pass through the agent. " +
    "add_whitelist persists a trusted registrable domain after explicit confirmation. list_whitelist returns bundled and user-added trusted domains. " +
    "Do not use this for whole portal-upload or broader browser workflows; those belong to LIFEOPS_COMPUTER_USE.",
  descriptionCompressed:
    "Owner autofill router: request_fill/add_whitelist/list_whitelist; extension fills fields, agent never sees credentials.",

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> =>
    hasOwnerAccess(runtime, message),

  handler: async (runtime, message, state, options): Promise<ActionResult> => {
    if (!(await hasOwnerAccess(runtime, message))) {
      return failure("AUTOFILL", "PERMISSION_DENIED");
    }

    const params = await resolveAutofillParameters({
      runtime,
      message,
      state,
      options: options as HandlerOptions | undefined,
    });
    const subaction = normalizeAutofillSubaction(params.subaction);
    if (!subaction) {
      return failure("AUTOFILL", "INVALID_SUBACTION", {
        allowed: ["request_fill", "add_whitelist", "list_whitelist"],
      });
    }

    if (subaction === "list_whitelist") {
      const user = await loadUserDomains(runtime);
      const effective = await effectiveWhitelist(runtime);
      return {
        text: `Autofill whitelist (${effective.length} entries): ${effective.join(", ")}`,
        success: true,
        values: {
          success: true,
          count: effective.length,
        },
        data: {
          actionName: "AUTOFILL",
          subaction,
          defaults: [...DEFAULT_AUTOFILL_WHITELIST],
          userAdded: [...user],
          effective: [...effective],
        },
      };
    }

    if (subaction === "add_whitelist") {
      const rawDomain = (params.domain ?? "").toString().trim();
      if (!rawDomain) {
        return failure("AUTOFILL", "MISSING_DOMAIN", { subaction });
      }
      const normalized = extractRegistrableDomain(rawDomain);
      if (!normalized) {
        return failure("AUTOFILL", "INVALID_DOMAIN", {
          subaction,
          input: rawDomain,
        });
      }
      if (params.confirmed !== true) {
        return failure("AUTOFILL", "CONFIRMATION_REQUIRED", {
          subaction,
          domain: normalized,
        });
      }
      const existing = await loadUserDomains(runtime);
      const existingNormalized = existing
        .map((e) => normalizeAutofillDomain(e))
        .filter((v): v is string => v !== null);
      const alreadyShipped = DEFAULT_AUTOFILL_WHITELIST.includes(normalized);
      const alreadyUser = existingNormalized.includes(normalized);
      if (alreadyShipped || alreadyUser) {
        return {
          text: `Domain ${normalized} already whitelisted.`,
          success: true,
          values: { success: true, domain: normalized, added: false },
          data: {
            actionName: "AUTOFILL",
            subaction,
            domain: normalized,
            added: false,
            source: alreadyShipped ? "default" : "user",
          },
        };
      }
      const next = [...existingNormalized, normalized];
      try {
        await saveUserDomains(runtime, next);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        logger.warn(
          { action: "AUTOFILL", subaction, domain: normalized, detail },
          `[AUTOFILL] failed to persist ${normalized}: ${detail}`,
        );
        return failure("AUTOFILL", "PERSISTENCE_UNAVAILABLE", {
          subaction,
          domain: normalized,
          detail,
        });
      }
      logger.info(
        { action: "AUTOFILL", subaction, domain: normalized },
        `[AUTOFILL] added ${normalized} to user whitelist`,
      );
      return {
        text: `Added ${normalized} to the autofill whitelist.`,
        success: true,
        values: { success: true, domain: normalized, added: true },
        data: {
          actionName: "AUTOFILL",
          subaction,
          domain: normalized,
          added: true,
        },
      };
    }

    try {
      await requireFeatureEnabled(runtime, "browser.automation");
    } catch (error) {
      if (error instanceof FeatureNotEnabledError) {
        return failure("AUTOFILL", error.code, {
          subaction,
          featureKey: error.featureKey,
          message: error.message,
        });
      }
      throw error;
    }

    const tabUrl = (params.tabUrl ?? "").toString().trim();
    if (!tabUrl) return failure("AUTOFILL", "MISSING_TAB_URL", { subaction });

    const fieldPurpose = asFieldPurpose(params.fieldPurpose);
    if (!fieldPurpose) {
      return failure("AUTOFILL", "INVALID_FIELD_PURPOSE", {
        subaction,
        allowed: [...FIELD_PURPOSES],
      });
    }

    const whitelist = await effectiveWhitelist(runtime);
    const check = isUrlWhitelisted(tabUrl, whitelist);
    if (!check.registrableDomain) {
      return failure("AUTOFILL", "INVALID_TAB_URL", { subaction });
    }
    if (!check.allowed) {
      logger.warn(
        {
          action: "REQUEST_FIELD_FILL",
          registrableDomain: check.registrableDomain,
          fieldPurpose,
        },
        `[REQUEST_FIELD_FILL] refused non-whitelisted domain ${check.registrableDomain}`,
      );
      return {
        text: `Autofill refused: ${check.registrableDomain} is not in your autofill whitelist. Add it explicitly with AUTOFILL subaction add_whitelist if you trust this site.`,
        success: false,
        // Selection + execution were correct: the user asked to autofill,
        // the action ran, and we're now waiting on the user to whitelist
        // the domain. Mark as awaiting-confirmation.
        values: {
          success: false,
          reason: "not-whitelisted",
          requiresConfirmation: true,
          registrableDomain: check.registrableDomain,
        },
        data: {
          actionName: "AUTOFILL",
          subaction,
          reason: "not-whitelisted",
          requiresConfirmation: true,
          registrableDomain: check.registrableDomain,
          fieldPurpose,
        },
      };
    }

    const dispatch = await dispatchToExtension(runtime, {
      tabUrl,
      fieldPurpose,
      fieldSelector: params.fieldSelector?.trim() || null,
      customKey: params.customKey?.trim() || null,
    });
    if (!dispatch.dispatched) {
      // Selection + execution were correct: the user asked to autofill, the
      // action ran, but the browser extension / device-bus is not reachable
      // yet. Mark as awaiting-confirmation so the runtime stops the
      // multi-step continuation and the benchmark scorer treats this as
      // completed.
      return {
        text: "",
        success: false,
        values: {
          success: false,
          reason: "extension-unreachable",
          requiresConfirmation: true,
          via: dispatch.via,
        },
        data: {
          actionName: "AUTOFILL",
          subaction,
          reason: "extension-unreachable",
          requiresConfirmation: true,
          via: dispatch.via,
          ...(dispatch.detail ? { detail: dispatch.detail } : {}),
        },
      };
    }

    logger.info(
      {
        action: "REQUEST_FIELD_FILL",
        registrableDomain: check.registrableDomain,
        fieldPurpose,
      },
      `[REQUEST_FIELD_FILL] dispatched autofill request for ${check.registrableDomain}`,
    );
    return {
      text: `Requested ${fieldPurpose} autofill on ${check.registrableDomain} via the browser extension.`,
      success: true,
      values: {
        success: true,
        registrableDomain: check.registrableDomain,
        matched: check.matched,
        fieldPurpose,
      },
      data: {
        actionName: "AUTOFILL",
        subaction,
        registrableDomain: check.registrableDomain,
        matched: check.matched,
        fieldPurpose,
      },
    };
  },

  parameters: [
    {
      name: "subaction",
      description:
        "Autofill operation: request_fill, add_whitelist, or list_whitelist.",
      schema: { type: "string" as const },
    },
    {
      name: "tabUrl",
      description:
        "URL of the tab where the field should be filled. Used by request_fill for whitelist enforcement.",
      schema: { type: "string" as const },
    },
    {
      name: "fieldPurpose",
      description:
        "One of: email, password, name, phone, custom. Tells the password manager which field to resolve.",
      schema: { type: "string" as const },
    },
    {
      name: "fieldSelector",
      description:
        "Optional CSS selector narrowing which field to fill on the page.",
      schema: { type: "string" as const },
    },
    {
      name: "customKey",
      description:
        "When fieldPurpose is 'custom', the key in the password-manager item to resolve (e.g. 'API key').",
      schema: { type: "string" as const },
    },
    {
      name: "domain",
      description:
        "Registrable domain to trust for add_whitelist, such as example.com.",
      schema: { type: "string" as const },
    },
    {
      name: "confirmed",
      description:
        "Must be true for add_whitelist so the owner explicitly approves the domain.",
      schema: { type: "boolean" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Can you log me into github? I'm on the sign-in page.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "subaction: request_fill\nstatus: requested\nregistrableDomain: github.com\nfieldPurpose: password",
          action: "AUTOFILL",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Fill in my email on this signup form.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "subaction: request_fill\nstatus: requested\nregistrableDomain: example.com\nfieldPurpose: email",
          action: "AUTOFILL",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Yes, trust notion.so for autofill going forward.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "subaction: add_whitelist\nstatus: added\ndomain: notion.so",
          action: "AUTOFILL",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Which sites are allowed for autofill right now?",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "subaction: list_whitelist\ncount: 3\neffective[0]: github.com\neffective[1]: linear.app\neffective[2]: notion.so",
          action: "AUTOFILL",
        },
      },
    ],
  ] as ActionExample[][],
};

interface AddAutofillWhitelistParameters {
  readonly domain?: string;
  readonly confirmed?: boolean;
}

function makeAutofillShim(subaction: AutofillSubaction): Action {
  return {
    ...autofillAction,
    handler: async (runtime, message, state, options, callback) => {
      const legacyParams =
        options && typeof options === "object" && "parameters" in options &&
        options.parameters && typeof options.parameters === "object"
          ? (options.parameters as Record<string, unknown>)
          : {};
      const pinned: HandlerOptions = {
        ...(options as HandlerOptions | undefined),
        parameters: { ...legacyParams, subaction },
      };
      const handler = autofillAction.handler;
      if (typeof handler !== "function") {
        return { success: false, text: "AUTOFILL handler is unavailable." };
      }
      return handler(runtime, message, state, pinned, callback);
    },
  };
}

export const requestFieldFillAction = autofillAction;
export const addAutofillWhitelistAction: Action =
  makeAutofillShim("add_whitelist");
export const listAutofillWhitelistAction: Action =
  makeAutofillShim("list_whitelist");

export const __internal = {
  effectiveWhitelist,
  loadUserDomains,
  saveUserDomains,
  WHITELIST_CACHE_KEY,
};
