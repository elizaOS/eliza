/**
 * Materializes an isolated Pi provider route for one spawned coding session.
 * Provider identity, endpoint, model, billing, and credential source are
 * resolved together; secrets remain in the child environment and never enter
 * Pi configuration, argv, logs, or durable session metadata.
 */

import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CodingAgentSelection } from "@elizaos/core";
import { ElizaError } from "@elizaos/core";

export type PiApiDialect =
  | "builtin-kimi-coding"
  | "builtin-openai-compatible"
  | "openai-completions";
export type PiBillingMode =
  | "subscription-coding-plan"
  | "api-payg"
  | "api-credits-or-byok";
export type PiTermsPolicy =
  | "coding-plan-supported-tools"
  | "direct-api"
  | "credits-or-byok";

export interface PiProviderRoute {
  accountProviderId:
    | "zai-coding"
    | "kimi-coding"
    | "deepseek-api"
    | "zai-api"
    | "moonshot-api"
    | "xai-api"
    | "openrouter-api";
  piProviderId: string;
  providerLabel: string;
  dialect: PiApiDialect;
  keyEnv: string;
  baseUrl: string;
  defaultModel?: string;
  authHeader: "Authorization: Bearer";
  billingMode: PiBillingMode;
  termsPolicy: PiTermsPolicy;
  headers?: Readonly<Record<string, string>>;
  builtIn: boolean;
}

export const PI_PROVIDER_ROUTES = {
  "zai-coding": {
    accountProviderId: "zai-coding",
    piProviderId: "eliza-zai-coding-plan",
    providerLabel: "Z.AI Coding Plan",
    dialect: "openai-completions",
    keyEnv: "ZAI_API_KEY",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    defaultModel: "glm-5.1",
    authHeader: "Authorization: Bearer",
    billingMode: "subscription-coding-plan",
    termsPolicy: "coding-plan-supported-tools",
    builtIn: false,
  },
  "kimi-coding": {
    accountProviderId: "kimi-coding",
    piProviderId: "kimi-coding",
    providerLabel: "Kimi Coding Plan",
    dialect: "builtin-kimi-coding",
    keyEnv: "KIMI_API_KEY",
    baseUrl: "https://api.kimi.com/coding/v1",
    defaultModel: "kimi-for-coding",
    authHeader: "Authorization: Bearer",
    billingMode: "subscription-coding-plan",
    termsPolicy: "coding-plan-supported-tools",
    builtIn: true,
  },
  "deepseek-api": {
    accountProviderId: "deepseek-api",
    piProviderId: "eliza-deepseek",
    providerLabel: "DeepSeek API (PAYG)",
    dialect: "openai-completions",
    keyEnv: "DEEPSEEK_API_KEY",
    baseUrl: "https://api.deepseek.com",
    defaultModel: "deepseek-chat",
    authHeader: "Authorization: Bearer",
    billingMode: "api-payg",
    termsPolicy: "direct-api",
    builtIn: false,
  },
  "zai-api": {
    accountProviderId: "zai-api",
    piProviderId: "zai",
    providerLabel: "Z.AI API (PAYG)",
    dialect: "builtin-openai-compatible",
    keyEnv: "ZAI_API_KEY",
    baseUrl: "https://api.z.ai/api/paas/v4",
    defaultModel: "glm-5.1",
    authHeader: "Authorization: Bearer",
    billingMode: "api-payg",
    termsPolicy: "direct-api",
    builtIn: true,
  },
  "moonshot-api": {
    accountProviderId: "moonshot-api",
    piProviderId: "eliza-moonshot",
    providerLabel: "Kimi / Moonshot API (PAYG)",
    dialect: "openai-completions",
    keyEnv: "MOONSHOT_API_KEY",
    baseUrl: "https://api.moonshot.ai/v1",
    defaultModel: "kimi-k2.5",
    authHeader: "Authorization: Bearer",
    billingMode: "api-payg",
    termsPolicy: "direct-api",
    builtIn: false,
  },
  "xai-api": {
    accountProviderId: "xai-api",
    piProviderId: "xai",
    providerLabel: "xAI API (PAYG)",
    dialect: "builtin-openai-compatible",
    keyEnv: "XAI_API_KEY",
    baseUrl: "https://api.x.ai/v1",
    defaultModel: "grok-code-fast-1",
    authHeader: "Authorization: Bearer",
    billingMode: "api-payg",
    termsPolicy: "direct-api",
    builtIn: true,
  },
  "openrouter-api": {
    accountProviderId: "openrouter-api",
    piProviderId: "openrouter",
    providerLabel: "OpenRouter credits / BYOK",
    dialect: "builtin-openai-compatible",
    keyEnv: "OPENROUTER_API_KEY",
    baseUrl: "https://openrouter.ai/api/v1",
    authHeader: "Authorization: Bearer",
    billingMode: "api-credits-or-byok",
    termsPolicy: "credits-or-byok",
    headers: {
      "HTTP-Referer": "https://elizaos.ai",
      "X-OpenRouter-Title": "elizaOS coding agent",
    },
    builtIn: true,
  },
} as const satisfies Readonly<Record<string, PiProviderRoute>>;

export type PiProviderRouteId = keyof typeof PI_PROVIDER_ROUTES;

