import { extractActionParamsViaLlm } from "@elizaos/agent";
import {
  type ActionResult,
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
  type State,
  logger,
} from "@elizaos/core";
import {
  injectCredentialToClipboard,
  listPasswordItems,
  type PasswordManagerBridgeConfig,
  type PasswordManagerItem,
  searchPasswordItems,
} from "../lifeops/password-manager-bridge.js";

/**
 * Password manager handler.
 *
 * Owner-only. Subactions:
 *   - search: match items by query string.
 *   - list: return a bounded number of items.
 *   - inject_username / inject_password: copy a field to the OS clipboard.
 *
 * Plaintext credentials NEVER appear in chat or in ActionResult payloads.
 */

type PasswordManagerSubaction =
  | "search"
  | "list"
  | "inject_username"
  | "inject_password";

type PasswordManagerParameters = {
  subaction?: PasswordManagerSubaction | string;
  intent?: string;
  query?: string;
  itemId?: string;
  field?: "username" | "password";
  confirmed?: boolean;
  limit?: number;
};

const ACTION_NAME = "PASSWORD_MANAGER";

const PARAM_SCHEMA = [
  {
    name: "subaction",
    description: "One of: search, list, inject_username, inject_password.",
    schema: { type: "string" as const },
  },
  {
    name: "intent",
    description: "Natural-language description of the lookup intent.",
    schema: { type: "string" as const },
  },
  {
    name: "query",
    description:
      "Search string matched against item title, URL, username, and tags.",
    schema: { type: "string" as const },
  },
  {
    name: "itemId",
    description:
      "Password manager item id (required for inject_* subactions).",
    schema: { type: "string" as const },
  },
  {
    name: "field",
    description:
      "Which field to inject when using a generic inject subaction. Ignored when subaction explicitly names the field.",
    schema: { type: "string" as const },
  },
  {
    name: "confirmed",
    description:
      "Must be explicitly true to copy a credential to the clipboard.",
    schema: { type: "boolean" as const },
  },
  {
    name: "limit",
    description: "Optional item limit for the `list` subaction (default 20).",
    schema: { type: "number" as const },
  },
];

const ACTION_DESCRIPTION =
  "Look up or copy credentials from your password manager (1Password CLI or ProtonPass). " +
  "Subactions: search, list, inject_username, inject_password. Credentials are NEVER displayed in chat — injection only copies to the OS clipboard briefly.";

function readConfig(
  runtime: { getSetting?: (key: string) => unknown } | undefined,
): PasswordManagerBridgeConfig {
  const account =
    process.env.ELIZA_1PASSWORD_ACCOUNT?.trim() ||
    (() => {
      const setting = runtime?.getSetting?.("ELIZA_1PASSWORD_ACCOUNT");
      return typeof setting === "string" ? setting.trim() : "";
    })();
  const config: PasswordManagerBridgeConfig = {};
  if (account) config.onePasswordAccount = account;
  return config;
}

function describeItems(items: PasswordManagerItem[]): string {
  if (items.length === 0) return "No matching items.";
  return items
    .map((item, index) => {
      const parts = [`${index + 1}. ${item.title} (id: ${item.id})`];
      if (item.url) parts.push(`url: ${item.url}`);
      if (item.username) parts.push(`username: ${item.username}`);
      return parts.join(" — ");
    })
    .join("\n");
}

function failure(error: string, extra?: Record<string, unknown>): ActionResult {
  const userMessages: Record<string, string> = {
    PERMISSION_DENIED:
      "Password manager is owner-only; you don't have access here.",
    MISSING_QUERY:
      "Which login should I look up? Tell me the service (e.g. GitHub, AWS).",
    MISSING_ITEM_ID: "I need the password manager item id to copy a field.",
    CONFIRMATION_REQUIRED:
      "Copying a credential needs explicit confirmation. Re-issue with confirmed: true.",
    UNKNOWN_SUBACTION:
      "Say 'list my saved logins', 'find my <service> login', or 'copy <service> password to clipboard'.",
  };
  return {
    text: userMessages[error] ?? error,
    success: false,
    values: { success: false, error },
    data: { actionName: ACTION_NAME, error, ...extra },
  };
}

