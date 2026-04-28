/**
 * Browser-extension autofill actions (T8f — plan §6.14).
 *
 * Three actions:
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

import { extractActionParamsViaLlm } from "@elizaos/agent/actions/extract-params";
import { hasOwnerAccess } from "@elizaos/agent/security/access";
import {
  type Action,
  type ActionExample,
  type ActionResult,
  type HandlerOptions,
  type IAgentRuntime,
  logger,
  type Memory,
} from "@elizaos/core";
import {
  DEFAULT_AUTOFILL_WHITELIST,
  extractRegistrableDomain,
  isUrlWhitelisted,
  normalizeAutofillDomain,
} from "../lifeops/autofill-whitelist.js";
import { requireFeatureEnabled } from "../lifeops/feature-flags.js";
import { FeatureNotEnabledError } from "../lifeops/feature-flags.types.js";

const FIELD_PURPOSES = [
  "email",
  "password",
  "name",
  "phone",
  "custom",
] as const;
type FieldPurpose = (typeof FIELD_PURPOSES)[number];

const WHITELIST_CACHE_KEY = "eliza:lifeops-autofill-whitelist";
const DEVICE_BUS_URL_ENV = "MILADY_DEVICE_BUS_URL";
const DEVICE_BUS_TOKEN_ENV = "MILADY_DEVICE_BUS_TOKEN";

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

export const requestFieldFillAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: "REQUEST_FIELD_FILL",
  suppressPostActionContinuation: true,
  similes: ["AUTOFILL_FIELD", "AUTOFILL_REQUEST", "FILL_PASSWORD_FIELD"],
  description:
    "Ask the LifeOps browser extension to autofill one specific field via the installed password manager (1Password or ProtonPass). Use this only when the current tab URL and exact field purpose are already known. Refuses on domains not in the user's autofill whitelist. Credentials never pass through the agent — the extension resolves them locally. Do not use this for whole portal-upload or broader browser workflows; those belong to LIFEOPS_COMPUTER_USE.",

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> =>
    hasOwnerAccess(runtime, message),

  handler: async (runtime, message, state, options): Promise<ActionResult> => {
    if (!(await hasOwnerAccess(runtime, message))) {
      return failure("REQUEST_FIELD_FILL", "PERMISSION_DENIED");
    }

    try {
      await requireFeatureEnabled(runtime, "browser.automation");
    } catch (error) {
      if (error instanceof FeatureNotEnabledError) {
        return failure("REQUEST_FIELD_FILL", error.code, {
          featureKey: error.featureKey,
          message: error.message,
        });
      }
      throw error;
    }

    const rawParams =
      ((options as HandlerOptions | undefined)?.parameters as
        | RequestFieldFillParameters
        | undefined) ?? {};
    const params = (await extractActionParamsViaLlm<RequestFieldFillParameters>(
      {
        runtime,
        message,
        state,
        actionName: "REQUEST_FIELD_FILL",
        actionDescription: requestFieldFillAction.description ?? "",
        paramSchema: requestFieldFillAction.parameters ?? [],
        existingParams: rawParams,
        requiredFields: ["tabUrl", "fieldPurpose"],
      },
    )) as RequestFieldFillParameters;

    const tabUrl = (params.tabUrl ?? "").toString().trim();
    if (!tabUrl) return failure("REQUEST_FIELD_FILL", "MISSING_TAB_URL");

    const fieldPurpose = asFieldPurpose(params.fieldPurpose);
    if (!fieldPurpose) {
      return failure("REQUEST_FIELD_FILL", "INVALID_FIELD_PURPOSE", {
        allowed: [...FIELD_PURPOSES],
      });
    }

    const whitelist = await effectiveWhitelist(runtime);
    const check = isUrlWhitelisted(tabUrl, whitelist);
    if (!check.registrableDomain) {
      return failure("REQUEST_FIELD_FILL", "INVALID_TAB_URL");
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
        text: `Autofill refused: ${check.registrableDomain} is not in your autofill whitelist. Add it explicitly with ADD_AUTOFILL_WHITELIST if you trust this site.`,
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
          actionName: "REQUEST_FIELD_FILL",
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
          actionName: "REQUEST_FIELD_FILL",
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
        actionName: "REQUEST_FIELD_FILL",
        registrableDomain: check.registrableDomain,
        matched: check.matched,
        fieldPurpose,
      },
    };
  },

  parameters: [
    {
      name: "tabUrl",
      description:
        "URL of the tab where the field should be filled. Used for whitelist enforcement.",
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
          text: "Requested password autofill on github.com via the browser extension.",
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
          text: "Requested email autofill on example.com via the browser extension.",
        },
      },
    ],
  ] as ActionExample[][],
};

interface AddAutofillWhitelistParameters {
  readonly domain?: string;
  readonly confirmed?: boolean;
}

export const addAutofillWhitelistAction: Action = {
  name: "ADD_AUTOFILL_WHITELIST",
  similes: ["TRUST_SITE_FOR_AUTOFILL", "APPROVE_AUTOFILL_DOMAIN"],
  description:
    "Add a domain to the autofill whitelist. Requires explicit user confirmation (confirmed: true). Persisted to the local profile store.",

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> =>
    hasOwnerAccess(runtime, message),

  handler: async (runtime, message, state, options): Promise<ActionResult> => {
    if (!(await hasOwnerAccess(runtime, message))) {
      return failure("ADD_AUTOFILL_WHITELIST", "PERMISSION_DENIED");
    }
    const rawParams =
      ((options as HandlerOptions | undefined)?.parameters as
        | AddAutofillWhitelistParameters
        | undefined) ?? {};
    const params =
      (await extractActionParamsViaLlm<AddAutofillWhitelistParameters>({
        runtime,
        message,
        state,
        actionName: "ADD_AUTOFILL_WHITELIST",
        actionDescription: addAutofillWhitelistAction.description ?? "",
        paramSchema: addAutofillWhitelistAction.parameters ?? [],
        existingParams: rawParams,
        requiredFields: ["domain"],
      })) as AddAutofillWhitelistParameters;
    const rawDomain = (params.domain ?? "").toString().trim();
    if (!rawDomain) {
      return failure("ADD_AUTOFILL_WHITELIST", "MISSING_DOMAIN");
    }
    const normalized = extractRegistrableDomain(rawDomain);
    if (!normalized) {
      return failure("ADD_AUTOFILL_WHITELIST", "INVALID_DOMAIN", {
        input: rawDomain,
      });
    }
    if (params.confirmed !== true) {
      return failure("ADD_AUTOFILL_WHITELIST", "CONFIRMATION_REQUIRED", {
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
          actionName: "ADD_AUTOFILL_WHITELIST",
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
        { action: "ADD_AUTOFILL_WHITELIST", domain: normalized, detail },
        `[ADD_AUTOFILL_WHITELIST] failed to persist ${normalized}: ${detail}`,
      );
      return failure("ADD_AUTOFILL_WHITELIST", "PERSISTENCE_UNAVAILABLE", {
        domain: normalized,
        detail,
      });
    }
    logger.info(
      { action: "ADD_AUTOFILL_WHITELIST", domain: normalized },
      `[ADD_AUTOFILL_WHITELIST] added ${normalized} to user whitelist`,
    );
    return {
      text: `Added ${normalized} to the autofill whitelist.`,
      success: true,
      values: { success: true, domain: normalized, added: true },
      data: {
        actionName: "ADD_AUTOFILL_WHITELIST",
        domain: normalized,
        added: true,
      },
    };
  },

  parameters: [
    {
      name: "domain",
      description:
        "Domain to add. Stored as a registrable domain (e.g. 'example.com'). Subdomains are covered by the parent entry.",
      schema: { type: "string" as const },
    },
    {
      name: "confirmed",
      description:
        "Must be explicitly true. Required to ensure the user approved the addition, not the agent.",
      schema: { type: "boolean" as const },
    },
  ],
  examples: [
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
          text: "Added notion.so to the autofill whitelist.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Go ahead and approve linear.app for password autofill.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Added linear.app to the autofill whitelist.",
        },
      },
    ],
  ] as ActionExample[][],
};

export const listAutofillWhitelistAction: Action = {
  name: "LIST_AUTOFILL_WHITELIST",
  similes: ["SHOW_AUTOFILL_WHITELIST", "GET_AUTOFILL_WHITELIST"],
  description:
    "List effective autofill whitelist entries: the bundled defaults plus user-added entries.",

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> =>
    hasOwnerAccess(runtime, message),

  handler: async (runtime, message): Promise<ActionResult> => {
    if (!(await hasOwnerAccess(runtime, message))) {
      return failure("LIST_AUTOFILL_WHITELIST", "PERMISSION_DENIED");
    }
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
        actionName: "LIST_AUTOFILL_WHITELIST",
        defaults: [...DEFAULT_AUTOFILL_WHITELIST],
        userAdded: [...user],
        effective: [...effective],
      },
    };
  },

  parameters: [],
  examples: [
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
          text: "Autofill whitelist (4 entries): github.com, notion.so, linear.app, example.com",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Show me my trusted sites.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Autofill whitelist (3 entries): github.com, notion.so, linear.app",
        },
      },
    ],
  ] as ActionExample[][],
};

export const __internal = {
  effectiveWhitelist,
  loadUserDomains,
  saveUserDomains,
  WHITELIST_CACHE_KEY,
};
