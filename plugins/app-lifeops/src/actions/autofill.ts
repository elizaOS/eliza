import {
  type ActionResult,
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
  type State,
  logger,
} from "@elizaos/core";
import {
  DEFAULT_AUTOFILL_WHITELIST,
  extractRegistrableDomain,
  isUrlWhitelisted,
  normalizeAutofillDomain,
} from "../lifeops/autofill-whitelist.js";
import { requireFeatureEnabled } from "../lifeops/feature-flags.js";
import { FeatureNotEnabledError } from "../lifeops/feature-flags.types.js";
import {
  resolveActionArgs,
  type SubactionsMap,
} from "./lib/resolve-action-args.js";

const ACTION_NAME = "AUTOFILL";

const FIELD_PURPOSES = [
  "email",
  "password",
  "name",
  "phone",
  "custom",
] as const;
type FieldPurpose = (typeof FIELD_PURPOSES)[number];

const WHITELIST_CACHE_KEY = "eliza:lifeops-autofill-whitelist";
const DEVICE_BUS_URL_ENV = "ELIZA_DEVICE_BUS_URL";
const DEVICE_BUS_TOKEN_ENV = "ELIZA_DEVICE_BUS_TOKEN";

type AutofillSubaction = "fill" | "whitelist_add" | "whitelist_list";

interface AutofillParams {
  field?: string;
  domain?: string;
  url?: string;
  confirmed?: boolean;
}

const SUBACTIONS: SubactionsMap<AutofillSubaction> = {
  fill: {
    description:
      "Request a one-field autofill via the browser extension password manager. Refused on non-whitelisted domains.",
    descriptionCompressed:
      "autofill one field(field,domain) extension+password-manager allowlist-gated",
    required: ["field", "domain"],
    optional: ["url"],
  },
  whitelist_add: {
    description:
      "Add a domain to the autofill allowlist. Requires confirmed:true.",
    descriptionCompressed: "add domain autofill allowlist confirmed-true",
    required: ["domain", "confirmed"],
  },
  whitelist_list: {
    description:
      "List the effective autofill allowlist (defaults plus user-added entries).",
    descriptionCompressed: "list autofill allowlist defaults+user",
    required: [],
  },
};

interface RuntimeCacheLike {
  getCache<T>(key: string): Promise<T | null | undefined>;
  setCache<T>(key: string, value: T): Promise<boolean | undefined>;
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

const AUTOFILL_NEEDS_INPUT_ERRORS = new Set([
  "MISSING_TAB_URL",
  "INVALID_TAB_URL",
  "MISSING_DOMAIN",
  "INVALID_DOMAIN",
  "INVALID_FIELD_PURPOSE",
  "CONFIRMATION_REQUIRED",
  "PERSISTENCE_UNAVAILABLE",
  "FEATURE_NOT_ENABLED",
  "FEATURE_DISABLED",
]);

function failure(error: string, extra?: Record<string, unknown>): ActionResult {
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
      actionName: ACTION_NAME,
      error,
      ...(needsInput ? { requiresConfirmation: true } : {}),
      ...extra,
    },
  };
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
      { action: ACTION_NAME },
      `[${ACTION_NAME}] device bus not configured; extension cannot be reached from agent`,
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