/**
 * Handler function backing the CREDENTIALS umbrella's password-manager
 * subactions (`search`, `list`, `inject_username`, `inject_password`).
 *
 * Folded out of the legacy `PASSWORD_MANAGER` action surface — Audit B Defer
 * #5. The umbrella in `./credentials.ts` is the only caller; no Action object
 * is registered for this handler anymore.
 */
export async function runPasswordManagerHandler(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  options: HandlerOptions | undefined,
): Promise<ActionResult> {
  try {
    const rawParameters = options?.parameters;
    const rawParams = ((typeof rawParameters === "object" &&
    rawParameters !== null
      ? (rawParameters as PasswordManagerParameters)
      : {}) ?? {}) as PasswordManagerParameters;
    const params = (await extractActionParamsViaLlm<PasswordManagerParameters>({
      runtime,
      message,
      state,
      actionName: ACTION_NAME,
      actionDescription: ACTION_DESCRIPTION,
      paramSchema: PARAM_SCHEMA,
      existingParams: rawParams,
      requiredFields: ["subaction"],
    })) as PasswordManagerParameters;

    const subaction = (params.subaction ?? "")
      .toString()
      .trim()
      .toLowerCase();
    const config = readConfig(runtime);

    if (subaction === "search") {
      const query = (params.query ?? params.intent ?? "").toString().trim();
      if (!query) return failure("MISSING_QUERY");
      const items = await searchPasswordItems(query, config);
      const text = `Saved login items only — passwords remain hidden.\n${describeItems(items)}`;
      return {
        text,
        success: true,
        values: { success: true, count: items.length },
        data: {
          actionName: ACTION_NAME,
          subaction: "search",
          query,
          items,
        },
      };
    }

    if (subaction === "list") {
      const limit =
        typeof params.limit === "number" && params.limit > 0
          ? Math.floor(params.limit)
          : 20;
      const items = await listPasswordItems({ limit }, config);
      return {
        text: `Saved login items only — passwords remain hidden.\n${describeItems(items)}`,
        success: true,
        values: { success: true, count: items.length },
        data: {
          actionName: ACTION_NAME,
          subaction: "list",
          items,
        },
      };
    }

    if (subaction === "inject_username" || subaction === "inject_password") {
      const field: "username" | "password" =
        subaction === "inject_username" ? "username" : "password";
      const itemId = (params.itemId ?? "").toString().trim();
      if (!itemId) return failure("MISSING_ITEM_ID");
      if (params.confirmed !== true) {
        return failure("CONFIRMATION_REQUIRED", { itemId, field });
      }
      const result = await injectCredentialToClipboard(itemId, field, config);
      logger.info(
        {
          action: ACTION_NAME,
          subaction,
          itemId,
          field,
          fixtureMode: result.fixtureMode === true,
        },
        `[${ACTION_NAME}] Copied ${field} for item ${itemId} to clipboard`,
      );
      const fixtureSuffix = result.fixtureMode
        ? " [fixture backend: no actual clipboard write — test/benchmark mode]"
        : "";
      return {
        text: `Copied ${field} for item '${itemId}' to clipboard (clears in ${result.expiresInSeconds}s).${fixtureSuffix}`,
        success: true,
        values: {
          success: true,
          field,
          expiresInSeconds: result.expiresInSeconds,
          fixtureMode: result.fixtureMode === true,
        },
        data: {
          actionName: ACTION_NAME,
          subaction,
          itemId,
          field,
          expiresInSeconds: result.expiresInSeconds,
          fixtureMode: result.fixtureMode === true,
        },
      };
    }

    return failure("UNKNOWN_SUBACTION", { subaction });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unknown password manager failure.";
    logger.warn({ error }, `[${ACTION_NAME}] handler failed`);
    return failure("PASSWORD_MANAGER_FAILED", { error: message });
  }
}