export function isPiProviderRouteId(value: string): value is PiProviderRouteId {
  return Object.hasOwn(PI_PROVIDER_ROUTES, value);
}

export const PI_PROVIDER_CREDENTIAL_ENVS = Object.freeze([
  "ZAI_API_KEY",
  "Z_AI_API_KEY",
  "KIMI_API_KEY",
  "MOONSHOT_API_KEY",
  "DEEPSEEK_API_KEY",
  "XAI_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
]);

const MODEL_PATTERN = /^[~A-Za-z0-9][A-Za-z0-9._:/+~-]*$/;

export interface PreparedPiProviderRoute {
  env: Record<string, string>;
  summary: {
    accountProviderId: PiProviderRoute["accountProviderId"];
    piProviderId: string;
    providerLabel: string;
    dialect: PiApiDialect;
    endpoint: string;
    authHeader: PiProviderRoute["authHeader"];
    model: string;
    billingMode: PiBillingMode;
    termsPolicy: PiTermsPolicy;
    builtIn: boolean;
  };
}

function validateModel(model: string, providerId: string): string {
  const value = model.trim();
  if (!value || value.length > 256 || !MODEL_PATTERN.test(value)) {
    throw new ElizaError("Pi provider received an invalid model id", {
      code: "PI_PROVIDER_MODEL_INVALID",
      context: { providerId },
      severity: "fatal",
    });
  }
  return value;
}

function validateEndpoint(value: string, providerId: string): string {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error("expected credential-free HTTPS endpoint");
    }
    return url.toString().replace(/\/+$/, "");
  } catch (cause) {
    throw new ElizaError("Pi provider received an invalid endpoint", {
      code: "PI_PROVIDER_ENDPOINT_INVALID",
      cause,
      context: { providerId },
      severity: "fatal",
    });
  }
}

function credentialFor(
  route: PiProviderRoute,
  selection: CodingAgentSelection,
): string {
  const credential = selection.envPatch[route.keyEnv];
  if (!credential?.trim()) {
    throw new ElizaError(`${route.providerLabel} credential is unavailable`, {
      code: "PI_PROVIDER_CREDENTIAL_MISSING",
      context: { providerId: route.accountProviderId, keyEnv: route.keyEnv },
      severity: "fatal",
    });
  }
  return credential;
}

/** Build the private Pi home and return only child-safe environment values. */
export async function preparePiProviderRoute(input: {
  sessionId: string;
  stateRoot: string;
  selection: CodingAgentSelection;
  model?: string;
}): Promise<PreparedPiProviderRoute> {
  if (!isPiProviderRouteId(input.selection.providerId)) {
    throw new ElizaError("Selected account has no Pi provider route", {
      code: "PI_PROVIDER_UNSUPPORTED",
      context: { providerId: input.selection.providerId },
      severity: "fatal",
    });
  }
  const route: PiProviderRoute = PI_PROVIDER_ROUTES[input.selection.providerId];
  const credential = credentialFor(route, input.selection);
  const model = validateModel(
    input.model ?? route.defaultModel ?? "",
    route.accountProviderId,
  );
  const endpoint = validateEndpoint(route.baseUrl, route.accountProviderId);
  const piHome = path.join(input.stateRoot, "pi-agent", input.sessionId);
  await mkdir(piHome, { recursive: true, mode: 0o700 });

  const provider = {
    baseUrl: endpoint,
    apiKey: "ELIZA_PI_ROUTE_API_KEY",
    ...(!route.builtIn ? { api: "openai-completions" } : {}),
    ...(route.headers ? { headers: route.headers } : {}),
    models: [{ id: model, name: model }],
  };
  const models = { providers: { [route.piProviderId]: provider } };
  const settings = {
    defaultProvider: route.piProviderId,
    defaultModel: model,
  };
  await Promise.all([
    writeFile(path.join(piHome, "models.json"), JSON.stringify(models), {
      encoding: "utf8",
      mode: 0o600,
    }),
    writeFile(path.join(piHome, "settings.json"), JSON.stringify(settings), {
      encoding: "utf8",
      mode: 0o600,
    }),
  ]);
  await Promise.all([
    chmod(piHome, 0o700),
    chmod(path.join(piHome, "models.json"), 0o600),
    chmod(path.join(piHome, "settings.json"), 0o600),
  ]);

  return {
    env: {
      PI_CODING_AGENT_DIR: piHome,
      ELIZA_PI_ROUTE_API_KEY: credential,
      ELIZA_PI_PROVIDER_ROUTE: route.accountProviderId,
    },
    summary: {
      accountProviderId: route.accountProviderId,
      piProviderId: route.piProviderId,
      providerLabel: route.providerLabel,
      dialect: route.dialect,
      endpoint,
      authHeader: route.authHeader,
      model,
      billingMode: route.billingMode,
      termsPolicy: route.termsPolicy,
      builtIn: route.builtIn,
    },
  };
}

/** Drop ambient provider credentials after all spawn-env merge steps. */
export function enforcePiProviderCredentialIsolation(
  env: NodeJS.ProcessEnv,
): void {
  if (!env.ELIZA_PI_PROVIDER_ROUTE) return;
  for (const key of PI_PROVIDER_CREDENTIAL_ENVS) delete env[key];
  delete env.ELIZA_PI_PROVIDER_ROUTE;
}