async function handleFill(
  runtime: IAgentRuntime,
  params: AutofillParams,
): Promise<ActionResult> {
  try {
    await requireFeatureEnabled(runtime, "browser.automation");
  } catch (error) {
    if (error instanceof FeatureNotEnabledError) {
      return failure(error.code, {
        featureKey: error.featureKey,
        message: error.message,
      });
    }
    throw error;
  }

  const fieldPurpose = asFieldPurpose(params.field);
  if (!fieldPurpose) {
    return failure("INVALID_FIELD_PURPOSE", { allowed: [...FIELD_PURPOSES] });
  }

  const tabUrl = (params.url ?? params.domain ?? "").toString().trim();
  if (!tabUrl) return failure("MISSING_TAB_URL");

  const whitelist = await effectiveWhitelist(runtime);
  const check = isUrlWhitelisted(tabUrl, whitelist);
  if (!check.registrableDomain) {
    return failure("INVALID_TAB_URL");
  }
  if (!check.allowed) {
    logger.warn(
      {
        action: ACTION_NAME,
        registrableDomain: check.registrableDomain,
        fieldPurpose,
      },
      `[${ACTION_NAME}] refused non-whitelisted domain ${check.registrableDomain}`,
    );
    return {
      text: `Autofill refused: ${check.registrableDomain} is not in your autofill whitelist. Add it explicitly with the whitelist_add subaction if you trust this site.`,
      success: false,
      values: {
        success: false,
        reason: "not-whitelisted",
        requiresConfirmation: true,
        registrableDomain: check.registrableDomain,
      },
      data: {
        actionName: ACTION_NAME,
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
    fieldSelector: null,
    customKey: null,
  });
  if (!dispatch.dispatched) {
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
        actionName: ACTION_NAME,
        reason: "extension-unreachable",
        requiresConfirmation: true,
        via: dispatch.via,
        ...(dispatch.detail ? { detail: dispatch.detail } : {}),
      },
    };
  }

  logger.info(
    {
      action: ACTION_NAME,
      registrableDomain: check.registrableDomain,
      fieldPurpose,
    },
    `[${ACTION_NAME}] dispatched autofill request for ${check.registrableDomain}`,
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
      actionName: ACTION_NAME,
      registrableDomain: check.registrableDomain,
      matched: check.matched,
      fieldPurpose,
    },
  };
}

async function handleWhitelistAdd(
  runtime: IAgentRuntime,
  params: AutofillParams,
): Promise<ActionResult> {
  const rawDomain = (params.domain ?? "").toString().trim();
  if (!rawDomain) {
    return failure("MISSING_DOMAIN");
  }
  const normalized = extractRegistrableDomain(rawDomain);
  if (!normalized) {
    return failure("INVALID_DOMAIN", { input: rawDomain });
  }
  if (params.confirmed !== true) {
    return failure("CONFIRMATION_REQUIRED", { domain: normalized });
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
        actionName: ACTION_NAME,
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
      { action: ACTION_NAME, domain: normalized, detail },
      `[${ACTION_NAME}] failed to persist ${normalized}: ${detail}`,
    );
    return failure("PERSISTENCE_UNAVAILABLE", { domain: normalized, detail });
  }
  logger.info(
    { action: ACTION_NAME, domain: normalized },
    `[${ACTION_NAME}] added ${normalized} to user whitelist`,
  );
  return {
    text: `Added ${normalized} to the autofill whitelist.`,
    success: true,
    values: { success: true, domain: normalized, added: true },
    data: {
      actionName: ACTION_NAME,
      domain: normalized,
      added: true,
    },
  };
}

async function handleWhitelistList(
  runtime: IAgentRuntime,
): Promise<ActionResult> {
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
      actionName: ACTION_NAME,
      defaults: [...DEFAULT_AUTOFILL_WHITELIST],
      userAdded: [...user],
      effective: [...effective],
    },
  };
}

/**
 * Handler function backing the CREDENTIALS umbrella's autofill subactions
 * (`fill`, `whitelist_add`, `whitelist_list`).
 *
 * Folded out of the legacy `AUTOFILL` action surface — Audit B Defer #5.
 * The umbrella in `./credentials.ts` is the only caller; no Action object
 * is registered for this handler anymore.
 */
export async function runAutofillHandler(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  options: HandlerOptions | undefined,
): Promise<ActionResult> {
  const resolved = await resolveActionArgs<AutofillSubaction, AutofillParams>({
    runtime,
    message,
    state,
    options,
    actionName: ACTION_NAME,
    subactions: SUBACTIONS,
  });
  if (!resolved.ok) {
    return {
      success: false,
      text: resolved.clarification,
      data: { actionName: ACTION_NAME, missing: resolved.missing },
    };
  }

  const { subaction, params } = resolved;
  switch (subaction) {
    case "fill":
      return handleFill(runtime, params);
    case "whitelist_add":
      return handleWhitelistAdd(runtime, params);
    case "whitelist_list":
      return handleWhitelistList(runtime);
  }
}

export const __internal = {
  effectiveWhitelist,
  loadUserDomains,
  saveUserDomains,
  WHITELIST_CACHE_KEY,
};
