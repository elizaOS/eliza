import { extractActionParamsViaLlm } from "@elizaos/agent";
import {
  type Action,
  type ActionExample,
  type ActionResult,
  type HandlerOptions,
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
 * Password manager action.
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
    data: { actionName: "PASSWORD_MANAGER", error, ...extra },
  };
}

const examples: ActionExample[][] = [
  [
    { name: "{{user1}}", content: { text: "Find my GitHub login" } },
    {
      name: "{{agent}}",
      content: {
        text: "Searching your password manager for GitHub.",
        actions: ["PASSWORD_MANAGER"],
      },
    },
  ],
  [
    {
      name: "{{user1}}",
      content: { text: "Copy my AWS password to clipboard" },
    },
    {
      name: "{{agent}}",
      content: {
        text: "Copied the AWS password to your clipboard (clears in 30s).",
        actions: ["PASSWORD_MANAGER"],
      },
    },
  ],
  [
    { name: "{{user1}}", content: { text: "List my recent saved logins" } },
    {
      name: "{{agent}}",
      content: {
        text: "Here are your most recent saved items.",
        actions: ["PASSWORD_MANAGER"],
      },
    },
  ],
];

export const passwordManagerAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: "PASSWORD_MANAGER",
  similes: [
    "ONEPASSWORD",
    "PROTONPASS",
    "CREDENTIAL_LOOKUP",
    "COPY_CREDENTIAL",
    "SHOW_LOGINS",
  ],
  description:
    "Look up or copy credentials from your password manager (1Password CLI or ProtonPass). " +
    "Subactions: search, list, inject_username, inject_password. Credentials are NEVER displayed in chat — injection only copies to the OS clipboard briefly.",
  descriptionCompressed:
    "password manager 1Password|ProtonPass: search list inject_username inject_password (clipboard-only confirm-required no-plaintext-chat)",
  routingHint:
    "credential search/list/copy/inject -> PASSWORD_MANAGER; AUTOFILL handles login/password/form fill on a site",
  contexts: ["secrets", "browser", "automation"],
  roleGate: { minRole: "OWNER" },
  suppressPostActionContinuation: true,

  validate: async () => true,

  handler: async (runtime, message, state, options): Promise<ActionResult> => {
    try {
      const rawParameters = (options as HandlerOptions | undefined)?.parameters;
      const rawParams = ((typeof rawParameters === "object" &&
      rawParameters !== null
        ? (rawParameters as PasswordManagerParameters)
        : {}) ?? {}) as PasswordManagerParameters;
      const params =
        (await extractActionParamsViaLlm<PasswordManagerParameters>({
          runtime,
          message,
          state,
          actionName: "PASSWORD_MANAGER",
          actionDescription: passwordManagerAction.description ?? "",
          paramSchema: passwordManagerAction.parameters ?? [],
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
            actionName: "PASSWORD_MANAGER",
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
            actionName: "PASSWORD_MANAGER",
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
            action: "PASSWORD_MANAGER",
            subaction,
            itemId,
            field,
            fixtureMode: result.fixtureMode === true,
          },
          `[PASSWORD_MANAGER] Copied ${field} for item ${itemId} to clipboard`,
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
            actionName: "PASSWORD_MANAGER",
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
      logger.warn({ error }, "[PASSWORD_MANAGER] Action failed");
      return failure("PASSWORD_MANAGER_FAILED", { error: message });
    }
  },

  examples,

  parameters: [
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
  ],
};
